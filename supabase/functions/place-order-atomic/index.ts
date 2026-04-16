// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-tool-secret",
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

function toStatus(value: unknown): "pending" | "closed" {
  return normalizeString(value).toLowerCase() === "closed" ? "closed" : "pending"
}

function normalizeFulfillmentType(value: unknown): "pickup" | "delivery" {
  return normalizeString(value).toLowerCase() === "delivery" ? "delivery" : "pickup"
}

function normalizeUkPostcode(value: unknown): string {
  const compact = normalizeString(value).toUpperCase().replace(/\s+/g, "")
  if (!compact) {
    return ""
  }
  if (compact.length <= 3) {
    return compact
  }
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`
}

function normalizePaymentCollection(
  value: unknown,
  fulfillmentType: "pickup" | "delivery",
): "unpaid" | "cod" {
  const normalized = normalizeString(value).toLowerCase()
  if (normalized === "cod" || normalized === "unpaid") {
    return normalized
  }
  return fulfillmentType === "delivery" ? "cod" : "unpaid"
}

function toInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return fallback
}

function formatOrderCode(value: unknown): string | null {
  const numericValue = toInteger(value, 0)
  if (numericValue <= 0) return null
  return String(numericValue).padStart(3, "0")
}

type ParsedItem = {
  item_id: string
  quantity: number
  name?: string
  unit_price?: number
}

function parseItems(value: unknown): ParsedItem[] {
  if (!Array.isArray(value)) return []

  return value
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null
      const row = raw as Record<string, unknown>
      const itemId = normalizeString(row.item_id)
      if (!itemId) return null

      const quantity = Math.max(1, toInteger(row.quantity, 1))
      const name = normalizeString(row.name)
      const unitPriceRaw = row.unit_price
      const parsed: ParsedItem = {
        item_id: itemId,
        quantity,
      }
      if (name) parsed.name = name
      if (typeof unitPriceRaw === "number" && Number.isFinite(unitPriceRaw)) {
        parsed.unit_price = unitPriceRaw
      } else if (typeof unitPriceRaw === "string") {
        const n = Number(unitPriceRaw)
        if (Number.isFinite(n)) parsed.unit_price = n
      }
      return parsed
    })
    .filter(Boolean) as ParsedItem[]
}

async function resolveRestaurantIdFromAgent(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  claimedRestaurantId: string
}) {
  const linkResult = await params.supabase
    .from("voice_agent_links")
    .select("restaurant_id")
    .eq("workspace_agent_id", params.agentId)
    .maybeSingle()

  if (linkResult.error) {
    throw new Error(linkResult.error.message)
  }

  const restaurantId = normalizeString(linkResult.data?.restaurant_id)
  if (!restaurantId) {
    return { status: "agent_not_linked" as const }
  }

  if (params.claimedRestaurantId && params.claimedRestaurantId !== restaurantId) {
    return { status: "restaurant_mismatch" as const, restaurantId }
  }

  return { status: "ok" as const, restaurantId }
}

async function linkOrderToConversation(params: {
  supabase: ReturnType<typeof createClient>
  orderId: string
  restaurantId: string
  conversationId: string
}) {
  const { error: orderUpdateError } = await params.supabase
    .from("restaurant_orders")
    .update({
      source_provider: PROVIDER,
      source_conversation_id: params.conversationId,
    })
    .eq("id", params.orderId)
    .eq("restaurant_id", params.restaurantId)

  if (orderUpdateError) {
    console.error("[place-order-atomic] Failed to link order conversation:", orderUpdateError.message)
  }

  const { error: webhookUpdateError } = await params.supabase
    .from("post_call_webhooks")
    .update({
      created_order_id: params.orderId,
      restaurant_id: params.restaurantId,
    })
    .eq("provider", PROVIDER)
    .eq("conversation_id", params.conversationId)

  if (webhookUpdateError) {
    console.error("[place-order-atomic] Failed to link post-call webhook to order:", webhookUpdateError.message)
  }
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  const expectedToolSecret = normalizeString(Deno.env.get("ELEVENLABS_TOOL_SECRET"))
  const incomingToolSecret =
    normalizeString(request.headers.get("x-tool-secret")) ||
    normalizeString(request.headers.get("authorization")).replace(/^bearer\s+/i, "")
  if (expectedToolSecret && incomingToolSecret !== expectedToolSecret) {
    return jsonResponse(401, { error: "Unauthorized tool request." })
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase service configuration is missing." })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Body must be a JSON object." })
  }

  const bodyObj = body as Record<string, unknown>
  const agentId = normalizeString(bodyObj.agent_id)
  const claimedRestaurantId = normalizeString(bodyObj.restaurant_id)
  const conversationId = normalizeString(bodyObj.conversation_id)
  const customerName = normalizeString(bodyObj.customer_name)
  const customerPhone = normalizeString(bodyObj.customer_phone)
  const fulfillmentType = normalizeFulfillmentType(bodyObj.fulfillment_type)
  const deliveryPostcode = normalizeUkPostcode(bodyObj.delivery_postcode)
  const deliveryAddress = normalizeString(bodyObj.delivery_address)
  const paymentCollection = normalizePaymentCollection(bodyObj.payment_collection, fulfillmentType)
  const notes = normalizeString(bodyObj.notes)
  const status = toStatus(bodyObj.status)
  const items = parseItems(bodyObj.items)

  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
  }
  if (!customerName) {
    return jsonResponse(400, { error: "customer_name is required." })
  }
  if (!customerPhone) {
    return jsonResponse(400, { error: "customer_phone is required." })
  }
  if (fulfillmentType === "delivery" && !deliveryPostcode) {
    return jsonResponse(400, { error: "delivery_postcode is required when fulfillment_type is delivery." })
  }
  if (fulfillmentType === "delivery" && !deliveryAddress) {
    return jsonResponse(400, { error: "delivery_address is required when fulfillment_type is delivery." })
  }
  if (items.length === 0) {
    return jsonResponse(400, { error: "items must be a non-empty array with item_id and quantity." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let restaurantId = ""
  try {
    const resolvedRestaurant = await resolveRestaurantIdFromAgent({
      supabase,
      agentId,
      claimedRestaurantId,
    })
    if (resolvedRestaurant.status === "agent_not_linked") {
      return jsonResponse(404, { error: "agent_id is not linked to any restaurant." })
    }
    if (resolvedRestaurant.status === "restaurant_mismatch") {
      return jsonResponse(403, {
        error: "Provided restaurant_id does not match agent ownership.",
        resolved_restaurant_id: resolvedRestaurant.restaurantId,
      })
    }
    restaurantId = resolvedRestaurant.restaurantId
  } catch (error) {
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : "Failed to resolve agent link.",
    })
  }

  const rpcResult = await supabase.rpc("place_voice_order_atomic", {
    p_restaurant_id: restaurantId,
    p_customer_name: customerName,
    p_customer_phone: customerPhone,
    p_notes: notes || null,
    p_status: status,
    p_items: items,
    p_fulfillment_type: fulfillmentType,
    p_delivery_postcode: fulfillmentType === "delivery" ? deliveryPostcode : null,
    p_delivery_address: fulfillmentType === "delivery" ? deliveryAddress : null,
    p_payment_collection: paymentCollection,
  })

  if (rpcResult.error) {
    const message = normalizeString(rpcResult.error.message)
    const lower = message.toLowerCase()
    if (lower.includes("insufficient stock")) {
      return jsonResponse(409, {
        ok: false,
        reason: "insufficient_stock",
        error: message,
      })
    }
    if (lower.includes("all 999 active order ids")) {
      return jsonResponse(409, {
        ok: false,
        reason: "active_order_id_capacity_reached",
        error: "All live 3-digit order IDs are currently in use. Complete a pending order, then try again.",
      })
    }
    if (
      lower.includes("another pending order is currently being finalized") ||
      lower.includes("could not obtain lock on row") ||
      lower.includes("canceling statement due to lock timeout") ||
      lower.includes("statement timeout")
    ) {
      return jsonResponse(409, {
        ok: false,
        reason: "order_busy_retry",
        error: "Another order is being finalized right now. Please retry in a few seconds.",
        db_error: message || "Unknown database error",
      })
    }
    if (lower.includes("not found") || lower.includes("unavailable")) {
      return jsonResponse(409, {
        ok: false,
        reason: "invalid_item_state",
        error: message,
      })
    }
    if (
      lower.includes("place_voice_order_atomic") ||
      lower.includes("p_customer_phone") ||
      lower.includes("customer_phone") ||
      lower.includes("short_order_code") ||
      lower.includes("order_code_date")
    ) {
      return jsonResponse(500, {
        ok: false,
        reason: "order_tracking_schema_missing",
        error: message || "Unknown database error",
        remediation:
          "Run supabase/005_order_contact_and_short_code.sql, supabase/006_active_pending_order_ids.sql, and supabase/013_order_fulfillment_and_delivery_fields.sql in Supabase SQL Editor, then retry.",
      })
    }
    if (
      lower.includes("fulfillment_type") ||
      lower.includes("delivery_postcode") ||
      lower.includes("delivery_address") ||
      lower.includes("payment_collection")
    ) {
      return jsonResponse(500, {
        ok: false,
        reason: "order_fulfillment_schema_missing",
        error: message || "Unknown database error",
        remediation:
          "Run supabase/013_order_fulfillment_and_delivery_fields.sql in Supabase SQL Editor, then retry.",
      })
    }
    return jsonResponse(500, { error: message || "Failed to place order atomically." })
  }

  const firstRow = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data
  const orderId = normalizeString(firstRow?.order_id)
  const shortOrderCode = Number(firstRow?.short_order_code || 0)

  if (orderId && conversationId) {
    await linkOrderToConversation({
      supabase,
      orderId,
      restaurantId,
      conversationId,
    })
  }

  return jsonResponse(200, {
    ok: true,
    agent_id: agentId,
    restaurant_id: restaurantId,
    conversation_id: conversationId || null,
    order_id: orderId || null,
    short_order_code: shortOrderCode > 0 ? shortOrderCode : null,
    order_code: formatOrderCode(firstRow?.short_order_code),
    fulfillment_type: fulfillmentType,
    delivery_postcode: fulfillmentType === "delivery" ? deliveryPostcode : null,
    delivery_address: fulfillmentType === "delivery" ? deliveryAddress : null,
    payment_collection: paymentCollection,
    total_price: Number(firstRow?.total_price || 0),
    item_count: Number(firstRow?.item_count || items.length),
  })
})
