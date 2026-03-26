import type { MenuCustomizationDraft, MenuItemDraft } from "./types"

type GeminiParseResult = {
  items: MenuItemDraft[]
  summary: string
  warnings: string[]
}

type GeminiHttpResult = {
  response: Response
  payload: Record<string, unknown>
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

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function toOptionalString(value: unknown): string | null {
  const normalized = toTrimmedString(value)
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

function sanitizeCustomizations(value: unknown): MenuCustomizationDraft[] {
  if (!Array.isArray(value)) return []

  return value
    .map((rawCustomization) => {
      const customization = rawCustomization as Record<string, unknown>
      const label = toTrimmedString(customization.label)
      if (!label) return null

      return {
        label,
        value: toOptionalString(customization.value),
        priceDelta: toNumber(customization.priceDelta),
        isRequired: Boolean(customization.isRequired),
      }
    })
    .filter(Boolean) as MenuCustomizationDraft[]
}

function sanitizeItems(value: unknown): MenuItemDraft[] {
  if (!Array.isArray(value)) return []

  return value
    .map((rawItem) => {
      const item = rawItem as Record<string, unknown>
      const name = toTrimmedString(item.name)
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
    .filter(Boolean) as MenuItemDraft[]
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

function parseGeminiResponse(payload: any): GeminiParseResult {
  const text: string =
    payload?.candidates?.[0]?.content?.parts?.find((part: any) => typeof part?.text === "string")?.text || ""

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

  const items = sanitizeItems(parsed.items)
  const summary = toTrimmedString(parsed.summary)
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((warning) => toTrimmedString(warning)).filter(Boolean)
    : []

  return {
    items,
    summary,
    warnings,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseQuotaDetail(payload: Record<string, unknown>): string | null {
  const details = Array.isArray((payload as any)?.error?.details) ? ((payload as any).error.details as any[]) : []
  const quotaFailure = details.find((detail) => String(detail?.["@type"] || "").includes("google.rpc.QuotaFailure"))
  const violations = Array.isArray(quotaFailure?.violations) ? quotaFailure.violations : []
  const firstDescription = toTrimmedString(violations[0]?.description)
  return firstDescription || null
}

async function requestGemini(
  endpoint: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  retryDelayMs?: number,
): Promise<GeminiHttpResult> {
  const fetchOnce = async (): Promise<GeminiHttpResult> => {
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
  if (result.response.status !== 429) return result

  const retryAfterMs = parseRetryAfterMs(result.response.headers.get("retry-after"))
  const waitMs = Math.min(Math.max(retryAfterMs ?? retryDelayMs ?? 2000, 1000), 15000)
  await sleep(waitMs)

  result = await fetchOnce()
  return result
}

export async function parseMenuFromImageWithGemini(input: {
  imageBase64: string
  imageMimeType: string
  promptHint?: string
}): Promise<GeminiParseResult> {
  const apiKey = String(process.env.EXPO_PUBLIC_GEMINI_API_KEY || "").trim()
  const model = String(process.env.EXPO_PUBLIC_GEMINI_MODEL || "gemini-2.0-flash").trim()

  if (!apiKey) {
    throw new Error("Gemini API key is missing. Set EXPO_PUBLIC_GEMINI_API_KEY in .env.")
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
- Never return markdown/code fences.
${input.promptHint ? `Additional context from user OCR notes:\n${input.promptHint}` : ""}`

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: input.imageMimeType || "image/jpeg",
              data: input.imageBase64,
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

  const { response, payload } = await requestGemini(endpoint, apiKey, requestBody)
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"))
      const retryAfterSeconds = retryAfterMs ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : null
      const retryHint = retryAfterSeconds ? ` Retry after about ${retryAfterSeconds}s.` : " Retry in a few seconds."
      const quotaHint = parseQuotaDetail(payload)
      const detailHint = quotaHint ? ` ${quotaHint}` : ""
      throw new Error(`Gemini rate limit reached (429).${retryHint}${detailHint}`)
    }

    const providerMessage =
      toTrimmedString((payload as any)?.error?.message) || `Gemini request failed (${response.status})`
    throw new Error(providerMessage)
  }

  return parseGeminiResponse(payload)
}
