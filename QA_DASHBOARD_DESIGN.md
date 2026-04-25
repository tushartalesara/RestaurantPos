# Task 2 — QA Dashboard, Billing & Audit System
### Complete Feature Specification + Team Task List

> **Scope:** Builds directly on `FEATURE_EXPLANATION.md`, `CODE_ARCHITECTURE.md`, and the new requirements:
> audit trail, AI error tracking, currency/country per restaurant, country-level tax table,
> per-restaurant service fee config, and tip/tax/service fee on the bill.
> Every schema design and task is grounded in these documented sources.

---

## Overview of What Is Being Built

Four interconnected systems that all feed into or are visible from the QA Dashboard:

| System | What It Does |
|---|---|
| **Audit Log** | Records every human-made change to orders, menus, and settings with before/after snapshots |
| **AI Correction Tracker** | When a human fixes an AI voice order, captures exactly what the AI got wrong and categorizes the error |
| **Billing Engine** | Adds tax (per country), service fee (per restaurant), and tip to every order's financial calculation |
| **QA Dashboard** | Surfaces all of the above in a read-only cross-restaurant auditor interface |

---

## Product Framing

### Problem Statement

RestaurantDemo already supports restaurant setup, menu management, manual orders, voice orders, delivery flows, payment settlement, call review, and printing. What it does not yet provide is a structured quality-control and billing-governance layer across restaurants.

This feature set exists to solve four business problems:

- there is no unified audit trail showing who changed important operational data and what changed
- there is no structured way to capture AI voice-order mistakes when a human fixes them
- there is no configurable billing model for country-specific tax, restaurant-specific service fee, and payment-time tip
- there is no QA-facing dashboard that lets an auditor review live activity, replay voice interactions, inspect corrections, and identify quality trends across restaurants

### Product Goal

Build a QA and billing control layer that makes RestaurantDemo:

- auditable
- explainable
- financially configurable per restaurant
- measurable in terms of AI quality over time

### Primary Users

| User | What They Need | Main Outcome |
|---|---|---|
| **QA Auditor** | Cross-restaurant visibility, replayable voice evidence, structured correction workflow, analytics | Identify AI mistakes, apply controlled corrections, and track quality trends |
| **Restaurant Owner / Admin** | Billing configuration and restaurant-level visibility into audit and correction history | Configure billing policy and monitor operational changes |
| **POS Staff / Waiter** | Clear bill breakdown and tip capture during payment settlement | Settle orders correctly and explain charges to customers |

### In Scope

- audit logging for key operational tables
- AI correction tracking for voice-originated orders
- country and currency configuration per restaurant
- country-level tax reference data
- per-restaurant service fee and tip configuration
- persisted billing breakdown on orders
- updated receipt and payment UX showing tax, service fee, and tip
- QA dashboard with Live Feed, Audit Log, AI Error Analytics, and AI Correction flow
- CSV export where called for in the dashboard design

### Out Of Scope

- customer-facing billing or customer self-service screens
- refunds, disputes, and chargeback workflows
- full accounting export or bookkeeping integration suite
- unrestricted QA write access to operational tables
- per-menu-item tax classification beyond the country and restaurant billing model described here
- broader staff-role redesign outside owner/admin, waiter/POS user, and QA auditor

---

## Product Requirements

These requirements define what the feature must achieve from a product point of view. The technical sections below are the implementation design that satisfies them.

### PR-1 Access and Role Boundaries

- The system must support a dedicated `qa_auditor` role with cross-restaurant read access to QA data.
- Restaurant owners must only see audit and correction data for their own restaurants.
- QA auditors must not receive broad direct write access to restaurant operational tables.
- Any QA write action must happen through an intentional, controlled workflow.

### PR-2 Auditability

- The system must record meaningful changes to orders, menus, and key settings.
- Audit history must show what changed, who performed the change, when it happened, which restaurant it affected, and which client surface initiated it.
- Audit history must support both per-record investigation and cross-restaurant review.
- Audit history must be queryable from one shared audit model rather than separate shadow tables per domain.

### PR-3 AI Correction Tracking

- When a human corrects a voice-originated order, the system must preserve both the AI version and the corrected human version.
- Each correction must capture one or more controlled error categories.
- Each correction must link back to the relevant conversation context when available, including transcript and recording references.
- Correction data must support aggregation and trend analysis over time.

### PR-4 Billing Configuration

- Each restaurant must have an explicit country and currency context.
- The system must support country-level default tax rates that can be selected or overridden per restaurant.
- Each restaurant must be able to configure service fee behavior independently.
- Each restaurant must be able to enable or disable tipping and define tip suggestions.
- The billing model must support both tax-exclusive and tax-inclusive presentation.

### PR-5 Stored Billing Breakdown

- Tax, service fee, and tip must be stored explicitly on the order, not inferred only at render time.
- Existing orders must remain readable after billing fields are introduced.
- Tip must be captured at payment settlement time rather than assumed at order creation time.
- Receipt rendering and dashboard rendering must use the stored order-level billing values.

### PR-6 Main App Billing UX

- Restaurant owners must be able to manage billing configuration from the main app.
- POS users must be able to see subtotal, tax, service fee, and total while handling an order.
- Payment settlement must support entering a tip when tipping is enabled.
- Bills and receipts must display the correct currency and fee labels for the restaurant.

### PR-7 QA Dashboard UX

