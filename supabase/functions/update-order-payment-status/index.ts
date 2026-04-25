// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"
import { compare } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  })
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizePaymentStatus(value: unknown): "unpaid" | "paid" {
  return normalizeString(value).toLowerCase() === "paid" ? "paid" : "unpaid"
}

function normalizePaymentMethod(value: unknown): "cash" | "card" | null {
  const normalized = normalizeString(value).toLowerCase()
  if (normalized === "cash" || normalized === "card") {
    return normalized
  }
  return null
}

function normalizePositiveNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, value)
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed)
    }
  }
  return 0
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

async function resolveUserId(request: Request, supabaseUrl: string, supabaseAnonKey: string) {
  const authHeader =
    normalizeString(request.headers.get("Authorization")) || normalizeString(request.headers.get("authorization"))
  if (!authHeader) {
    return ""
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })

  const authResult = await authClient.auth.getUser()
  if (authResult.error) {
    throw new Error(authResult.error.message)
  }

  return normalizeString(authResult.data.user?.id)
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseAnonKey = normalizeString(Deno.env.get("SUPABASE_ANON_KEY"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase function environment is incomplete." })
  }

  let userId = ""
  try {
    userId = await resolveUserId(request, supabaseUrl, supabaseAnonKey)
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : "Unauthorized." })
  }

  if (!userId) {
    return jsonResponse(401, { error: "Unauthorized." })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Body must be a JSON object." })
  }

  const bodyObj = body as Record<string, unknown>
  const restaurantId = normalizeString(bodyObj.restaurant_id)
  const orderId = normalizeString(bodyObj.order_id)
  const pin = normalizeString(bodyObj.pin)
  const paymentStatus = normalizePaymentStatus(bodyObj.payment_status)
  const paymentMethod = normalizePaymentMethod(bodyObj.payment_method)
  const cardTransactionId = normalizeString(bodyObj.card_transaction_id)
  const tipAmount = roundMoney(normalizePositiveNumber(bodyObj.tip_amount))

  if (!restaurantId) {
    return jsonResponse(400, { error: "restaurant_id is required." })
  }
  if (!orderId) {
    return jsonResponse(400, { error: "order_id is required." })
  }
  if (!pin) {
    return jsonResponse(400, { error: "pin is required." })
  }
  if (paymentStatus === "paid" && !paymentMethod) {
    return jsonResponse(400, { error: "Choose cash or card before marking the order as paid." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const restaurantLookup = await supabase
    .from("restaurants")
    .select("id, payment_pin_hash")
    .eq("id", restaurantId)
    .eq("owner_user_id", userId)
    .maybeSingle()

  if (restaurantLookup.error) {
    const message = normalizeString(restaurantLookup.error.message)
    if (message.toLowerCase().includes("payment_pin_hash")) {
      return jsonResponse(500, {
        error: message || "Per-restaurant payment PIN fields are missing.",
        remediation: "Run supabase/021_scalability_payment_and_indexes.sql in Supabase SQL Editor, then retry.",
      })
    }
    return jsonResponse(500, { error: restaurantLookup.error.message })
  }
  if (!restaurantLookup.data?.id) {
    return jsonResponse(403, { error: "You do not have access to this restaurant." })
  }

  const paymentPinHash = normalizeString(restaurantLookup.data.payment_pin_hash)
  if (!paymentPinHash) {
    return jsonResponse(403, {
      error: "No payment PIN is configured for this restaurant yet.",
      remediation: "Open Admin settings and save a restaurant-specific payment PIN first.",
    })
  }

  const pinValid = await compare(pin, paymentPinHash).catch(() => false)
  if (!pinValid) {
    return jsonResponse(403, { error: "Incorrect PIN." })
  }

  const orderLookup = await supabase
    .from("restaurant_orders")
    .select("id, subtotal_amount, tax_amount, tax_inclusive, service_fee_amount, tip_label")
    .eq("id", orderId)
    .eq("restaurant_id", restaurantId)
    .maybeSingle()

  if (orderLookup.error) {
    const message = normalizeString(orderLookup.error.message)
    const lower = message.toLowerCase()

    if (
      lower.includes("subtotal_amount") ||
      lower.includes("tax_amount") ||
      lower.includes("service_fee_amount") ||
      lower.includes("tip_label")
    ) {
      return jsonResponse(500, {
        error: message || "Order billing fields are missing.",
        remediation:
          "Run supabase/016_restaurant_billing_fields.sql, supabase/017_order_billing_fields.sql, and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then retry.",
      })
    }

    return jsonResponse(500, { error: message || "Failed to load order billing." })
  }

  if (!orderLookup.data?.id) {
    return jsonResponse(404, { error: "Order not found for this restaurant." })
  }

  const billingConfigLookup = await supabase
    .from("restaurant_billing_config")
    .select("tip_label")
    .eq("restaurant_id", restaurantId)
    .maybeSingle()

  if (billingConfigLookup.error) {
    const message = normalizeString(billingConfigLookup.error.message)
    const lower = message.toLowerCase()

    if (lower.includes("restaurant_billing_config")) {
      return jsonResponse(500, {
        error: message || "Billing configuration is missing.",
        remediation:
          "Run supabase/016_restaurant_billing_fields.sql, supabase/017_order_billing_fields.sql, and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then retry.",
      })
    }
  }

  const subtotalAmount = normalizePositiveNumber(orderLookup.data.subtotal_amount)
  const taxAmount = normalizePositiveNumber(orderLookup.data.tax_amount)
  const taxInclusive = Boolean(orderLookup.data.tax_inclusive)
  const serviceFeeAmount = normalizePositiveNumber(orderLookup.data.service_fee_amount)
  const nextTipAmount = paymentStatus === "paid" ? tipAmount : 0
  const totalBeforeTip = roundMoney(subtotalAmount + serviceFeeAmount + (taxInclusive ? 0 : taxAmount))
  const nextTotalPrice = roundMoney(totalBeforeTip + nextTipAmount)
  const tipLabel =
    normalizeString(billingConfigLookup.data?.tip_label) ||
    normalizeString(orderLookup.data.tip_label) ||
    "Gratuity"

  const updateResult = await supabase
    .from("restaurant_orders")
    .update({
      payment_status: paymentStatus,
      payment_method: paymentStatus === "paid" ? paymentMethod : null,
      card_transaction_id: paymentStatus === "paid" && paymentMethod === "card" ? cardTransactionId || null : null,
      tip_amount: nextTipAmount,
      tip_label: tipLabel,
      total_price: nextTotalPrice,
      payment_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("restaurant_id", restaurantId)
    .select("id, payment_status, payment_method, card_transaction_id, tip_amount")
    .maybeSingle()

  if (updateResult.error) {
    const message = normalizeString(updateResult.error.message)
    const lower = message.toLowerCase()

    if (
      lower.includes("payment_status") ||
      lower.includes("payment_method") ||
      lower.includes("card_transaction_id")
    ) {
      return jsonResponse(500, {
        error: message || "Order payment fields are missing.",
        remediation: "Run supabase/014_order_payment_settlement.sql in Supabase SQL Editor, then retry.",
      })
    }
    if (
      lower.includes("tip_amount") ||
      lower.includes("tip_label") ||
      lower.includes("subtotal_amount") ||
      lower.includes("service_fee_amount")
    ) {
      return jsonResponse(500, {
        error: message || "Order billing fields are missing.",
        remediation:
          "Run supabase/016_restaurant_billing_fields.sql, supabase/017_order_billing_fields.sql, and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then retry.",
      })
    }

    return jsonResponse(500, { error: message || "Failed to update order payment." })
  }

  return jsonResponse(200, {
    ok: true,
    order_id: normalizeString(updateResult.data.id),
    payment_status: normalizeString(updateResult.data.payment_status) || paymentStatus,
    payment_method: normalizeString(updateResult.data.payment_method) || null,
    card_transaction_id: normalizeString(updateResult.data.card_transaction_id) || null,
    tip_amount: normalizePositiveNumber(updateResult.data.tip_amount),
  })
})
