// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"
const ADDRESS_API_BASE_URL = "https://api.getAddress.io"

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

function toInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value)
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed)
  }
  return fallback
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true
    if (value.toLowerCase() === "false") return false
  }
  return fallback
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function normalizeFulfillmentType(value: unknown): "pickup" | "delivery" {
  return normalizeString(value).toLowerCase() === "delivery" ? "delivery" : "pickup"
}

function normalizePaymentCollection(value: unknown, fulfillmentType: "pickup" | "delivery"): "unpaid" | "cod" {
  const normalized = normalizeString(value).toLowerCase()
  if (normalized === "cod" || normalized === "unpaid") {
    return normalized
  }
  return fulfillmentType === "delivery" ? "cod" : "unpaid"
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

function looksLikeUkPostcode(value: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/.test(value)
}

function resolveGetAddressApiKey(): string {
  return (
    normalizeString(Deno.env.get("MOBILE_ONBOARDING_GETADDRESS_API_KEY")) ||
    normalizeString(Deno.env.get("GETADDRESS_API_KEY"))
  )
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

function formatOrderCode(value: unknown): string | null {
  const numericValue = toInteger(value, 0)
  if (numericValue <= 0) return null
  return String(numericValue).padStart(3, "0")
}

function isMissingStockColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return message.includes("stock_quantity") || message.includes("is_available")
}

function isMissingMenuSortOrderColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return message.includes("sort_order")
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

function createServiceClient() {
  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error("Supabase service configuration is missing.")
  }

  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
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

async function resolveMenuItem(params: {
  supabase: ReturnType<typeof createClient>
  restaurantId: string
  itemId: string
  itemName: string
  selectColumns: string
}) {
  if (params.itemId) {
    const byId = await params.supabase
      .from("menu_items")
      .select(params.selectColumns)
      .eq("restaurant_id", params.restaurantId)
      .eq("id", params.itemId)
      .maybeSingle()

    if (byId.error) {
      throw byId.error
    }

    if (!byId.data) {
      return { status: "not_found" as const, candidates: [] }
    }

    return { status: "resolved" as const, item: byId.data }
  }

  const target = params.itemName.toLowerCase()
  const searchByName = await params.supabase
    .from("menu_items")
    .select(params.selectColumns)
    .eq("restaurant_id", params.restaurantId)
    .ilike("name", `%${params.itemName}%`)
    .order("name", { ascending: true })
    .limit(10)

  if (searchByName.error) {
    throw searchByName.error
  }

  const rows = searchByName.data || []
  if (rows.length === 0) {
    return { status: "not_found" as const, candidates: [] }
  }

  const exactMatches = rows.filter((row) => normalizeString(row.name).toLowerCase() === target)
  if (exactMatches.length === 1) {
    return { status: "resolved" as const, item: exactMatches[0] }
  }

  if (exactMatches.length > 1) {
    return { status: "ambiguous" as const, candidates: exactMatches }
  }

  return { status: "no_exact_match" as const, candidates: rows }
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
    console.error("[voice-tool-dispatcher] Failed to link order conversation:", orderUpdateError.message)
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
    console.error("[voice-tool-dispatcher] Failed to link post-call webhook to order:", webhookUpdateError.message)
  }
}

