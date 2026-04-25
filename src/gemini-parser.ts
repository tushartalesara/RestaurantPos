import type { MenuCustomizationDraft, MenuItemDraft } from "./types"
import { assertSupabaseConfigured, supabase } from "./supabase"

type GeminiParseResult = {
  items: MenuItemDraft[]
  summary: string
  warnings: string[]
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

export async function parseMenuFromImageWithGemini(input: {
  restaurantId: string
  imageBase64: string
  imageMimeType: string
  promptHint?: string
}): Promise<GeminiParseResult> {
  assertSupabaseConfigured()

  const { data, error } = await supabase.functions.invoke<{
    items?: unknown
    summary?: unknown
    warnings?: unknown
    error?: string
  }>("parse-menu-image", {
    body: {
      restaurant_id: input.restaurantId,
      image_base64: input.imageBase64,
      image_mime_type: input.imageMimeType,
      prompt_hint: input.promptHint || null,
    },
  })

  if (error) {
    throw new Error(error.message || "Failed to parse the menu image.")
  }

  if (toTrimmedString(data?.error)) {
    throw new Error(toTrimmedString(data?.error))
  }

  const warnings = Array.isArray(data?.warnings)
    ? data.warnings.map((warning) => toTrimmedString(warning)).filter(Boolean)
    : []

  return {
    items: sanitizeItems(data?.items),
    summary: toTrimmedString(data?.summary),
    warnings,
  }
}
