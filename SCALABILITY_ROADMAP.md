# Task 1 — Scalability & Infrastructure Roadmap
### RestaurantDemo → Enterprise-Grade Platform (100+ Restaurants)

---

## Executive Summary

Your current stack is already well-positioned for multi-tenant scale. Supabase Auth + RLS gives you tenant isolation, atomic Postgres RPCs give you safe concurrent writes, and the ElevenLabs webhook pipeline gives you async voice ingestion. The biggest risks are not architectural — they are operational: client-side polling under load, row-level lock contention under concurrent voice calls, synchronous webhook processing, and a small number of exposed secrets that become serious vulnerabilities at scale. Fix those, add the right indexes, and your current stack carries you comfortably to 100+ restaurants.

---

## Baseline Assessment

| Layer | Current State | Risk at Scale |
|---|---|---|
| Auth & Tenancy | Supabase Auth + RLS by `restaurant_id` | ✅ Correct model, needs index hardening |
| Order writes | Atomic RPCs (`place_voice_order_atomic`, `save_manual_order_atomic`) | ⚠️ Row-lock contention under burst |
| Order freshness | 8-second polling per session | 🔴 High — multiplies across tenants |
| Webhook ingestion | Synchronous in Edge Function | ⚠️ Fragile under burst traffic |
| Voice tool latency | 6 separate Edge Functions | ⚠️ Cold-start risk mid-conversation |
| Gemini API key | Client-side in app bundle | 🔴 Extractable, uncontrolled cost |
| Payment PIN | Single global secret | 🔴 Single point of compromise |
| Call recordings | Public Storage bucket | 🔴 No access control at scale |
| State management | `AppRoot.tsx` monolith | ⚠️ Regression risk for new features |

---

## Critical Fix 1 — Replace Polling with Realtime Subscriptions

### The Problem

The app polls every 8 seconds for orders and stock. At 100 restaurants with 2–3 active staff sessions each, that is 200–300 HTTP requests hitting Supabase every 8 seconds, continuously, even at 3am when nothing is happening. This is the single largest scalability liability in the codebase.

### The Fix

Replace the `setInterval` polling loop in `AppRoot.tsx` with **Supabase Realtime `postgres_changes` subscriptions**. This is already in your stack — no new infrastructure required. One persistent WebSocket per session replaces hundreds of polling requests. Supabase Realtime is built on Phoenix Channels and supports tens of thousands of concurrent subscribers.

```typescript
// src/hooks/useOrderSubscription.ts
// Replace the setInterval polling block with this pattern

export const useOrderSubscription = (
  restaurantId: string,
  onOrderChange: () => void
) => {
  useEffect(() => {
    const channel = supabase
      .channel(`orders:${restaurantId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'restaurant_orders',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => onOrderChange()
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'menu_items',
          filter: `restaurant_id=eq.${restaurantId}`,
        },
        () => onOrderChange() // keep stock current
      )
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [restaurantId]);
};
```

**Keep polling as a fallback recovery path only** — if the WebSocket connection drops, fall back to a single poll on reconnect, not a continuous loop.

The current pause-while-editing behavior (background refresh pauses while order editor, item picker, customization modal, or payment modal is open) should be preserved in the subscription model by simply unsubscribing during edit flows and resubscribing on close.

---

## Critical Fix 2 — Resolve Row-Lock Contention in Atomic Order RPCs

### The Problem

Migration `009_fast_fail_order_locks.sql` hardened the locking behavior, but the current RPCs still use `SELECT ... FOR UPDATE` on `menu_items` rows. Under concurrent voice calls — two callers ordering the last portion of the same dish at the same restaurant simultaneously — these transactions queue behind one lock and whichever loses will fail or time out. At 100 restaurants with busy periods, this is a regular occurrence.

### The Fix

Replace **pessimistic locking** with **optimistic concurrency control** using a `version` column. This removes the lock entirely and replaces it with a compare-and-swap that either succeeds instantly or fails fast with a clean error for the voice tool to retry.

**Migration — add to `menu_items`:**

```sql
-- supabase/016_menu_item_version_column.sql
ALTER TABLE menu_items
  ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Update existing rows to a consistent starting version