async function handleGetMenuItems(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const queryText = normalizeString(params.body.query)
  const category = normalizeString(params.body.category)
  const includeUnavailable = toBoolean(params.body.include_unavailable, false)
  const limit = Math.min(Math.max(toInteger(params.body.limit, 20), 1), 100)

  let query = params.supabase
    .from("menu_items")
    .select("id, restaurant_id, name, description, category, base_price, stock_quantity, is_available, sort_order, created_at")
    .eq("restaurant_id", params.restaurantId)

  if (!includeUnavailable) {
    query = query.eq("is_available", true).gt("stock_quantity", 0)
  }
  if (category) {
    query = query.ilike("category", `%${category}%`)
  }
  if (queryText) {
    query = query.ilike("name", `%${queryText}%`)
  }

  const result = await query.order("sort_order", { ascending: true }).order("created_at", { ascending: true }).limit(limit)

  if (result.error) {
    if (isMissingMenuSortOrderColumnError(result.error)) {
      return jsonResponse(500, {
        error:
          "Menu ordering fields are missing on menu_items. Run supabase/007_menu_item_sort_order.sql and retry.",
      })
    }
    if (isMissingStockColumnError(result.error)) {
      return jsonResponse(500, {
        error:
          "Stock columns are missing on menu_items. Run mobile-onboarding-rn/supabase/003_menu_stock_and_tool_support.sql and retry.",
      })
    }
    return jsonResponse(500, { error: result.error.message })
  }

  const items = (result.data || []).map((item) => ({
    id: String(item.id),
    restaurant_id: String(item.restaurant_id),
    name: String(item.name || ""),
    description: item.description === null ? null : String(item.description),
    category: item.category === null ? null : String(item.category),
    base_price: Number(item.base_price || 0),
    sort_order: Number(item.sort_order || 0),
    stock_quantity: Number(item.stock_quantity || 0),
    is_available: Boolean(item.is_available),
  }))

  return jsonResponse(200, {
    ok: true,
    action: "get-menu-items",
    agent_id: params.agentId,
    restaurant_id: params.restaurantId,
    count: items.length,
    items,
  })
}

async function handleGetItemCustomizations(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const itemId = normalizeString(params.body.item_id)
  const itemName = normalizeString(params.body.item_name)

  if (!itemId && !itemName) {
    return jsonResponse(400, { error: "Provide item_id or item_name." })
  }

  try {
    const resolved = await resolveMenuItem({
      supabase: params.supabase,
      restaurantId: params.restaurantId,
      itemId,
      itemName,
      selectColumns: "id, restaurant_id, name, description, category, base_price, stock_quantity, is_available",
    })

    if (resolved.status === "not_found") {
      return jsonResponse(200, {
        ok: true,
        action: "get-item-customizations",
        found: false,
        reason: "item_not_found",
      })
    }

    if (resolved.status === "ambiguous" || resolved.status === "no_exact_match") {
      return jsonResponse(200, {
        ok: true,
        action: "get-item-customizations",
        found: false,
        reason: resolved.status === "ambiguous" ? "ambiguous_item_name" : "no_exact_match",
        candidates: resolved.candidates.map((row) => ({
          id: String(row.id),
          name: String(row.name || ""),
          category: row.category === null ? null : String(row.category),
          base_price: Number(row.base_price || 0),
          stock_quantity: Number(row.stock_quantity || 0),
          is_available: Boolean(row.is_available),
        })),
      })
    }

    const item = resolved.item
    const customizationsResult = await params.supabase
      .from("menu_item_customizations")
      .select("id, menu_item_id, label, value, price_delta, is_required")
      .eq("menu_item_id", item.id)
      .order("created_at", { ascending: true })

    if (customizationsResult.error) {
      return jsonResponse(500, { error: customizationsResult.error.message })
    }

    const customizations = (customizationsResult.data || []).map((option) => ({
      id: String(option.id),
      menu_item_id: String(option.menu_item_id),
      label: String(option.label || ""),
      value: option.value === null ? null : String(option.value),
      price_delta: Number(option.price_delta || 0),
      is_required: Boolean(option.is_required),
    }))

    return jsonResponse(200, {
      ok: true,
      action: "get-item-customizations",
      found: true,
      agent_id: params.agentId,
      restaurant_id: params.restaurantId,
      item: {
        id: String(item.id),
        restaurant_id: String(item.restaurant_id),
        name: String(item.name || ""),
        description: item.description === null ? null : String(item.description),
        category: item.category === null ? null : String(item.category),
        base_price: Number(item.base_price || 0),
        stock_quantity: Number(item.stock_quantity || 0),
        is_available: Boolean(item.is_available),
      },
      customization_count: customizations.length,
      customizations,
    })
  } catch (error) {
    if (isMissingStockColumnError(error)) {
      return jsonResponse(500, {
        error:
          "Stock columns are missing on menu_items. Run mobile-onboarding-rn/supabase/003_menu_stock_and_tool_support.sql and retry.",
      })
    }
    return jsonResponse(500, {
      error: normalizeString((error as { message?: string })?.message) || "Failed to resolve customizations.",
    })
  }
}