- QA auditors must have a live, filterable, cross-restaurant order feed.
- QA auditors must be able to inspect order details, billing breakdown, and call-review context in one workflow.
- QA auditors must have a dedicated audit log view for before/after investigation.
- QA auditors must have an analytics view focused on AI error trends, not just raw order counts.
- The dashboard should remain primarily read-only except for the deliberate correction flow.

### PR-8 Reporting and Operations

- The system must support weekly or monthly AI quality review through analytics and export.
- The system must support tracing a correction from the dashboard back to the underlying order and audit events.
- The system must let an owner or auditor answer questions such as:
  - what changed on this order
  - who changed it
  - what the AI got wrong
  - how often that error happens
  - what fees and taxes contributed to the final total

### PR-9 Security and Data Integrity

- All new data models must respect existing restaurant ownership boundaries.
- Role-sensitive access must be enforced server-side, not trusted only from the client.
- Billing calculations that affect stored totals must happen in trusted backend paths.
- The correction workflow must leave an auditable trace of both the correction record and the resulting order mutation.

### PR-10 Usability and Trust

- Auditors must be able to understand an order and its voice evidence without leaving the QA workflow.
- Owners and staff must be able to explain charges to customers from the visible bill breakdown.
- Terminology used in billing and QA screens must stay consistent across the app, dashboard, and receipts.

---

## User Stories

### QA Auditor Stories

- As a QA auditor, I want to see a live feed of recent orders across restaurants so that I can quickly identify orders that need review.
- As a QA auditor, I want to filter the feed by restaurant, status, voice-only state, and date range so that I can focus on the right subset of orders.
- As a QA auditor, I want to open an order and see customer details, fulfillment details, billing breakdown, transcript, and recording in one place so that I can investigate issues efficiently.
- As a QA auditor, I want to flag exactly what the AI got wrong using a controlled list of error types so that reporting stays structured and comparable.
- As a QA auditor, I want to add free-text notes to a correction so that I can capture context that does not fit the controlled error taxonomy.
- As a QA auditor, I want a correction to preserve both the AI's original order snapshot and the human-corrected version so that later reviewers can understand the exact delta.
- As a QA auditor, I want the correction to be linked to the resulting audit event so that I can trace the correction through the system.
- As a QA auditor, I want to view an audit log with before/after data and changed fields so that I can understand who changed what and when.
- As a QA auditor, I want to see which AI mistakes are most common across restaurants so that I can prioritize model and prompt improvements.
- As a QA auditor, I want to export AI error analytics to CSV so that I can share weekly QA reports with the team.

### Restaurant Owner / Admin Stories

- As a restaurant owner, I want to configure my restaurant's country and currency so that all billing displays match the business location.
- As a restaurant owner, I want to choose the correct tax rule and tax presentation mode so that customer bills reflect local business policy.
- As a restaurant owner, I want to configure a service fee by flat amount or percentage so that the restaurant can apply its pricing policy consistently.
- As a restaurant owner, I want to enable tip suggestions for staff when appropriate so that gratuity can be captured cleanly during payment.
- As a restaurant owner, I want to view audit and correction history only for my own restaurants so that I can monitor operational changes without seeing other businesses' data.
- As a restaurant owner, I want receipts and order views to show tax, service fee, and tip clearly so that customers and staff can understand the final amount.

### POS Staff / Waiter Stories

- As a waiter, I want to see subtotal, tax, service fee, and total while working with an order so that I can explain the bill accurately.
- As a waiter, I want to add a tip during payment settlement when tipping is enabled so that the final paid amount is recorded correctly.
- As a waiter, I want the currency symbol and billing labels to match the restaurant configuration so that there is no confusion at the point of payment.

### Operations / Product Stories

- As a product or operations lead, I want AI correction data categorized consistently so that I can measure whether the voice-ordering system is improving.
- As a product or operations lead, I want audit coverage across key operational tables so that compliance, debugging, and dispute resolution are possible without manual reconstruction.
- As a product or operations lead, I want billing rules stored in configuration rather than hardcoded per restaurant so that the system can scale to multiple countries and brands.

---

## Part 1 — Audit Trail System

### Design Choice: Single Generic Table (Not Per-Table Shadows)

The recommended enterprise Postgres pattern is **one amorphous audit table** with JSONB `old_data`/`new_data` columns rather than duplicate shadow tables per domain table. This means:
- One migration to deploy, one table to query across the entire system
- Adding a new table to auditing requires only attaching a trigger, not a schema duplication
- Changed fields are queryable without joining multiple tables

The Postgres trigger reads a **session variable** (`app.current_user_id`) to capture the authenticated Supabase user — not the database role (which would just be `postgres` for everything). Edge Functions and client mutations must set this variable at the start of each transaction.

### Migration — `022_audit_trail.sql`