UPDATE menu_items SET version = 1;
```

**Updated RPC logic (replace the FOR UPDATE block):**

```sql
-- Inside place_voice_order_atomic and save_manual_order_atomic
-- Replace: SELECT stock_quantity FROM menu_items WHERE id = v_item_id FOR UPDATE
-- With: compare-and-swap on version

-- First read (no lock):
SELECT stock_quantity, version
  INTO v_current_stock, v_expected_version
  FROM menu_items
  WHERE id = v_item_id;

IF v_current_stock < v_qty THEN
  RAISE EXCEPTION 'Insufficient stock for item %', v_item_id
    USING ERRCODE = 'P0002';
END IF;

-- Compare-and-swap update:
UPDATE menu_items
SET
  stock_quantity = stock_quantity - v_qty,
  version = version + 1
WHERE id = v_item_id
  AND version = v_expected_version       -- if version changed, another order beat us
  AND stock_quantity >= v_qty;           -- double-check stock hasn't dropped

IF NOT FOUND THEN
  RAISE EXCEPTION 'Stock conflict on item %. Please retry.', v_item_id
    USING ERRCODE = 'P0001';
END IF;
```

**Voice tool retry behavior:** The `place-order-atomic` Edge Function should catch `ERRCODE P0001` and retry the full RPC once before returning an error to ElevenLabs. One retry resolves the vast majority of conflicts because they are timing races, not persistent shortage.

---

## Critical Fix 3 — Consolidate Voice Tool Edge Functions

### The Problem

Your voice ordering path uses 6 separate Edge Functions:
- `get-menu-items`
- `get-item-customizations`
- `check-item-stock`
- `lookup-uk-postcode-addresses`
- `place-order-atomic`
- `create-elevenlabs-agent`

Each one is a separate Deno process. Cold starts on infrequently-hit functions can be 200–500ms. During a live voice conversation, that latency is audible and disruptive. Under burst traffic (dinner rush at 10 restaurants simultaneously), cold starts are frequent.

### The Fix

Consolidate the 5 live-conversation tool functions into a **single dispatcher Edge Function**. One warm process handles all tool calls:

```typescript
// supabase/functions/voice-tool-dispatcher/index.ts

import { serve } from 'https://deno.land/std/http/server.ts'

serve(async (req) => {
  const { action, restaurantId, params } = await req.json()

  // Validate shared tool secret
  const toolSecret = req.headers.get('x-tool-secret')
  if (toolSecret !== Deno.env.get('ELEVENLABS_TOOL_SECRET')) {
    return new Response('Unauthorized', { status: 401 })
  }

  switch (action) {
    case 'get-menu-items':
      return handleGetMenuItems(restaurantId, params)
    case 'get-item-customizations':
      return handleGetItemCustomizations(restaurantId, params)
    case 'check-item-stock':
      return handleCheckItemStock(restaurantId, params)
    case 'lookup-uk-postcode-addresses':
      return handlePostcodeLookup(params)
    case 'place-order-atomic':
      return handlePlaceOrder(restaurantId, params)
    default:
      return new Response('Unknown action', { status: 400 })
  }
})
```

Update the ElevenLabs agent's tool definitions to point all tools at this single endpoint with an `action` field. The existing tool schema shape is unchanged — only the URL changes.

**Additionally:** Add a lightweight keep-alive cron (GitHub Actions or Supabase Cron) that pings the dispatcher every 4 minutes to prevent cold starts during active service hours.

---

## Critical Fix 4 — Async Webhook Ingestion Queue

### The Problem

`elevenlabs-post-call/index.ts` currently does 4–5 sequential operations synchronously: validate HMAC, merge payload by conversation, upload audio to Storage, persist transcript, link to order. During a dinner rush when many calls end simultaneously, these operations pile up, and any timeout causes ElevenLabs to retry, potentially creating duplicates.

### The Fix

Decouple ingest from processing using a **durable queue table**. The Edge Function becomes a thin, fast receiver. A background worker processes at its own pace.

**Migration:**

```sql
-- supabase/017_webhook_ingest_queue.sql
CREATE TABLE webhook_ingest_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payload      JSONB         NOT NULL,
  source       TEXT          NOT NULL DEFAULT 'elevenlabs',
  idempotency_key TEXT       UNIQUE,    -- ElevenLabs conversation_id + event_type
  received_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  status       TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  error_message TEXT
);

