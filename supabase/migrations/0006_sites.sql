-- ============================================================================
-- 0006: sites (one Supabase project, many reviewed websites)
--
-- Every review table now belongs to a site. One Supabase project and one
-- Google OAuth client can serve any number of deployed websites; each deploy
-- says which site it is (TEXOMODO_SITE_ID at build time, written to config.json) and
-- every query, policy and storage path is scoped by it.
--
--   sites           one row per website (id = short slug, e.g. 'allsaints')
--   review_access   now per site. site NULL = a platform-wide row (grants every
--                   site; use it for the person who runs the platform).
--   annotations     site column (immutable); replies, events and change
--                   requests inherit it through their annotation.
--   screenshots     stored under <site>/<page>/<id>.jpg; the first folder of
--                   the object path is the site and is what the policies check.
--   functions       review_is_authorized(site) and review_role(site) replace
--                   the zero-argument versions, which are dropped so nothing
--                   can answer "authorized" without naming a site.
--
-- BEFORE RUNNING on a project that already holds comments: the backfill below
-- assigns every existing row to the site id in `existing_site`. Change it if
-- your TEXOMODO_SITE_ID is not 'allsaints'. Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Sites
-- ----------------------------------------------------------------------------
create table if not exists public.sites (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  note        text,
  created_at  timestamptz not null default now()
);
comment on table public.sites is
  'One row per reviewed website. id is the TEXOMODO_SITE_ID the deploy is built with. Managed by scripts/sync-allowlist.mjs (service role); not readable from the browser.';
alter table public.sites enable row level security;
revoke all on public.sites from anon, authenticated;

-- Backfill target for rows that predate this migration.
create temp table if not exists existing_site as select 'allsaints'::text as id;
insert into public.sites (id, name, note)
select id, 'All Saints Catholic Church', 'created by migration 0006' from existing_site
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Allowlist: per site, or platform-wide (site is null)
-- ----------------------------------------------------------------------------
alter table public.review_access
  add column if not exists site text references public.sites (id) on delete cascade;
update public.review_access set site = (select id from existing_site) where site is null and note is distinct from 'PLATFORM_ADMINS';
alter table public.review_access drop constraint if exists review_access_kind_value_key;
alter table public.review_access drop constraint if exists review_access_site_kind_value_key;
alter table public.review_access add constraint review_access_site_kind_value_key unique nulls not distinct (site, kind, value);
create index if not exists review_access_site_idx on public.review_access (site);
comment on column public.review_access.site is
  'Site this row grants access to. NULL grants every site (platform admin); only email rows should be platform-wide.';
comment on table public.review_access is
  'Who may enter Review Mode, per site. kind=domain matches any Google account on that domain; kind=email matches one account. Managed by scripts/sync-allowlist.mjs from TEXOMODO_SITE_ID + ALLOWED_GOOGLE_DOMAIN / ALLOWED_EMAILS / ALLOWED_MAINTAINERS (and PLATFORM_ADMINS for site = NULL rows).';

-- ----------------------------------------------------------------------------
-- Annotations carry the site. Children reach it through the annotation.
-- ----------------------------------------------------------------------------
alter table public.annotations add column if not exists site text;
update public.annotations set site = (select id from existing_site) where site is null;
alter table public.annotations alter column site set not null;
alter table public.annotations drop constraint if exists annotations_site_fkey;
alter table public.annotations add constraint annotations_site_fkey foreign key (site) references public.sites (id) on delete cascade;

drop index if exists public.annotations_page_idx;
drop index if exists public.annotations_shared_idx;
create index if not exists annotations_site_page_idx on public.annotations (site, page, created_at);
create index if not exists annotations_site_shared_idx on public.annotations (site, scope, created_at) where scope <> 'page';
comment on column public.annotations.site is 'The reviewed website this comment belongs to (sites.id). Immutable.';

-- Screenshots move under a site folder.
update public.annotations
  set screenshot_path = site || '/' || screenshot_path
  where screenshot_path is not null and screenshot_path not like site || '/%';
do $$
begin
  update storage.objects o
    set name = a.site || '/' || o.name
    from public.annotations a
    where o.bucket_id = 'review-screenshots'
      and a.screenshot_path = a.site || '/' || o.name
      and o.name not like a.site || '/%';
