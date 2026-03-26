-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 002_post_call_webhook_ingestion.sql
-- 3) 003_menu_stock_and_tool_support.sql
-- 4) 004_place_voice_order_atomic.sql
-- 5) 005_order_contact_and_short_code.sql
--
-- Converts the short 3-digit number into a live order ID:
-- - only pending orders keep a 3-digit ID
-- - closed orders release that ID immediately
-- - the next pending order gets the lowest free ID between 001 and 999
-- - the UUID order_id remains the permanent internal identifier

update public.restaurant_orders
set status = case when status = 'closed' then 'closed' else 'pending' end
where status is distinct from case when status = 'closed' then 'closed' else 'pending' end;

update public.restaurant_orders
set short_order_code = null,
    order_code_date = null
where short_order_code is not null
   or order_code_date is not null;

do $$
begin
  if exists (
    select 1
    from public.restaurant_orders
    where status = 'pending'
    group by restaurant_id
    having count(*) > 999
  ) then
    raise exception 'Some restaurants already have more than 999 pending orders. Close or archive some orders, then rerun this migration.';
  end if;
end
$$;

with ranked_pending_orders as (
  select
    ro.id,
    row_number() over (
      partition by ro.restaurant_id
      order by ro.created_at asc, ro.id asc
    ) as sequence_number
  from public.restaurant_orders ro
  where ro.status = 'pending'
)
update public.restaurant_orders ro
set short_order_code = ranked_pending_orders.sequence_number,
    order_code_date = timezone('UTC', coalesce(ro.updated_at, ro.created_at, now()))::date
from ranked_pending_orders
where ro.id = ranked_pending_orders.id;

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

  if new.short_order_code is not null and (new.short_order_code < 1 or new.short_order_code > 999) then
    raise exception 'short_order_code must be between 1 and 999';
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
    new.order_code_date := coalesce(old.order_code_date, timezone('UTC', coalesce(new.updated_at, new.created_at, now()))::date);
    return new;
  end if;

  if new.short_order_code is not null then
    if exists (
      select 1
      from public.restaurant_orders ro
      where ro.restaurant_id = new.restaurant_id
        and ro.status = 'pending'
        and ro.short_order_code = new.short_order_code
        and (v_current_order_id is null or ro.id <> v_current_order_id)
    ) then
      raise exception 'short_order_code % is already in use for an active order', new.short_order_code;
    end if;

    new.order_code_date := timezone('UTC', coalesce(new.updated_at, new.created_at, now()))::date;
    return new;
  end if;

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

create unique index if not exists idx_restaurant_orders_active_short_code
  on public.restaurant_orders (restaurant_id, short_order_code)
  where status = 'pending' and short_order_code is not null;
