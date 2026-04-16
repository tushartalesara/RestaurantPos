# Standalone Restaurant Onboarding App (React Native)

This is a standalone Expo React Native app (SDK 54) for restaurant onboarding:

- Restaurant owner login/register (Supabase Auth)
- Create and manage restaurant profile
- Scan menu pamphlet (camera/gallery)
- Parse OCR/pasted menu text into items + customizations
- Save all menu data in Supabase tables
- View/edit menu (including price updates)
- View/edit restaurant orders
- Create/link voice agents directly in ElevenLabs

## Setup

```bash
pnpm install
```

Create a `.env` file in the project root and set:

- `SUPABASE_URL` from Supabase project settings
- `SUPABASE_ANON_KEY` from Supabase project settings
- `EXPO_PUBLIC_GEMINI_API_KEY` for AI image parsing
- Optional: `EXPO_PUBLIC_GEMINI_MODEL` (default: `gemini-2.0-flash`)

### Admin Password Reset Script (service role)

Use this only with admin/server credentials to reset a password without sending email.

1. Create `.env.admin` and set:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
2. Run one of:
   - `pnpm admin:reset-password -- --email user@example.com --password NewPassword123`
   - `pnpm admin:reset-password -- --user-id <uuid> --password NewPassword123`
3. Optional dry run:
   - `pnpm admin:reset-password -- --email user@example.com --password NewPassword123 --dry-run`

Notes:
- Keep `.env.admin` out of source control.
- This script uses Supabase Admin API, so do not ship `SUPABASE_SERVICE_ROLE_KEY` inside mobile builds.

Run SQL schema in Supabase SQL editor:

- `supabase/001_init_restaurant_onboarding.sql`
- `supabase/002_post_call_webhook_ingestion.sql`
- `supabase/003_menu_stock_and_tool_support.sql`
- `supabase/004_place_voice_order_atomic.sql`
- `supabase/010_manual_order_stock_atomic.sql`
- `supabase/012_voice_agent_link_webhooks.sql`

Run app:

```bash
pnpm start
```

## Voice Agent Connection

In the app, go to **Voice AI Configuration** and either:

1. Create a new ElevenLabs agent using the restaurant's ElevenLabs API key
2. Link an existing ElevenLabs `agent_id`

The app stores the linked `agent_id` per restaurant in Supabase table `voice_agent_links`.

The create flow is direct to ElevenLabs:

- the mobile app collects the restaurant's ElevenLabs API key
- the app calls the Supabase edge function `create-elevenlabs-agent`
- that function creates the agent in ElevenLabs, provisions the menu/order tools, configures the post-call webhook, and stores the final link in Supabase

Before using the create flow, deploy and configure:

- `supabase/functions/create-elevenlabs-agent/index.ts`
- `supabase/functions/elevenlabs-post-call/index.ts`
- all tool functions listed below

Set these Supabase function secrets/env vars:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ELEVENLABS_TOOL_SECRET`
- `GETADDRESS_API_KEY`
- `ORDER_PAYMENT_PIN`
- Optional: `MOBILE_ONBOARDING_SUPABASE_FUNCTIONS_BASE_URL` or `SUPABASE_FUNCTIONS_BASE_URL`

## Menu Scan Note

Current standalone flow:

1. Capture/pick menu image
2. AI extraction with Gemini parses difficult menu photos
3. Optional OCR notes can be added for better extraction
4. Review/edit parsed items and customizations before save

This avoids backend OCR dependencies and keeps the app fully standalone.

## Supabase Tables

Run the SQL script to create:

- `restaurants`
- `menu_scans`
- `menu_items`
- `menu_item_customizations`
- `voice_agent_links`
- `restaurant_orders`
- `restaurant_order_items`
- `post_call_webhooks`

Reference schema file:

- `supabase/001_init_restaurant_onboarding.sql`
- `supabase/002_post_call_webhook_ingestion.sql`
- `supabase/003_menu_stock_and_tool_support.sql`
- `supabase/004_place_voice_order_atomic.sql`
- `supabase/010_manual_order_stock_atomic.sql`
- `supabase/013_order_fulfillment_and_delivery_fields.sql`
- `supabase/014_order_payment_settlement.sql`
- `supabase/012_voice_agent_link_webhooks.sql`

## Post-Call Webhook

For ElevenLabs post-call ingestion:

- Function source: `supabase/functions/elevenlabs-post-call/index.ts`
- Setup guide: `supabase/functions/elevenlabs-post-call/README.md`

Webhook output flow:

1. Receive ElevenLabs post-call payload
2. Store raw payload in `post_call_webhooks`
3. In mobile app, run Gemini extraction from transcript
4. Create `restaurant_orders` and `restaurant_order_items` from extracted result

## ElevenLabs Tool Functions

These Supabase edge functions are provided for live menu/order calls:

- `supabase/functions/create-elevenlabs-agent/index.ts`
- `supabase/functions/get-menu-items/index.ts`
- `supabase/functions/get-item-customizations/index.ts`
- `supabase/functions/check-item-stock/index.ts`
- `supabase/functions/lookup-uk-postcode-addresses/index.ts`
- `supabase/functions/place-order-atomic/index.ts`
- `supabase/functions/update-order-payment-status/index.ts`

Deploy:

```bash
supabase functions deploy create-elevenlabs-agent
supabase functions deploy get-menu-items
supabase functions deploy get-item-customizations
supabase functions deploy check-item-stock
supabase functions deploy lookup-uk-postcode-addresses
supabase functions deploy place-order-atomic
supabase functions deploy update-order-payment-status
supabase functions deploy elevenlabs-post-call
```

Set a shared tool secret (used as `x-tool-secret` header from ElevenLabs tool config):

```bash
supabase secrets set ELEVENLABS_TOOL_SECRET=your_tool_shared_secret
supabase secrets set GETADDRESS_API_KEY=your_getaddress_api_key
supabase secrets set ORDER_PAYMENT_PIN=1234
```

Stock support migration required:

- `supabase/003_menu_stock_and_tool_support.sql`
- `supabase/004_place_voice_order_atomic.sql`
- `supabase/010_manual_order_stock_atomic.sql`
- `supabase/013_order_fulfillment_and_delivery_fields.sql`
- `supabase/014_order_payment_settlement.sql`
- `supabase/012_voice_agent_link_webhooks.sql`
