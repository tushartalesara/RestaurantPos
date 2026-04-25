# RestaurantDemo Code Architecture

## Purpose

This document explains how the app is built so another developer or LLM agent can navigate it quickly and safely.

Read `FEATURE_EXPLANATION.md` first if you need the product view. Read this file if you need the code and backend map.

## 1. Stack

Client:

- Expo SDK 54
- React 19
- React Native 0.81
- React Native Web
- Supabase JS
- AsyncStorage
- Expo Image Picker
- Expo Audio
- Expo Print

Backend:

- Supabase Auth
- Supabase Postgres
- Supabase Storage
- Supabase Edge Functions

External services:

- Gemini for menu image parsing
- ElevenLabs for conversation agents and post-call webhooks
- getAddress.io for UK postcode lookup

## 2. Entrypoint and app shell

The runtime entry is simple:

- `App.tsx`
  - only renders `src/screens/AppRoot.tsx`
- `src/screens/AppRoot.tsx`
  - main orchestration layer for almost the whole app

Important architectural fact:

- there is no router package
- there is no Redux, Zustand, MobX, or other global state store
- most of the app state is held directly inside `AppRoot.tsx`

## 3. Main file map

### Shell and screens

- `App.tsx`
  - tiny wrapper
- `src/screens/AppRoot.tsx`
  - auth, POS, Admin, modals, printing, notifications, voice setup, day summary
- `src/screens/MenuScreen.tsx`
  - extracted Admin menu editor

### Data and services

- `src/supabase.ts`
  - Supabase client config
- `src/auth.ts`
  - login, register, reset, redirect completion, session helpers
- `src/db.ts`
  - main client-side data access layer
- `src/workspace-api.ts`
  - calls the ElevenLabs agent-creation edge function

### Parsing and formatting

- `src/gemini-parser.ts`
  - Gemini image parse
- `src/menu-parser.ts`
  - heuristic text parser fallback
- `src/utils/formatters.ts`
  - shared formatters for money, postcodes, statuses, payment labels, receipt helpers
- `src/utils/receiptContent.tsx`
  - React receipt preview layout
- `src/utils/printUtils.ts`
  - print HTML generation and cross-platform print helper

### UI pieces

- `src/components/Sidebar.tsx`
  - tablet POS sidebar
- `src/components/ChannelBadge.tsx`
  - voice channel badge
- `src/modals/CallReviewModal.tsx`
  - voice review modal
- `src/modals/ReceiptPreviewModal.tsx`
  - receipt preview modal

### Backend

- `supabase/*.sql`
  - schema and migrations
- `supabase/functions/*`
  - edge functions for voice tools, postcode lookup, payment updates, and post-call ingestion

### Scripts

- `scripts/admin-reset-password.js`
  - admin/service-role password reset helper

## 4. App modes and tab model

Types live in `src/types/index.ts`.

Important runtime types:

- `AppMode = "admin" | "pos"`
- `MainTab = "overview" | "menu" | "orders" | "voice" | "summary"`

Current live usage:

- POS uses `orders` and `summary`
- Admin uses `overview`, `menu`, `orders`, and `voice`

Mode behavior:

- native starts in POS
- web can derive mode from query, hash, or path

Mode helpers live in `AppRoot.tsx`:

- `normalizeWebPortalMode`
- `resolveWebPortalMode`
- `getInitialAppMode`

## 5. State ownership in `AppRoot.tsx`

The main state groups are:

- boot and auth
- restaurant selection and profile fields
- menu scan state
- saved menu plus editable menu
- orders plus UI drafts
- modals for order editor, item picker, customization, payment, receipt preview, and call review
- print preferences and printer options
- saved ElevenLabs API key and linked agent state
- new-order polling and chime state

This file is effectively the app controller.

## 6. Shared domain types

Important shared types from `src/types/index.ts`:

- `RestaurantRecord`
- `MenuItemDraft`
- `MenuCustomizationDraft`
- `RestaurantOrderRecord`
- `RestaurantOrderItemRecord`
- `OrderCallReviewRecord`
- `UiOrderDraft`
- `VoiceAgentLinkRecord`
- `FulfillmentType`
- `PaymentCollection`
- `PaymentStatus`
- `PaymentMethod`

