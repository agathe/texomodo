-- ============================================================================
-- 0003: which screen sizes a comment applies to
--
-- devices  text[]  breakpoint names ('phone', 'tablet', 'desktop') the comment
--                  applies to. Empty array = all sizes. Defaults are inferred
--                  by the overlay from where the element is visible.
-- The viewport JSON column already records width/height/dpr; the overlay now
-- also stores breakpoint, preset (device frame), userAgent and touch there.
-- ============================================================================

alter table public.annotations
  add column if not exists devices text[] not null default '{}'::text[];

comment on column public.annotations.devices is
  'Breakpoint names the comment applies to (phone/tablet/desktop). Empty = all sizes.';

-- Only the author may change which sizes a comment applies to.
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
       or new.category is distinct from old.category
       or new.devices is distinct from old.devices then
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
