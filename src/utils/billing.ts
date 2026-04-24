import type { BillingConfig } from "../types"

function toOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return null
}

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  const parsed = toOptionalNumber(value)
  if (parsed === null) {
    return Math.max(0, fallback)
  }
  return Math.max(0, parsed)
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function readValue(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in source) {
      return source[key]
    }
  }
  return undefined
}

export type NormalizedBillingBreakdown = {
  currencyCode: string
  subtotalAmount: number
  taxAmount: number
  taxRatePercent: number
  taxInclusive: boolean
  taxLabel: string
  serviceFeeAmount: number
  serviceFeeLabel: string
  tipAmount: number
  tipLabel: string
  totalBeforeTip: number
  totalAmount: number
  hasStoredBreakdown: boolean
}

export function calculateDraftBillingBreakdown(params: {
  subtotalAmount: number
  currencyCode: string
  taxRatePercent: number
  taxInclusive: boolean
  taxLabel?: string | null
  serviceFeeEnabled?: boolean
  serviceFeeType?: "percent" | "flat" | null
  serviceFeeValue?: number | null
  serviceFeeLabel?: string | null
  tipAmount?: number | null
  tipLabel?: string | null
}): NormalizedBillingBreakdown {
  const subtotalAmount = roundMoney(toNonNegativeNumber(params.subtotalAmount))
  const taxRatePercent = roundMoney(toNonNegativeNumber(params.taxRatePercent))
  const taxInclusive = Boolean(params.taxInclusive)
  const serviceFeeType = params.serviceFeeType === "flat" ? "flat" : params.serviceFeeType === "percent" ? "percent" : null
  const serviceFeeValue = toNonNegativeNumber(params.serviceFeeValue)
  const tipAmount = roundMoney(toNonNegativeNumber(params.tipAmount))

  const taxAmount =
    taxRatePercent <= 0
      ? 0
      : taxInclusive
        ? roundMoney((subtotalAmount * taxRatePercent) / (100 + taxRatePercent))
        : roundMoney(subtotalAmount * (taxRatePercent / 100))

  const serviceFeeAmount =
    !params.serviceFeeEnabled || !serviceFeeType || serviceFeeValue <= 0
      ? 0
      : serviceFeeType === "flat"
        ? roundMoney(serviceFeeValue)
        : roundMoney(subtotalAmount * (serviceFeeValue / 100))

  const totalBeforeTip = roundMoney(subtotalAmount + serviceFeeAmount + (taxInclusive ? 0 : taxAmount))
  const totalAmount = roundMoney(totalBeforeTip + tipAmount)

  return {
    currencyCode: String(params.currencyCode || "GBP").trim().toUpperCase() || "GBP",
    subtotalAmount,
    taxAmount,
    taxRatePercent,
    taxInclusive,
    taxLabel: String(params.taxLabel || "VAT").trim() || "VAT",
    serviceFeeAmount,
    serviceFeeLabel: String(params.serviceFeeLabel || "Service Charge").trim() || "Service Charge",
    tipAmount,
    tipLabel: String(params.tipLabel || "Gratuity").trim() || "Gratuity",
    totalBeforeTip,
    totalAmount,
    hasStoredBreakdown: true,
  }
}

export function normalizeOrderBillingBreakdown(
  sourceValue: unknown,
  options?: {
    fallbackSubtotalAmount?: number
    fallbackCurrencyCode?: string
    fallbackTipLabel?: string
  },
): NormalizedBillingBreakdown {
  const source = sourceValue && typeof sourceValue === "object" ? (sourceValue as Record<string, unknown>) : {}
  const fallbackSubtotalAmount = roundMoney(toNonNegativeNumber(options?.fallbackSubtotalAmount))
  const subtotalValue = toOptionalNumber(readValue(source, "subtotalAmount", "subtotal_amount"))
  const fallbackTotalAmount = toOptionalNumber(readValue(source, "totalPrice", "total_amount", "total"))
  const subtotalAmount = roundMoney(
    subtotalValue ?? (fallbackSubtotalAmount > 0 ? fallbackSubtotalAmount : toNonNegativeNumber(fallbackTotalAmount)),
  )
  const taxAmount = roundMoney(toNonNegativeNumber(readValue(source, "taxAmount", "tax_amount")))
  const taxRatePercent = roundMoney(toNonNegativeNumber(readValue(source, "taxRatePercent", "tax_rate_percent")))
  const taxInclusive = Boolean(readValue(source, "taxInclusive", "tax_inclusive"))
  const serviceFeeAmount = roundMoney(toNonNegativeNumber(readValue(source, "serviceFeeAmount", "service_fee_amount")))
  const tipAmount = roundMoney(toNonNegativeNumber(readValue(source, "tipAmount", "tip_amount")))
  const storedTotalAmount = toOptionalNumber(readValue(source, "totalPrice", "total_amount", "total"))
  const totalBeforeTip = roundMoney(subtotalAmount + serviceFeeAmount + (taxInclusive ? 0 : taxAmount))
  const totalAmount = roundMoney(storedTotalAmount ?? (totalBeforeTip + tipAmount))
  const currencyCode = String(
    readValue(source, "currencyCode", "currency_code") || options?.fallbackCurrencyCode || "GBP",
  )
    .trim()
    .toUpperCase() || "GBP"

  const hasStoredBreakdown =
    subtotalValue !== null ||
    taxAmount > 0 ||
    taxRatePercent > 0 ||
    serviceFeeAmount > 0 ||
    tipAmount > 0 ||
    Boolean(readValue(source, "currencyCode", "currency_code"))

  return {
    currencyCode,
    subtotalAmount,
    taxAmount,
    taxRatePercent,
    taxInclusive,
    taxLabel: String(readValue(source, "taxLabel", "tax_label") || "VAT").trim() || "VAT",
    serviceFeeAmount,
    serviceFeeLabel: String(readValue(source, "serviceFeeLabel", "service_fee_label") || "Service Charge").trim() || "Service Charge",
    tipAmount,
    tipLabel:
      String(readValue(source, "tipLabel", "tip_label") || options?.fallbackTipLabel || "Gratuity").trim() ||
      "Gratuity",
    totalBeforeTip,
    totalAmount,
    hasStoredBreakdown,
  }
}

export function getTipAmountFromPercent(subtotalAmount: number, tipPercent: number): number {
  const normalizedSubtotalAmount = toNonNegativeNumber(subtotalAmount)
  const normalizedTipPercent = toNonNegativeNumber(tipPercent)
  return roundMoney(normalizedSubtotalAmount * (normalizedTipPercent / 100))
}

export function billingConfigToDraftBreakdown(
  billingConfig: BillingConfig | null | undefined,
  subtotalAmount: number,
  tipAmount = 0,
): NormalizedBillingBreakdown {
  return calculateDraftBillingBreakdown({
    subtotalAmount,
    currencyCode: billingConfig?.currencyCode || "GBP",
    taxRatePercent: billingConfig?.resolvedTaxRatePercent || 0,
    taxInclusive: Boolean(billingConfig?.taxInclusive),
    taxLabel: billingConfig?.taxLabel || "VAT",
    serviceFeeEnabled: Boolean(billingConfig?.serviceFeeEnabled),
    serviceFeeType: billingConfig?.serviceFeeType || null,
    serviceFeeValue: billingConfig?.serviceFeeValue || 0,
    serviceFeeLabel: billingConfig?.serviceFeeLabel || "Service Charge",
    tipAmount,
    tipLabel: billingConfig?.tipLabel || "Gratuity",
  })
}
