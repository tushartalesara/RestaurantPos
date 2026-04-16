// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

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
  const getAddressApiKey = resolveGetAddressApiKey()
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase service configuration is missing." })
  }
  if (!getAddressApiKey) {
    return jsonResponse(500, {
      error: "UK postcode lookup secret is missing. Set GETADDRESS_API_KEY in Supabase secrets.",
    })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Body must be a JSON object." })
  }

  const bodyObj = body as Record<string, unknown>
  const agentId = normalizeString(bodyObj.agent_id)
  const claimedRestaurantId = normalizeString(bodyObj.restaurant_id)
  const postcode = normalizeUkPostcode(bodyObj.postcode)

  if (!agentId) {
    return jsonResponse(400, { error: "agent_id is required." })
  }
  if (!postcode) {
    return jsonResponse(400, { error: "postcode is required." })
  }
  if (!looksLikeUkPostcode(postcode)) {
    return jsonResponse(400, { error: "Enter a valid UK postcode before looking up delivery addresses." })
  }

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
      agent_id: agentId,
      restaurant_id: restaurantId,
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
    agent_id: agentId,
    restaurant_id: restaurantId,
    postcode,
    count: addresses.length,
    addresses,
  })
})
