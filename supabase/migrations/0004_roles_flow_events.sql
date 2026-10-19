-- ============================================================================
-- 0004: roles, verification flow, editing, and a database-enforced activity log
--
-- Roles      review_access.role: 'reviewer' (default) or 'maintainer'.
--            Reviewers edit their own comments and replies and may resolve
--            their own comments. Maintainers edit anyone's metadata, verify,
--            resolve and reopen any comment, and may delete any comment.
-- Status     open -> verified (maintainer looked at it) -> resolved
--            resolution: 'addressed' or 'declined'. Reopen is always allowed.
-- Events     annotation_events is written by triggers only (SECURITY DEFINER),
--            so the client cannot skip or forge history.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Roles
-- ----------------------------------------------------------------------------
alter table public.review_access
  add column if not exists role text not null default 'reviewer';
alter table public.review_access drop constraint if exists review_access_role_check;
alter table public.review_access add constraint review_access_role_check check (role in ('reviewer', 'maintainer'));
comment on column public.review_access.role is 'reviewer | maintainer. Only email rows can grant maintainer.';

create or replace function public.review_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'service_role' then 'maintainer'
    when not public.review_is_authorized() then null
    when exists (
      select 1 from public.review_access a
      where a.kind = 'email' and lower(a.value) = public.review_email() and a.role = 'maintainer'
    ) then 'maintainer'
    else 'reviewer'
  end;
$$;
revoke all on function public.review_role() from public;
grant execute on function public.review_role() to anon, authenticated;

-- Who is acting, for audit rows.
create or replace function public.review_actor()
returns jsonb
language sql
stable
as $$
  select case
    when auth.role() = 'service_role' then jsonb_build_object('email', 'pipeline', 'name', 'AI pipeline')
    else jsonb_build_object(
      'email', public.review_email(),
      'name', coalesce(auth.jwt() -> 'user_metadata' ->> 'full_name', auth.jwt() -> 'user_metadata' ->> 'name', split_part(public.review_email(), '@', 1))
    )
  end;
$$;
grant execute on function public.review_actor() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Status flow and edit metadata
-- ----------------------------------------------------------------------------
alter table public.annotations drop constraint if exists annotations_status_check;
alter table public.annotations add constraint annotations_status_check check (status in ('open', 'verified', 'resolved'));

alter table public.annotations
  add column if not exists resolution text,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by jsonb,
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by jsonb;
alter table public.annotations drop constraint if exists annotations_resolution_check;
alter table public.annotations add constraint annotations_resolution_check check (resolution is null or resolution in ('addressed', 'declined'));

alter table public.annotation_replies add column if not exists edited_at timestamptz;

-- ----------------------------------------------------------------------------
-- Activity log
-- ----------------------------------------------------------------------------
create table if not exists public.annotation_events (
  id             bigint generated always as identity primary key,
  annotation_id  uuid not null references public.annotations (id) on delete cascade,
  actor          jsonb not null,
  actor_id       uuid,
  kind           text not null,   -- created | edited | moved | metadata | verified | resolved | reopened | replied | reply_edited | reply_deleted
  changes        jsonb,           -- { field: { from, to } } for edits; { resolution } for resolved
  at             timestamptz not null default now()
);
create index if not exists annotation_events_annotation_idx on public.annotation_events (annotation_id, at);
alter table public.annotation_events enable row level security;
drop policy if exists "reviewers read events" on public.annotation_events;
create policy "reviewers read events" on public.annotation_events
  for select to authenticated using (public.review_is_authorized());
-- No insert/update/delete policies: only the triggers below (SECURITY DEFINER) write here.

-- ----------------------------------------------------------------------------
-- Guard: who may change what on an annotation
-- ----------------------------------------------------------------------------
create or replace function public.annotations_guard_update()
returns trigger
language plpgsql
as $$
declare
  role text := public.review_role();
  is_author boolean := (old.author_id = auth.uid());
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

-- Maintainers may delete any comment.
drop policy if exists "authors delete annotations" on public.annotations;
create policy "authors delete annotations" on public.annotations
  for delete to authenticated
  using (public.review_is_authorized() and (author_id = auth.uid() or public.review_role() = 'maintainer'));

