import type { MenuCustomizationDraft, MenuItemDraft } from "./types"

function extractPrice(text: string): number {
  const match = text.match(/(\d+(?:\.\d{1,2})?)\s*$/)
  if (!match) return 0
  const price = Number(match[1])
  return Number.isFinite(price) ? price : 0
}

function cleanName(raw: string): string {
  return raw
    .replace(/[£$€]\s*[0-9]+(?:\.[0-9]{1,2})?\s*$/g, "")
    .replace(/[0-9]+(?:\.[0-9]{1,2})?\s*$/g, "")
    .replace(/[-:]+$/g, "")
    .trim()
}

function isMostlyUppercase(value: string): boolean {
  const lettersOnly = value.replace(/[^a-z]/gi, "")
  return lettersOnly.length > 0 && lettersOnly === lettersOnly.toUpperCase()
}

function looksLikeSectionHeading(line: string): boolean {
  const normalized = cleanName(line)
  const wordCount = normalized.split(/\s+/).filter(Boolean).length
  const hasPrice = /\d+(?:\.\d{1,2})?\s*$/.test(line)
  const hasComma = line.includes(",")
  const hasCategoryKeyword = /\b(deals?|specials?|offers?|menu|bucket|buckets?|platters?|family|classic|classics|burgers?|wraps?|drinks?|salads?|desserts?|rice|food)\b/i.test(normalized)

  if (!normalized || hasPrice || hasComma || wordCount === 0 || wordCount > 6) {
    return false
  }

  if (hasCategoryKeyword) {
    return true
  }

  return isMostlyUppercase(normalized) && wordCount >= 2 && wordCount <= 4
}

function extractInlineCustomizations(text: string): MenuCustomizationDraft[] {
  const customizations: MenuCustomizationDraft[] = []

  const spiceMatch = text.match(/spice\s*[:\-]\s*([a-z0-9\s\/,]+)/i)
  if (spiceMatch) {
    customizations.push({
      label: "Spice Level",
      value: spiceMatch[1].trim(),
      priceDelta: 0,
      isRequired: false,
    })
  }

  const addOnMatches = text.matchAll(/(?:add|extra)\s+([a-z0-9\s]+)\s*\+?\s*(\d+(?:\.\d{1,2})?)/gi)
  for (const match of addOnMatches) {
    customizations.push({
      label: `Add ${match[1].trim()}`,
      value: null,
      priceDelta: Number(match[2]),
      isRequired: false,
    })
  }

  return customizations
}

export function parseMenuText(rawText: string): MenuItemDraft[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const items: MenuItemDraft[] = []
  let pendingItem: { name: string; basePrice: number } | null = null
  let currentCategory: string | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const nextLine = lines[index + 1] || ""
    const hasDelimiter = /[-:]/.test(line)
    const hasPrice = /\d+(?:\.\d{1,2})?\s*$/.test(line)
    const wordCount = cleanName(line)
      .split(/\s+/)
      .filter(Boolean).length
    const looksLikeTitleOnly = /^[a-z0-9\s&()+/'.,-]+$/i.test(line) && !line.includes(",") && !hasPrice && wordCount <= 5
    const looksLikeTitleWithInlinePrice = hasPrice && !line.includes(",") && wordCount <= 5
    const looksLikeDetailLine = line.includes(",") || /\b(?:pcs?|pc|wings?|strips?|fries|drink|meal|combo)\b/i.test(line)
    const currentLooksLikeSectionHeading = looksLikeSectionHeading(line)
    const nextLooksLikeSectionHeading = looksLikeSectionHeading(nextLine)

    if (currentLooksLikeSectionHeading) {
      currentCategory = cleanName(nextLooksLikeSectionHeading ? nextLine : line) || null
      if (nextLooksLikeSectionHeading) {
        index += 1
      }
      continue
    }

    if (pendingItem && looksLikeDetailLine && !looksLikeTitleWithInlinePrice && !looksLikeTitleOnly) {
      const description = cleanName(line).trim()
      items.push({
        name: pendingItem.name,
        description: description || null,
        category: currentCategory,
        basePrice: hasPrice ? extractPrice(line) : pendingItem.basePrice,
        stockQuantity: 1,
        customizations: [],
      })
      pendingItem = null
      continue
    }

    if (pendingItem) {
      items.push({
        name: pendingItem.name,
        description: null,
        category: currentCategory,
        basePrice: pendingItem.basePrice,
        stockQuantity: 1,
        customizations: [],
      })
      pendingItem = null
    }

    if (looksLikeTitleOnly || looksLikeTitleWithInlinePrice) {
      pendingItem = {
        name: cleanName(line),
        basePrice: extractPrice(line),
      }
      continue
    }

    if (!hasDelimiter && !hasPrice) {
      continue
    }

    const basePrice = extractPrice(line)
    const name = cleanName(line.split(/\s{2,}/)[0] || line)
    if (!name) continue

    const customizations = extractInlineCustomizations(line)
    items.push({
      name,
      description: null,
      category: currentCategory,
      basePrice,
      stockQuantity: 1,
      customizations,
    })
  }

  if (pendingItem?.name) {
    items.push({
      name: pendingItem.name,
      description: null,
      category: currentCategory,
      basePrice: pendingItem.basePrice,
      stockQuantity: 1,
      customizations: [],
    })
  }

  return items
}

export function createEmptyMenuItem(): MenuItemDraft {
  return {
    name: "",
    description: null,
    category: null,
    basePrice: 0,
    stockQuantity: 1,
    customizations: [],
  }
}
