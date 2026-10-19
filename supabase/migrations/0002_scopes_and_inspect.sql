-- ============================================================================
-- 0002: comment scope, category and the Inspect tool's "element" type
--
-- scope      page      -> about this page only (default, previous behaviour)
--            component -> about a shared block (header, footer, nav ...) that
--                         appears on every page; listed on every page
--            site      -> about a site-wide rule (typography, colour ...)
-- component  the shared block's name (data-component attribute or landmark)
-- category   what the comment is about; informs humans and the AI pipeline
-- ============================================================================

alter table public.annotations
  add column if not exists scope text not null default 'page',
  add column if not exists component text,
  add column if not exists category text;

alter table public.annotations drop constraint if exists annotations_scope_check;
alter table public.annotations add constraint annotations_scope_check
  check (scope in ('page', 'component', 'site'));

alter table public.annotations drop constraint if exists annotations_category_check;
alter table public.annotations add constraint annotations_category_check
  check (category is null or category in ('content', 'navigation', 'layout', 'typography', 'color', 'imagery', 'other'));

-- The Inspect tool anchors a comment to an element rather than a drawn shape.
alter table public.annotations drop constraint if exists annotations_type_check;
alter table public.annotations add constraint annotations_type_check
  check (type in ('pin', 'element', 'rectangle', 'circle', 'draw'));

create index if not exists annotations_shared_idx on public.annotations (scope, created_at) where scope <> 'page';

comment on column public.annotations.scope is 'page | component | site. Non-page comments are listed on every page.';
comment on column public.annotations.component is 'Shared block name when scope = component (e.g. site-header, site-footer, primary-nav).';
comment on column public.annotations.category is 'content | navigation | layout | typography | color | imagery | other';

-- Only the author may change scope/component/category (same rule as the comment text).
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
       or new.screenshot_path is distinct from old.screenshot_path
       or new.scope is distinct from old.scope
       or new.component is distinct from old.component
       or new.category is distinct from old.category then
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
