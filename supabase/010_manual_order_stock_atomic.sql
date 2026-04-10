-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 003_menu_stock_and_tool_support.sql
-- 3) 005_order_contact_and_short_code.sql
-- 4) 006_active_pending_order_ids.sql
--
-- Adds:
-- - menu_item_id storage on restaurant_order_items
-- - an authenticated owner-safe RPC for manual POS orders
--   that checks and updates stock atomically on create/edit

alter table public.restaurant_order_items
  add column if not exists menu_item_id uuid references public.menu_items(id) on delete set null;

create index if not exists idx_restaurant_order_items_menu_item_id
  on public.restaurant_order_items(menu_item_id);

drop function if exists public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb);

create function public.save_manual_order_atomic(
  p_restaurant_id uuid,
  p_order_id uuid default null,
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
  v_user_id uuid := auth.uid();
  v_item jsonb;
  v_item_id uuid;
  v_qty integer;
  v_name text;
  v_unit_price numeric(12, 2);
  v_stock integer;
  v_available boolean;
  v_final_name text;
  v_final_price numeric(12, 2);
  v_existing_order_id uuid;
  v_short_order_code integer;
  v_total numeric(12, 2) := 0;
  v_item_count integer := 0;
  v_old_qty integer;
  v_new_qty integer;
  v_delta integer;
begin
  perform set_config('lock_timeout', '3s', true);
  perform set_config('statement_timeout', '15s', true);

  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_restaurant_id is null then
    raise exception 'p_restaurant_id is required';
  end if;

  if not exists (
    select 1
    from public.restaurants r
    where r.id = p_restaurant_id
      and r.owner_user_id = v_user_id
  ) then
    raise exception 'Restaurant not found or access denied';
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

  create temporary table if not exists pg_temp.manual_order_rows (
    menu_item_id uuid not null,
    name text not null,
    quantity integer not null,
    unit_price numeric(12, 2) not null
  ) on commit drop;

  create temporary table if not exists pg_temp.manual_order_old_totals (
    menu_item_id uuid primary key,
    quantity integer not null
  ) on commit drop;

  truncate table pg_temp.manual_order_rows;
  truncate table pg_temp.manual_order_old_totals;

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
      mi.is_available
    into
      v_name,
      v_unit_price,
      v_available
    from public.menu_items mi
    where mi.id = v_item_id
      and mi.restaurant_id = p_restaurant_id;

    if not found then
      raise exception 'Item % not found for this restaurant', v_item_id;
    end if;

    if not coalesce(v_available, false) then
      raise exception 'Item % is currently unavailable', v_name;
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

    insert into pg_temp.manual_order_rows (
      menu_item_id,
      name,
      quantity,
      unit_price
    )
    values (
      v_item_id,
      v_final_name,
      v_qty,
      v_final_price
    );
  end loop;

  if p_order_id is not null then
    select ro.id, ro.short_order_code
    into v_existing_order_id, v_short_order_code
    from public.restaurant_orders ro
    where ro.id = p_order_id
      and ro.restaurant_id = p_restaurant_id
    for update;

    if not found then
      raise exception 'Order % not found for this restaurant', p_order_id;
    end if;

    insert into pg_temp.manual_order_old_totals (menu_item_id, quantity)
    select
      roi.menu_item_id,
      sum(roi.quantity)::integer
    from public.restaurant_order_items roi
    where roi.order_id = p_order_id
      and roi.menu_item_id is not null
    group by roi.menu_item_id;
  end if;

  for v_item_id in
    select distinct affected.menu_item_id
    from (
      select menu_item_id from pg_temp.manual_order_rows
      union
      select menu_item_id from pg_temp.manual_order_old_totals
    ) affected
    where affected.menu_item_id is not null
  loop
    select
      mi.name,
      mi.stock_quantity,
      mi.is_available
    into
      v_name,
      v_stock,
      v_available
    from public.menu_items mi
    where mi.id = v_item_id
      and mi.restaurant_id = p_restaurant_id
    for update nowait;

    if not found then
      raise exception 'Item % not found for this restaurant', v_item_id;
    end if;

    select coalesce(sum(quantity), 0)::integer
    into v_new_qty
    from pg_temp.manual_order_rows
    where menu_item_id = v_item_id;

    select coalesce(sum(quantity), 0)::integer
    into v_old_qty
    from pg_temp.manual_order_old_totals
    where menu_item_id = v_item_id;

    v_delta := coalesce(v_new_qty, 0) - coalesce(v_old_qty, 0);

    if v_delta > 0 then
      if not coalesce(v_available, false) then
        raise exception 'Item % is currently unavailable', v_name;
      end if;

      if coalesce(v_stock, 0) < v_delta then
        raise exception 'Insufficient stock for % (requested %, available %)', v_name, v_delta, coalesce(v_stock, 0);
      end if;
    end if;

    update public.menu_items
    set stock_quantity = stock_quantity - v_delta
    where id = v_item_id
      and restaurant_id = p_restaurant_id;
  end loop;

  select
    coalesce(sum(quantity * unit_price), 0)::numeric(12, 2),
    count(*)::integer
  into
    v_total,
    v_item_count
  from pg_temp.manual_order_rows;

  if p_order_id is null then
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
    into v_existing_order_id, v_short_order_code;
  else
    update public.restaurant_orders
    set
      customer_name = nullif(trim(coalesce(p_customer_name, '')), ''),
      customer_phone = nullif(trim(coalesce(p_customer_phone, '')), ''),
      status = p_status,
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      total_price = v_total,
      updated_at = now()
    where id = p_order_id
      and restaurant_id = p_restaurant_id
    returning public.restaurant_orders.id, public.restaurant_orders.short_order_code
    into v_existing_order_id, v_short_order_code;

    delete from public.restaurant_order_items
    where order_id = p_order_id;
  end if;

  insert into public.restaurant_order_items (
    order_id,
    menu_item_id,
    name,
    quantity,
    unit_price
  )
  select
    v_existing_order_id,
    row.menu_item_id,
    row.name,
    row.quantity,
    row.unit_price
  from pg_temp.manual_order_rows row;

  return query
  select
    v_existing_order_id,
    v_short_order_code,
    v_total,
    v_item_count;
end;
$$;

revoke all on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb) from public;
grant execute on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb) to service_role;
