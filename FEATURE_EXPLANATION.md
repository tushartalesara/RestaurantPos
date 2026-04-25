# RestaurantDemo Feature Explanation

## Purpose

This document explains the app as a product and workflow system.

Use it to understand:

- what the app does today
- how POS and Admin differ
- how orders move through the system
- how voice ordering, delivery, payments, and printing work

For the code-level map, read `CODE_ARCHITECTURE.md` after this file.

## Product summary

RestaurantDemo is a UK-focused restaurant operations app for a restaurant owner and their staff.

The app is designed to:

- authenticate the owner
- create and switch between restaurants
- scan and digitize a menu
- manage menu items, prices, stock, and customizations
- receive and manage orders
- accept manual POS orders and ElevenLabs voice-agent orders
- support pickup and delivery workflows
- review call transcripts and recordings
- print customer receipts
- auto-print new orders when enabled
- show a same-day business summary

## Main app surfaces

The live app has three practical surfaces:

- Authentication
- POS
- Admin

## 1. Authentication

The app currently supports only Supabase email/password auth.

Supported flows:

- login with email and password
- register a new account
- request a password reset email
- complete an auth redirect from a verification or reset link
- restore an existing session
- sign out

Important behavior:

- login is owner-centric, not staff-account-centric
- signup may require email confirmation
- the app can recognize verification and recovery links and turn them into friendly UI states
- invalid refresh tokens are treated as expired local sessions

Current registration password rules:

- minimum 8 characters
- at least one uppercase letter
- at least one special character
- 12 or more characters is recommended

What is not supported:

- Google login
- Apple login
- magic links as the main login method
- phone OTP login
- separate waiter logins

## 2. Restaurant model

One authenticated owner can manage multiple restaurants.

Each restaurant currently stores:

- name
- phone
- address

The selected restaurant controls the context for:

- menu
- orders
- voice-agent link
- locally saved ElevenLabs API key for that restaurant on this device
- locally saved printer preferences for that restaurant on this device

## 3. Navigation model

The app has two working modes:

- `pos`
- `admin`

Current behavior:

- after login, the app opens in POS by default
- POS is the daily working surface
- Admin is opened when the user wants setup or management tools
- on web, mode can also be derived from URL values such as `?portal=admin`, `?mode=pos`, hash segments, or the last path segment

Current active tabs:

- POS: `orders`, `summary`
- Admin: `overview`, `menu`, `orders`, `voice`

## 4. POS

POS is intentionally narrow and order-focused.

### POS orders

This is the main live queue.

Staff can:

- see all orders
- filter by `All`, `Pending`, or `Complete`
- open manual order creation from the floating `+` button
- edit order details
- mark an order complete
- move an order back to pending
- open receipt preview
- open payment settlement
- open call review for voice-backed orders

Each order card can show:

- short order code
- status
- customer name
- phone number
- delivery badge when relevant
- payment badge
- delivery address when relevant
- line items
- total

### POS day summary

POS also has a `Day Summary` screen.

It shows today's:

- total orders
- pending orders
- completed orders
- gross sales
- cash total
- credit total
- COD outstanding
- unpaid outstanding
- outstanding total

POS does not expose printer settings.

## 5. Admin

Admin is the configuration and management workspace.

### Admin overview

This tab combines two major setup areas:

- Restaurant profile
- Menu scan and parse

From here the owner can:

- select a restaurant
- update restaurant name, phone, and address
- take or upload a menu image
- paste OCR or helper notes
- parse the menu with AI
- review and edit parsed draft items before saving

### Admin menu

This is the manual menu editor.

The owner can:

- inspect the saved menu
- edit names, categories, descriptions, prices, stock, and customizations
- add items
- remove items
- save the full menu

### Admin orders

Admin can also work with the order queue using the same shared order UI patterns as POS.

### Admin voice

This is the ElevenLabs setup area.

The owner can:

- save an ElevenLabs API key locally on the current device
- create a new ElevenLabs agent from inside the app
- manually link an existing agent ID
- see which agent is currently linked

### Admin printer settings

Printer settings are admin-only.

From there the owner can:

- choose a printer target
- enable or disable auto print
- save printer settings
- print all pending receipts

## 6. Menu onboarding and parsing

Menu onboarding can start from:

- camera capture
- gallery upload
- pasted OCR text or notes

Parsing behavior:

1. If an image exists, the app first tries Gemini image parsing.
2. If that fails and OCR text exists, the app falls back to the local text parser.

The app supports two parse modes:

- `New Menu`: replace the current menu
- `Add Items`: keep the existing menu and append new items

After parsing, the user can review and edit the draft before saving.

Each draft item can include:

- name
- description
- category
- base price
- stock quantity
- customization text

## 7. Menu management

Saved menu items can store:

- name
- description
- category
- base price
- stock quantity
- customizations

Important operational behavior:

- stock quantity is used by both manual ordering and voice ordering
- zero stock effectively makes the item unavailable
- menu order is preserved with `sort_order`

Important technical consequence:

- menu saves are full replace operations, not row-by-row patch updates
- existing menu items and their customizations are deleted and reinserted
- menu item IDs therefore are not stable across a full save

## 8. Order model

An order can include:

- customer name
- customer phone
- fulfillment type
- delivery postcode
- delivery address
- payment collection mode
- payment settlement state
- payment method
- optional card transaction ID
- short order code
- status
- notes
- total price
- items
- optional call-review data

