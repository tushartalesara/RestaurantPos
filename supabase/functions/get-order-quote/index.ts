// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

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

function normalizeFulfillmentType(value: unknown): "pickup" | "delivery" {
  return normalizeString(value).toLowerCase() === "delivery" ? "delivery" : "pickup"
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function toInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return fallback
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

      if (name) {
        parsed.name = name
      }

      if (typeof unitPriceRaw === "number" && Number.isFinite(unitPriceRaw)) {
        parsed.unit_price = unitPriceRaw
      } else if (typeof unitPriceRaw === "string") {
        const parsedPrice = Number(unitPriceRaw)
        if (Number.isFinite(parsedPrice)) {
          parsed.unit_price = parsedPrice
        }
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

function buildQuoteSummary(params: {
  currencyCode: string
  totalPrice: number
  taxInclusive: boolean
  taxAmount: number
  taxLabel: string
  serviceFeeAmount: number
  serviceFeeLabel: string
}) {
  const totalText = `${params.currencyCode} ${params.totalPrice.toFixed(2)}`
  const detailParts: string[] = []

  if (params.serviceFeeAmount > 0) {
    detailParts.push(`${params.serviceFeeLabel} ${params.currencyCode} ${params.serviceFeeAmount.toFixed(2)}`)
  }

  if (params.taxAmount > 0) {
    detailParts.push(
      params.taxInclusive
        ? `${params.taxLabel} already included`
        : `${params.taxLabel} ${params.currencyCode} ${params.taxAmount.toFixed(2)}`,
    )
  }

  return detailParts.length > 0
    ? `Final total ${totalText}. Breakdown includes ${detailParts.join(" and ")}.`
    : `Final total ${totalText}.`
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
  const fulfillmentType = normalizeFulfillmentType(bodyObj.fulfillment_type)
  const items = parseItems(bodyObj.items)

  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
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

  try {
    const resolvedItems: Array<Record<string, unknown>> = []
    let subtotalAmount = 0
    let itemCount = 0
    let quantityTotal = 0

    for (const item of items) {
      const itemLookup = await supabase
        .from("menu_items")
        .select("id, name, base_price, stock_quantity, is_available")
        .eq("restaurant_id", restaurantId)
        .eq("id", item.item_id)
        .maybeSingle()

      if (itemLookup.error) {
        const lookupMessage = normalizeString(itemLookup.error.message)
        const lower = lookupMessage.toLowerCase()

        if (
          lower.includes("base_price") ||
          lower.includes("stock_quantity") ||
          lower.includes("is_available")
        ) {
          return jsonResponse(500, {
            error: lookupMessage || "Menu item billing fields are missing.",
            remediation:
              "Run supabase/003_menu_stock_and_tool_support.sql and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then retry.",
          })
        }

        throw new Error(lookupMessage || "Failed to load menu item.")
      }

      if (!itemLookup.data?.id) {
        return jsonResponse(409, {
          ok: false,
          reason: "invalid_item_state",
          error: `Item ${item.item_id} was not found for this restaurant.`,
        })
      }

      if (!itemLookup.data.is_available) {
        return jsonResponse(409, {
          ok: false,
          reason: "invalid_item_state",
          error: `${normalizeString(itemLookup.data.name) || "This item"} is currently unavailable.`,
        })
      }

      const availableQty = Math.max(0, Number(itemLookup.data.stock_quantity || 0))
      if (availableQty < item.quantity) {
        return jsonResponse(409, {
          ok: false,
          reason: "insufficient_stock",
          error: `Insufficient stock for ${normalizeString(itemLookup.data.name) || "item"} (requested ${item.quantity}, available ${availableQty}).`,
        })
      }

      const unitPrice =
        typeof item.unit_price === "number" && Number.isFinite(item.unit_price)
          ? item.unit_price
          : Number(itemLookup.data.base_price || 0)
      const lineTotal = roundMoney(unitPrice * item.quantity)

      subtotalAmount = roundMoney(subtotalAmount + lineTotal)
      itemCount += 1
      quantityTotal += item.quantity

      resolvedItems.push({
        item_id: String(itemLookup.data.id),
        name: item.name || normalizeString(itemLookup.data.name),
        quantity: item.quantity,
        unit_price: roundMoney(unitPrice),
        line_total: lineTotal,
      })
    }

    const billingResult = await supabase.rpc("calculate_order_billing", {
      p_restaurant_id: restaurantId,
      p_subtotal_amount: subtotalAmount,
      p_tip_amount: 0,
    })

    if (billingResult.error) {
      const message = normalizeString(billingResult.error.message)
      const lower = message.toLowerCase()

      if (
        lower.includes("calculate_order_billing") ||
        lower.includes("restaurant_billing_config") ||
        lower.includes("country_tax_rates") ||
        lower.includes("tax_amount") ||
        lower.includes("tax_rate_percent") ||
        lower.includes("tax_inclusive")
      ) {
        return jsonResponse(500, {
          error: message || "Billing calculation is missing.",
          remediation:
            "Run supabase/016_restaurant_billing_fields.sql, supabase/017_order_billing_fields.sql, and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then retry.",
        })
      }

      throw new Error(message || "Failed to calculate order billing.")
    }

    const billingRow = Array.isArray(billingResult.data) ? billingResult.data[0] : billingResult.data
    const taxAmount = roundMoney(Number(billingRow?.tax_amount || 0))
    const taxRatePercent = roundMoney(Number(billingRow?.tax_rate_percent || 0))
    const taxInclusive = Boolean(billingRow?.tax_inclusive)
    const taxLabel = normalizeString(billingRow?.tax_label) || "VAT"
    const serviceFeeAmount = roundMoney(Number(billingRow?.service_fee_amount || 0))
    const serviceFeeLabel = normalizeString(billingRow?.service_fee_label) || "Service Charge"
    const tipAmount = roundMoney(Number(billingRow?.tip_amount || 0))
    const tipLabel = normalizeString(billingRow?.tip_label) || "Gratuity"
    const currencyCode = normalizeString(billingRow?.currency_code) || "GBP"
    const totalPrice = roundMoney(Number(billingRow?.total_price || 0))

    return jsonResponse(200, {
      ok: true,
      agent_id: agentId,
      restaurant_id: restaurantId,
      conversation_id: conversationId || null,
      fulfillment_type: fulfillmentType,
      subtotal_amount: subtotalAmount,
      tax_amount: taxAmount,
      tax_rate_percent: taxRatePercent,
      tax_inclusive: taxInclusive,
      tax_label: taxLabel,
      service_fee_amount: serviceFeeAmount,
      service_fee_label: serviceFeeLabel,
      tip_amount: tipAmount,
      tip_label: tipLabel,
      currency_code: currencyCode,
      total_price: totalPrice,
      item_count: itemCount,
      quantity_total: quantityTotal,
      items: resolvedItems,
      quote_summary: buildQuoteSummary({
        currencyCode,
        totalPrice,
        taxInclusive,
        taxAmount,
        taxLabel,
        serviceFeeAmount,
        serviceFeeLabel,
      }),
    })
  } catch (error) {
    return jsonResponse(500, {
      error: normalizeString((error as { message?: string })?.message) || "Failed to quote the order.",
    })
  }
})
