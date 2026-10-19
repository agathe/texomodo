-- ============================================================================
-- TexoModo: Review Mode schema
-- Run once in the Supabase SQL editor (or `supabase db push`).
--
-- Security model
--   * Visitors never touch these tables. The public site works without them.
--   * Every table has Row Level Security. Access requires a signed-in Google
--     user whose email is on the allowlist (review_access): either an exact
--     email or a Google Workspace domain. The check is a SECURITY DEFINER
--     function so the allowlist itself is never readable from the browser.
--   * The browser only ever holds the anon key. The service role key is used
--     by scripts/sync-allowlist.mjs on a developer machine and, later, by the
--     server-side AI change-request pipeline. Never ship it to the client.
--   * change_requests is append-only from the browser (reviewers may request
--     a change). Only server-side code with the service role may update it.
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- Allowlist
-- ----------------------------------------------------------------------------
create table if not exists public.review_access (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('domain', 'email')),
  value       text not null,
  note        text,
  created_at  timestamptz not null default now(),
  unique (kind, value)
);
comment on table public.review_access is
  'Who may enter Review Mode. kind=domain matches any Google account on that domain; kind=email matches one account. Managed by scripts/sync-allowlist.mjs from ALLOWED_GOOGLE_DOMAIN / ALLOWED_EMAILS.';

alter table public.review_access enable row level security;
-- No policies on purpose: nothing but the service role (which bypasses RLS)
-- and the SECURITY DEFINER function below may read or write it.
revoke all on public.review_access from anon, authenticated;

-- Lower-cased email of the caller, '' when anonymous.
create or replace function public.review_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- TRUE when the caller is signed in and on the allowlist. Used by every policy.
create or replace function public.review_is_authorized()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.role() = 'authenticated'
    and public.review_email() <> ''
    and (
      exists (
        select 1 from public.review_access a
        where a.kind = 'email' and lower(a.value) = public.review_email()
      )
      or exists (
        select 1 from public.review_access a
        where a.kind = 'domain'
          and public.review_email() like '%@' || lower(a.value)
      )
    );
$$;

