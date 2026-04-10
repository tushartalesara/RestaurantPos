import { ReceiptOrder } from "../types"

export function formatShortOrderCode(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null
  return String(Math.max(0, Math.floor(Number(value)))).padStart(3, "0")
}

export function formatCurrencyDisplay(value: number | null | undefined): string {
  return `$${Number(value || 0).toFixed(2)}`
}

export function formatAudioTime(value: number | null | undefined): string {
  const totalSeconds = Math.max(0, Math.floor(Number(value || 0)))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
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
