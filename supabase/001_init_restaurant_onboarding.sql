-- Run this in Supabase SQL editor (or with psql against your Supabase database).
-- This creates tables + RLS policies for the mobile onboarding app.

create extension if not exists pgcrypto;

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  phone text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.menu_scans (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  image_uri text,
  raw_menu_text text,
  extracted_payload jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  scan_id uuid references public.menu_scans(id) on delete set null,
  name text not null,
  description text,
  category text,
  base_price numeric(12, 2) not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.menu_item_customizations (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  label text not null,
  value text,
  price_delta numeric(12, 2) not null default 0,
  is_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voice_agent_links (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  workspace_base_url text not null,
  workspace_agent_id text not null,
  provider text not null default 'elevenlabs',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.restaurant_orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  customer_name text not null,
  status text not null default 'pending' check (status in ('pending', 'closed')),
  notes text,
  total_price numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.restaurant_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  name text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_price numeric(12, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_restaurants_owner_user_id on public.restaurants(owner_user_id);
create index if not exists idx_menu_scans_restaurant_id on public.menu_scans(restaurant_id);
create index if not exists idx_menu_items_restaurant_id on public.menu_items(restaurant_id);
create index if not exists idx_menu_items_restaurant_sort_order on public.menu_items(restaurant_id, sort_order, created_at);
create index if not exists idx_menu_item_customizations_menu_item_id on public.menu_item_customizations(menu_item_id);
create index if not exists idx_restaurant_orders_restaurant_id on public.restaurant_orders(restaurant_id);
create index if not exists idx_restaurant_order_items_order_id on public.restaurant_order_items(order_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_restaurants_updated_at on public.restaurants;
create trigger trg_restaurants_updated_at
before update on public.restaurants
for each row execute function public.set_updated_at();

drop trigger if exists trg_menu_items_updated_at on public.menu_items;
create trigger trg_menu_items_updated_at
before update on public.menu_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_menu_item_customizations_updated_at on public.menu_item_customizations;
create trigger trg_menu_item_customizations_updated_at
before update on public.menu_item_customizations
for each row execute function public.set_updated_at();

drop trigger if exists trg_voice_agent_links_updated_at on public.voice_agent_links;
create trigger trg_voice_agent_links_updated_at
before update on public.voice_agent_links
for each row execute function public.set_updated_at();

drop trigger if exists trg_restaurant_orders_updated_at on public.restaurant_orders;
create trigger trg_restaurant_orders_updated_at
before update on public.restaurant_orders
for each row execute function public.set_updated_at();

drop trigger if exists trg_restaurant_order_items_updated_at on public.restaurant_order_items;
create trigger trg_restaurant_order_items_updated_at
before update on public.restaurant_order_items
for each row execute function public.set_updated_at();

alter table public.restaurants enable row level security;
alter table public.menu_scans enable row level security;
alter table public.menu_items enable row level security;
alter table public.menu_item_customizations enable row level security;
alter table public.voice_agent_links enable row level security;
alter table public.restaurant_orders enable row level security;
alter table public.restaurant_order_items enable row level security;

drop policy if exists "restaurants_owner_all" on public.restaurants;
create policy "restaurants_owner_all"
on public.restaurants
for all
to authenticated
using (owner_user_id = auth.uid())
with check (owner_user_id = auth.uid());

drop policy if exists "menu_scans_owner_all" on public.menu_scans;
create policy "menu_scans_owner_all"
on public.menu_scans
for all
to authenticated
using (
  exists (
    select 1 from public.restaurants r
    where r.id = menu_scans.restaurant_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = menu_scans.restaurant_id and r.owner_user_id = auth.uid()
  )
);

drop policy if exists "menu_items_owner_all" on public.menu_items;
create policy "menu_items_owner_all"
on public.menu_items
for all
to authenticated
using (
  exists (
    select 1 from public.restaurants r
    where r.id = menu_items.restaurant_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = menu_items.restaurant_id and r.owner_user_id = auth.uid()
  )
);

drop policy if exists "menu_item_customizations_owner_all" on public.menu_item_customizations;
create policy "menu_item_customizations_owner_all"
on public.menu_item_customizations
for all
to authenticated
using (
  exists (
    select 1
    from public.menu_items mi
    join public.restaurants r on r.id = mi.restaurant_id
    where mi.id = menu_item_customizations.menu_item_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.menu_items mi
    join public.restaurants r on r.id = mi.restaurant_id
    where mi.id = menu_item_customizations.menu_item_id and r.owner_user_id = auth.uid()
  )
);

drop policy if exists "voice_agent_links_owner_all" on public.voice_agent_links;
create policy "voice_agent_links_owner_all"
on public.voice_agent_links
for all
to authenticated
using (
  exists (
    select 1 from public.restaurants r
    where r.id = voice_agent_links.restaurant_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = voice_agent_links.restaurant_id and r.owner_user_id = auth.uid()
  )
);

drop policy if exists "restaurant_orders_owner_all" on public.restaurant_orders;
create policy "restaurant_orders_owner_all"
on public.restaurant_orders
for all
to authenticated
using (
  exists (
    select 1 from public.restaurants r
    where r.id = restaurant_orders.restaurant_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.restaurants r
    where r.id = restaurant_orders.restaurant_id and r.owner_user_id = auth.uid()
  )
);

drop policy if exists "restaurant_order_items_owner_all" on public.restaurant_order_items;
create policy "restaurant_order_items_owner_all"
on public.restaurant_order_items
for all
to authenticated
using (
  exists (
    select 1
    from public.restaurant_orders ro
    join public.restaurants r on r.id = ro.restaurant_id
    where ro.id = restaurant_order_items.order_id and r.owner_user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.restaurant_orders ro
    join public.restaurants r on r.id = ro.restaurant_id
    where ro.id = restaurant_order_items.order_id and r.owner_user_id = auth.uid()
  )
);
