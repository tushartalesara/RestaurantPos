-- Run this after:
-- 1) 006_active_pending_order_ids.sql
-- 2) 009_fast_fail_order_locks.sql
-- 3) 013_order_fulfillment_and_delivery_fields.sql
--
-- Purpose:
-- - remove any leftover legacy daily short-code trigger/index
-- - make active 3-digit order codes always choose the next free pending code
-- - avoid collisions when an old trigger pre-fills short_order_code on insert

drop trigger if exists trg_assign_restaurant_order_short_code on public.restaurant_orders;
drop trigger if exists trg_sync_active_restaurant_order_short_code on public.restaurant_orders;

drop index if exists idx_restaurant_orders_restaurant_day_short_code;
drop index if exists idx_restaurant_orders_active_short_code;

create or replace function public.sync_active_restaurant_order_short_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assigned_code integer;
  v_current_order_id uuid;
begin
  if new.restaurant_id is null then
    raise exception 'restaurant_id is required before assigning an order ID';
  end if;

  if new.status is null or new.status not in ('pending', 'closed') then
    new.status := 'pending';
  end if;

  if new.status <> 'pending' then
    new.short_order_code := null;
    new.order_code_date := null;
    return new;
  end if;

  if not pg_try_advisory_xact_lock(hashtext(new.restaurant_id::text), 1) then
    raise exception 'Another pending order is currently being finalized for this restaurant. Please retry in a few seconds.';
  end if;

  if tg_op = 'UPDATE' then
    v_current_order_id := old.id;
  else
    v_current_order_id := null;
  end if;

  if tg_op = 'UPDATE'
    and coalesce(old.status, 'pending') = 'pending'
    and old.restaurant_id = new.restaurant_id
    and old.short_order_code is not null
    and (new.short_order_code is null or new.short_order_code = old.short_order_code) then
    new.short_order_code := old.short_order_code;
    new.order_code_date := coalesce(
      old.order_code_date,
      timezone('UTC', coalesce(new.updated_at, new.created_at, now()))::date
    );
    return new;
  end if;

  -- Ignore any pre-filled short_order_code from legacy triggers or client inserts
  -- and always choose the next free active code for new pending orders.
  new.short_order_code := null;

  select candidate
  into v_assigned_code
  from generate_series(1, 999) candidate
  where not exists (
    select 1
    from public.restaurant_orders ro
    where ro.restaurant_id = new.restaurant_id
      and ro.status = 'pending'
      and ro.short_order_code = candidate
      and (v_current_order_id is null or ro.id <> v_current_order_id)
  )
  order by candidate
  limit 1;

  if v_assigned_code is null then
    raise exception 'All 999 active order IDs are currently in use for restaurant %', new.restaurant_id;
  end if;

  new.short_order_code := v_assigned_code;
  new.order_code_date := timezone('UTC', coalesce(new.updated_at, new.created_at, now()))::date;
  return new;
end;
$$;

create trigger trg_sync_active_restaurant_order_short_code
before insert or update of status, restaurant_id, short_order_code
on public.restaurant_orders
for each row execute function public.sync_active_restaurant_order_short_code();

create unique index idx_restaurant_orders_active_short_code
  on public.restaurant_orders (restaurant_id, short_order_code)
  where status = 'pending' and short_order_code is not null;

select pg_notify('pgrst', 'reload schema');