```sql
-- ── 1. Audit log table ───────────────────────────────────────────
CREATE TABLE audit_logs (
  id                BIGSERIAL     PRIMARY KEY,
  table_name        TEXT          NOT NULL,
  record_id         TEXT          NOT NULL,       -- PK of changed row (as text)
  action            TEXT          NOT NULL
                    CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data          JSONB,                        -- full row before change (NULL on INSERT)
  new_data          JSONB,                        -- full row after change  (NULL on DELETE)
  changed_fields    TEXT[],                       -- column names that actually changed (UPDATE only)
  performed_by      UUID,                         -- auth.uid() of the acting user
  performed_by_role TEXT,                         -- 'owner' | 'qa_auditor' | 'voice_agent' | 'system'
  restaurant_id     UUID,                         -- denormalized for fast per-restaurant queries
  performed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  client_app        TEXT                          -- 'pos_app' | 'admin_app' | 'qa_dashboard' | 'voice_tool'
);

-- Indexes for the three most common query patterns
CREATE INDEX idx_audit_table_record    ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_restaurant_time ON audit_logs(restaurant_id, performed_at DESC);
CREATE INDEX idx_audit_performed_by    ON audit_logs(performed_by);

-- ── 2. Session context setter (called by Edge Functions before writes) ──
CREATE OR REPLACE FUNCTION set_audit_context(
  p_user_id    UUID,
  p_role       TEXT,
  p_client_app TEXT
) RETURNS VOID AS $$
BEGIN
  PERFORM set_config('app.current_user_id',   p_user_id::TEXT, true);
  PERFORM set_config('app.current_user_role',  p_role,          true);
  PERFORM set_config('app.client_app',         p_client_app,    true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 3. Generic trigger function ──────────────────────────────────
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id    UUID;
  v_user_role  TEXT;
  v_client_app TEXT;
  v_record_id  TEXT;
  v_changed    TEXT[];
  v_old_json   JSONB;
  v_new_json   JSONB;
  v_restaurant UUID;
BEGIN
  BEGIN
    v_user_id    := current_setting('app.current_user_id',   true)::UUID;
    v_user_role  := current_setting('app.current_user_role',  true);
    v_client_app := current_setting('app.client_app',         true);
  EXCEPTION WHEN OTHERS THEN
    v_user_id := NULL;
  END;

  IF TG_OP = 'DELETE' THEN
    v_record_id  := (row_to_json(OLD) ->> 'id');
    v_restaurant := (row_to_json(OLD) ->> 'restaurant_id')::UUID;
    v_old_json   := to_jsonb(OLD);
    v_new_json   := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_record_id  := (row_to_json(NEW) ->> 'id');
    v_restaurant := (row_to_json(NEW) ->> 'restaurant_id')::UUID;
    v_old_json   := NULL;
    v_new_json   := to_jsonb(NEW);
  ELSE
    v_record_id  := (row_to_json(NEW) ->> 'id');
    v_restaurant := (row_to_json(NEW) ->> 'restaurant_id')::UUID;
    v_old_json   := to_jsonb(OLD);
    v_new_json   := to_jsonb(NEW);
    -- Calculate exactly which fields changed
    SELECT array_agg(key) INTO v_changed
    FROM (
      SELECT key FROM jsonb_each(v_new_json)
      WHERE value IS DISTINCT FROM (v_old_json -> key)
    ) diff;
  END IF;

  INSERT INTO audit_logs (
    table_name, record_id, action,
    old_data, new_data, changed_fields,
    performed_by, performed_by_role,
    restaurant_id, performed_at, client_app
  ) VALUES (
    TG_TABLE_NAME, v_record_id, TG_OP,
    v_old_json, v_new_json, v_changed,
    v_user_id, v_user_role,
    v_restaurant, now(), v_client_app
  );

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 4. Attach triggers to audited tables ─────────────────────────
CREATE TRIGGER audit_restaurant_orders
  AFTER INSERT OR UPDATE OR DELETE ON restaurant_orders
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_menu_items
  AFTER INSERT OR UPDATE OR DELETE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_restaurants
  AFTER UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_restaurant_order_items
  AFTER INSERT OR UPDATE OR DELETE ON restaurant_order_items
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- ── 5. RLS ────────────────────────────────────────────────────────
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "qa_auditor_read_all_audit_logs"
  ON audit_logs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'qa_auditor')
  );

CREATE POLICY "owner_read_own_audit_logs"
  ON audit_logs FOR SELECT
  USING (
    restaurant_id IN (SELECT id FROM restaurants WHERE owner_user_id = auth.uid())
  );
```

### Wiring Audit Context in Edge Functions

Every Edge Function that performs a write must call `set_audit_context` before writing:

```typescript
// supabase/functions/_shared/auditContext.ts
export const setAuditContext = async (
  client: SupabaseClient,
  userId: string,
  role: 'owner' | 'qa_auditor' | 'voice_agent' | 'system',
  clientApp: string
) => {
  await client.rpc('set_audit_context', {
    p_user_id: userId,
    p_role: role,
    p_client_app: clientApp,
  })
}

// Example usage at the top of place-order-atomic/index.ts:
await setAuditContext(supabase, userId, 'voice_agent', 'voice_tool')
// ... then proceed with the order RPC
```

---

## Part 2 — AI Voice Order Correction Tracker

### Purpose

When a QA auditor corrects an order that was placed by the voice AI, the system must:
1. Record what the AI originally placed (snapshot at correction time)
2. Record what the human changed it to
3. Categorize the type of AI error from a controlled vocabulary
4. Link the correction back to the conversation transcript and recording so the mistake can be replayed

This data feeds the **AI Error Analytics** view in the QA Dashboard.

### Migration — `023_order_corrections.sql`

