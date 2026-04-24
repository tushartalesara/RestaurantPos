-- Run this after:
-- 1) 016_restaurant_billing_fields.sql
--
-- Adds:
-- - stored billing breakdown on restaurant_orders
-- - backfills legacy orders so subtotal remains the original menu-price total

alter table public.restaurant_orders
  add column if not exists subtotal_amount numeric(10, 2),
  add column if not exists tax_amount numeric(10, 2),
  add column if not exists tax_rate_percent numeric(5, 2),
  add column if not exists tax_inclusive boolean,
  add column if not exists tax_label text,
  add column if not exists service_fee_amount numeric(10, 2),
  add column if not exists service_fee_label text,
  add column if not exists tip_amount numeric(10, 2),
  add column if not exists tip_label text,
  add column if not exists currency_code text;

update public.restaurant_orders o
set
  subtotal_amount = coalesce(o.subtotal_amount, o.total_price, 0),
  tax_amount = coalesce(o.tax_amount, 0),
  tax_rate_percent = coalesce(o.tax_rate_percent, 0),
  tax_inclusive = coalesce(o.tax_inclusive, false),
  tax_label = coalesce(nullif(trim(o.tax_label), ''), 'VAT'),
  service_fee_amount = coalesce(o.service_fee_amount, 0),
  service_fee_label = coalesce(nullif(trim(o.service_fee_label), ''), 'Service Charge'),
  tip_amount = coalesce(o.tip_amount, 0),
  tip_label = coalesce(nullif(trim(o.tip_label), ''), 'Gratuity'),
  currency_code = coalesce(nullif(trim(o.currency_code), ''), r.currency_code, 'GBP')
from public.restaurants r
where r.id = o.restaurant_id;

alter table public.restaurant_orders
  alter column subtotal_amount set default 0,
  alter column subtotal_amount set not null,
  alter column tax_amount set default 0,
  alter column tax_amount set not null,
  alter column tax_rate_percent set default 0,
  alter column tax_rate_percent set not null,
  alter column tax_inclusive set default false,
  alter column tax_inclusive set not null,
  alter column tax_label set default 'VAT',
  alter column tax_label set not null,
  alter column service_fee_amount set default 0,
  alter column service_fee_amount set not null,
  alter column service_fee_label set default 'Service Charge',
  alter column service_fee_label set not null,
  alter column tip_amount set default 0,
  alter column tip_amount set not null,
  alter column tip_label set default 'Gratuity',
  alter column tip_label set not null,
  alter column currency_code set default 'GBP',
  alter column currency_code set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurant_orders_currency_code_length_check'
  ) then
    alter table public.restaurant_orders
      add constraint restaurant_orders_currency_code_length_check
      check (char_length(currency_code) = 3);
  end if;
end $$;

create index if not exists idx_restaurant_orders_billing_created_at
  on public.restaurant_orders(restaurant_id, created_at desc);

select pg_notify('pgrst', 'reload schema');
