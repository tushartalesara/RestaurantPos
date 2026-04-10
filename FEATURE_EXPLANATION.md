# Restaurant POS App: Feature Overview

## Purpose

This app is a restaurant operations app for owners and staff.
It is used to set up a restaurant, manage its menu, receive orders, handle voice-AI orders, review calls, and print customer bills.

This document is written for testers and product reviewers.
It explains what the app does from a user point of view, without code details.

## Main Areas of the App

## 1. Login and Account Access

Restaurant owners can:

- sign in with email and password
- create a new account
- reset their password
- stay signed in between app launches
- sign out when finished

Expected product behavior:

- after login, the app should open in POS mode by default
- Admin is still available, but it is not the default landing screen

## 2. Restaurant Setup

Each account can work with one or more restaurants.

Restaurant profile information includes:

- restaurant name
- phone number
- address

Expected product behavior:

- the selected restaurant controls which menu, orders, and voice-agent connection are shown
- switching restaurants should also switch the data shown in the app

## 3. Menu Scan and AI Parse

The app supports onboarding a restaurant by scanning a menu image.

The user can:

- take a photo of a printed menu
- pick a menu image from the gallery
- optionally add extra text notes to improve parsing
- run AI parsing
- review the parsed menu before saving it

Typical parsed content includes:

- item name
- category
- description
- price
- stock quantity
- customizations or add-ons

## 4. Menu Management

Once the menu is in the app, the user can manage it manually.

Supported actions:

- view saved items
- add a new item manually
- edit an item
- remove an item
- update price
- update stock quantity
- update customizations
- save the full menu

Expected product behavior:

- menu changes should persist after refresh or relaunch
- larger menus should still scroll smoothly

## 5. POS Orders Screen

POS is the main staff-facing workspace.

It is designed for daily order handling and should be the first screen after login.

Main capabilities:

- view all orders
- filter by All, Pending, or Complete
- see summary counts
- create a manual order
- edit an order
- delete an order
- mark an order complete
- move an order back to pending if needed
- preview the bill
- print receipts

Information priority on the card is:

- order number
- customer name
- order items
- total
- action buttons

## 6. Voice AI Orders

Orders coming from the voice system are visually distinct.

Voice-order cues include:

- a Voice AI badge
- a Call Review button when review data is available
- the same receipt and completion flows as other orders

Expected product behavior:

- only voice-backed orders should show the voice badge
- non-voice manual orders should not show voice review actions

## 7. Call Review

For voice-backed orders, the app can show a call review screen.

It may include:

- transcript of the conversation
- audio playback of the recording
- a status label showing call-review readiness

Expected product behavior:

- transcript should be readable and scrollable
- agent and customer messages should be visually different
- the screen should still handle missing transcript or missing audio gracefully

## 8. Receipt Preview and Printing

The app includes a bill preview experience designed to look like a thermal receipt.

Capabilities:

- open a bill preview for a single order
- print a single bill
- print all pending bills together

Expected product behavior:

- receipt content should show restaurant name, order code, customer, items, notes if any, and total
- the in-app preview should look like a narrow thermal receipt

Important note:

- on some browser print previews, the receipt may still appear on a larger page, but the receipt content itself should still be correct

## 9. Voice Agent Setup with ElevenLabs

The app allows the restaurant to connect an ElevenLabs voice agent.

There are two supported flows:

- create a new agent inside ElevenLabs
- link an existing agent ID

The app also supports saving the ElevenLabs API key locally on the current device so the user does not have to re-enter it every time.

Expected product behavior:

- after saving the API key once on a device, the app should show it in masked form
- the user should be able to edit the saved key later
- even if an agent is already linked, the app should still allow creating a new one

## 10. ElevenLabs API Key Permissions Needed for Testing

If a tester needs to create a new agent from inside the app, they must use an ElevenLabs API key with the right permissions.

Based on the current app behavior, the safest test setup is:

### Required permissions

- `ElevenAgents`: `Write`
- `Webhooks`: `Access`

### Recommended additional permission

- `Workspace`: `Write`

Why this is recommended:

- the app creates or updates an ElevenLabs agent
- the app attaches a post-call webhook
- the app configures post-call settings, including audio delivery

### Everything else can stay disabled unless your ElevenLabs workspace requires more

For normal app testing, these do not need to be enabled:

- Text to Speech
- Speech to Speech
- Speech to Text
- Sound Effects
- Audio Isolation
- Music Generation
- Dubbing
- Projects
- Audio Native
- Voices
- Voice Generation
- Forced Alignment
- History
- Models
- Pronunciation Dictionaries
- User
- Workspace Analytics
- Service Accounts
- Group Members
- Workspace Members Read
- Workspace Members Invite
- Workspace Members Remove
- Terms of Service Accept

If the tester is only linking an existing agent ID and not creating a new one, they do not need to use the API key creation flow at all.

## 11. Admin Console

Admin remains available as a secondary workspace.

Typical Admin uses:

- restaurant overview
- menu management
- order management
- voice-agent setup
- restaurant profile updates

Expected product behavior:

- Admin should be reachable when needed
- POS should still remain the default landing area after login

## 12. Settings

Settings gives the user a place to:

- move between POS and Admin
- view account context
- sign out

Expected product behavior:

- settings should never trap the user
- there should always be a clear way back

## Short Summary for a Tester

If you need a simple mental model:

- owner signs in
- owner sets up or selects a restaurant
- owner scans and saves a menu
- staff use POS to handle incoming orders
- voice orders are highlighted and can include transcript and audio review
- receipts can be previewed and printed
- the app can connect to ElevenLabs for live voice-agent ordering