```sql
CREATE TABLE order_corrections (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id             UUID        NOT NULL REFERENCES restaurant_orders(id),
  restaurant_id        UUID        NOT NULL REFERENCES restaurants(id),
  conversation_id      TEXT,                    -- links to post_call_webhooks.conversation_id
  corrected_by         UUID        NOT NULL,    -- auth.uid() of the human who corrected
  corrected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  ai_order_snapshot    JSONB       NOT NULL,    -- order + items as they were when human intervened
  human_order_snapshot JSONB       NOT NULL,    -- order + items after human fix

  error_types          TEXT[]      NOT NULL,    -- one or more from the controlled list below
  -- Controlled vocabulary:
  --   'wrong_item'           AI selected wrong menu item
  --   'wrong_quantity'       AI got quantity wrong
  --   'wrong_customization'  AI missed or misheard a customization
  --   'wrong_address'        Delivery address incorrect
  --   'wrong_postcode'       Postcode incorrect
  --   'wrong_fulfillment'    Pickup vs delivery confused
  --   'wrong_customer_name'  Name misheard
  --   'wrong_phone'          Phone number incorrect
  --   'missed_item'          AI did not capture an item the customer ordered
  --   'phantom_item'         AI added an item the customer did not order
  --   'other'

  notes                TEXT,                   -- free-text explanation from the auditor
  audit_log_id         BIGINT REFERENCES audit_logs(id)  -- link to the resulting audit row
);

CREATE INDEX idx_corrections_order      ON order_corrections(order_id);
CREATE INDEX idx_corrections_restaurant ON order_corrections(restaurant_id, corrected_at DESC);
CREATE INDEX idx_corrections_conv       ON order_corrections(conversation_id);
CREATE INDEX idx_corrections_error_type ON order_corrections USING GIN(error_types);

ALTER TABLE order_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "qa_auditor_read_corrections"
  ON order_corrections FOR SELECT
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'qa_auditor'));

CREATE POLICY "qa_auditor_insert_corrections"
  ON order_corrections FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'qa_auditor'));

CREATE POLICY "owner_read_own_corrections"
  ON order_corrections FOR SELECT
  USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_user_id = auth.uid()));

-- ── AI Error Analytics View ───────────────────────────────────────
CREATE VIEW ai_error_analytics AS
SELECT
  oc.restaurant_id,
  r.name                              AS restaurant_name,
  unnest(oc.error_types)              AS error_type,
  COUNT(*)                            AS occurrence_count,
  date_trunc('week', oc.corrected_at) AS week
FROM order_corrections oc
JOIN restaurants r ON r.id = oc.restaurant_id
GROUP BY oc.restaurant_id, r.name, error_type, week
ORDER BY week DESC, occurrence_count DESC;

GRANT SELECT ON ai_error_analytics TO authenticated;
```

---

## Part 3 — Billing Engine (Tax + Service Fee + Tip)

### Design Principles

The billing system is structured so that:
- **Tax** is determined by the restaurant's country and stored as a reference table you maintain
- **Service fee** is configured per restaurant (percent or flat amount)
- **Tip** is captured at payment settlement time — it is not known at order creation
- All three amounts are stored explicitly on the order (not recalculated at display time)
- The bill calculation order is: Subtotal → Tax → Service Fee → (Tip at payment)

For the UK market (your primary market), VAT on hot food in restaurants is 20% and is commonly **tax-exclusive** (added on top of displayed prices). This is the default. Tax-inclusive mode is supported for markets where menu prices already include VAT/GST.

### Migration — `024_restaurant_billing_fields.sql`

```sql
-- ── 1. Add country and currency to restaurants ────────────────────
ALTER TABLE restaurants
  ADD COLUMN country_code  TEXT NOT NULL DEFAULT 'GB'
    CHECK (char_length(country_code) = 2),   -- ISO 3166-1 alpha-2
  ADD COLUMN currency_code TEXT NOT NULL DEFAULT 'GBP'
    CHECK (char_length(currency_code) = 3);  -- ISO 4217

-- ── 2. Country tax rates reference table ─────────────────────────
CREATE TABLE country_tax_rates (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  country_code   TEXT         NOT NULL CHECK (char_length(country_code) = 2),
  tax_name       TEXT         NOT NULL,     -- 'VAT', 'GST', 'Sales Tax'
  rate_percent   NUMERIC(5,2) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  is_default     BOOLEAN      NOT NULL DEFAULT false,
  effective_from DATE         NOT NULL DEFAULT CURRENT_DATE,
  notes          TEXT,
  UNIQUE (country_code, tax_name, effective_from)
);

-- Seed data for common markets (verify rates before production)
INSERT INTO country_tax_rates
  (country_code, tax_name, rate_percent, is_default, notes)
VALUES
  ('GB', 'VAT',          20.00, true,  'Standard UK VAT — hot food and drinks in restaurants'),
  ('GB', 'VAT Zero',      0.00, false, 'Zero-rated — cold takeaway food'),
  ('US', 'Sales Tax',     8.875,true,  'Example: New York City combined rate. Override per restaurant.'),
  ('IN', 'GST',           5.00, true,  'Standard GST for restaurant services'),
  ('AE', 'VAT',           5.00, true,  'UAE standard VAT rate'),
  ('AU', 'GST',          10.00, true,  'Australian GST standard rate'),
  ('CA', 'HST',          13.00, true,  'Ontario HST — confirm province per restaurant');

ALTER TABLE country_tax_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anyone_read_tax_rates"
  ON country_tax_rates FOR SELECT TO authenticated USING (true);

-- ── 3. Per-restaurant billing config ─────────────────────────────
CREATE TABLE restaurant_billing_config (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       UUID         NOT NULL UNIQUE REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Tax
  tax_rate_id         UUID         REFERENCES country_tax_rates(id),
  tax_rate_override   NUMERIC(5,2),    -- set this for US local rates or special cases
  tax_inclusive       BOOLEAN      NOT NULL DEFAULT false,
  tax_label           TEXT         NOT NULL DEFAULT 'VAT',   -- displayed on receipt

  -- Service fee
  service_fee_enabled BOOLEAN      NOT NULL DEFAULT false,
  service_fee_type    TEXT         CHECK (service_fee_type IN ('percent', 'flat')),
  service_fee_value   NUMERIC(8,2),
  service_fee_label   TEXT         NOT NULL DEFAULT 'Service Charge',

  -- Tip
  tip_enabled         BOOLEAN      NOT NULL DEFAULT false,
  tip_suggestions     NUMERIC[]    NOT NULL DEFAULT ARRAY[10, 12.5, 15, 20],
  tip_label           TEXT         NOT NULL DEFAULT 'Gratuity',

  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE restaurant_billing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_manage_billing_config"
  ON restaurant_billing_config FOR ALL
  USING (restaurant_id IN (SELECT id FROM restaurants WHERE owner_user_id = auth.uid()));

CREATE POLICY "qa_auditor_read_billing_config"
  ON restaurant_billing_config FOR SELECT
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'qa_auditor'));
```

