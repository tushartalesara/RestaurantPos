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

## 4) lookup-uk-postcode-addresses

Path:

`/lookup-uk-postcode-addresses`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "postcode": "SW1A 1AA"
}
```

## 5) get-order-quote

Path:

`/get-order-quote`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "conversation_id": "OPTIONAL_CONVERSATION_ID",
  "fulfillment_type": "pickup",
  "items": [
    { "item_id": "MENU_ITEM_UUID", "quantity": 2 },
    { "item_id": "MENU_ITEM_UUID_2", "quantity": 1 }
  ]
}
```

## 6) place-order-atomic

Path:

`/place-order-atomic`

Request body:

```json
{
  "agent_id": "AGENT_ID_FROM_ELEVENLABS",
  "restaurant_id": "OPTIONAL_RESTAURANT_UUID",
  "customer_name": "John",
  "customer_phone": "07123456789",
  "fulfillment_type": "delivery",
  "delivery_postcode": "SW1A 1AA",
  "delivery_address": "10 Downing Street, Westminster, London, SW1A 2AA",
  "payment_collection": "cod",
  "status": "pending",
  "notes": "no onions",
  "items": [
    { "item_id": "MENU_ITEM_UUID", "quantity": 2 },
    { "item_id": "MENU_ITEM_UUID_2", "quantity": 1 }
  ]
}
```

## 7) update-order-payment-status

Path:

`/update-order-payment-status`

Request body:

```json
{
  "restaurant_id": "RESTAURANT_UUID",
  "order_id": "ORDER_UUID",
  "pin": "1234",
  "payment_status": "paid",
  "payment_method": "card",
  "card_transaction_id": "TXN-12345"
}
```

## Setup Checklist

1. Run SQL migrations:
   - `supabase/001_init_restaurant_onboarding.sql`
   - `supabase/002_post_call_webhook_ingestion.sql`
   - `supabase/003_menu_stock_and_tool_support.sql`
   - `supabase/005_order_contact_and_short_code.sql`
   - `supabase/006_active_pending_order_ids.sql`
   - `supabase/010_manual_order_stock_atomic.sql`
   - `supabase/013_order_fulfillment_and_delivery_fields.sql`
   - `supabase/014_order_payment_settlement.sql`
2. Deploy all 7 tool functions:
   - `supabase functions deploy get-menu-items`
   - `supabase functions deploy get-item-customizations`
   - `supabase functions deploy check-item-stock`
   - `supabase functions deploy lookup-uk-postcode-addresses`
   - `supabase functions deploy get-order-quote`
   - `supabase functions deploy place-order-atomic`
   - `supabase functions deploy update-order-payment-status`
3. Set secrets:
   - `supabase secrets set ELEVENLABS_TOOL_SECRET=...`
   - `supabase secrets set GETADDRESS_API_KEY=...`
   - `supabase secrets set ORDER_PAYMENT_PIN=1234`
