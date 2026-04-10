# Manual Test Plan: Restaurant POS App

## Purpose

This document is for testers who are validating the app as a product.
It focuses only on user-visible behavior.
It does not include code, database, or developer setup instructions.

## What Testers Need Before Starting

Please make sure the following are already provided to you by the project owner or developer:

- a working test build of the app
- internet access
- one valid test login
- at least one restaurant account ready for testing
- at least one restaurant with menu data
- if voice-agent creation is part of testing, one valid ElevenLabs API key

## ElevenLabs API Key Permissions for Testing

If you need to test "Create Agent in ElevenLabs" from inside the app, use an ElevenLabs API key with these permissions.

### Required

- `ElevenAgents`: `Write`
- `Webhooks`: `Access`

### Recommended

- `Workspace`: `Write`

This combination is recommended because the app needs to:

- create or update an agent
- attach a post-call webhook
- configure post-call behavior, including audio delivery

### Everything else can remain disabled unless your ElevenLabs workspace specifically requires more

These are not normally needed for app testing:

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

Important note:

- if you are only testing "Link Existing Agent", you do not need to create a new API key for agent creation

## Devices to Cover

Minimum coverage:

- Android phone
- Android tablet or wide emulator
- web browser

## General Expected Behavior

- POS should be the default landing screen after login
- Admin should still be reachable when needed
- voice orders should look visually different from manual orders
- receipt preview should look like a narrow bill
- the app should remain usable even when some optional data is missing, such as transcript or audio

## Test Cases

## 1. App Launch

### 1.1 App opens correctly

Steps:

1. Launch the app.

Expected:

- the app opens without crashing
- either the login screen or the signed-in experience appears
- there is no blank or frozen startup screen

### 1.2 Reopen app after closing

Steps:

1. Close the app.
2. Reopen it.

Expected:

- the app still opens cleanly
- if the session is valid, the user remains signed in

## 2. Authentication

### 2.1 Login with valid credentials

Steps:

1. Enter a valid email and password.
2. Tap login.

Expected:

- login succeeds
- the user lands in POS, not Admin

### 2.2 Login with invalid credentials

Steps:

1. Enter the wrong password.
2. Try logging in.

Expected:

- a useful error appears
- the app remains usable

### 2.3 Password reset flow

Steps:

1. Open password reset.
2. Enter a valid email.
3. Submit.

Expected:

- the app shows a confirmation or guidance message

### 2.4 Sign out

Steps:

1. Sign out from the app.

Expected:

- the user is returned to the login screen

## 3. Restaurant Selection and Profile

### 3.1 Load an existing restaurant

Steps:

1. Sign in with an account that already has at least one restaurant.

Expected:

- restaurant information is shown correctly

### 3.2 Update restaurant details

Steps:

1. Edit restaurant name, phone, or address.
2. Save.
3. Refresh or reopen the app.

Expected:

- the updated details remain saved

### 3.3 Switch restaurants

Steps:

1. If the test account has multiple restaurants, switch between them.

Expected:

- the app updates the visible menu, orders, and voice-agent status for the selected restaurant

## 4. Menu Scan and Parse

### 4.1 Capture a menu image

Steps:

1. Open the menu scan flow.
2. Use the camera to capture a menu image.

Expected:

- permission is handled correctly
- the image is accepted

### 4.2 Pick an image from gallery

Steps:

1. Open the gallery picker.
2. Select a menu image.

Expected:

- the image loads successfully

### 4.3 Parse menu image

Steps:

1. Run AI parse on a valid menu image.

Expected:

- parsed items appear
- names, categories, and prices look reasonable

### 4.4 Parse with added text context

Steps:

1. Add optional text notes.
2. Parse again.

Expected:

- parsing still works
- results are improved or at least not worse

### 4.5 Poor image handling

Steps:

1. Try a poor-quality or unreadable image.

Expected:

- the app shows a helpful failure or warning
- the app does not freeze or crash

## 5. Menu Management

### 5.1 Edit existing items

Steps:

1. Open the menu screen.
2. Edit item name, category, description, price, stock, or customization text.
3. Save.

Expected:

- the changes persist

### 5.2 Add an item manually

Steps:

1. Add a new menu item.
2. Fill in details.
3. Save.

Expected:

- the new item appears after saving and remains after refresh

### 5.3 Remove an item

Steps:

1. Remove a menu item.
2. Save.

Expected:

- the item stays removed

### 5.4 Large menu performance

Steps:

1. Open a menu with many items.
2. Scroll quickly.
3. Edit an item and continue using the screen.

Expected:

- the menu screen remains responsive
- opening the menu screen does not freeze the app

## 6. POS Orders

### 6.1 POS is the default landing screen

Steps:

1. Log in.

Expected:

- POS opens first

### 6.2 Summary counts are correct

Steps:

1. Compare the counts for pending, complete, and voice orders with known test data.

Expected:

- counts are correct

### 6.3 Filters work

Steps:

1. Switch between All, Pending, and Complete.

Expected:

- order list updates correctly
- empty states make sense

### 6.4 Add a manual order

Steps:

1. Tap the `+` button.
2. Add customer details.
3. Add at least one item.
4. Save the order.

Expected:

- the order appears in the list
- it is marked pending

### 6.5 Manual order validation

Steps:

1. Try saving with missing customer name.
2. Try saving with missing phone.
3. Try saving with no items.

Expected:

- the app shows validation messages
- invalid orders are not saved

### 6.6 Edit an order

Steps:

1. Edit an existing order.
2. Save changes.

Expected:

- changes persist

### 6.7 Delete an order

Steps:

1. Delete an order.

Expected:

- the order disappears

### 6.8 Mark complete

