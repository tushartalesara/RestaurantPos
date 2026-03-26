-- Run this after:
-- 1) 001_init_restaurant_onboarding.sql
-- 2) 002_post_call_webhook_ingestion.sql
--
-- Adds stock/availability support required for ElevenLabs tool-based ordering.

alter table public.menu_items
  add column if not exists stock_quantity integer not null default 0 check (stock_quantity >= 0),
  add column if not exists is_available boolean not null default true;

create index if not exists idx_menu_items_restaurant_available
  on public.menu_items(restaurant_id, is_available);
