# Restaurant Tool Functions

These functions are designed for ElevenLabs custom tools.

Base URL:

`https://<PROJECT_REF>.functions.supabase.co`

Required header for all tools:

- `x-tool-secret: <ELEVENLABS_TOOL_SECRET>`

Important security model:

- Always pass `agent_id` in tool requests.
- Server resolves `restaurant_id` from `voice_agent_links`.
- Optional `restaurant_id` can be passed, but mismatch is rejected.

## 1) get-menu-items

Path:

`/get-menu-items`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "query": "optional search text",
  "category": "optional category",
  "limit": 20,
  "include_unavailable": false
}
```

## 2) get-item-customizations

Path:

`/get-item-customizations`

Request body (by item name):

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "item_name": "Peri Burger"
}
```

Request body (by item id):

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "item_id": "MENU_ITEM_UUID"
}
```

## 3) check-item-stock

Path:

`/check-item-stock`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "item_name": "Peri Burger",
  "requested_qty": 3
}
```

## 4) place-order-atomic

Path:

`/place-order-atomic`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "customer_name": "John",
  "status": "pending",
  "notes": "no onions",
  "items": [
    { "item_id": "MENU_ITEM_UUID", "quantity": 2 },
    { "item_id": "MENU_ITEM_UUID_2", "quantity": 1 }
  ]
}
```

## Setup Checklist

1. Run SQL migrations:
   - `supabase/001_init_restaurant_onboarding.sql`
   - `supabase/002_post_call_webhook_ingestion.sql`
   - `supabase/003_menu_stock_and_tool_support.sql`
   - `supabase/004_place_voice_order_atomic.sql`
2. Deploy all 4 functions:
   - `supabase functions deploy get-menu-items`
   - `supabase functions deploy get-item-customizations`
   - `supabase functions deploy check-item-stock`
   - `supabase functions deploy place-order-atomic`
3. Set secret:
   - `supabase secrets set ELEVENLABS_TOOL_SECRET=...`