exception when insufficient_privilege then
  raise notice 'could not move existing screenshots under a site folder; move them in the Storage UI if any exist';
end $$;

-- ----------------------------------------------------------------------------
-- Old policies go first: they depend on the zero-argument functions.
-- ----------------------------------------------------------------------------
drop policy if exists "reviewers read annotations"        on public.annotations;
drop policy if exists "reviewers create annotations"      on public.annotations;
drop policy if exists "reviewers update annotations"      on public.annotations;
drop policy if exists "authors delete annotations"        on public.annotations;
drop policy if exists "reviewers read replies"            on public.annotation_replies;
drop policy if exists "reviewers create replies"          on public.annotation_replies;
drop policy if exists "authors edit replies"              on public.annotation_replies;
drop policy if exists "authors delete replies"            on public.annotation_replies;
drop policy if exists "reviewers read events"             on public.annotation_events;
drop policy if exists "reviewers read change requests"    on public.change_requests;
drop policy if exists "reviewers create change requests"  on public.change_requests;
drop policy if exists "reviewers read screenshots"        on storage.objects;
drop policy if exists "reviewers upload screenshots"      on storage.objects;
drop policy if exists "reviewers update screenshots"      on storage.objects;
drop policy if exists "owners delete screenshots"         on storage.objects;

drop function if exists public.review_role();
drop function if exists public.review_is_authorized();

