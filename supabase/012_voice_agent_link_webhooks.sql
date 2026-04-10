alter table public.voice_agent_links
  add column if not exists post_call_webhook_id text;

alter table public.voice_agent_links
  add column if not exists post_call_webhook_secret text;

create index if not exists idx_voice_agent_links_post_call_webhook_id
  on public.voice_agent_links(post_call_webhook_id);