### Migration — `025_order_billing_fields.sql`

```sql
ALTER TABLE restaurant_orders
  ADD COLUMN subtotal_amount    NUMERIC(10,2),
  ADD COLUMN tax_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN tax_rate_percent   NUMERIC(5,2)  NOT NULL DEFAULT 0,
  ADD COLUMN tax_inclusive      BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN tax_label          TEXT          NOT NULL DEFAULT 'VAT',
  ADD COLUMN service_fee_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN service_fee_label  TEXT          NOT NULL DEFAULT 'Service Charge',
  ADD COLUMN tip_amount         NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN currency_code      TEXT          NOT NULL DEFAULT 'GBP';

-- Backfill existing orders: treat existing total_price as subtotal
UPDATE restaurant_orders
  SET subtotal_amount = total_price
  WHERE subtotal_amount IS NULL;
```

### Bill Calculation Order

```
Subtotal          = sum of (item_price × qty) across all order items
──────────────────────────────────────────────────────────────────────
Tax (exclusive)   = subtotal × (rate / 100)            [most common — add on top]
Tax (inclusive)   = subtotal × rate / (100 + rate)     [extract embedded tax for display]
Service Fee       = subtotal × (fee_value / 100)        [if type = 'percent']
                  = fee_value                            [if type = 'flat']
Tip               = customer-chosen at payment time     [not known at order creation]
──────────────────────────────────────────────────────────────────────
Grand Total       = subtotal + tax (if exclusive) + service_fee + tip
```

### Receipt Line Item Display

```
  Chicken Tikka Masala x2    £18.00
  Garlic Naan x1              £3.50
  ──────────────────────────────────
  Subtotal                   £21.50
  VAT (20%)                   £4.30
  Service Charge (12.5%)      £2.69
  ──────────────────────────────────
  Total before tip           £28.49
  Gratuity                    £4.30   ← added after payment settlement
  ──────────────────────────────────
  TOTAL                      £32.79
```

Tip is added to the receipt only after payment is settled (`tip_amount > 0`).

---

## Part 4 — QA Dashboard (Updated)

The core architecture from the original Task 2 spec (separate Vite/React app, Supabase Realtime feed, `qa_order_feed` view, role-based RLS) is unchanged. The updates below add the new panels required by the audit and billing features.

### Updated `qa_order_feed` View

```sql
-- Update view to include billing fields (from migration 025)
CREATE OR REPLACE VIEW qa_order_feed AS
SELECT
  o.id, o.restaurant_id, o.short_order_code, o.status, o.created_at,
  o.customer_name, o.customer_phone,
  o.fulfillment_type, o.delivery_postcode, o.delivery_address,
  o.payment_collection, o.payment_status, o.payment_method,
  -- Billing breakdown
  o.subtotal_amount, o.tax_amount, o.tax_rate_percent,
  o.tax_inclusive, o.tax_label,
  o.service_fee_amount, o.service_fee_label,
  o.tip_amount, o.total_price, o.currency_code,
  o.notes,
  r.name         AS restaurant_name,
  r.currency_code AS restaurant_currency,
  -- Call review summary
  pcw.id              AS webhook_id,
  pcw.analysis_status AS call_analysis_status,
  pcw.conversation_id,
  (pcw.id IS NOT NULL)               AS has_call_review,
  (pcw.recording_path IS NOT NULL)   AS has_recording,
  -- Correction flag
  (oc.id IS NOT NULL)                AS has_correction
FROM restaurant_orders o
JOIN restaurants r        ON r.id = o.restaurant_id
LEFT JOIN post_call_webhooks pcw ON pcw.order_id = o.id
LEFT JOIN order_corrections oc   ON oc.order_id  = o.id
ORDER BY o.created_at DESC;

GRANT SELECT ON qa_order_feed TO authenticated;
```

