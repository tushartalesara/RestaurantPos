// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"
import { hash } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts"

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
  const pin = normalizeString(bodyObj.pin).replace(/[^\d]/g, "")

  if (!restaurantId) {
    return jsonResponse(400, { error: "restaurant_id is required." })
  }

  if (!/^\d{4,8}$/.test(pin)) {
    return jsonResponse(400, { error: "PIN must be 4 to 8 digits." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const restaurantLookup = await supabase
    .from("restaurants")
    .select("id")
    .eq("id", restaurantId)
    .eq("owner_user_id", userId)
    .maybeSingle()

  if (restaurantLookup.error) {
    return jsonResponse(500, { error: restaurantLookup.error.message })
  }

  if (!restaurantLookup.data?.id) {
    return jsonResponse(403, { error: "You do not have access to this restaurant." })
  }

  const paymentPinHash = await hash(pin)
  const updatedAt = new Date().toISOString()
  const updateResult = await supabase
    .from("restaurants")
    .update({
      payment_pin_hash: paymentPinHash,
      payment_pin_updated_at: updatedAt,
      updated_at: updatedAt,
    })
    .eq("id", restaurantId)
    .eq("owner_user_id", userId)
    .select("id")
    .maybeSingle()

  if (updateResult.error) {
    const message = normalizeString(updateResult.error.message)
    if (message.toLowerCase().includes("payment_pin_hash") || message.toLowerCase().includes("payment_pin_updated_at")) {
      return jsonResponse(500, {
        error: message || "Per-restaurant payment PIN fields are missing.",
        remediation: "Run supabase/021_scalability_payment_and_indexes.sql in Supabase SQL Editor, then retry.",
      })
    }
    return jsonResponse(500, { error: message || "Failed to save payment PIN." })
  }

  return jsonResponse(200, {
    ok: true,
    restaurant_id: restaurantId,
    has_payment_pin: true,
    updated_at: updatedAt,
  })
})
