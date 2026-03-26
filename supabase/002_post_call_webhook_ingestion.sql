-- Post-call webhook ingestion queue for app-side transcript analysis
-- Run this after 001_init_restaurant_onboarding.sql

alter table public.restaurant_orders
  add column if not exists source_provider text,
  add column if not exists source_conversation_id text;

create unique index if not exists idx_restaurant_orders_source_unique
  on public.restaurant_orders(source_provider, source_conversation_id);

create table if not exists public.post_call_webhooks (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'elevenlabs',
  dedupe_key text not null unique,
  event_id text,
  event_type text,
  conversation_id text,
  agent_id text,
  restaurant_id uuid references public.restaurants(id) on delete set null,
  webhook_payload jsonb not null default '{}'::jsonb,
  transcript_text text,
  analysis jsonb,
  analysis_status text not null default 'processing' check (analysis_status in ('processing', 'completed', 'failed')),
  analysis_error text,
  extracted_order jsonb,
  created_order_id uuid references public.restaurant_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_post_call_webhooks_restaurant_id on public.post_call_webhooks(restaurant_id);
create index if not exists idx_post_call_webhooks_conversation_id on public.post_call_webhooks(conversation_id);
create index if not exists idx_post_call_webhooks_agent_id on public.post_call_webhooks(agent_id);
create index if not exists idx_post_call_webhooks_created_order_id on public.post_call_webhooks(created_order_id);
create unique index if not exists idx_post_call_webhooks_provider_conversation_unique
  on public.post_call_webhooks(provider, conversation_id)
  where conversation_id is not null;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'call-recordings',
  'call-recordings',
  true,
  52428800,
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop trigger if exists trg_post_call_webhooks_updated_at on public.post_call_webhooks;
create trigger trg_post_call_webhooks_updated_at
before update on public.post_call_webhooks
for each row execute function public.set_updated_at();

alter table public.post_call_webhooks enable row level security;

drop policy if exists "post_call_webhooks_owner_all" on public.post_call_webhooks;
create policy "post_call_webhooks_owner_all"
on public.post_call_webhooks
for all
to authenticated
using (
  restaurant_id is null
  or exists (
    select 1 from public.restaurants r
    where r.id = post_call_webhooks.restaurant_id and r.owner_user_id = auth.uid()
  )
)
with check (
  restaurant_id is null
  or exists (
    select 1 from public.restaurants r
    where r.id = post_call_webhooks.restaurant_id and r.owner_user_id = auth.uid()
  )
);
