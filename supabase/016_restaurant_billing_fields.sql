-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 014_order_payment_settlement.sql
--
-- Adds:
-- - country and currency context on restaurants
-- - country-level tax reference rates
-- - per-restaurant billing configuration for tax, service fee, and tip

alter table public.restaurants
  add column if not exists country_code text,
  add column if not exists currency_code text;

update public.restaurants
set
  country_code = coalesce(nullif(trim(country_code), ''), 'GB'),
  currency_code = coalesce(nullif(trim(currency_code), ''), 'GBP')
where country_code is null
   or currency_code is null
   or trim(coalesce(country_code, '')) = ''
   or trim(coalesce(currency_code, '')) = '';

alter table public.restaurants
  alter column country_code set default 'GB',
  alter column country_code set not null,
  alter column currency_code set default 'GBP',
  alter column currency_code set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurants_country_code_length_check'
  ) then
    alter table public.restaurants
      add constraint restaurants_country_code_length_check
      check (char_length(country_code) = 2);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'restaurants_currency_code_length_check'
  ) then
    alter table public.restaurants
      add constraint restaurants_currency_code_length_check
      check (char_length(currency_code) = 3);
  end if;
end $$;

create table if not exists public.country_tax_rates (
  id uuid primary key default gen_random_uuid(),
  country_code text not null check (char_length(country_code) = 2),
  tax_name text not null,
  rate_percent numeric(5, 2) not null check (rate_percent >= 0 and rate_percent <= 100),
  is_default boolean not null default false,
  effective_from date not null default current_date,
  notes text,
  unique (country_code, tax_name, effective_from)
);

insert into public.country_tax_rates (country_code, tax_name, rate_percent, is_default, notes)
values
  ('GB', 'VAT', 20.00, true, 'Standard UK VAT for restaurant hot food and drinks'),
  ('GB', 'VAT Zero', 0.00, false, 'Zero-rated cold takeaway food'),
  ('US', 'Sales Tax', 8.875, true, 'Example New York City combined rate. Override per restaurant when needed.'),
  ('IN', 'GST', 5.00, true, 'Standard GST rate for restaurant services'),
  ('AE', 'VAT', 5.00, true, 'UAE standard VAT rate'),
  ('AU', 'GST', 10.00, true, 'Australian GST standard rate'),
  ('CA', 'HST', 13.00, true, 'Ontario HST. Confirm province per restaurant.')
on conflict (country_code, tax_name, effective_from) do nothing;

alter table public.country_tax_rates enable row level security;

drop policy if exists "country_tax_rates_read_all" on public.country_tax_rates;
create policy "country_tax_rates_read_all"
on public.country_tax_rates
for select
to authenticated
using (true);

create table if not exists public.restaurant_billing_config (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  tax_rate_id uuid references public.country_tax_rates(id),
  tax_rate_override numeric(5, 2),
  tax_inclusive boolean not null default false,
  tax_label text not null default 'VAT',
  service_fee_enabled boolean not null default false,
  service_fee_type text check (service_fee_type in ('percent', 'flat')),
  service_fee_value numeric(8, 2),
  service_fee_label text not null default 'Service Charge',
  tip_enabled boolean not null default false,
  tip_suggestions numeric[] not null default array[10, 12.5, 15, 20],
  tip_label text not null default 'Gratuity',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_restaurant_billing_config_updated_at on public.restaurant_billing_config;
create trigger trg_restaurant_billing_config_updated_at
before update on public.restaurant_billing_config
for each row execute function public.set_updated_at();

insert into public.restaurant_billing_config (
  restaurant_id,
  tax_rate_id,
  tax_label,
  service_fee_enabled,
  service_fee_type,
  service_fee_value,
  tip_enabled,
  tip_suggestions,
  tip_label
)
select
  r.id,
  ctr.id,
  coalesce(ctr.tax_name, 'VAT'),
  false,
  null,
  null,
  false,
  array[10, 12.5, 15, 20],
  'Gratuity'
from public.restaurants r
left join lateral (
  select c.id, c.tax_name
  from public.country_tax_rates c
  where c.country_code = r.country_code
    and c.is_default = true
  order by c.effective_from desc
  limit 1
) ctr on true
on conflict (restaurant_id) do nothing;

alter table public.restaurant_billing_config enable row level security;

drop policy if exists "restaurant_billing_config_owner_all" on public.restaurant_billing_config;
create policy "restaurant_billing_config_owner_all"
on public.restaurant_billing_config
for all
to authenticated
using (
  exists (
    select 1 from public.restaurants r
    where r.id = restaurant_billing_config.restaurant_id
      and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = restaurant_billing_config.restaurant_id
      and r.owner_user_id = auth.uid()
  )
);

create index if not exists idx_country_tax_rates_country_default
  on public.country_tax_rates(country_code, is_default, effective_from desc);

create index if not exists idx_restaurant_billing_config_restaurant_id
  on public.restaurant_billing_config(restaurant_id);

select pg_notify('pgrst', 'reload schema');
