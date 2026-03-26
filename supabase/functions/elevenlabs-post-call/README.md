# ElevenLabs Post-Call Webhook (Supabase Edge Function)

This function receives ElevenLabs post-call webhooks and stores raw payloads/transcripts in Supabase for later app-side extraction.

## 1) Run SQL migrations

In Supabase SQL Editor run:

1. `supabase/001_init_restaurant_onboarding.sql`
2. `supabase/002_post_call_webhook_ingestion.sql`

## 2) Deploy function

From `mobile-onboarding-rn`:

```bash
supabase functions deploy elevenlabs-post-call
```

## 3) Set function secrets

```bash
supabase secrets set ELEVENLABS_WEBHOOK_AUTH_TOKEN=your_shared_webhook_token
```

Notes:

- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are used by the function.
- On hosted Supabase they are available automatically for Edge Functions.
- If running locally, set them manually as secrets.

## 4) Configure ElevenLabs webhook

Use endpoint:

`https://<YOUR_PROJECT_REF>.functions.supabase.co/elevenlabs-post-call`

Set a matching custom header/token:

- Header: `x-elevenlabs-webhook-token`
- Value: same as `ELEVENLABS_WEBHOOK_AUTH_TOKEN`

## What gets stored

- `post_call_webhooks`: raw payload, transcript snapshot, and processing status
- `restaurant_orders` + `restaurant_order_items`: not created in this function

Linking rule:

- Webhook `agent_id` is matched against `voice_agent_links.workspace_agent_id`
- Matched restaurant receives the webhook row
- If `agent_id` is missing or not linked, webhook is acknowledged (`200`) and skipped
- If audio and transcript arrive as separate events for the same `conversation_id`, they are merged into one row (`dedupe_key` is `provider + conversation_id`)
- Transcript follow-up events without `agent_id` are still merged if `conversation_id` matches an existing row

Normalized metadata captured in `webhook_payload.normalized_metadata`:

- `recording_url` (from `data.recording_url` / `data.audio_url`)
- `call_duration_secs` (from `data.call_duration_secs`)

App-side flow:

1. Open mobile app Orders tab
2. Review webhook rows in queue
3. Run Gemini extraction from transcript in app
4. Save extracted order into `restaurant_orders`
