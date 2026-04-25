// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const MENU_PARSE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          basePrice: { type: "number" },
          stockQuantity: { type: "number" },
          customizations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                value: { type: "string" },
                priceDelta: { type: "number" },
                isRequired: { type: "boolean" },
              },
              required: ["label", "priceDelta", "isRequired"],
            },
          },
        },
        required: ["name", "basePrice", "customizations"],
      },
    },
  },
  required: ["summary", "warnings", "items"],
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

function toOptionalString(value: unknown): string | null {
  const normalized = normalizeString(value)
  return normalized.length > 0 ? normalized : null
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const normalized = value.replace(/[^0-9.\-]/g, "")
    const parsed = Number(normalized)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
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

function sanitizeCustomizations(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .map((rawCustomization) => {
      const customization = rawCustomization as Record<string, unknown>
      const label = normalizeString(customization.label)
      if (!label) return null

      return {
        label,
        value: toOptionalString(customization.value),
        priceDelta: toNumber(customization.priceDelta),
        isRequired: Boolean(customization.isRequired),
      }
    })
    .filter(Boolean)
}

function sanitizeItems(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .map((rawItem) => {
      const item = rawItem as Record<string, unknown>
      const name = normalizeString(item.name)
      if (!name) return null

      return {
        name,
        description: toOptionalString(item.description),
        category: toOptionalString(item.category),
        basePrice: toNumber(item.basePrice),
        stockQuantity: Math.max(0, toNumber(item.stockQuantity || 1)),
        customizations: sanitizeCustomizations(item.customizations),
      }
    })
    .filter(Boolean)
}

function extractJsonBlock(rawText: string): string {
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim()
  }

  const firstBrace = rawText.indexOf("{")
  const lastBrace = rawText.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1)
  }

  return rawText
}

function parseGeminiResponse(payload: Record<string, unknown>) {
  const candidates = Array.isArray((payload as any)?.candidates) ? ((payload as any).candidates as any[]) : []
  const firstCandidate = candidates[0] || {}
  const parts = Array.isArray(firstCandidate?.content?.parts) ? firstCandidate.content.parts : []
  const text = parts.find((part: any) => typeof part?.text === "string")?.text || ""

  if (!text.trim()) {
    throw new Error("Gemini returned empty output.")
  }

  const jsonBlock = extractJsonBlock(text)
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(jsonBlock)
  } catch {
    throw new Error("Gemini output was not valid JSON.")
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((warning) => normalizeString(warning)).filter(Boolean)
    : []

  return {
    summary: normalizeString(parsed.summary),
    warnings,
    items: sanitizeItems(parsed.items),
  }
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000)
  }

  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const delta = timestamp - Date.now()
  return delta > 0 ? delta : null
}

function parseQuotaDetail(payload: Record<string, unknown>): string | null {
  const details = Array.isArray((payload as any)?.error?.details) ? ((payload as any).error.details as any[]) : []
  const quotaFailure = details.find((detail) => String(detail?.["@type"] || "").includes("google.rpc.QuotaFailure"))
  const violations = Array.isArray(quotaFailure?.violations) ? quotaFailure.violations : []
  const firstDescription = normalizeString(violations[0]?.description)
  return firstDescription || null
}

async function requestGemini(endpoint: string, apiKey: string, requestBody: Record<string, unknown>) {
  const fetchOnce = async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    })

    const payload = await response.json().catch(() => ({} as Record<string, unknown>))
    return { response, payload }
  }

  let result = await fetchOnce()
  if (result.response.status !== 429) {
    return result
  }

  const retryAfterMs = parseRetryAfterMs(result.response.headers.get("retry-after"))
  const waitMs = Math.min(Math.max(retryAfterMs ?? 2000, 1000), 15000)
  await new Promise((resolve) => setTimeout(resolve, waitMs))

  result = await fetchOnce()
  return result
}