Important distinction:

- `RestaurantOrderRecord` is the persisted/domain shape
- `UiOrderDraft` is the mutable form used by order editing UI

## 7. Auth architecture

Auth code lives in `src/auth.ts`.

Main exported functions:

- `registerWithEmail`
- `loginWithEmail`
- `resetPasswordWithEmail`
- `completeAuthRedirectFromUrl`
- `getSession`
- `clearSession`

Behavior notes:

- signup uses `emailRedirectTo`
- password reset uses `redirectTo`
- redirect parsing supports both query-string and hash token formats
- invalid refresh tokens are treated as expired local sessions

Client env vars used:

- `EXPO_PUBLIC_APP_SCHEME`
- `EXPO_PUBLIC_EMAIL_CONFIRM_REDIRECT_URL`
- `EXPO_PUBLIC_PASSWORD_RESET_REDIRECT_URL`

## 8. Supabase client setup

`src/supabase.ts` reads:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

and falls back to:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

The Supabase client uses AsyncStorage-backed auth persistence.

`assertSupabaseConfigured()` is used early so missing env vars fail fast with a clear startup message.

## 9. Restaurant load lifecycle

Startup flow inside `AppRoot.tsx`:

1. `initDatabase()` warms up auth/session access.
2. initial URL is checked for auth redirects.
3. stored session is loaded.
4. if a user exists, the app switches to POS and loads restaurants.

When a restaurant is selected, the app loads in parallel:

- menu items
- orders
- voice agent link
- local ElevenLabs API key for that restaurant
- local print preferences for that restaurant

## 10. Menu onboarding flow

The key functions are:

- `handleParseMenu()` in `AppRoot.tsx`
- `parseMenuFromImageWithGemini()` in `src/gemini-parser.ts`
- `parseMenuText()` in `src/menu-parser.ts`

Flow:

1. validate that image or text exists
2. try Gemini image parsing first
3. if that fails and OCR/helper text exists, use the local text parser
4. dedupe and merge or replace draft items
5. save a `menu_scans` row
6. keep the reviewed menu draft in UI state

Gemini parsing is client-side, not server-side.

## 11. Menu save architecture

Saving menu changes eventually calls:

- `replaceRestaurantMenuItems()` in `src/db.ts`

That function:

- finds existing menu items for the restaurant
- deletes existing customizations
- deletes existing menu items
- reinserts all items in order with `sort_order`
- reinserts customizations

This is one of the most important gotchas in the repo:

- menu item IDs are not stable across a full menu save

## 12. Order architecture

Orders are loaded by:

- `listRestaurantOrders()` in `src/db.ts`

That function:

1. loads rows from `restaurant_orders`
2. loads `restaurant_order_items`
3. loads matching `post_call_webhooks`
4. attaches transcript, recording URL, and analysis state as `callReview`

UI order rendering then works from `orderDrafts`, which are derived from those persisted rows.

## 13. Manual order save path

Main UI function:

- `persistOrderDraft()` in `AppRoot.tsx`

Data-layer function:

- `saveRestaurantOrder()` in `src/db.ts`

Client-side validation covers:

- customer name
- customer phone
- delivery postcode and address for delivery
- valid-looking UK postcode
- at least one item
- local stock limits

If every order line has a real `menuItemId`, the app uses the atomic RPC:

- `save_manual_order_atomic`

That RPC:

- validates ownership with `auth.uid()`
- handles both create and update
- calculates stock deltas when editing existing orders
- updates stock safely
- saves order and item rows

If the RPC or supporting schema is missing, `saveRestaurantOrder()` falls back to direct table writes.

## 14. Voice-order path

The client side only configures the agent and stores the link.

Live voice ordering is server-side and tool-driven.

### Client code

- `src/workspace-api.ts`
- Admin voice section in `AppRoot.tsx`

### Edge functions used for voice

- `create-elevenlabs-agent`
- `get-menu-items`
- `get-item-customizations`
- `check-item-stock`
- `lookup-uk-postcode-addresses`
- `place-order-atomic`

### Final order placement

`place-order-atomic` calls the Postgres RPC:

- `place_voice_order_atomic`

That RPC validates:

- customer info
- fulfillment type
- delivery postcode and address when needed
- stock and availability

Then it:

- decrements stock
- creates the order
- inserts order items
- returns order code and totals

## 15. ElevenLabs agent creation flow

Edge function:

- `supabase/functions/create-elevenlabs-agent/index.ts`

Responsibilities:

- verify the signed-in user owns the restaurant
- provision or update ElevenLabs tools
- create the ElevenLabs post-call webhook
- enable audio delivery in ElevenLabs settings
- create the conversation agent
- patch the agent with the restaurant prompt and tool IDs
- save the final link in `voice_agent_links`

The current prompt logic explicitly supports:

- pickup vs delivery
- postcode-first address lookup
- COD vs unpaid collection behavior
- explicit confirmation before tool-based order placement

## 16. Post-call webhook architecture

Edge function:

- `supabase/functions/elevenlabs-post-call/index.ts`

Responsibilities:

- accept ElevenLabs post-call payloads
- verify shared token or HMAC signature when configured
- merge payloads by conversation over time
- upload `full_audio` to Supabase Storage
- persist transcript and analysis data
- link the webhook row back to the order when possible

Storage bucket used:

- `call-recordings`

The app later reads the public recording URL from the merged webhook payload.

## 17. Payment settlement architecture

Client call path:

- `AppRoot.tsx` payment modal
- `src/db.ts` `updateRestaurantOrderPayment()`
- edge function `update-order-payment-status`

The edge function exists because the waiter PIN must be verified server-side.

Server responsibilities:

- resolve the Supabase user from the auth header
- verify restaurant ownership
- verify the shared payment PIN secret
- update `payment_status`, `payment_method`, `card_transaction_id`, and `payment_updated_at`

## 18. Printing architecture

Receipt generation:

- `src/utils/receiptContent.tsx`
- `src/utils/printUtils.ts`

Print execution:

- web uses a hidden iframe plus `window.print()`
- native uses `Print.printAsync()`

Current stored printer preference fields:

- `autoPrintEnabled`
- `selectedPrinterId`
- `selectedPrinterName`
- `selectedPrinterUrl`

AsyncStorage key:

- `restaurant-print-preferences:<restaurantId>`

Important current rules:

- printer settings modal is admin-only
- auto print is disabled until a printer target is selected
- iOS can choose a printer with `Print.selectPrinterAsync()`
- web and Android mostly depend on the system print sheet

## 19. New-order polling and alerts

Polling interval:

- 8 seconds

Refresh behavior:

- reloads orders
- reloads menu items so stock stays current
- compares fetched IDs against `knownOrderIdsRef`
- identifies new orders

If new orders are found:

- queue chime
- optionally speak `New order` on web
- show notification
- auto print if enabled

Background refresh is paused while the user is editing an order or payment state.

## 20. Local storage keys

Important local keys:

- `restaurant-elevenlabs-api-key:<restaurantId>`
- `restaurant-print-preferences:<restaurantId>`

These are per device, not server-synced.

## 21. Client env vars

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `EXPO_PUBLIC_GEMINI_API_KEY`
- `EXPO_PUBLIC_GEMINI_MODEL`
- `EXPO_PUBLIC_APP_SCHEME`
- `EXPO_PUBLIC_EMAIL_CONFIRM_REDIRECT_URL`
- `EXPO_PUBLIC_PASSWORD_RESET_REDIRECT_URL`