revoke all on function public.review_is_authorized() from public;
grant execute on function public.review_is_authorized() to anon, authenticated;
grant execute on function public.review_email() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Annotations (one row = one review comment anchored to a place on a page)
-- The JSON columns mirror review/types.d.ts. Keep them in sync.
-- ----------------------------------------------------------------------------
create table if not exists public.annotations (
  id              uuid primary key default gen_random_uuid(),
  page            text not null,                       -- pathname, e.g. /mass-times.html
  url             text not null,                       -- full URL at creation
  title           text,                                -- document.title
  type            text not null check (type in ('pin', 'rectangle', 'circle', 'draw')),
  geometry        jsonb not null,                      -- AnnotationGeometry
  viewport        jsonb,                               -- { width, height, dpr }
  scroll          jsonb,                               -- { x, y }
  target          jsonb,                               -- AnnotationTarget (selector, text, html, rect ...)
  comment         text not null check (char_length(comment) between 1 and 5000),
  author_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author          jsonb not null,                      -- { email, name, avatar }
  status          text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at     timestamptz,
  resolved_by     jsonb,                               -- { email, name }
  build           jsonb,                               -- { commit, branch, context, deployUrl, deployId, builtAt }
  screenshot_path text,                                -- object path in the review-screenshots bucket
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists annotations_page_idx on public.annotations (page, created_at);

create table if not exists public.annotation_replies (
  id             uuid primary key default gen_random_uuid(),
  annotation_id  uuid not null references public.annotations (id) on delete cascade,
  author_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author         jsonb not null,
  body           text not null check (char_length(body) between 1 and 5000),
  created_at     timestamptz not null default now()
);
create index if not exists annotation_replies_annotation_idx on public.annotation_replies (annotation_id, created_at);

-- ----------------------------------------------------------------------------
-- Change requests (Phase 2 extension point: annotation -> AI -> PR -> preview)
-- Reviewers may create a row; only server-side code may advance it.
-- ----------------------------------------------------------------------------
create table if not exists public.change_requests (
  id                  uuid primary key default gen_random_uuid(),
  annotation_id       uuid not null references public.annotations (id) on delete cascade,
  instruction         text not null check (char_length(instruction) between 1 and 5000),
  status              text not null default 'requested'
                      check (status in ('requested', 'working', 'preview-ready', 'approved', 'rejected', 'failed')),
  requested_by        jsonb not null,                  -- { email, name }
  requested_by_id     uuid not null default auth.uid(),
  page_context        jsonb,                           -- snapshot of the annotation (page, target, geometry, build)
  repository_context  jsonb,                           -- { repo, baseBranch, baseCommit, files[] } filled by the pipeline
  branch              text,
  pull_request_url    text,
  preview_url         text,
  log                 jsonb not null default '[]'::jsonb, -- [{ at, event, detail }]
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists change_requests_annotation_idx on public.change_requests (annotation_id, created_at);

-- ----------------------------------------------------------------------------
-- Triggers
-- ----------------------------------------------------------------------------
create or replace function public.review_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists annotations_touch on public.annotations;
create trigger annotations_touch before update on public.annotations
  for each row execute function public.review_touch_updated_at();

drop trigger if exists change_requests_touch on public.change_requests;
create trigger change_requests_touch before update on public.change_requests
  for each row execute function public.review_touch_updated_at();

-- Any reviewer may resolve/reopen, but only the author may change anything else.
create or replace function public.annotations_guard_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.author_id <> old.author_id
     or new.page <> old.page
     or new.url <> old.url
     or new.created_at <> old.created_at then
    raise exception 'immutable annotation fields';
  end if;
  if old.author_id <> auth.uid() then
    if new.comment <> old.comment
       or new.geometry <> old.geometry
       or new.target is distinct from old.target
       or new.screenshot_path is distinct from old.screenshot_path then
      raise exception 'only the author may edit this annotation';
    end if;
  end if;
  if new.status = 'resolved' and old.status <> 'resolved' then
    new.resolved_at = now();
  elsif new.status = 'open' then
    new.resolved_at = null;
    new.resolved_by = null;
  end if;
  return new;
end;
$$;

drop trigger if exists annotations_guard on public.annotations;
create trigger annotations_guard before update on public.annotations
  for each row execute function public.annotations_guard_update();

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.annotations       enable row level security;
alter table public.annotation_replies enable row level security;
alter table public.change_requests   enable row level security;

drop policy if exists "reviewers read annotations"   on public.annotations;
drop policy if exists "reviewers create annotations" on public.annotations;
drop policy if exists "reviewers update annotations" on public.annotations;
drop policy if exists "authors delete annotations"   on public.annotations;

create policy "reviewers read annotations" on public.annotations
  for select to authenticated using (public.review_is_authorized());
create policy "reviewers create annotations" on public.annotations
  for insert to authenticated with check (public.review_is_authorized() and author_id = auth.uid());
create policy "reviewers update annotations" on public.annotations
  for update to authenticated using (public.review_is_authorized()) with check (public.review_is_authorized());
create policy "authors delete annotations" on public.annotations
  for delete to authenticated using (public.review_is_authorized() and author_id = auth.uid());

drop policy if exists "reviewers read replies"   on public.annotation_replies;
drop policy if exists "reviewers create replies" on public.annotation_replies;
drop policy if exists "authors delete replies"   on public.annotation_replies;

create policy "reviewers read replies" on public.annotation_replies
  for select to authenticated using (public.review_is_authorized());
create policy "reviewers create replies" on public.annotation_replies
  for insert to authenticated with check (public.review_is_authorized() and author_id = auth.uid());
create policy "authors delete replies" on public.annotation_replies
  for delete to authenticated using (public.review_is_authorized() and author_id = auth.uid());

drop policy if exists "reviewers read change requests"   on public.change_requests;
drop policy if exists "reviewers create change requests" on public.change_requests;

create policy "reviewers read change requests" on public.change_requests
  for select to authenticated using (public.review_is_authorized());
create policy "reviewers create change requests" on public.change_requests
  for insert to authenticated with check (public.review_is_authorized() and requested_by_id = auth.uid());
-- No update/delete policy: only the service role (server-side pipeline) may advance a request.

-- ----------------------------------------------------------------------------
-- Screenshots: private bucket, same allowlist
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-screenshots', 'review-screenshots', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists "reviewers read screenshots"   on storage.objects;
drop policy if exists "reviewers upload screenshots" on storage.objects;
drop policy if exists "owners delete screenshots"    on storage.objects;

create policy "reviewers read screenshots" on storage.objects
  for select to authenticated
  using (bucket_id = 'review-screenshots' and public.review_is_authorized());
create policy "reviewers upload screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'review-screenshots' and public.review_is_authorized());
create policy "owners delete screenshots" on storage.objects
  for delete to authenticated
  using (bucket_id = 'review-screenshots' and owner = auth.uid());

-- ----------------------------------------------------------------------------
-- Realtime: let open drawers see other reviewers' comments as they arrive.
-- (RLS still applies to realtime; unauthorized users receive nothing.)
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'annotations'
  ) then
    alter publication supabase_realtime add table public.annotations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'annotation_replies'
  ) then
    alter publication supabase_realtime add table public.annotation_replies;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Allowlist seed. Prefer `npm run allowlist` (reads .env). To seed by hand:
--   insert into public.review_access (kind, value) values ('domain', 'example.org');
--   insert into public.review_access (kind, value) values ('email', 'reviewer@gmail.com');
-- ----------------------------------------------------------------------------
