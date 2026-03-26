-- Merge audio/transcript webhook rows for the same conversation into one record
-- Run this on projects that already have post_call_webhooks data

with ranked as (
  select
    id,
    provider,
    conversation_id,
    row_number() over (
      partition by provider, conversation_id
      order by updated_at desc nulls last, created_at desc nulls last, id desc
    ) as rn
  from public.post_call_webhooks
  where conversation_id is not null
),
keepers as (
  select provider, conversation_id, id as keeper_id
  from ranked
  where rn = 1
),
conversation_agg as (
  select
    k.keeper_id,
    (
      select p.event_id
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.event_id is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as event_id,
    (
      select p.event_type
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.event_type is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as event_type,
    (
      select p.agent_id
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.agent_id is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as agent_id,
    (
      select p.restaurant_id
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.restaurant_id is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as restaurant_id,
    (
      select p.transcript_text
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.transcript_text is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as transcript_text,
    (
      select p.analysis
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.analysis is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as analysis,
    (
      select p.analysis_status
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.analysis_status is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as analysis_status,
    (
      select p.analysis_error
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.analysis_error is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as analysis_error,
    (
      select p.extracted_order
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.extracted_order is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as extracted_order,
    (
      select p.created_order_id
      from public.post_call_webhooks p
      where p.provider = k.provider and p.conversation_id = k.conversation_id and p.created_order_id is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as created_order_id,
    (
      select coalesce(
        p.webhook_payload #>> '{normalized_metadata,recording_url}',
        p.webhook_payload ->> 'recording_url',
        p.webhook_payload ->> 'audio_url'
      )
      from public.post_call_webhooks p
      where p.provider = k.provider
        and p.conversation_id = k.conversation_id
        and coalesce(
          p.webhook_payload #>> '{normalized_metadata,recording_url}',
          p.webhook_payload ->> 'recording_url',
          p.webhook_payload ->> 'audio_url'
        ) is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as recording_url,
    (
      select p.webhook_payload #>> '{normalized_metadata,recording_storage_bucket}'
      from public.post_call_webhooks p
      where p.provider = k.provider
        and p.conversation_id = k.conversation_id
        and p.webhook_payload #>> '{normalized_metadata,recording_storage_bucket}' is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as recording_storage_bucket,
    (
      select p.webhook_payload #>> '{normalized_metadata,recording_storage_path}'
      from public.post_call_webhooks p
      where p.provider = k.provider
        and p.conversation_id = k.conversation_id
        and p.webhook_payload #>> '{normalized_metadata,recording_storage_path}' is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as recording_storage_path,
    (
      select (p.webhook_payload #>> '{normalized_metadata,recording_size_bytes}')::bigint
      from public.post_call_webhooks p
      where p.provider = k.provider
        and p.conversation_id = k.conversation_id
        and p.webhook_payload #>> '{normalized_metadata,recording_size_bytes}' is not null
      order by p.updated_at desc nulls last, p.created_at desc nulls last, p.id desc
      limit 1
    ) as recording_size_bytes
  from keepers k
),
updated_keepers as (
  update public.post_call_webhooks target
  set
    event_id = coalesce(a.event_id, target.event_id),
    event_type = coalesce(a.event_type, target.event_type),
    agent_id = coalesce(a.agent_id, target.agent_id),
    restaurant_id = coalesce(a.restaurant_id, target.restaurant_id),
    transcript_text = coalesce(a.transcript_text, target.transcript_text),
    analysis = coalesce(a.analysis, target.analysis),
    analysis_status = coalesce(a.analysis_status, target.analysis_status),
    analysis_error = coalesce(a.analysis_error, target.analysis_error),
    extracted_order = coalesce(a.extracted_order, target.extracted_order),
    created_order_id = coalesce(a.created_order_id, target.created_order_id),
    webhook_payload =
      case
        when a.recording_url is null and a.recording_storage_bucket is null and a.recording_storage_path is null and a.recording_size_bytes is null
          then coalesce(target.webhook_payload, '{}'::jsonb)
        else jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                coalesce(target.webhook_payload, '{}'::jsonb),
                '{normalized_metadata,recording_url}',
                to_jsonb(a.recording_url),
                true
              ),
              '{normalized_metadata,recording_storage_bucket}',
              to_jsonb(a.recording_storage_bucket),
              true
            ),
            '{normalized_metadata,recording_storage_path}',
            to_jsonb(a.recording_storage_path),
            true
          ),
          '{normalized_metadata,recording_size_bytes}',
          to_jsonb(a.recording_size_bytes),
          true
        )
      end
  from conversation_agg a
  where target.id = a.keeper_id
  returning target.provider, target.conversation_id
)
delete from public.post_call_webhooks doomed
using ranked r
where doomed.id = r.id
  and r.rn > 1;

update public.post_call_webhooks
set dedupe_key = provider || ':conversation:' || conversation_id
where conversation_id is not null;

create unique index if not exists idx_post_call_webhooks_provider_conversation_unique
  on public.post_call_webhooks(provider, conversation_id)
  where conversation_id is not null;