### Dashboard Layout — Full 3-Panel View

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  RESTAURANTDEMO — QA DASHBOARD                              [Auditor: name] [⏻]  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  [📋 Live Feed]  [📜 Audit Log]  [🤖 AI Errors]                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│  [All Restaurants ▼]  [All Status ▼]  [🎙 Voice Only □]  [🔍 Search...]          │
│  ● LIVE  ·  47 orders today                                                      │
├─────────────────────────┬────────────────────────────────────────────────────────┤
│  LIVE FEED              │  ORDER #042  ·  Riverside Grill  ·  PENDING            │
│  ──────────────────     │  ──────────────────────────────────────────────────    │
│  #042  2 min ago    ●   │  John Smith  ·  07700 900000                           │
│  🎙 VOICE · DELIVERY    │  DELIVERY  ·  COD  ·  12 High St, EC1A 1BB             │
│  John Smith             │                                                        │
│  Riverside Grill        │  Chicken Tikka Masala x2    £18.00                    │
│  ✏️ Corrected           │  Garlic Naan x1              £3.50                    │
│  ──────────────────     │  ─────────────────────────────────                    │
│  #041  5 min ago        │  Subtotal                   £21.50                    │
│  MANUAL · PICKUP        │  VAT (20%)                   £4.30                    │
│  Sarah Jones            │  Service Charge (12.5%)      £2.69                    │
│  The Curry House        │  ─────────────────────────────────                    │
│  ──────────────────     │  Total (excl. tip)          £28.49                    │
│  #040  8 min ago        │                                                        │
│  🎙 VOICE · PICKUP      │  ── CALL REVIEW ──────────────────────────────────    │
│  [closed]               │  Analysis: COMPLETE  ·  🎙 Recording available        │
│  ──────────────────     │                                                        │
│                         │  Agent:     "Is this pickup or delivery?"              │
│  [Load more...]         │  Customer:  "Delivery please"                          │
│                         │  Agent:     "What's your postcode?"                    │
│                         │  Customer:  "E C 1 A 1 B B"                           │
│                         │  ...                                                   │
│                         │                                                        │
│                         │  ▶ 0:00 ─────────────────────── 2:34                  │
│                         │                                                        │
│                         │         [🚩 Flag AI Error]                             │
└─────────────────────────┴────────────────────────────────────────────────────────┘
```

### Audit Log Tab

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  AUDIT LOG                                                                       │
│  [All Tables ▼]  [All Actions ▼]  [All Restaurants ▼]  [Date Range...]          │
├────────────────────┬────────┬───────────────────┬──────────────┬─────────────────┤
│ Table              │ Action │ Changed By         │ When         │ Fields Changed  │
├────────────────────┼────────┼───────────────────┼──────────────┼─────────────────┤
│ restaurant_orders  │ UPDATE │ qa_auditor         │ 2 min ago    │ status, items   │
│ restaurant_orders  │ INSERT │ voice_agent        │ 4 min ago    │ [new order]     │
│ menu_items         │ UPDATE │ owner              │ 1 hr ago     │ stock_quantity  │
│ restaurant_orders  │ UPDATE │ owner              │ 2 hrs ago    │ payment_status  │
└────────────────────┴────────┴───────────────────┴──────────────┴─────────────────┘
  ↓ Click any row to expand full before/after diff:

  CHANGED FIELDS — restaurant_orders #042
  ┌─────────────────────┬──────────────────────┬──────────────────────┐
  │ Field               │ Before               │ After                │
  ├─────────────────────┼──────────────────────┼──────────────────────┤
  │ status         🟡   │ "pending"            │ "closed"             │
  │ total_price    🟡   │ 21.50                │ 28.49                │
  │ tax_amount     🟢   │ [null]               │ 4.30                 │
  └─────────────────────┴──────────────────────┴──────────────────────┘
```

### AI Error Analytics Tab

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  AI ERROR ANALYTICS  ·  [This Week ▼]  ·  [All Restaurants ▼]   [Export CSV]   │
│                                                                                  │
│  Most Common AI Errors:                                                          │
│  ──────────────────────────────────────────────────────────────                 │
│  Wrong Quantity         ████████████████████████  24 occurrences                │
│  Missed Item            ██████████████             9 occurrences                │
│  Wrong Address          ████████████               7 occurrences                │
│  Wrong Customer Name    ██████                     3 occurrences                │
│  Wrong Fulfillment      ████                       2 occurrences                │
│  Phantom Item           ██                         1 occurrence                 │
│                                                                                  │
│  By Restaurant:                                                                  │
│  Riverside Grill     ████████████████  18 errors                                │
│  The Curry House     ████████           9 errors                                │
│  Mango Tree          ████               4 errors                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### AI Correction Modal

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  FLAG AI ERROR  ·  Order #042  ·  Riverside Grill                               │
│                                                                                  │
│  AI placed this order:                                                           │
│    Chicken Tikka Masala x2  ·  Garlic Naan x1                                   │
│                                                                                  │
│  What errors did the AI make?                                                    │
│  [✓] Wrong Quantity        [ ] Wrong Item          [ ] Missed Item              │
│  [ ] Phantom Item          [ ] Wrong Address       [ ] Wrong Postcode           │
│  [ ] Wrong Fulfillment     [ ] Wrong Customer Name [ ] Wrong Phone              │
│  [ ] Other                                                                       │
│                                                                                  │
│  Notes (optional):                                                               │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ Customer said 3 portions at 1:24 in transcript, AI wrote 2               │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
│                                     [Cancel]  [Submit & Apply Correction]        │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Part 5 — Complete Team Task List

Every task is labeled for **Person A** (backend/database focus) or **Person B** (frontend/UI focus), with complexity rating (S/M/L) and dependencies.

---

### 🗃️ BACKEND TRACK — Person A

#### Sprint 1: Database Migrations

