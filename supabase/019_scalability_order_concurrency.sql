-- Scalability hardening for high-concurrency ordering.
-- Adds optimistic concurrency to menu item stock updates so concurrent callers
-- fail fast with a retryable conflict instead of blocking on row locks.

alter table public.menu_items
  add column if not exists version integer not null default 1;

update public.menu_items
set version = 1
where version is null or version < 1;

create or replace function public.place_voice_order_atomic(
  p_restaurant_id uuid,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_notes text default null,
  p_status text default 'pending',
  p_items jsonb default '[]'::jsonb,
  p_fulfillment_type text default 'pickup',
  p_delivery_postcode text default null,
  p_delivery_address text default null,
  p_payment_collection text default null
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
  v_expected_version integer;
  v_final_name text;
  v_final_price numeric(12, 2);
  v_order_id uuid;
  v_short_order_code integer;
  v_subtotal numeric(12, 2) := 0;
  v_item_count integer := 0;
  v_tax_amount numeric(12, 2) := 0;
  v_tax_rate_percent numeric(5, 2) := 0;
  v_tax_inclusive boolean := false;
  v_tax_label text := 'VAT';
  v_service_fee_amount numeric(12, 2) := 0;
  v_service_fee_label text := 'Service Charge';
  v_tip_amount numeric(12, 2) := 0;
  v_tip_label text := 'Gratuity';
  v_currency_code text := 'GBP';
  v_total_price numeric(12, 2) := 0;
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

  if p_fulfillment_type is null or p_fulfillment_type not in ('pickup', 'delivery') then
    p_fulfillment_type := 'pickup';
  end if;

  if p_fulfillment_type = 'delivery' then
    p_delivery_postcode := upper(regexp_replace(trim(coalesce(p_delivery_postcode, '')), '\s+', '', 'g'));
    if length(coalesce(p_delivery_postcode, '')) > 3 then
      p_delivery_postcode := left(p_delivery_postcode, length(p_delivery_postcode) - 3) || ' ' || right(p_delivery_postcode, 3);
    end if;
    p_delivery_postcode := nullif(trim(coalesce(p_delivery_postcode, '')), '');
    p_delivery_address := nullif(trim(coalesce(p_delivery_address, '')), '');
    if p_delivery_postcode is null then
      raise exception 'p_delivery_postcode is required for delivery orders';
    end if;
    if p_delivery_address is null then
      raise exception 'p_delivery_address is required for delivery orders';
    end if;
    p_payment_collection := 'cod';
  else
    p_delivery_postcode := null;
    p_delivery_address := null;
    p_payment_collection := 'unpaid';
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
      mi.is_available,
      mi.version
    into
      v_name,
      v_unit_price,
      v_stock,
      v_available,
      v_expected_version
    from public.menu_items mi
    where mi.id = v_item_id
      and mi.restaurant_id = p_restaurant_id;

    if not found then
      raise exception 'Item % not found for this restaurant', v_item_id;
    end if;

    if not coalesce(v_available, false) then
      raise exception 'Item % is currently unavailable', v_name
        using errcode = 'P0002';
    end if;

    if coalesce(v_stock, 0) < v_qty then
      raise exception 'Insufficient stock for % (requested %, available %)', v_name, v_qty, coalesce(v_stock, 0)
        using errcode = 'P0002';
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
    set
      stock_quantity = stock_quantity - v_qty,
      version = version + 1
    where id = v_item_id
      and restaurant_id = p_restaurant_id
      and version = v_expected_version
      and stock_quantity >= v_qty;

    if not found then
      raise exception 'Stock conflict on item %. Please retry.', v_name
        using errcode = 'P0001';
    end if;

    v_resolved_item := jsonb_build_object(
      'item_id', v_item_id,
      'name', v_final_name,
      'quantity', v_qty,
      'unit_price', v_final_price
    );
    v_resolved_items := v_resolved_items || jsonb_build_array(v_resolved_item);

    v_subtotal := v_subtotal + (v_final_price * v_qty);
    v_item_count := v_item_count + 1;
  end loop;

  select
    calc.tax_amount,
    calc.tax_rate_percent,
    calc.tax_inclusive,
    calc.tax_label,
    calc.service_fee_amount,
    calc.service_fee_label,
    calc.tip_amount,
    calc.tip_label,
    calc.currency_code,
    calc.total_price
  into
    v_tax_amount,
    v_tax_rate_percent,
    v_tax_inclusive,
    v_tax_label,
    v_service_fee_amount,
    v_service_fee_label,
    v_tip_amount,
    v_tip_label,
    v_currency_code,
    v_total_price
  from public.calculate_order_billing(p_restaurant_id, v_subtotal, 0) calc;

  insert into public.restaurant_orders (
    restaurant_id,
    customer_name,
    customer_phone,
    fulfillment_type,
    delivery_postcode,
    delivery_address,
    payment_collection,
    status,
    notes,
    subtotal_amount,
    tax_amount,
    tax_rate_percent,
    tax_inclusive,
    tax_label,
    service_fee_amount,
    service_fee_label,
    tip_amount,
    tip_label,
    currency_code,
    total_price
  )
  values (
    p_restaurant_id,
    nullif(trim(coalesce(p_customer_name, '')), ''),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    p_fulfillment_type,
    p_delivery_postcode,
    p_delivery_address,
    p_payment_collection,
    p_status,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_subtotal,
    v_tax_amount,
    v_tax_rate_percent,
    v_tax_inclusive,
    v_tax_label,
    v_service_fee_amount,
    v_service_fee_label,
    v_tip_amount,
    v_tip_label,
    v_currency_code,
    v_total_price
  )
  returning public.restaurant_orders.id, public.restaurant_orders.short_order_code
  into v_order_id, v_short_order_code;

  for v_item in
    select value from jsonb_array_elements(v_resolved_items)
  loop
    v_item_id := nullif(trim(coalesce(v_item->>'item_id', '')), '')::uuid;
    v_final_name := coalesce(nullif(trim(coalesce(v_item->>'name', '')), ''), 'Menu Item');
    v_qty := greatest(1, coalesce((v_item->>'quantity')::integer, 1));
    v_final_price := coalesce((v_item->>'unit_price')::numeric, 0);

    insert into public.restaurant_order_items (
      order_id,
      menu_item_id,
      name,
      quantity,
      unit_price
    )
    values (
      v_order_id,
      v_item_id,
      v_final_name,
      v_qty,
      v_final_price
    );
  end loop;

  return query select v_order_id, v_short_order_code, v_total_price, v_item_count;
end;
$$;

revoke all on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb, text, text, text, text) from public;
grant execute on function public.place_voice_order_atomic(uuid, text, text, text, text, jsonb, text, text, text, text) to service_role;