async function handleCheckItemStock(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const itemId = normalizeString(params.body.item_id)
  const itemName = normalizeString(params.body.item_name)
  const requestedQty = Math.max(1, toInteger(params.body.requested_qty, 1))

  if (!itemId && !itemName) {
    return jsonResponse(400, { error: "Provide item_id or item_name." })
  }

  try {
    const resolved = await resolveMenuItem({
      supabase: params.supabase,
      restaurantId: params.restaurantId,
      itemId,
      itemName,
      selectColumns: "id, restaurant_id, name, stock_quantity, is_available, base_price",
    })

    if (resolved.status === "not_found") {
      return jsonResponse(200, {
        ok: true,
        action: "check-item-stock",
        found: false,
        reason: "item_not_found",
      })
    }

    if (resolved.status === "ambiguous" || resolved.status === "no_exact_match") {
      return jsonResponse(200, {
        ok: true,
        action: "check-item-stock",
        found: false,
        reason: resolved.status === "ambiguous" ? "ambiguous_item_name" : "no_exact_match",
        candidates: resolved.candidates.map((row) => ({
          id: String(row.id),
          name: String(row.name || ""),
          base_price: Number(row.base_price || 0),
          stock_quantity: Number(row.stock_quantity || 0),
          is_available: Boolean(row.is_available),
        })),
      })
    }

    const item = resolved.item
    const availableQty = Boolean(item.is_available) ? Math.max(0, Number(item.stock_quantity || 0)) : 0
    const canFulfill = requestedQty <= availableQty

    return jsonResponse(200, {
      ok: true,
      action: "check-item-stock",
      found: true,
      agent_id: params.agentId,
      restaurant_id: params.restaurantId,
      item: {
        id: String(item.id),
        name: String(item.name || ""),
        is_available: Boolean(item.is_available),
      },
      requested_qty: requestedQty,
      available_qty: availableQty,
      max_fulfillable_qty: availableQty,
      can_fulfill: canFulfill,
      shortfall_qty: canFulfill ? 0 : requestedQty - availableQty,
      note: "Use place-order-atomic to commit the order with transactional stock enforcement.",
    })
  } catch (error) {
    if (isMissingStockColumnError(error)) {
      return jsonResponse(500, {
        error:
          "Stock columns are missing on menu_items. Run mobile-onboarding-rn/supabase/003_menu_stock_and_tool_support.sql and retry.",
      })
    }
    return jsonResponse(500, {
      error: normalizeString((error as { message?: string })?.message) || "Failed to check stock.",
    })
  }
}