## 22. Edge-function secrets and env vars

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_FUNCTIONS_BASE_URL` or `MOBILE_ONBOARDING_SUPABASE_FUNCTIONS_BASE_URL`
- `ELEVENLABS_TOOL_SECRET`
- `GETADDRESS_API_KEY`
- `ORDER_PAYMENT_PIN`
- `ELEVENLABS_WEBHOOK_AUTH_TOKEN` optional

## 23. Schema and migration map

### `001_init_restaurant_onboarding.sql`

Creates base tables plus RLS:

- `restaurants`
- `menu_scans`
- `menu_items`
- `menu_item_customizations`
- `voice_agent_links`
- `restaurant_orders`
- `restaurant_order_items`

### `002_post_call_webhook_ingestion.sql`

Adds:

- source tracking fields on orders
- `post_call_webhooks`
- public `call-recordings` bucket

### `003_menu_stock_and_tool_support.sql`

Adds stock fields to `menu_items`:

- `stock_quantity`
- `is_available`

### `004_place_voice_order_atomic.sql`

Original atomic voice-order function.

### `005_order_contact_and_short_code.sql`

Adds:

- `customer_phone`
- `short_order_code`
- `order_code_date`

### `006_active_pending_order_ids.sql`

Introduces active pending short-order-code behavior.

### `007_menu_item_sort_order.sql`

Adds and repairs `sort_order`.

### `008_repair_place_voice_order_atomic.sql`

Historical repair for the voice-order RPC.

### `009_fast_fail_order_locks.sql`

Hardens order locking behavior and fail-fast concurrency.

### `010_manual_order_stock_atomic.sql`

Adds:

- `menu_item_id` on order items
- `save_manual_order_atomic`

### `010_post_call_audio_storage.sql`

Additional audio storage setup.

### `011_post_call_webhook_conversation_merge.sql`

Improves conversation-level post-call merging.

### `012_voice_agent_link_webhooks.sql`

Adds:

- `post_call_webhook_id`
- `post_call_webhook_secret`

to `voice_agent_links`.

### `013_order_fulfillment_and_delivery_fields.sql`

Adds:

- `fulfillment_type`
- `delivery_postcode`
- `delivery_address`
- `payment_collection`

and rebuilds both manual and voice order RPCs to support delivery.

### `014_order_payment_settlement.sql`

Adds:

- `payment_status`
- `payment_method`
- `card_transaction_id`
- `payment_updated_at`

### `015_harden_active_short_order_codes.sql`

Removes legacy short-code conflicts and makes active pending codes always choose the next free live code.

## 24. Important trust boundaries

Safe in client:

- Supabase anon key
- public Gemini key if the product accepts that risk
- local ElevenLabs API key convenience storage
- local printer preferences

Must stay server-side:

- Supabase service role key
- ElevenLabs tool secret
- payment PIN
- getAddress API key
- webhook verification secrets

## 25. Common edit entry points

Change auth:

- `src/auth.ts`
- `src/supabase.ts`
- `src/screens/AppRoot.tsx`

Change menu parse:

- `src/gemini-parser.ts`
- `src/menu-parser.ts`
- `src/screens/AppRoot.tsx`

Change menu save behavior:

- `src/db.ts`
- relevant migrations

Change manual order flow:

- `src/screens/AppRoot.tsx`
- `src/db.ts`
- `supabase/010_manual_order_stock_atomic.sql`
- `supabase/013_order_fulfillment_and_delivery_fields.sql`

Change payment settlement:

- `src/screens/AppRoot.tsx`
- `src/db.ts`
- `supabase/functions/update-order-payment-status/index.ts`
- `supabase/014_order_payment_settlement.sql`

Change printing:

- `src/utils/receiptContent.tsx`
- `src/utils/printUtils.ts`
- `src/screens/AppRoot.tsx`

Change voice setup or voice tools:

- `src/workspace-api.ts`
- `supabase/functions/create-elevenlabs-agent/index.ts`
- tool functions in `supabase/functions`
- relevant order and menu migrations

Change call review:

- `supabase/functions/elevenlabs-post-call/index.ts`
- `src/db.ts`
- `src/modals/CallReviewModal.tsx`

## 26. Known gotchas

- `AppRoot.tsx` is a monolith, so many changes have wide regression risk
- menu saves replace rows, so menu item IDs change
- printing cannot promise true silent fixed-printer behavior on every platform
- call recordings are stored in a public bucket
- some older docs in the repo are behind the current runtime behavior

## 27. Safe checklist for future agents

Before changing a feature, check whether it also affects:

- shared types
- `src/db.ts`
- receipt generation
- edge functions
- SQL migrations
- local storage keys
- ElevenLabs prompt and tool schema

After changes, usually verify:

1. `pnpm -s tsc --noEmit`
2. whether a new migration is needed
3. whether an edge function deploy step changed
4. whether new env vars or secrets are required