Steps:

1. Mark a pending order complete.

Expected:

- it moves out of the Pending filter
- it appears in Complete

### 6.9 Move complete order back to pending

Steps:

1. If the app allows it, move a complete order back to pending.

Expected:

- it returns to Pending

### 6.10 Print all pending

Steps:

1. Make sure there are multiple pending orders.
2. Use the print-all action.

Expected:

- the print flow starts without crashing

## 7. Voice Orders

### 7.1 Voice badge visibility

Steps:

1. Compare a voice-backed order and a manual order.

Expected:

- only the voice-backed order shows the Voice AI badge

### 7.2 Call Review button visibility

Steps:

1. Compare a voice-backed order and a manual order.

Expected:

- Call Review is shown only when voice-call review data exists

## 8. Call Review

### 8.1 Open Call Review

Steps:

1. Tap Call Review on a voice-backed order.

Expected:

- the review screen opens
- header details are visible

### 8.2 Transcript is visible and scrollable

Steps:

1. Open a review that has transcript text.
2. Scroll through it.

Expected:

- transcript messages are visible
- scrolling works
- agent and customer messages look different

### 8.3 Empty transcript state

Steps:

1. Open a review with no transcript.

Expected:

- a clear empty state is shown

### 8.4 Audio playback

Steps:

1. Open a review with audio.
2. Play the recording.
3. Stop or pause it.

Expected:

- audio plays correctly
- progress updates

### 8.5 Missing audio state

Steps:

1. Open a review with no recording.

Expected:

- the app handles it gracefully
- no crash occurs

## 9. Bill Preview and Printing

### 9.1 Open Bill Preview

Steps:

1. Tap Bill Preview on an order.

Expected:

- preview opens successfully
- restaurant name, order number, customer, items, and total are visible

### 9.2 Thermal bill appearance

Steps:

1. Inspect the preview visually.

Expected:

- it looks like a narrow printed bill

### 9.3 Print a single bill

Steps:

1. Print one order from preview or from the order actions.

Expected:

- print flow starts
- no crash occurs

### 9.4 Web print preview behavior

Steps:

1. Test printing in a browser.

Expected:

- bill content is correct
- if it appears on a larger page, the bill content itself should still remain correct and readable

## 10. ElevenLabs Agent Setup

### 10.1 Save API key locally

Steps:

1. Open the voice-agent section.
2. Enter a valid ElevenLabs API key.
3. Save it.
4. Leave and return to the same screen.

Expected:

- the key is shown in masked form
- it stays saved on the same device for that restaurant

### 10.2 Edit saved API key

Steps:

1. Edit the saved key.
2. Save it.

Expected:

- the updated masked key is shown

### 10.3 Create a new agent

Steps:

1. Use a valid saved API key with the permissions listed at the top of this document.
2. Tap Create Agent in ElevenLabs.

Expected:

- the app creates and links an agent
- linked-agent information updates on screen

### 10.4 Create a new agent even when one already exists

Steps:

1. On a restaurant that already has a linked agent, use Create Agent again.

Expected:

- the create option is still available

### 10.5 Link an existing agent

Steps:

1. Enter an existing agent ID.
2. Link it.

Expected:

- the existing agent is linked successfully

### 10.6 Invalid API key handling

Steps:

1. Try creating an agent with an invalid key.

Expected:

- the app shows a clear error
- the app remains usable

## 11. End-to-End Voice Ordering

Run this section only if the ElevenLabs environment is fully ready.

### 11.1 Live menu and stock response

Steps:

1. Use a linked agent for a restaurant with a valid menu.
2. Run a live or controlled call.
3. Ask about menu items and availability.

Expected:

- the agent responds based on the restaurant menu

### 11.2 Place a voice order

Steps:

1. Place a valid order during the call.

Expected:

- a new order appears in the app
- the order is correct

### 11.3 Post-call review context appears

Steps:

1. Finish the call.
2. Refresh the order list if needed.

Expected:

- the order appears as a voice-backed order
- call review becomes available when transcript or audio exists

## 12. Settings and Navigation

### 12.1 Open settings

Steps:

1. Open settings from the app.

Expected:

- settings opens correctly
- there is a clear way back

### 12.2 Move between POS and Admin

Steps:

1. Switch from POS to Admin.
2. Switch back to POS.

Expected:

- both directions work
- the user is never trapped on a screen

### 12.3 Sign out from settings

Steps:

1. Sign out from settings.

Expected:

- user returns to login

## 13. Visual and Layout Checks

### 13.1 Status bar and safe area

Steps:

1. Check the app on Android phone.
2. Check on iPhone or simulator if available.
3. Open POS, Admin, Call Review, and Bill Preview.

Expected:

- headers do not overlap the device status bar
- modal headers are fully visible

### 13.2 Tablet and wide layout

Steps:

1. Open the app on a tablet or wide screen.

Expected:

- layout remains usable
- content is not cramped or broken

### 13.3 Long text handling

Steps:

1. Test long restaurant names, customer names, notes, and menu item names.

Expected:

- layout remains stable
- key actions remain visible and tappable

## Suggested Bug Report Format

Include:

- screen name
- device and platform
- account used
- selected restaurant
- exact steps
- expected result
- actual result
- screenshot or recording
- whether the issue happens always or only sometimes

## Minimum Smoke Test for Every Build

If time is limited, verify these at minimum:

1. Login works
2. POS is the default landing screen
3. Restaurant loads correctly
4. Menu screen opens without freezing
5. Manual order can be created
6. Pending order can be marked complete
7. Bill Preview opens
8. Call Review opens for a voice-backed order
9. ElevenLabs API key can be saved locally
10. Sign out works