create or replace function public.save_manual_order_atomic(
  p_restaurant_id uuid,
  p_order_id uuid default null,
  p_customer_name text default null,
  p_customer_phone text default null,
  p_notes text default null,
  p_status text default 'pending',
  p_items jsonb default '[]'::jsonb,
  p_fulfillment_type text default 'pickup',
  p_delivery_postcode text default null,
  p_delivery_address text default null,
  p_payment_collection text default null
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
  v_expected_version integer;
  v_final_name text;
  v_final_price numeric(12, 2);
  v_existing_order_id uuid;
  v_short_order_code integer;
  v_subtotal numeric(12, 2) := 0;
  v_item_count integer := 0;
  v_old_qty integer;
  v_new_qty integer;
  v_delta integer;
  v_existing_tip_amount numeric(12, 2) := 0;
  v_existing_tip_label text := null;
  v_tax_amount numeric(12, 2) := 0;
  v_tax_rate_percent numeric(5, 2) := 0;
  v_tax_inclusive boolean := false;
  v_tax_label text := 'VAT';
  v_service_fee_amount numeric(12, 2) := 0;
  v_service_fee_label text := 'Service Charge';
  v_tip_amount numeric(12, 2) := 0;
  v_tip_label text := 'Gratuity';
  v_currency_code text := 'GBP';
  v_total_price numeric(12, 2) := 0;
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

  if p_fulfillment_type is null or p_fulfillment_type not in ('pickup', 'delivery') then
    p_fulfillment_type := 'pickup';
  end if;

  if p_fulfillment_type = 'delivery' then
    p_delivery_postcode := upper(regexp_replace(trim(coalesce(p_delivery_postcode, '')), '\s+', '', 'g'));
    if length(coalesce(p_delivery_postcode, '')) > 3 then
      p_delivery_postcode := left(p_delivery_postcode, length(p_delivery_postcode) - 3) || ' ' || right(p_delivery_postcode, 3);
    end if;
    p_delivery_postcode := nullif(trim(coalesce(p_delivery_postcode, '')), '');
    p_delivery_address := nullif(trim(coalesce(p_delivery_address, '')), '');
    if p_delivery_postcode is null then
      raise exception 'p_delivery_postcode is required for delivery orders';
    end if;
    if p_delivery_address is null then
      raise exception 'p_delivery_address is required for delivery orders';
    end if;
    p_payment_collection := 'cod';
  else
    p_delivery_postcode := null;
    p_delivery_address := null;
    p_payment_collection := 'unpaid';
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
      raise exception 'Item % is currently unavailable', v_name
        using errcode = 'P0002';
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
    select
      ro.id,
      ro.short_order_code,
      coalesce(ro.tip_amount, 0),
      ro.tip_label
    into
      v_existing_order_id,
      v_short_order_code,
      v_existing_tip_amount,
      v_existing_tip_label
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
      mi.is_available,
      mi.version
    into
      v_name,
      v_stock,
      v_available,
      v_expected_version
    from public.menu_items mi
    where mi.id = v_item_id
      and mi.restaurant_id = p_restaurant_id;

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
        raise exception 'Item % is currently unavailable', v_name
          using errcode = 'P0002';
      end if;

      if coalesce(v_stock, 0) < v_delta then
        raise exception 'Insufficient stock for % (requested %, available %)', v_name, v_delta, coalesce(v_stock, 0)
          using errcode = 'P0002';
      end if;
    end if;

    if v_delta <> 0 then
      update public.menu_items
      set
        stock_quantity = stock_quantity - v_delta,
        version = version + 1
      where id = v_item_id
        and restaurant_id = p_restaurant_id
        and version = v_expected_version
        and (v_delta <= 0 or stock_quantity >= v_delta);

      if not found then
        raise exception 'Stock conflict on item %. Please retry.', v_name
          using errcode = 'P0001';
      end if;
    end if;
  end loop;

  select
    coalesce(sum(quantity * unit_price), 0)::numeric(12, 2),
    count(*)::integer
  into
    v_subtotal,
    v_item_count
  from pg_temp.manual_order_rows;

  select
    calc.tax_amount,
    calc.tax_rate_percent,
    calc.tax_inclusive,
    calc.tax_label,
    calc.service_fee_amount,
    calc.service_fee_label,
    calc.tip_amount,
    calc.tip_label,
    calc.currency_code,
    calc.total_price
  into
    v_tax_amount,
    v_tax_rate_percent,
    v_tax_inclusive,
    v_tax_label,
    v_service_fee_amount,
    v_service_fee_label,
    v_tip_amount,
    v_tip_label,
    v_currency_code,
    v_total_price
  from public.calculate_order_billing(p_restaurant_id, v_subtotal, v_existing_tip_amount) calc;

  v_tip_label := coalesce(nullif(trim(coalesce(v_existing_tip_label, '')), ''), v_tip_label);

  if p_order_id is null then
    insert into public.restaurant_orders (
      restaurant_id,
      customer_name,
      customer_phone,
      fulfillment_type,
      delivery_postcode,
      delivery_address,
      payment_collection,
      status,
      notes,
      subtotal_amount,
      tax_amount,
      tax_rate_percent,
      tax_inclusive,
      tax_label,
      service_fee_amount,
      service_fee_label,
      tip_amount,
      tip_label,
      currency_code,
      total_price
    )
    values (
      p_restaurant_id,
      nullif(trim(coalesce(p_customer_name, '')), ''),
      nullif(trim(coalesce(p_customer_phone, '')), ''),
      p_fulfillment_type,
      p_delivery_postcode,
      p_delivery_address,
      p_payment_collection,
      p_status,
      nullif(trim(coalesce(p_notes, '')), ''),
      v_subtotal,
      v_tax_amount,
      v_tax_rate_percent,
      v_tax_inclusive,
      v_tax_label,
      v_service_fee_amount,
      v_service_fee_label,
      v_tip_amount,
      v_tip_label,
      v_currency_code,
      v_total_price
    )
    returning public.restaurant_orders.id, public.restaurant_orders.short_order_code
    into v_existing_order_id, v_short_order_code;
  else
    update public.restaurant_orders
    set
      customer_name = nullif(trim(coalesce(p_customer_name, '')), ''),
      customer_phone = nullif(trim(coalesce(p_customer_phone, '')), ''),
      fulfillment_type = p_fulfillment_type,
      delivery_postcode = p_delivery_postcode,
      delivery_address = p_delivery_address,
      payment_collection = p_payment_collection,
      status = p_status,
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      subtotal_amount = v_subtotal,
      tax_amount = v_tax_amount,
      tax_rate_percent = v_tax_rate_percent,
      tax_inclusive = v_tax_inclusive,
      tax_label = v_tax_label,
      service_fee_amount = v_service_fee_amount,
      service_fee_label = v_service_fee_label,
      tip_amount = v_tip_amount,
      tip_label = v_tip_label,
      currency_code = v_currency_code,
      total_price = v_total_price,
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
    v_total_price,
    v_item_count;
end;
$$;

revoke all on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb, text, text, text, text) from public;
grant execute on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb, text, text, text, text) to authenticated;
grant execute on function public.save_manual_order_atomic(uuid, uuid, text, text, text, text, jsonb, text, text, text, text) to service_role;

select pg_notify('pgrst', 'reload schema');
