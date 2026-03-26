-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 003_menu_stock_and_tool_support.sql
--
-- Adds explicit menu ordering so the app and voice tools can preserve
-- the same category and item sequence as the original menu.

alter table public.menu_items
  add column if not exists sort_order integer;

with ordered_menu_items as (
  select
    mi.id,
    row_number() over (
      partition by mi.restaurant_id
      order by mi.created_at asc, mi.id asc
    ) - 1 as sequence_number
  from public.menu_items mi
)
update public.menu_items mi
set sort_order = ordered_menu_items.sequence_number
from ordered_menu_items
where mi.id = ordered_menu_items.id
  and mi.sort_order is null;

update public.menu_items
set sort_order = 0
where sort_order is null;

alter table public.menu_items
  alter column sort_order set default 0;

alter table public.menu_items
  alter column sort_order set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'menu_items_sort_order_non_negative'
  ) then
    alter table public.menu_items
      add constraint menu_items_sort_order_non_negative
      check (sort_order >= 0);
  end if;
end
$$;

create index if not exists idx_menu_items_restaurant_sort_order
  on public.menu_items(restaurant_id, sort_order, created_at);