CREATE INDEX idx_queue_status_received
  ON webhook_ingest_queue(status, received_at)
  WHERE status = 'pending';
```

**Updated `elevenlabs-post-call` Edge Function (thin receiver):**

```typescript
serve(async (req) => {
  const payload = await req.json()

  // Validate HMAC / shared token (fast, no DB)
  validateWebhookSignature(req, payload)

  const idempotencyKey = `${payload.conversation_id}:${payload.type}`

  // Write to queue and return immediately
  const { error } = await supabase
    .from('webhook_ingest_queue')
    .insert({
      payload,
      idempotency_key: idempotencyKey,
      source: 'elevenlabs',
    })
    .onConflict('idempotency_key')
    .ignore()  // idempotent — duplicates are safely dropped

  if (error) {
    console.error('Queue insert failed:', error)
    return new Response('Error', { status: 500 })
  }

  return new Response('Accepted', { status: 202 })  // fast return to ElevenLabs
})
```

**Background worker** (a separate Edge Function triggered by Supabase Cron every 30 seconds) picks up `pending` rows, runs the full merge/audio-upload/order-linkage logic, and marks rows `done`. This pattern is the same one used by Stripe for webhook processing: receive fast, process durably.

---

## Critical Fix 5 — Move Gemini Parsing Server-Side

### The Problem

`EXPO_PUBLIC_GEMINI_API_KEY` is compiled into the app bundle. Any installed build can have this key extracted via `strings` or a bundler reverse-engineering tool. At 100 restaurants with active onboarding, the key is at real risk of extraction and abuse, and cost overruns cannot be rate-limited per tenant.

### The Fix

Create a new Edge Function `parse-menu-image` that receives the image from the client and calls Gemini server-side using a secret key.

**Client flow:**

```typescript
// src/gemini-parser.ts — updated
export async function parseMenuFromImageWithGemini(
  imageUri: string,
  restaurantId: string
): Promise<MenuItemDraft[]> {
  // 1. Upload image to a private temp bucket
  const blob = await uriToBlob(imageUri)
  const tempPath = `menu-scans/${restaurantId}/${Date.now()}.jpg`
  await supabase.storage.from('menu-uploads').upload(tempPath, blob)

  // 2. Call Edge Function (no API key in client)
  const { data, error } = await supabase.functions.invoke('parse-menu-image', {
    body: { restaurantId, imagePath: tempPath },
  })

  if (error) throw error
  return data.items as MenuItemDraft[]
}
```

**Edge Function:**

```typescript
// supabase/functions/parse-menu-image/index.ts
// Uses GEMINI_API_KEY from Supabase secrets — never exposed to client
serve(async (req) => {
  const { restaurantId, imagePath } = await req.json()
  // Verify user owns restaurant via auth.uid()
  // Download image from private bucket
  // Call Gemini API with server-side key
  // Return parsed draft items
})
```

Delete `EXPO_PUBLIC_GEMINI_API_KEY` and `EXPO_PUBLIC_GEMINI_MODEL` from the client env vars entirely after this migration.

---

## Critical Fix 6 — Per-Restaurant Payment PIN

### The Problem

`ORDER_PAYMENT_PIN` is a single Edge Function secret shared across all restaurants. One leaked PIN breaks payment authorization for every tenant on the platform.

### The Fix

Add a hashed PIN column to `restaurants` and make the `update-order-payment-status` Edge Function look up the PIN for the specific restaurant being settled.

**Migration:**

```sql
-- supabase/018_per_restaurant_payment_pin.sql
ALTER TABLE restaurants
  ADD COLUMN payment_pin_hash TEXT;       -- bcrypt hash, set by owner via Admin
