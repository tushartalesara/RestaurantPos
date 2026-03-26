-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 002_post_call_webhook_ingestion.sql
-- 3) 003_menu_stock_and_tool_support.sql
-- 4) 004_place_voice_order_atomic.sql
--
-- Adds:
-- - customer phone storage on restaurant_orders
-- - a waiter-friendly 3-digit order code
-- - per-restaurant, per-day uniqueness for that code
-- - an updated place_voice_order_atomic RPC that stores phone + returns the short code

alter table public.restaurant_orders
  add column if not exists customer_phone text,
  add column if not exists short_order_code integer,
  add column if not exists order_code_date date;

create table if not exists public.restaurant_order_code_counters (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  order_code_date date not null,
  last_value integer not null default 0 check (last_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, order_code_date)
);

drop trigger if exists trg_restaurant_order_code_counters_updated_at on public.restaurant_order_code_counters;
create trigger trg_restaurant_order_code_counters_updated_at
before update on public.restaurant_order_code_counters
for each row execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurant_orders_short_order_code_range'
  ) then
    alter table public.restaurant_orders
      add constraint restaurant_orders_short_order_code_range
      check (short_order_code is null or (short_order_code between 1 and 999));
  end if;
end
$$;

create or replace function public.assign_restaurant_order_short_code()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_code_date date;
  v_next_value integer;
begin
  if new.restaurant_id is null then
    raise exception 'restaurant_id is required before assigning an order code';
  end if;

  v_order_code_date := coalesce(new.order_code_date, timezone('UTC', coalesce(new.created_at, now()))::date);
  new.order_code_date := v_order_code_date;

  if new.short_order_code is not null then
    if new.short_order_code < 1 or new.short_order_code > 999 then
      raise exception 'short_order_code must be between 1 and 999';
    end if;
    return new;
  end if;

  insert into public.restaurant_order_code_counters (
    restaurant_id,
    order_code_date,
    last_value
  )
  values (
    new.restaurant_id,
    v_order_code_date,
    1
  )
  on conflict (restaurant_id, order_code_date)
  do update set
    last_value = public.restaurant_order_code_counters.last_value + 1,
    updated_at = now()
  returning last_value into v_next_value;

  if v_next_value > 999 then
    raise exception 'Daily 3-digit order code limit reached for restaurant % on %', new.restaurant_id, v_order_code_date;
  end if;

  new.short_order_code := v_next_value;
  return new;
end;
$$;

drop trigger if exists trg_assign_restaurant_order_short_code on public.restaurant_orders;
create trigger trg_assign_restaurant_order_short_code
before insert on public.restaurant_orders
for each row execute function public.assign_restaurant_order_short_code();

update public.restaurant_orders
set order_code_date = coalesce(order_code_date, timezone('UTC', created_at)::date)
where order_code_date is null;

with ranked_orders as (
  select
    ro.id,
    row_number() over (
      partition by ro.restaurant_id, ro.order_code_date
      order by ro.created_at asc, ro.id asc
    ) as sequence_number
  from public.restaurant_orders ro
  where ro.short_order_code is null
)
update public.restaurant_orders ro
set short_order_code = ranked_orders.sequence_number
from ranked_orders
where ro.id = ranked_orders.id
  and ranked_orders.sequence_number <= 999;

do $$
begin
  if exists (
    select 1
    from public.restaurant_orders
    where short_order_code is null
  ) then
    raise exception 'Some existing restaurant orders exceed the 3-digit code limit for one restaurant/day. Archive or split those orders, then rerun this migration.';
  end if;
end
$$;

create unique index if not exists idx_restaurant_orders_restaurant_day_short_code
  on public.restaurant_orders(restaurant_id, order_code_date, short_order_code);

insert into public.restaurant_order_code_counters (
  restaurant_id,
  order_code_date,
  last_value
)
select
  restaurant_id,
  order_code_date,
  max(short_order_code) as last_value
from public.restaurant_orders
where order_code_date is not null
  and short_order_code is not null
group by restaurant_id, order_code_date
on conflict (restaurant_id, order_code_date)
do update set
  last_value = greatest(public.restaurant_order_code_counters.last_value, excluded.last_value),
  updated_at = now();

drop function if exists public.place_voice_order_atomic(uuid, text, text, text, jsonb);
drop function if exists public.place_voice_order_atomic(uuid, text, text, text, text, jsonb);

