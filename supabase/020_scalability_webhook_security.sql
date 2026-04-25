-- Scalability and security hardening for webhook ingestion and call recordings.
-- - moves call recordings to a private bucket model
-- - stores recording paths directly on post_call_webhooks
-- - adds a durable ingest queue for post-call processing

alter table public.post_call_webhooks
  add column if not exists recording_storage_bucket text,
  add column if not exists recording_storage_path text,
  add column if not exists recording_size_bytes bigint;

update public.post_call_webhooks
set
  recording_storage_bucket = coalesce(
    recording_storage_bucket,
    nullif(webhook_payload #>> '{normalized_metadata,recording_storage_bucket}', '')
  ),
  recording_storage_path = coalesce(
    recording_storage_path,
    nullif(webhook_payload #>> '{normalized_metadata,recording_storage_path}', '')
  ),
  recording_size_bytes = coalesce(
    recording_size_bytes,
    nullif(webhook_payload #>> '{normalized_metadata,recording_size_bytes}', '')::bigint
  );

create table if not exists public.webhook_ingest_queue (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  source text not null default 'elevenlabs',
  idempotency_key text unique,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  last_attempt_at timestamptz,
  attempt_count integer not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  error_message text
);

create index if not exists idx_webhook_ingest_queue_status_received
  on public.webhook_ingest_queue(status, received_at);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'call-recordings',
  'call-recordings',
  false,
  52428800,
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "call_recordings_owner_select" on storage.objects;
create policy "call_recordings_owner_select"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'call-recordings'
  and exists (
    select 1
    from public.restaurants r
    where r.id::text = (storage.foldername(name))[1]
      and r.owner_user_id = auth.uid()
  )
);

select pg_notify('pgrst', 'reload schema');