```

**Edge Function update:**

```typescript
// supabase/functions/update-order-payment-status/index.ts
// Replace: compare against Deno.env.get('ORDER_PAYMENT_PIN')
// With:

const { data: restaurant } = await supabase
  .from('restaurants')
  .select('payment_pin_hash')
  .eq('id', restaurantId)
  .single()

const pinValid = await bcrypt.compare(submittedPin, restaurant.payment_pin_hash)
if (!pinValid) return new Response('Invalid PIN', { status: 403 })
```

Restaurant owners set their PIN from Admin settings. The global `ORDER_PAYMENT_PIN` secret is deprecated.

---

## Critical Fix 7 — Private Call Recordings Bucket

### The Problem

`call-recordings` is a public Storage bucket. Any person with any recording URL can access any restaurant's call recordings — there is no access control. This is a significant GDPR and data protection risk for a UK-focused platform.

### The Fix

Set the bucket to **private** and generate short-lived signed URLs at read time. This is a one-setting change in Supabase and a two-line change in `db.ts` and `CallReviewModal.tsx`.

```typescript
// src/db.ts — when loading call review data
// Replace: return webhook.recording_url (public URL)
// With:

if (webhook.recording_path) {
  const { data: signedUrlData } = await supabase.storage
    .from('call-recordings')
    .createSignedUrl(webhook.recording_path, 1800) // 30-minute expiry

  webhook.recording_url = signedUrlData?.signedUrl ?? null
}
```

Store `recording_path` (the storage object path) in `post_call_webhooks`, not the full public URL. Generate signed URLs on demand. The `CallReviewModal.tsx` playback UX is unchanged from the user's perspective.

---

## Database Hardening — Required Indexes

These indexes are the most impactful single change for query performance under multi-tenant load. All queries in `db.ts` filter by `restaurant_id`, and without composite indexes on that column, Postgres does full table scans as rows grow.

```sql
-- supabase/019_scale_indexes.sql
-- Run with CONCURRENTLY to avoid locking tables during migration