create function public.place_voice_order_atomic(
  p_restaurant_id uuid,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_notes text default null,
  p_status text default 'pending',
  p_items jsonb default '[]'::jsonb
)
returns table(order_id uuid, short_order_code integer, total_price numeric, item_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_resolved_item jsonb;
  v_resolved_items jsonb := '[]'::jsonb;
  v_item_id uuid;
  v_qty integer;
  v_name text;
  v_unit_price numeric(12, 2);
  v_stock integer;
  v_available boolean;
  v_final_name text;
  v_final_price numeric(12, 2);
  v_order_id uuid;
  v_short_order_code integer;
  v_total numeric(12, 2) := 0;
  v_item_count integer := 0;
begin
  perform set_config('lock_timeout', '3s', true);
  perform set_config('statement_timeout', '15s', true);

  if p_restaurant_id is null then
    raise exception 'p_restaurant_id is required';
  end if;

  if nullif(trim(coalesce(p_customer_name, '')), '') is null then
    raise exception 'p_customer_name is required';
  end if;

  if nullif(trim(coalesce(p_customer_phone, '')), '') is null then
    raise exception 'p_customer_phone is required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty JSON array';
  end if;

  if p_status is null or p_status not in ('pending', 'closed') then
    p_status := 'pending';
  end if;

  for v_item in
    select value from jsonb_array_elements(p_items)
  loop
    v_item_id := nullif(trim(coalesce(v_item->>'item_id', '')), '')::uuid;
    if v_item_id is null then
      raise exception 'Each item must include item_id';
    end if;

    v_qty := greatest(
      1,
      coalesce(
        case
          when trim(coalesce(v_item->>'quantity', '')) ~ '^-?\d+$' then (v_item->>'quantity')::integer
          else null
        end,
        1
      )
    );

    select
      mi.name,
      mi.base_price,
      mi.stock_quantity,
      mi.is_available
    into
      v_name,
      v_unit_price,
      v_stock,
      v_available
    from public.menu_items mi
    where mi.id = v_item_id
      and mi.restaurant_id = p_restaurant_id
    for update nowait;

    if not found then
      raise exception 'Item % not found for this restaurant', v_item_id;
    end if;

    if not coalesce(v_available, false) then
      raise exception 'Item % is currently unavailable', v_name;
    end if;

    if coalesce(v_stock, 0) < v_qty then
      raise exception 'Insufficient stock for % (requested %, available %)', v_name, v_qty, coalesce(v_stock, 0);
    end if;

    v_final_name := coalesce(nullif(trim(coalesce(v_item->>'name', '')), ''), v_name);
    v_final_price := coalesce(
      case
        when trim(coalesce(v_item->>'unit_price', '')) ~ '^-?\d+(\.\d+)?$' then (v_item->>'unit_price')::numeric
        else null
      end,
      v_unit_price,
      0
    );

    update public.menu_items
    set stock_quantity = stock_quantity - v_qty
    where id = v_item_id
      and restaurant_id = p_restaurant_id;

    v_resolved_item := jsonb_build_object(
      'item_id', v_item_id,
      'name', v_final_name,
      'quantity', v_qty,
      'unit_price', v_final_price
    );
    v_resolved_items := v_resolved_items || jsonb_build_array(v_resolved_item);

    v_total := v_total + (v_final_price * v_qty);
    v_item_count := v_item_count + 1;
  end loop;

  insert into public.restaurant_orders (
    restaurant_id,
    customer_name,
    customer_phone,
    status,
    notes,
    total_price
  )
  values (
    p_restaurant_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    p_status,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_total
  )
  returning public.restaurant_orders.id, public.restaurant_orders.short_order_code
  into v_order_id, v_short_order_code;

  for v_item in
    select value from jsonb_array_elements(v_resolved_items)
  loop
    v_final_name := coalesce(nullif(trim(coalesce(v_item->>'name', '')), ''), 'Menu Item');
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 1));
    v_final_price := coalesce((v_item->>'unit_price')::numeric, 0);

    insert into public.restaurant_order_items (
      order_id,
      name,
      quantity,
      unit_price
    )
    values (
      v_order_id,
      v_final_name,
      v_qty,
      v_final_price
    );
  end loop;

  return query select v_order_id, v_short_order_code, v_total, v_item_count;
end;
$$;

revoke all on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb) from public;
grant execute on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb) to service_role;

revoke all on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb) from public;
grant execute on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb) to service_role;