Key status concepts:

- order lifecycle status: `pending` or `closed`
- fulfillment type: `pickup` or `delivery`
- payment collection: `unpaid` for pickup, `cod` for delivery
- payment settlement: `unpaid` or `paid`
- payment method after settlement: `cash` or `card`

## 9. Manual order flow

Manual order creation is structured around a modal editor.

The user provides:

- customer name
- phone number
- pickup or delivery
- postcode and address for delivery
- notes
- items chosen from the saved menu

### Item picker

The item picker supports:

- search
- quantity increase and decrease
- customization selection
- local stock-aware add limits

### Save behavior

The app validates:

- customer name
- customer phone
- delivery postcode and address for delivery
- at least one item
- local stock limits

If every order line is tied to a real menu item ID, the app uses a stock-aware atomic backend save path.

Manual orders created as new pending orders also trigger the same new-order alert behavior as incoming voice orders.

## 10. Voice ordering

Voice ordering is powered by ElevenLabs conversation agents plus custom Supabase tool functions.

Supported connection flows:

- create a brand-new ElevenLabs agent from inside the app
- manually link an existing ElevenLabs agent ID

### Current voice agent behavior

The current prompt and tool setup instruct the agent to:

- ask whether the order is pickup or delivery
- collect customer name and phone
- use live tools to inspect the menu
- check stock before confirming quantities
- fetch item customizations where needed
- for delivery, ask postcode first
- look up UK addresses under that postcode
- let the caller choose one exact address
- summarize the order and get explicit confirmation
- place the order only through the atomic backend tool

Voice tool functions currently used:

- `get-menu-items`
- `get-item-customizations`
- `check-item-stock`
- `lookup-uk-postcode-addresses`
- `place-order-atomic`

## 11. Delivery workflow

Delivery is now part of the core order model.

Current behavior:

- delivery requires a UK postcode
- delivery requires a specific address
- voice delivery should use postcode lookup before address selection
- delivery orders default to `COD`
- delivery orders show address information on cards and receipts

Pickup orders:

- do not require postcode or address
- default to `UNPAID`
- no longer show a redundant `PICKUP` badge on the order card

## 12. Payment settlement

Payment settlement is a separate workflow from order creation.

The staff member taps the payment badge on an order.

The modal allows:

- entering the waiter PIN
- choosing `Cash` or `Card`
- optionally entering a card transaction ID
- marking the order as paid
- moving a paid order back to unpaid

Operational examples:

- pickup order starts as `UNPAID`
- delivery order starts as `COD`
- once settled, the badge becomes `CASH` or `CARD`

## 13. Call review

Voice-backed orders can have call review data.

Possible review content:

- transcript
- transcript split into agent vs customer messages
- recording URL
- analysis status

UI behavior:

- only orders with call-review content show the review action
- transcript is shown in a readable conversational layout
- recording playback is supported when a recording exists
- missing transcript or missing audio is handled gracefully

## 14. Polling, chime, and new-order experience

The app polls for fresh orders every 8 seconds.

When new orders appear:

- the app plays a loud chime
- on web, if speech synthesis is available, it also says `New order` or `X new orders`
- a notification banner appears
- if auto print is enabled, the print flow is opened automatically

Important protection:

Background refresh pauses while editing flows are open, including:

- order editor
- item picker
- item customization modal
- payment modal

This prevents in-progress manual edits from being overwritten.

## 15. Printing and receipts

Each order has a receipt preview flow.

Receipt content includes:

- restaurant name
- order code
- status
- date
- customer
- phone
- order type
- payment label
- postcode and address when relevant
- card reference when relevant
- notes
- line items
- total

Printing capabilities:

- print one order from receipt preview
- print all pending receipts from admin printer settings
- auto print new orders when enabled

Important platform limitation:

- the app can open the system print flow automatically
- it cannot promise silent fixed-printer printing on every platform
- iOS has stronger printer targeting support than web or Android

## 16. Day summary

The current product direction is to show day summary inside POS instead of printing it from printer settings.

The summary is a live operational view, not a formal accounting export.

## 17. Storage and integrations

The app uses:

- Supabase Auth
- Supabase Postgres
- Supabase Storage
- Supabase Edge Functions
- Gemini
- ElevenLabs
- getAddress.io
- Expo audio, image-picker, and print APIs

Data stored in Supabase includes:

- restaurants
- menu scans
- menu items
- menu customizations
- orders
- order items
- voice agent links
- post-call webhook rows
- call recordings in storage

Per-device local storage includes:

- saved ElevenLabs API key per restaurant
- print preferences per restaurant

## 18. Important caveats

- menu saves replace rows, so menu item IDs are not stable
- Gemini parsing uses a client-side Expo public key
- payment PIN is server-side and not configurable in the UI
- call recordings are stored in a public bucket for easy playback
- POS is intentionally narrow and centered on orders plus summary

## 19. Short mental model for an LLM

The safest high-level model is:

- owner signs in
- owner selects a restaurant
- owner scans and saves a menu
- POS becomes the daily order queue
- manual and voice orders both land in the same order system
- voice orders later gain transcript and recording metadata
- pickup vs delivery affects address and payment collection behavior
- payment settlement is a separate PIN-gated flow
- receipts and printing are central to the daily workflow
