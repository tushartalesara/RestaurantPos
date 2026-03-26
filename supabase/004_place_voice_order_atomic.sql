-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 002_post_call_webhook_ingestion.sql
-- 3) 003_menu_stock_and_tool_support.sql
--
-- Adds an atomic order placement RPC for voice tools:
-- - validates item availability
-- - validates requested quantity
-- - decrements stock in one transaction
-- - writes order + order items

create or replace function public.place_voice_order_atomic(
  p_restaurant_id uuid,
  p_customer_name text default null,
  p_notes text default null,
  p_status text default 'pending',
  p_items jsonb default '[]'::jsonb
)
returns table(order_id uuid, total_price numeric, item_count integer)
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
  v_total numeric(12, 2) := 0;
  v_item_count integer := 0;
begin
  if p_restaurant_id is null then
    raise exception 'p_restaurant_id is required';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'p_items must be a non-empty JSON array';
  end if;

  if p_status is null or p_status not in ('pending', 'closed') then
    p_status := 'pending';
  end if;

  -- Validate + lock + decrement stock in a single pass.
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
    for update;

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
    status,
    notes,
    total_price
  )
  values (
    p_restaurant_id,
    coalesce(nullif(trim(coalesce(p_customer_name, '')), ''), 'Voice Caller'),
    p_status,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_total
  )
  returning id into v_order_id;

  -- Insert order line items using resolved/validated values.
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

  return query select v_order_id, v_total, v_item_count;
end;
$$;

revoke all on function public.place_voice_order_atomic(uuid, text, text, text, jsonb) from public;
grant execute on function public.place_voice_order_atomic(uuid, text, text, text, jsonb) to service_role;
