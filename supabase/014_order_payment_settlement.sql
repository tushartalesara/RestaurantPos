-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 005_order_contact_and_short_code.sql
-- 3) 006_active_pending_order_ids.sql
-- 4) 013_order_fulfillment_and_delivery_fields.sql
--
-- Adds:
-- - payment settlement state for orders
-- - paid/unpaid tracking separated from pickup/COD collection mode
-- - optional card transaction reference storage

alter table public.restaurant_orders
  add column if not exists payment_status text,
  add column if not exists payment_method text,
  add column if not exists card_transaction_id text,
  add column if not exists payment_updated_at timestamptz;

update public.restaurant_orders
set payment_status = 'unpaid'
where payment_status is null
  or lower(coalesce(payment_status, '')) not in ('unpaid', 'paid');

alter table public.restaurant_orders
  alter column payment_status set default 'unpaid',
  alter column payment_status set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurant_orders_payment_status_check'
  ) then
    alter table public.restaurant_orders
      add constraint restaurant_orders_payment_status_check
      check (payment_status in ('unpaid', 'paid'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurant_orders_payment_method_check'
  ) then
    alter table public.restaurant_orders
      add constraint restaurant_orders_payment_method_check
      check (payment_method is null or payment_method in ('cash', 'card'));
  end if;
end $$;

update public.restaurant_orders
set
  payment_method = null,
  card_transaction_id = null,
  payment_updated_at = null
where payment_status = 'unpaid';

create index if not exists idx_restaurant_orders_payment_status
  on public.restaurant_orders(restaurant_id, payment_status, status);

select pg_notify('pgrst', 'reload schema');