function resolveGeminiApiKey(): string {
  return (
    normalizeString(Deno.env.get("MOBILE_ONBOARDING_GEMINI_API_KEY")) ||
    normalizeString(Deno.env.get("GEMINI_API_KEY")) ||
    normalizeString(Deno.env.get("GOOGLE_GEMINI_API_KEY"))
  )
}

function resolveGeminiModel(): string {
  return (
    normalizeString(Deno.env.get("MOBILE_ONBOARDING_GEMINI_MODEL")) ||
    normalizeString(Deno.env.get("GEMINI_MODEL")) ||
    normalizeString(Deno.env.get("GOOGLE_GEMINI_MODEL")) ||
    "gemini-2.0-flash"
  )
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

  const geminiApiKey = resolveGeminiApiKey()
  const geminiModel = resolveGeminiModel()
  if (!geminiApiKey) {
    return jsonResponse(500, { error: "Gemini API key is missing from Supabase secrets." })
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
  const imageBase64 = normalizeString(bodyObj.image_base64).replace(/\s+/g, "")
  const imageMimeType = normalizeString(bodyObj.image_mime_type) || "image/jpeg"
  const promptHint = normalizeString(bodyObj.prompt_hint)

  if (!restaurantId) {
    return jsonResponse(400, { error: "restaurant_id is required." })
  }

  if (!imageBase64) {
    return jsonResponse(400, { error: "image_base64 is required." })
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

  const prompt = `Extract restaurant menu items from this photo, even if the image is noisy or angled.
Return only valid JSON in this exact schema:
{
  "summary": "short extracted summary",
  "warnings": ["any uncertainty or quality notes"],
  "items": [
    {
      "name": "item name",
      "description": "optional description or null",
      "category": "optional category or null",
      "basePrice": 0,
      "customizations": [
        {
          "label": "customization label",
          "value": "optional detail or null",
          "priceDelta": 0,
          "isRequired": false
        }
      ]
    }
  ]
}
Rules:
- Include as many real menu items as possible.
- Keep items in the same reading order as the menu photo: top-to-bottom within a section, and left-to-right across columns or panels. Never alphabetize or reorder items.
- If price is unclear, set basePrice to 0 and add a warning.
- Use numbers for basePrice and priceDelta.
- For combos, meals, and deals, keep the item name short, like "Combo 1" or "Fried Strips Meal".
- If a combo name is on one line and its included contents are on the next line, merge them into one item.
- Put fixed included contents into description, for example "1 pc chicken, 2 wings, 1 strip and fries".
- Use customizations only for optional add-ons or choices, not for fixed combo contents.
- Always attach the nearest visible section heading to each item as category.
- Prefer the most specific visible section heading, for example use "Peri Peri Deals", "Peri Peri Platters", "Classic Deals", or "Fried Chicken Deals" instead of a generic banner like "Grilled Food".
- If a section such as "Family Bucket", "Deals", "Wraps", or "Burgers" is visible, preserve that exact wording as category.
- Keep items grouped under their original categories and preserve the category order from the menu photo.
- Never return markdown or code fences.
${promptHint ? `Additional context from user OCR notes:\n${promptHint}` : ""}`

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`
  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: imageMimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseJsonSchema: MENU_PARSE_RESPONSE_SCHEMA,
    },
  }

  const { response, payload } = await requestGemini(endpoint, geminiApiKey, requestBody)
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))
      const retryAfterSeconds = retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null
      const retryHint = retryAfterSeconds ? ` Retry after about ${retryAfterSeconds}s.` : " Retry in a few seconds."
      const quotaHint = parseQuotaDetail(payload)
      const detailHint = quotaHint ? ` ${quotaHint}` : ""
      return jsonResponse(429, {
        error: `Gemini rate limit reached (429).${retryHint}${detailHint}`,
      })
    }

    const providerMessage =
      normalizeString((payload as any)?.error?.message) || `Gemini request failed (${response.status})`
    return jsonResponse(502, { error: providerMessage })
  }

  try {
    const parsed = parseGeminiResponse(payload)
    return jsonResponse(200, parsed)
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Failed to parse Gemini output.",
    })
  }
})