CREATE INDEX CONCURRENTLY idx_orders_restaurant_created
  ON restaurant_orders(restaurant_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_orders_restaurant_status
  ON restaurant_orders(restaurant_id, status);

CREATE INDEX CONCURRENTLY idx_order_items_order
  ON restaurant_order_items(order_id);

CREATE INDEX CONCURRENTLY idx_menu_items_restaurant_sort
  ON menu_items(restaurant_id, sort_order);

CREATE INDEX CONCURRENTLY idx_menu_items_restaurant_available
  ON menu_items(restaurant_id, is_available)
  WHERE is_available = true;

-- Critical for listRestaurantOrders() join
CREATE INDEX CONCURRENTLY idx_webhooks_order_id
  ON post_call_webhooks(order_id);

CREATE INDEX CONCURRENTLY idx_webhooks_conversation
  ON post_call_webhooks(conversation_id);

-- For the ingest queue (Fix 4)
CREATE INDEX CONCURRENTLY idx_queue_pending
  ON webhook_ingest_queue(status, received_at)
  WHERE status = 'pending';
```

**Enable PgBouncer connection pooling** in your Supabase project settings (transaction mode). At 100 restaurants with simultaneous active sessions, raw Postgres connections will exhaust the limit. PgBouncer multiplexes hundreds of application connections through a small Postgres pool without any code changes.

---

## `AppRoot.tsx` Monolith — Incremental Refactor Plan

The architecture doc explicitly flags this as the biggest regression risk in the codebase. Every new feature added to `AppRoot.tsx` increases the blast radius of any change. The fix is incremental — not a rewrite.

**Step 1 (Month 1): Extract domain stores using Zustand**

Zustand has no boilerplate, works identically on React Native and web, and components only re-render when their specific slice of state changes.

```
src/
  stores/
    useAuthStore.ts        -- auth state, session, user
    useRestaurantStore.ts  -- selected restaurant, profile fields
    useMenuStore.ts        -- menu items, drafts, scan state
    useOrderStore.ts       -- orders, order drafts, polling/subscription
    useVoiceStore.ts       -- ElevenLabs key, agent link, voice setup
    usePrintStore.ts       -- printer preferences, auto-print
```

**Step 2 (Month 2): Thin out `AppRoot.tsx`**

Once stores exist, `AppRoot.tsx` becomes a thin coordinator: it reads from stores, renders the top-level layout, and delegates to screens. Modals become self-contained consumers of their relevant store.

**Step 3 (Month 3+): New features live outside `AppRoot.tsx` entirely**

The QA Dashboard, multi-restaurant admin tools, and analytics surfaces are built as separate route entries that import stores directly, without touching `AppRoot.tsx`.

---

## Multi-Tenant Architecture — What You Already Have Right

Your current model — shared schema, RLS filtering by `owner_id` → `restaurant_id` ownership chain — is the canonical pattern for B2B SaaS at the 10–1,000 tenant range. Platforms like Retool, Linear, and Vercel all use this model. You do not need schema-per-tenant or database-per-tenant at 100 restaurants.

What the model requires to be reliable:
- Every operational table has `restaurant_id` and all queries filter by it first (you already do this).
- Composite indexes put `restaurant_id` as the leading column (Fix 7 above).
- RLS policies are the authorization boundary, not just the frontend (you already do this).
- Storage objects are restaurant-scoped in their path and access-controlled (Fix 6 above).
- No global secrets that span tenants (Fixes 5 and 6 above).

---

## Complete Priority-Ordered Implementation Plan

| Priority | Fix | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Private call recordings bucket | 1 day | Security / GDPR |
| 🔴 P0 | Per-restaurant payment PIN | 2 days | Security |
| 🔴 P0 | Gemini key server-side | 3 days | Security / cost |
| 🔴 P1 | Scale indexes + PgBouncer | 1 day | Performance at scale |
| 🔴 P1 | Replace polling with Realtime | 3 days | Infrastructure load |
| ⚠️ P2 | Async webhook ingest queue | 4 days | Reliability under burst |
| ⚠️ P2 | Optimistic stock CAS | 2 days | Concurrency safety |
| ⚠️ P2 | Consolidate voice tool Edge Functions | 2 days | Latency / cold starts |
| ✅ P3 | Zustand store extraction | 2 weeks | Maintainability |

---

## Operational Checklist Before Launch at 100+ Restaurants

- [ ] All tables have `restaurant_id` composite indexes as the leading column
- [ ] PgBouncer enabled in Supabase project settings (transaction mode)
- [ ] `call-recordings` bucket set to private
- [ ] `EXPO_PUBLIC_GEMINI_API_KEY` removed from client; server-side Edge Function deployed
- [ ] Per-restaurant PIN migration deployed; global `ORDER_PAYMENT_PIN` deprecated
- [ ] Post-call webhook ingest queue deployed and background worker running
- [ ] Voice tool dispatcher consolidated to single Edge Function
- [ ] Realtime subscriptions replace polling in main order feed
- [ ] HMAC signature verification enabled on all ElevenLabs webhooks (not just the optional token)
- [ ] Supabase Realtime enabled for the `restaurant_orders` and `menu_items` tables
- [ ] Recording paths stored instead of public URLs in `post_call_webhooks`