| # | Task | Size | Depends On |
|---|---|---|---|
| **B1** | Write and deploy `022_audit_trail.sql` — `audit_logs` table, `audit_trigger_function`, `set_audit_context` RPC, triggers on `restaurant_orders`, `menu_items`, `restaurants`, `restaurant_order_items` | M | — |
| **B2** | Write and deploy `023_order_corrections.sql` — `order_corrections` table, `ai_error_analytics` view, all RLS policies | S | B1 |
| **B3** | Write and deploy `024_restaurant_billing_fields.sql` — `country_code`/`currency_code` on `restaurants`, `country_tax_rates` table with seed data, `restaurant_billing_config` table | M | — |
| **B4** | Write and deploy `025_order_billing_fields.sql` — billing columns on `restaurant_orders`, backfill existing rows with `subtotal_amount = total_price` | S | B3 |
| **B5** | Write and deploy `026_update_order_rpcs_billing.sql` — update `place_voice_order_atomic` and `save_manual_order_atomic` to read `restaurant_billing_config`, calculate and store `tax_amount`, `service_fee_amount`, `subtotal_amount`, `currency_code` on each order | L | B3, B4 |
| **B6** | Write and deploy `020_user_profiles.sql` + `021_qa_order_feed_view.sql` from original Task 2 spec (if not yet done), update `qa_order_feed` view to include new billing fields and `has_correction` flag | S | B4 |

#### Sprint 2: Edge Functions

| # | Task | Size | Depends On |
|---|---|---|---|
| **B7** | Create shared `supabase/functions/_shared/auditContext.ts` helper — exports `setAuditContext()` function | S | B1 |
| **B8** | Update `place-order-atomic`, `save_manual_order_atomic`, and `update-order-payment-status` Edge Functions to call `setAuditContext` before each write, with correct `performed_by_role` and `client_app` values | S | B7 |
| **B9** | Update `elevenlabs-post-call` Edge Function to call `setAuditContext` with `role = 'voice_agent'` before any order linkage writes | S | B7 |
| **B10** | Update `update-order-payment-status` Edge Function to accept and store `tip_amount` — add to payment settlement payload, store on `restaurant_orders`, recalculate `total_price` | S | B4 |
| **B11** | Create new Edge Function `save-order-correction` — validates caller is `qa_auditor`, takes order correction payload, applies edit to `restaurant_orders`, inserts into `order_corrections`, returns the linked `audit_log_id` | M | B1, B2, B8 |
| **B12** | Create new Edge Function `get-billing-config` — returns merged billing config for a restaurant: resolved tax rate (override or from `country_tax_rates`), service fee settings, tip suggestions | S | B3 |

#### Sprint 3: Main App Backend (db.ts + types)

| # | Task | Size | Depends On |
|---|---|---|---|
| **B13** | Add to `src/db.ts`: `getBillingConfig(restaurantId)`, `saveBillingConfig(config)`, `getCountryTaxRates(countryCode)` | S | B3, B12 |
| **B14** | Update `src/types/index.ts` with new types: `BillingConfig`, `CountryTaxRate`, `RestaurantBillingConfig`, `OrderCorrection`, `AuditLogEntry`, `AuditLogDetail` | S | B3, B2 |

---

### 🖥️ FRONTEND TRACK — Person B

#### Sprint 1: Main App Billing UI

| # | Task | Size | Depends On |
|---|---|---|---|
| **F1** | Build **Billing Config screen** as new Admin tab — country selector (dropdown with country name + flag), currency display, tax rate selector (from `country_tax_rates` for selected country), manual rate override input, tax-inclusive toggle, service fee toggle and config (type/value/label), tip toggle and suggestion presets | M | B3, B13 |
| **F2** | Update `src/utils/receiptContent.tsx` — replace single `total_price` line with subtotal → tax (with % and label) → service fee (with label) → tip (when > 0) → grand total; use `currency_code` for currency symbol | M | B4, B5 |
| **F3** | Update `src/utils/printUtils.ts` — ensure new billing rows render correctly in print HTML, currency symbol is correct | S | F2 |
| **F4** | Update manual order creation modal (`AppRoot.tsx`) — show running subtotal, estimated tax, and service fee as items are added to the order | M | B5, B13 |
| **F5** | Update payment settlement modal — add **tip entry step**: show tip-enabled flag from billing config, display tip percentage buttons (from `tip_suggestions`), custom amount input, calculate tip on subtotal, pass `tip_amount` to `update-order-payment-status` Edge Function | M | B10, B13 |
| **F6** | Update order card `total_price` display to use `currency_code` symbol (£, $, ₹, AED, etc.) from the restaurant's config | S | B4 |

#### Sprint 2: QA Dashboard Core

| # | Task | Size | Depends On |
|---|---|---|---|
| **F7** | Scaffold QA Dashboard as a separate Vite + React + TypeScript project — Supabase client setup, auth gate (email/password login), role check on boot (`user_profiles.role = 'qa_auditor'`), three-tab routing (Live Feed, Audit Log, AI Errors) | S | B6 |
| **F8** | Build `useQAFeed` hook — initial load from `qa_order_feed` view, Supabase Realtime subscriptions on `restaurant_orders` and `post_call_webhooks`, cursor-based pagination | M | F7, B6 |
| **F9** | Build **Feed Column** component — order cards with: short code, restaurant name, status badge, fulfillment badge (DELIVERY/PICKUP), voice badge (🎙 when `has_call_review`), correction badge (✏️ when `has_correction`), payment badge, customer name, time ago | M | F8 |
| **F10** | Build **Filter Bar** — restaurant multi-select, status filter (all/pending/closed), voice-only toggle, date range picker | S | F9 |
| **F11** | Build **Order Detail Panel** — order header (code, restaurant, status), customer info (name, phone, address when delivery), billing breakdown (subtotal, tax with %, service fee with label, tip, total in correct currency), notes, line items with quantities and prices | M | F8 |
| **F12** | Build **Call Review Section** — agent vs customer transcript in conversational layout (two-column bubble style), audio player with playback position, analysis status badge, graceful fallback when transcript or recording is absent (matches `CallReviewModal.tsx` behavior in main app) | L | F11 |

