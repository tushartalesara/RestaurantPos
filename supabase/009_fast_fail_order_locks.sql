-- Run this after:
-- 1) 006_active_pending_order_ids.sql
-- 2) 008_repair_place_voice_order_atomic.sql
--
-- Purpose:
-- Prevent order placement from hanging until the external tool times out.
-- Instead, fail fast when another order is currently holding the restaurant
-- lock or a menu item stock row lock.

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

create or replace function public.place_voice_order_atomic(
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

select pg_notify('pgrst', 'reload schema');
