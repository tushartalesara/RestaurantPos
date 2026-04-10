# Standalone Restaurant Onboarding App (React Native)

This is a standalone Expo React Native app (SDK 54) for restaurant onboarding:

- Restaurant owner login/register (Supabase Auth)
- Create and manage restaurant profile
- Scan menu pamphlet (camera/gallery)
- Parse OCR/pasted menu text into items + customizations
- Save all menu data in Supabase tables
- View/edit menu (including price updates)
- View/edit restaurant orders
- Link/create voice agent in Ibara workspace (only workspace dependency)

## Setup

```bash
cd mobile-onboarding-rn
npm install
cp .env.example .env
```

Set:

- `SUPABASE_URL` from Supabase project settings
- `SUPABASE_ANON_KEY` from Supabase project settings
- `EXPO_PUBLIC_GEMINI_API_KEY` for AI image parsing
- Optional: `EXPO_PUBLIC_GEMINI_MODEL` (default: `gemini-2.0-flash`)

### Admin Password Reset Script (service role)

Use this only with admin/server credentials to reset a password without sending email.

1. Copy `.env.admin.example` to `.env.admin` and set:
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

Run app:

```bash
npm run start
```

## Voice Agent Connection

In the app, go to **Voice Agent Connection** and either:

1. Create an agent from Ibara credentials (email/password)
2. Link an existing workspace `agent_id`

The app stores the linked `agent_id` per restaurant in Supabase table `voice_agent_links`.

For mobile-specific ElevenLabs credentials, configure these in the `ibara-admin-portal` backend `.env`:

- `ELEVENLABS_API_KEY_AGENT_CREATION` (default key for non-mobile flows)
- `ELEVENLABS_API_KEY_AGENT_CREATION_MOBILE_ONBOARDING` (used when source is `mobile_onboarding`)

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

- `supabase/functions/get-menu-items/index.ts`
- `supabase/functions/get-item-customizations/index.ts`
- `supabase/functions/check-item-stock/index.ts`
- `supabase/functions/place-order-atomic/index.ts`

Deploy:

```bash
supabase functions deploy get-menu-items
supabase functions deploy get-item-customizations
supabase functions deploy check-item-stock
supabase functions deploy place-order-atomic
```

Set a shared tool secret (used as `x-tool-secret` header from ElevenLabs tool config):

```bash
supabase secrets set ELEVENLABS_TOOL_SECRET=your_tool_shared_secret
```

Stock support migration required:

- `supabase/003_menu_stock_and_tool_support.sql`
- `supabase/004_place_voice_order_atomic.sql`