async function handleLookupUkPostcodeAddresses(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const getAddressApiKey = resolveGetAddressApiKey()
  const postcode = normalizeUkPostcode(params.body.postcode)

  if (!getAddressApiKey) {
    return jsonResponse(500, {
      error: "UK postcode lookup secret is missing. Set GETADDRESS_API_KEY in Supabase secrets.",
    })
  }
  if (!postcode) {
    return jsonResponse(400, { error: "postcode is required." })
  }
  if (!looksLikeUkPostcode(postcode)) {
    return jsonResponse(400, { error: "Enter a valid UK postcode before looking up delivery addresses." })
  }

  const lookupUrl =
    `${ADDRESS_API_BASE_URL}/autocomplete/${encodeURIComponent(postcode)}` +
    `?api-key=${encodeURIComponent(getAddressApiKey)}&all=true&show-postcode=true`

  const addressResponse = await fetch(lookupUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  })

  if (addressResponse.status === 429) {
    return jsonResponse(429, {
      error: "UK postcode lookup is temporarily rate limited. Please retry in a moment.",
      retry_after: normalizeString(addressResponse.headers.get("retry-after")) || null,
    })
  }

  if (addressResponse.status === 404) {
    return jsonResponse(200, {
      ok: true,
      action: "lookup-uk-postcode-addresses",
      agent_id: params.agentId,
      restaurant_id: params.restaurantId,
      postcode,
      count: 0,
      addresses: [],
    })
  }

  if (!addressResponse.ok) {
    const errorText = await addressResponse.text().catch(() => "")
    return jsonResponse(502, {
      error: `UK postcode lookup failed (${addressResponse.status}).`,
      details: errorText || null,
    })
  }

  const payload = await addressResponse.json().catch(() => null)
  const rawSuggestions = Array.isArray(payload?.suggestions) ? payload.suggestions : []
  const addresses = rawSuggestions
    .map((entry: Record<string, unknown>, index: number) => {
      const address = normalizeString(entry?.address)
      const id = normalizeString(entry?.id)
      if (!address) {
        return null
      }
      return {
        index: index + 1,
        id: id || null,
        address,
        label: `${index + 1}. ${address}`,
      }
    })
    .filter(Boolean)

  return jsonResponse(200, {
    ok: true,
    action: "lookup-uk-postcode-addresses",
    agent_id: params.agentId,
    restaurant_id: params.restaurantId,
    postcode,
    count: addresses.length,
    addresses,
  })
}