-- ----------------------------------------------------------------------------
-- Events for annotations (trigger-written)
-- ----------------------------------------------------------------------------
create or replace function public.annotations_log_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
    values (new.id, public.review_actor(), auth.uid(), 'created', null);
    return new;
  end if;
  if new.status is distinct from old.status or new.resolution is distinct from old.resolution then
    insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
    values (new.id, public.review_actor(), auth.uid(),
      case when new.status = 'verified' then 'verified' when new.status = 'resolved' then 'resolved' else 'reopened' end,
      jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status), 'resolution', new.resolution));
  end if;
  if new.comment <> old.comment then
    insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
    values (new.id, public.review_actor(), auth.uid(), 'edited', jsonb_build_object('comment', jsonb_build_object('from', old.comment, 'to', new.comment)));
  end if;
  if new.type <> old.type or new.geometry <> old.geometry then
    insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
    values (new.id, public.review_actor(), auth.uid(), 'moved', jsonb_build_object(
      'type', jsonb_build_object('from', old.type, 'to', new.type),
      'selector', jsonb_build_object('from', old.target ->> 'selector', 'to', new.target ->> 'selector')));
  end if;
  if new.scope is distinct from old.scope then meta := meta || jsonb_build_object('scope', jsonb_build_object('from', old.scope, 'to', new.scope)); end if;
  if new.component is distinct from old.component then meta := meta || jsonb_build_object('component', jsonb_build_object('from', old.component, 'to', new.component)); end if;
  if new.category is distinct from old.category then meta := meta || jsonb_build_object('category', jsonb_build_object('from', old.category, 'to', new.category)); end if;
  if new.devices is distinct from old.devices then meta := meta || jsonb_build_object('devices', jsonb_build_object('from', to_jsonb(old.devices), 'to', to_jsonb(new.devices))); end if;
  if meta <> '{}'::jsonb then
    insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
    values (new.id, public.review_actor(), auth.uid(), 'metadata', meta);
  end if;
  return new;
end;
$$;
drop trigger if exists annotations_events on public.annotations;
create trigger annotations_events after insert or update on public.annotations
  for each row execute function public.annotations_log_event();

-- ----------------------------------------------------------------------------
-- Replies: edit your own; events
-- ----------------------------------------------------------------------------
drop policy if exists "authors edit replies" on public.annotation_replies;
create policy "authors edit replies" on public.annotation_replies
  for update to authenticated
  using (public.review_is_authorized() and author_id = auth.uid())
  with check (author_id = auth.uid());

create or replace function public.replies_guard_update()
returns trigger
language plpgsql
as $$
begin
  if auth.role() <> 'service_role' and old.author_id <> auth.uid() then
    raise exception 'only the author may edit a reply';
  end if;
  if new.annotation_id <> old.annotation_id or new.author_id <> old.author_id or new.created_at <> old.created_at then
    raise exception 'immutable reply fields';
  end if;
  if new.body <> old.body then new.edited_at = now(); end if;
  return new;
end;
$$;
drop trigger if exists replies_guard on public.annotation_replies;
create trigger replies_guard before update on public.annotation_replies
  for each row execute function public.replies_guard_update();

create or replace function public.replies_log_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op = 'INSERT' then
      insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
      values (new.annotation_id, public.review_actor(), auth.uid(), 'replied', jsonb_build_object('replyId', new.id));
    elsif tg_op = 'UPDATE' then
      if new.body <> old.body then
        insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
        values (new.annotation_id, public.review_actor(), auth.uid(), 'reply_edited', jsonb_build_object('replyId', new.id, 'body', jsonb_build_object('from', old.body, 'to', new.body)));
      end if;
    else
      insert into public.annotation_events (annotation_id, actor, actor_id, kind, changes)
      values (old.annotation_id, public.review_actor(), auth.uid(), 'reply_deleted', jsonb_build_object('replyId', old.id, 'body', old.body));
    end if;
  exception when foreign_key_violation then
    null; -- the parent comment is being deleted; nothing to log
  end;
  return coalesce(new, old);
end;
$$;
drop trigger if exists replies_events on public.annotation_replies;
create trigger replies_events after insert or update or delete on public.annotation_replies
  for each row execute function public.replies_log_event();

-- ----------------------------------------------------------------------------
-- Screenshots: re-anchoring replaces the screenshot, which needs update rights
-- ----------------------------------------------------------------------------
drop policy if exists "reviewers update screenshots" on storage.objects;
create policy "reviewers update screenshots" on storage.objects
  for update to authenticated
  using (bucket_id = 'review-screenshots' and public.review_is_authorized())
  with check (bucket_id = 'review-screenshots' and public.review_is_authorized());

-- ----------------------------------------------------------------------------
-- AI change requests may only start from verified comments
-- ----------------------------------------------------------------------------
drop policy if exists "reviewers create change requests" on public.change_requests;
create policy "reviewers create change requests" on public.change_requests
  for insert to authenticated
  with check (
    public.review_is_authorized()
    and requested_by_id = auth.uid()
    and exists (select 1 from public.annotations a where a.id = annotation_id and a.status = 'verified')
  );

-- ----------------------------------------------------------------------------
-- Realtime: events arrive with the comment they belong to
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'annotation_events') then
    alter publication supabase_realtime add table public.annotation_events;
  end if;
end $$;

-- To make someone a maintainer:
--   update public.review_access set role = 'maintainer' where kind = 'email' and value = 'you@example.org';
-- (or set ALLOWED_MAINTAINERS in .env and run `npm run allowlist`)
