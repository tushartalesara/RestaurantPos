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

function isMissingStockColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return message.includes("stock_quantity") || message.includes("is_available")
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
}) {
  if (params.itemId) {
    const byId = await params.supabase
      .from("menu_items")
      .select("id, restaurant_id, name, description, category, base_price, stock_quantity, is_available")
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
    .select("id, restaurant_id, name, description, category, base_price, stock_quantity, is_available")
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
  const itemId = normalizeString(bodyObj.item_id)
  const itemName = normalizeString(bodyObj.item_name)

  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
  }
  if (!itemId && !itemName) {
    return jsonResponse(400, { error: "Provide item_id or item_name." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

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

    const resolved = await resolveMenuItem({
      supabase,
      restaurantId: resolvedRestaurant.restaurantId,
      itemId,
      itemName,
    })

    if (resolved.status === "not_found") {
      return jsonResponse(200, {
        ok: true,
        found: false,
        reason: "item_not_found",
      })
    }

    if (resolved.status === "ambiguous" || resolved.status === "no_exact_match") {
      return jsonResponse(200, {
        ok: true,
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
    const customizationsResult = await supabase
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
      found: true,
      agent_id: agentId,
      restaurant_id: resolvedRestaurant.restaurantId,
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
})