async function handleGetOrderQuote(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const conversationId = normalizeString(params.body.conversation_id)
  const fulfillmentType = normalizeFulfillmentType(params.body.fulfillment_type)
  const items = parseItems(params.body.items)

  if (items.length === 0) {
    return jsonResponse(400, { error: "items must be a non-empty array with item_id and quantity." })
  }

  try {
    const resolvedItems: Array<Record<string, unknown>> = []
    let subtotalAmount = 0
    let itemCount = 0
    let quantityTotal = 0

    for (const item of items) {
      const itemLookup = await params.supabase
        .from("menu_items")
        .select("id, name, base_price, stock_quantity, is_available")
        .eq("restaurant_id", params.restaurantId)
        .eq("id", item.item_id)
        .maybeSingle()

      if (itemLookup.error) {
        const lookupMessage = normalizeString(itemLookup.error.message)
        const lower = lookupMessage.toLowerCase()

        if (lower.includes("base_price") || lower.includes("stock_quantity") || lower.includes("is_available")) {
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

    const billingResult = await params.supabase.rpc("calculate_order_billing", {
      p_restaurant_id: params.restaurantId,
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
      action: "get-order-quote",
      agent_id: params.agentId,
      restaurant_id: params.restaurantId,
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
}

async function invokePlaceVoiceOrderRpcWithRetry(params: {
  supabase: ReturnType<typeof createClient>
  restaurantId: string
  customerName: string
  customerPhone: string
  notes: string
  status: "pending" | "closed"
  items: ParsedItem[]
  fulfillmentType: "pickup" | "delivery"
  deliveryPostcode: string | null
  deliveryAddress: string | null
  paymentCollection: "unpaid" | "cod"
}) {
  let lastResult: { data: unknown; error: any } | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rpcResult = await params.supabase.rpc("place_voice_order_atomic", {
      p_restaurant_id: params.restaurantId,
      p_customer_name: params.customerName,
      p_customer_phone: params.customerPhone,
      p_notes: params.notes || null,
      p_status: params.status,
      p_items: params.items,
      p_fulfillment_type: params.fulfillmentType,
      p_delivery_postcode: params.fulfillmentType === "delivery" ? params.deliveryPostcode : null,
      p_delivery_address: params.fulfillmentType === "delivery" ? params.deliveryAddress : null,
      p_payment_collection: params.paymentCollection,
    })

    lastResult = rpcResult
    if (!rpcResult.error) {
      return rpcResult
    }

    const lower = normalizeString(rpcResult.error?.message).toLowerCase()
    const code = normalizeString(rpcResult.error?.code).toUpperCase()
    const retryableConflict = code === "P0001" || lower.includes("stock conflict")
    if (!retryableConflict || attempt > 0) {
      return rpcResult
    }
  }

  return lastResult
}

async function handlePlaceOrderAtomic(params: {
  supabase: ReturnType<typeof createClient>
  agentId: string
  restaurantId: string
  body: Record<string, unknown>
}) {
  const conversationId = normalizeString(params.body.conversation_id)
  const customerName = normalizeString(params.body.customer_name)
  const customerPhone = normalizeString(params.body.customer_phone)
  const fulfillmentType = normalizeFulfillmentType(params.body.fulfillment_type)
  const deliveryPostcode = normalizeUkPostcode(params.body.delivery_postcode)
  const deliveryAddress = normalizeString(params.body.delivery_address)
  const paymentCollection = normalizePaymentCollection(params.body.payment_collection, fulfillmentType)
  const notes = normalizeString(params.body.notes)
  const status = normalizeString(params.body.status).toLowerCase() === "closed" ? "closed" : "pending"
  const items = parseItems(params.body.items)

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

  const rpcResult = await invokePlaceVoiceOrderRpcWithRetry({
    supabase: params.supabase,
    restaurantId: params.restaurantId,
    customerName,
    customerPhone,
    notes,
    status,
    items,
    fulfillmentType,
    deliveryPostcode: fulfillmentType === "delivery" ? deliveryPostcode : null,
    deliveryAddress: fulfillmentType === "delivery" ? deliveryAddress : null,
    paymentCollection,
  })

  if (rpcResult.error) {
    const message = normalizeString(rpcResult.error.message)
    const lower = message.toLowerCase()
    const code = normalizeString(rpcResult.error.code).toUpperCase()

    if (code === "P0002" || lower.includes("insufficient stock")) {
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
    if (code === "P0001" || lower.includes("stock conflict")) {
      return jsonResponse(409, {
        ok: false,
        reason: "stock_conflict_retry_exhausted",
        error: "Another order changed stock at the same time. Please retry once more.",
        db_error: message || "Unknown database error",
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
      supabase: params.supabase,
      orderId,
      restaurantId: params.restaurantId,
      conversationId,
    })
  }

  return jsonResponse(200, {
    ok: true,
    action: "place-order-atomic",
    agent_id: params.agentId,
    restaurant_id: params.restaurantId,
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

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Body must be a JSON object." })
  }

  const bodyObj = body as Record<string, unknown>
  const action = normalizeString(bodyObj.action)
  const agentId = normalizeString(bodyObj.agent_id)
  const claimedRestaurantId = normalizeString(bodyObj.restaurant_id)

  if (!action) {
    return jsonResponse(400, { error: "action is required." })
  }

  if (action === "healthcheck") {
    return jsonResponse(200, {
      ok: true,
      action,
      timestamp: new Date().toISOString(),
    })
  }

  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
  }

  let supabase: ReturnType<typeof createClient>
  try {
    supabase = createServiceClient()
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Supabase service configuration is missing." })
  }

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

  switch (action) {
    case "get-menu-items":
      return await handleGetMenuItems({ supabase, agentId, restaurantId, body: bodyObj })
    case "get-item-customizations":
      return await handleGetItemCustomizations({ supabase, agentId, restaurantId, body: bodyObj })
    case "check-item-stock":
      return await handleCheckItemStock({ supabase, agentId, restaurantId, body: bodyObj })
    case "lookup-uk-postcode-addresses":
      return await handleLookupUkPostcodeAddresses({ supabase, agentId, restaurantId, body: bodyObj })
    case "get-order-quote":
      return await handleGetOrderQuote({ supabase, agentId, restaurantId, body: bodyObj })
    case "place-order-atomic":
      return await handlePlaceOrderAtomic({ supabase, agentId, restaurantId, body: bodyObj })
    default:
      return jsonResponse(400, { error: `Unknown action '${action}'.` })
  }
})
