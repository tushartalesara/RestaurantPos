-- Per-restaurant payment security and scale-focused indexes.

alter table public.restaurants
  add column if not exists payment_pin_hash text,
  add column if not exists payment_pin_updated_at timestamptz;

create unique index if not exists idx_voice_agent_links_workspace_agent_id
  on public.voice_agent_links(workspace_agent_id);

create index if not exists idx_restaurant_orders_restaurant_created_desc
  on public.restaurant_orders(restaurant_id, created_at desc);

create index if not exists idx_restaurant_orders_restaurant_status
  on public.restaurant_orders(restaurant_id, status);

create index if not exists idx_menu_items_restaurant_available
  on public.menu_items(restaurant_id, is_available)
  where is_available = true;

create index if not exists idx_post_call_webhooks_created_order_desc
  on public.post_call_webhooks(created_order_id);

create index if not exists idx_post_call_webhooks_conversation_desc
  on public.post_call_webhooks(conversation_id);

create index if not exists idx_webhook_ingest_queue_pending
  on public.webhook_ingest_queue(status, received_at)
  where status = 'pending';

select pg_notify('pgrst', 'reload schema');