#### Sprint 3: QA Dashboard — Audit and Correction Features

| # | Task | Size | Depends On |
|---|---|---|---|
| **F13** | Build **AI Correction Modal** — triggered by "Flag AI Error" button on voice orders; shows AI-placed order snapshot, error type checklist (all values from `error_types` enum), free-text notes, calls `save-order-correction` Edge Function on submit | M | B11, F12 |
| **F14** | Build **Audit Log Tab** — paginated table of `audit_logs` with columns: table name, action (color-coded INSERT/UPDATE/DELETE), performed by role, restaurant, timestamp, fields changed; expandable row showing full before/after diff | M | B1, F7 |
| **F15** | Build **Before/After Diff Viewer** component — renders two JSONB objects side-by-side, highlights changed fields in yellow, new fields in green, removed fields in red; used inside Audit Log row expansion | S | F14 |
| **F16** | Build **AI Error Analytics Tab** — bar chart (recharts) of error types by frequency, restaurant filter, week/month selector, summary stats (total corrections, most error-prone restaurant, most common error type), export to CSV button | M | B2, F7 |
| **F17** | Add billing summary section to Order Detail Panel — subtotal, tax line (label + %), service fee line (label), tip line (when > 0), grand total; all using `currency_code` | S | F11, B4 |

---

### 🔄 INTEGRATION TASKS (Either Person)

| # | Task | Size | Depends On |
|---|---|---|---|
| **I1** | End-to-end test: place a voice order → verify `audit_logs` row exists with `performed_by_role = 'voice_agent'` → verify billing amounts (tax, service fee) stored correctly on the order | M | B5, B8, B9 |
| **I2** | End-to-end test: restaurant owner edits an order in Admin → verify `audit_logs` row has correct `changed_fields` and `old_data`/`new_data` snapshots | S | B1, B8 |
| **I3** | End-to-end test: QA auditor opens Correction Modal → submits → verify `order_corrections` row created → verify linked `audit_logs` row exists → verify `ai_error_analytics` view updates | M | B11, F13 |
| **I4** | Receipt rendering test for 4 scenarios: (a) UK tax-exclusive restaurant with service fee and tip, (b) US tax-exclusive restaurant no service fee, (c) India GST tax-exclusive, (d) zero-tax restaurant | M | F2, B5 |
| **I5** | RLS security test: confirm QA auditor account cannot INSERT/UPDATE/DELETE on `restaurant_orders`, `menu_items`, `restaurants`, or `restaurant_billing_config` | S | B1–B6 |
| **I6** | Deploy QA Dashboard to Vercel, configure Supabase Auth allowed redirect URLs, provision first QA auditor account via Supabase Auth Admin API | S | F7–F16 |

---

### 📅 Suggested 3-Week Sprint Plan

```
WEEK 1 — Database and main app foundations
  Person A:  B1, B2, B3, B4     (all 4 database migrations)
  Person B:  F1, F2, F3         (billing config screen + receipt update in main app)
  
WEEK 2 — Logic and QA scaffold
  Person A:  B5, B6, B7, B8, B9, B10, B11, B12   (RPCs + Edge Functions)
  Person B:  F4, F5, F6, F7, F8, F9, F10          (order UI updates + QA dashboard core)

WEEK 3 — QA dashboard features + integration
  Person A:  B13, B14, I1, I2, I5, I6              (db.ts + types + integration tests)
  Person B:  F11, F12, F13, F14, F15, F16, F17     (detail panel + correction + analytics)
  Both:      I3, I4                                  (end-to-end correction + receipt tests)
```

---

## Complete New Migration List

Picks up from your existing `015_harden_active_short_order_codes.sql` and the Task 1 migrations `016`–`021`:

| Migration File | Contents |
|---|---|
| `022_audit_trail.sql` | `audit_logs` table, `set_audit_context` RPC, `audit_trigger_function`, triggers on 4 tables, RLS |
| `023_order_corrections.sql` | `order_corrections` table, `ai_error_analytics` view, RLS policies |
| `024_restaurant_billing_fields.sql` | `country_code`/`currency_code` on restaurants, `country_tax_rates` with seed data, `restaurant_billing_config` |
| `025_order_billing_fields.sql` | Billing columns on `restaurant_orders`, backfill of existing rows |
| `026_update_order_rpcs_billing.sql` | Updated `place_voice_order_atomic` and `save_manual_order_atomic` with billing calculation logic |

---

## Feature-to-Component Matrix

| New Feature | Migrations | Edge Functions | Main App | QA Dashboard |
|---|---|---|---|---|
| Audit trail | 022 | B8, B9 (update all writers) | None (passive) | Audit Log Tab (F14, F15) |
| AI correction tracking | 023 | B11 (new) | None | Correction Modal (F13), Analytics (F16) |
| Currency + country | 024 | B12 | Billing Config (F1), order cards (F6) | Order detail (F17) |
| Country tax rates | 024 | B12 | Billing Config (F1) | Order detail (F17) |
| Service fee config | 024 | B12 | Billing Config (F1) | Order detail (F17) |
| Tax on bill | 025, 026 | B5 (update RPCs) | Receipt (F2, F3), order modal (F4) | Order detail (F17) |
| Service fee on bill | 025, 026 | B5 (update RPCs) | Receipt (F2, F3), order modal (F4) | Order detail (F17) |
| Tip on bill | 025 | B10 (update payment) | Payment modal (F5) | Order detail (F17) |