-- ----------------------------------------------------------------------------
-- Site-aware authorization
-- (Parameters are named site_id, never `site`: in SQL functions a column of
-- the same name would win over the parameter and the check would be void.)
-- ----------------------------------------------------------------------------
-- TRUE when the caller is signed in, the site exists, and an allowlist row for
-- that site (or a platform-wide row) matches the caller's email or domain.
create or replace function public.review_is_authorized(site_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    auth.role() = 'authenticated'
    and public.review_email() <> ''
    and site_id is not null
    and exists (select 1 from public.sites s where s.id = site_id)
    and exists (
      select 1 from public.review_access a
      where (a.site is null or a.site = site_id)
        and (
          (a.kind = 'email' and lower(a.value) = public.review_email())
          or (a.kind = 'domain' and public.review_email() like '%@' || lower(a.value))
        )
    );
$$;
revoke all on function public.review_is_authorized(text) from public;
grant execute on function public.review_is_authorized(text) to anon, authenticated;

-- 'maintainer' | 'reviewer' | NULL (not authorized) for the given site.
create or replace function public.review_role(site_id text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'service_role' then 'maintainer'
    when not public.review_is_authorized(site_id) then null
    when exists (
      select 1 from public.review_access a
      where (a.site is null or a.site = site_id)
        and a.kind = 'email' and lower(a.value) = public.review_email() and a.role = 'maintainer'
    ) then 'maintainer'
    else 'reviewer'
  end;
$$;
revoke all on function public.review_role(text) from public;
grant execute on function public.review_role(text) to anon, authenticated;

-- Site of an annotation, for the policies on its children. SECURITY DEFINER so
-- it is not itself subject to the annotations policy (which it would satisfy
-- anyway; this keeps the plan simple).
create or replace function public.review_annotation_site(annotation uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select a.site from public.annotations a where a.id = annotation;
$$;
revoke all on function public.review_annotation_site(uuid) from public;
grant execute on function public.review_annotation_site(uuid) to anon, authenticated;

-- Sites the caller may review, with their role: lets a future switcher list
-- them. Reveals nothing about sites the caller is not on.
create or replace function public.review_sites()
returns table (site_id text, site_name text, site_role text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.name, public.review_role(s.id)
  from public.sites s
  where public.review_is_authorized(s.id)
  order by s.name;
$$;
revoke all on function public.review_sites() from public;
grant execute on function public.review_sites() to authenticated;

-- ----------------------------------------------------------------------------
-- Guard: site is immutable; the role is judged for the comment's site
-- ----------------------------------------------------------------------------
create or replace function public.annotations_guard_update()
returns trigger
language plpgsql
as $$
declare
  role text := public.review_role(old.site);
  is_author boolean := (old.author_id = auth.uid());
begin
  if auth.role() = 'service_role' then
    return new;
  end if;
  if new.author_id <> old.author_id
     or new.site <> old.site
     or new.page <> old.page
     or new.url <> old.url
     or new.created_at <> old.created_at then
    raise exception 'immutable annotation fields';
  end if;
  if not is_author and role is distinct from 'maintainer' then
    raise exception 'only the author or a maintainer may change this comment';
  end if;
  if new.status = 'verified' and old.status <> 'verified' then
    if role is distinct from 'maintainer' then
      raise exception 'only a maintainer may verify a comment';
    end if;
    new.verified_at = now();
    new.verified_by = public.review_actor();
    new.resolved_at = null; new.resolved_by = null; new.resolution = null;
  elsif new.status = 'resolved' and old.status <> 'resolved' then
    new.resolved_at = now();
    new.resolved_by = public.review_actor();
    if new.resolution is null then new.resolution = 'addressed'; end if;
  elsif new.status = 'open' then
    new.resolved_at = null; new.resolved_by = null; new.resolution = null;
    new.verified_at = null; new.verified_by = null;
  end if;
  if new.comment <> old.comment then
    new.edited_at = now();
    new.edited_by = public.review_actor();
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- Policies, now per site
-- ----------------------------------------------------------------------------
create policy "reviewers read annotations" on public.annotations
  for select to authenticated using (public.review_is_authorized(site));
create policy "reviewers create annotations" on public.annotations
  for insert to authenticated with check (public.review_is_authorized(site) and author_id = auth.uid());
create policy "reviewers update annotations" on public.annotations
  for update to authenticated using (public.review_is_authorized(site)) with check (public.review_is_authorized(site));
create policy "authors delete annotations" on public.annotations
  for delete to authenticated
  using (public.review_is_authorized(site) and (author_id = auth.uid() or public.review_role(site) = 'maintainer'));

create policy "reviewers read replies" on public.annotation_replies
  for select to authenticated using (public.review_is_authorized(public.review_annotation_site(annotation_id)));
create policy "reviewers create replies" on public.annotation_replies
  for insert to authenticated
  with check (public.review_is_authorized(public.review_annotation_site(annotation_id)) and author_id = auth.uid());
create policy "authors edit replies" on public.annotation_replies
  for update to authenticated
  using (public.review_is_authorized(public.review_annotation_site(annotation_id)) and author_id = auth.uid())
  with check (author_id = auth.uid());
create policy "authors delete replies" on public.annotation_replies
  for delete to authenticated
  using (public.review_is_authorized(public.review_annotation_site(annotation_id)) and author_id = auth.uid());

create policy "reviewers read events" on public.annotation_events
  for select to authenticated using (public.review_is_authorized(public.review_annotation_site(annotation_id)));

create policy "reviewers read change requests" on public.change_requests
  for select to authenticated using (public.review_is_authorized(public.review_annotation_site(annotation_id)));
create policy "reviewers create change requests" on public.change_requests
  for insert to authenticated
  with check (
    public.review_is_authorized(public.review_annotation_site(annotation_id))
    and requested_by_id = auth.uid()
    and exists (select 1 from public.annotations a where a.id = annotation_id and a.status = 'verified')
  );

-- Storage: the first path segment is the site.
create policy "reviewers read screenshots" on storage.objects
  for select to authenticated
  using (bucket_id = 'review-screenshots' and public.review_is_authorized((storage.foldername(name))[1]));
create policy "reviewers upload screenshots" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'review-screenshots' and public.review_is_authorized((storage.foldername(name))[1]));
create policy "reviewers update screenshots" on storage.objects
  for update to authenticated
  using (bucket_id = 'review-screenshots' and public.review_is_authorized((storage.foldername(name))[1]))
  with check (bucket_id = 'review-screenshots' and public.review_is_authorized((storage.foldername(name))[1]));
create policy "owners delete screenshots" on storage.objects
  for delete to authenticated
  using (bucket_id = 'review-screenshots' and owner = auth.uid());

drop table if exists existing_site;

-- To add a second website on this project:
--   insert into public.sites (id, name) values ('stmarys', 'St Mary Parish');
--   insert into public.review_access (site, kind, value, role) values ('stmarys', 'domain', 'stmarys.org', 'reviewer');
--   -- or, from that site's repo: TEXOMODO_SITE_ID=stmarys in .env, then `npm run allowlist`
-- To make someone a maintainer on every site:
--   insert into public.review_access (site, kind, value, role, note) values (null, 'email', 'you@example.org', 'maintainer', 'PLATFORM_ADMINS');
