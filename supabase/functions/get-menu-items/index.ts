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

function isMissingStockColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return message.includes("stock_quantity") || message.includes("is_available")
}

function isMissingMenuSortOrderColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return message.includes("sort_order")
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
  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
  }

  const queryText = normalizeString(bodyObj.query)
  const category = normalizeString(bodyObj.category)
  const includeUnavailable = toBoolean(bodyObj.include_unavailable, false)
  const limit = Math.min(Math.max(toInteger(bodyObj.limit, 20), 1), 100)

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let restaurantId = ""
  try {
    const resolved = await resolveRestaurantIdFromAgent({
      supabase,
      agentId,
      claimedRestaurantId,
    })

    if (resolved.status === "agent_not_linked") {
      return jsonResponse(404, { error: "agent_id is not linked to any restaurant." })
    }
    if (resolved.status === "restaurant_mismatch") {
      return jsonResponse(403, {
        error: "Provided restaurant_id does not match agent ownership.",
        resolved_restaurant_id: resolved.restaurantId,
      })
    }

    restaurantId = resolved.restaurantId
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to resolve agent link." })
  }

  let query = supabase
    .from("menu_items")
    .select("id, restaurant_id, name, description, category, base_price, stock_quantity, is_available, sort_order, created_at")
    .eq("restaurant_id", restaurantId)

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
    agent_id: agentId,
    restaurant_id: restaurantId,
    count: items.length,
    items,
  })
})
