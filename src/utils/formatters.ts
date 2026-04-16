import { ReceiptOrder } from "../types"

const CURRENCY_SYMBOL = "\u00A3"

export function formatShortOrderCode(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null
  return String(Math.max(0, Math.floor(Number(value)))).padStart(3, "0")
}

export function formatCurrencyDisplay(value: number | null | undefined): string {
  return `${CURRENCY_SYMBOL}${Number(value || 0).toFixed(2)}`
}

export function formatAudioTime(value: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0)))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

export function normalizeUkPostcode(value: unknown): string {
  const compact = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")

  if (!compact) {
    return ""
  }

  if (compact.length <= 3) {
    return compact
  }

  return `${compact.slice(0, -3)} ${compact.slice(-3)}`
}

export function getFulfillmentTypeLabel(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase() === "delivery" ? "DELIVERY" : "PICKUP"
}

export function getPaymentCollectionLabel(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase() === "cod" ? "COD" : "UNPAID"
}

export function getOrderPaymentDisplayLabel(params: {
  fulfillmentType?: string | null
  paymentCollection?: string | null
  paymentStatus?: string | null
  paymentMethod?: string | null
}): string {
  const fulfillmentType = String(params.fulfillmentType || "").trim().toLowerCase() === "delivery" ? "delivery" : "pickup"
  const paymentCollection =
    String(params.paymentCollection || "").trim().toLowerCase() === "cod"
      ? "cod"
      : fulfillmentType === "delivery"
        ? "cod"
        : "unpaid"
  const paymentStatus = String(params.paymentStatus || "").trim().toLowerCase() === "paid" ? "paid" : "unpaid"
  const paymentMethod = String(params.paymentMethod || "").trim().toLowerCase()

  if (paymentStatus === "paid") {
    if (paymentMethod === "card") return "CARD"
    if (paymentMethod === "cash") return "CASH"
  }

  if (paymentCollection === "cod") return "COD"
  return "UNPAID"
}

export function getOrderStatusTone(status: string | null | undefined): "pending" | "complete" | "cancelled" {
  const normalized = String(status || "")
    .trim()
    .toLowerCase()

  if (normalized === "closed" || normalized === "complete") {
    return "complete"
  }

  if (normalized === "cancelled" || normalized === "canceled") {
    return "cancelled"
  }

  return "pending"
}

export function getOrderStatusLabel(status: string | null | undefined): string {
  const normalized = getOrderStatusTone(status)
  if (normalized === "complete") return "COMPLETE"
  if (normalized === "cancelled") return "CANCELLED"
  return "PENDING"
}

export function matchesOrderStatusFilter(status: string | null | undefined, filter: "all" | "pending" | "complete"): boolean {
  if (filter === "all") return true
  return getOrderStatusTone(status) === filter
}

export function formatReceiptDate(value: string | null | undefined): string {
  const parsedDate = value ? new Date(value) : new Date()
  const safeDate = Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate
  return safeDate.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })
}

export function getReceiptNumericString(value: number | string | null | undefined): string {
  const parsedValue = Number.parseFloat(String(value ?? 0))
  return Number.isFinite(parsedValue) ? parsedValue.toFixed(2) : "0.00"
}

export function escapeReceiptHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function getReceiptOrderCode(order: ReceiptOrder): string {
  return String(order?.short_code || order?.id || "\u2014")
}
