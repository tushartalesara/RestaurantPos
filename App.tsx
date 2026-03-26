import { StatusBar } from "expo-status-bar"
import * as ImagePicker from "expo-image-picker"
import { useEffect, useMemo, useState } from "react"
import {
  ActivityIndicator,
  Image,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native"
import type { ImageStyle, ViewStyle } from "react-native"
import {
  clearSession,
  getSession,
  loginWithEmail,
  registerWithEmail,
  resetPasswordWithEmail,
  saveSession,
} from "./src/auth"
import {
  deleteRestaurantOrder,
  getVoiceAgentLink,
  initDatabase,
  insertMenuScan,
  listRestaurantOrders,
  listRestaurantMenuItems,
  listRestaurants,
  replaceRestaurantMenuItems,
  saveRestaurantOrder,
  saveRestaurant,
  saveVoiceAgentLink,
} from "./src/db"
import { createEmptyMenuItem, parseMenuText } from "./src/menu-parser"
import { parseMenuFromImageWithGemini } from "./src/gemini-parser"
import type {
  MenuCustomizationDraft,
  MenuItemDraft,
  RestaurantOrderRecord,
  RestaurantRecord,
  SessionUser,
  VoiceAgentLinkRecord,
} from "./src/types"
import { createRestaurantVoiceAgent, loginToIbaraWorkspace } from "./src/workspace-api"

const DEFAULT_IBARA_BASE_URL = String(process.env.EXPO_PUBLIC_IBARA_BASE_URL || "").trim()
const INPUT_PLACEHOLDER_COLOR = "#8fa3bf"
const FONT_SANS = Platform.select({
  web: "Geist, Geist Fallback, Segoe UI, sans-serif",
  ios: "System",
  android: "sans-serif",
  default: "System",
})

const THEME = {
  background: "#0f1728",
  card: "#18263b",
  cardAlt: "#132034",
  border: "#2d3f5b",
  text: "#eaf1ff",
  mutedText: "#97abc7",
  primary: "#3f86ff",
  primarySoft: "#253b61",
  accent: "#45d3c1",
  accentSoft: "#173946",
  chip: "#20324a",
  chipBorder: "#324964",
  chipText: "#cad9ec",
  activeTextDark: "#07222a",
  loadingOverlay: "rgba(10, 18, 33, 0.76)",
}

const AUTH_CARD_SHADOW = (Platform.select({
  web: {
    boxShadow: "0px 10px 16px rgba(4, 11, 21, 0.4)",
  },
  default: {
    shadowColor: "#040b15",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
  },
}) || {}) as Record<string, unknown>

const CARD_SHADOW = (Platform.select({
  web: {
    boxShadow: "0px 8px 12px rgba(4, 11, 21, 0.35)",
  },
  default: {
    shadowColor: "#040b15",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
  },
}) || {}) as Record<string, unknown>

const METRIC_CARD_SHADOW = (Platform.select({
  web: {
    boxShadow: "0px 6px 10px rgba(4, 11, 21, 0.28)",
  },
  default: {
    shadowColor: "#040b15",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
  },
}) || {}) as Record<string, unknown>

type UiDraftItem = {
  name: string
  description: string
  category: string
  basePrice: string
  stockQuantity: string
  customizationText: string
}

type UiOrderDraft = {
  id?: string
  customerName: string
  customerPhone: string
  shortOrderCode?: number | null
  orderCodeDate?: string | null
  status: "pending" | "closed"
  notes: string
  itemsText: string
  callReview?: RestaurantOrderRecord["callReview"]
}

type MainTab = "overview" | "menu" | "orders" | "voice"
type AppMode = "admin" | "pos"
type AuthMode = "login" | "register" | "reset"
type ParseInsertMode = "replace" | "prepend" | "append"
type NoticeKind = "info" | "success" | "error" | "warning"
type AppNotice = {
  title: string
  message: string
  kind: NoticeKind
}

const NOTICE_TIMEOUT_MS = 4500

function stripTechnicalText(value: string) {
  return value
    .replace(/\s*\(status\s*\d+\)\.?/gi, "")
    .replace(/\bover_email_send_rate_limit\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
}

function resolveNoticeKind(title: string, message: string, preferredKind: NoticeKind): NoticeKind {
  if (preferredKind !== "info") {
    return preferredKind
  }

  const lowerTitle = title.toLowerCase()
  const lowerMessage = message.toLowerCase()

  if (lowerMessage.includes("rate limit")) {
    return "warning"
  }

  if (
    lowerTitle.includes("failed") ||
    lowerTitle.includes("error") ||
    lowerTitle.includes("validation") ||
    lowerTitle.includes("required")
  ) {
    return "error"
  }

  if (lowerTitle.includes("warning") || lowerTitle.includes("permission")) {
    return "warning"
  }

  if (
    lowerTitle.includes("connected") ||
    lowerTitle.includes("deleted") ||
    lowerTitle.includes("removed") ||
    lowerTitle.includes("linked") ||
    lowerTitle.includes("saved") ||
    lowerTitle.includes("updated")
  ) {
    return "success"
  }

  return "info"
}

function makeFriendlyTitle(title: string, kind: NoticeKind, message: string) {
  const lowerTitle = title.toLowerCase()
  const lowerMessage = message.toLowerCase()

  if (lowerMessage.includes("rate limit")) {
    return "Please wait a bit"
  }
  if (lowerTitle.includes("validation")) {
    return "Check a few details"
  }
  if (lowerTitle.includes("authentication failed")) {
    return "Couldn't sign you in"
  }
  if (lowerTitle.includes("password reset failed")) {
    return "Couldn't send the reset link"
  }
  if (lowerTitle.includes("signup pending") || lowerTitle.includes("password reset")) {
    return "Check your email"
  }
  if (lowerTitle.includes("load failed")) {
    return "Couldn't load that yet"
  }
  if (lowerTitle.includes("capture failed")) {
    return "Couldn't open the camera"
  }
  if (lowerTitle.includes("image error")) {
    return "Couldn't use that image"
  }
  if (lowerTitle.includes("save failed")) {
    return "Couldn't save that yet"
  }
  if (lowerTitle.includes("remove failed") || lowerTitle.includes("delete failed")) {
    return "Couldn't remove that"
  }
  if (lowerTitle.includes("order save failed")) {
    return "Couldn't save the order"
  }
  if (lowerTitle.includes("refresh failed")) {
    return "Couldn't refresh right now"
  }
  if (lowerTitle.includes("parse failed")) {
    return "Couldn't read that clearly"
  }
  if (lowerTitle.includes("ai parse warning") || lowerTitle.includes("ai parsing notes")) {
    return "Please review this"
  }
  if (lowerTitle.includes("permission")) {
    return "Permission needed"
  }
  if (lowerTitle.includes("restaurant required")) {
    return "Pick a restaurant first"
  }
  if (lowerTitle.includes("input required")) {
    return "Add a little more"
  }
  if (lowerTitle.includes("voice agent error")) {
    return "Couldn't connect the voice assistant"
  }
  if (lowerTitle.includes("link failed")) {
    return "Couldn't link that assistant"
  }
  if (lowerTitle === "error") {
    return "Something went wrong"
  }
  if (lowerTitle.includes("saved")) {
    return "Saved"
  }
  if (lowerTitle.includes("linked")) {
    return "Linked"
  }
  if (lowerTitle.includes("deleted") || lowerTitle.includes("removed")) {
    return "Removed"
  }
  if (lowerTitle.includes("connected")) {
    return "Connected"
  }

  return kind === "success" ? "All set" : "Something needs attention"
}

function makeFriendlyMessage(message: string, kind: NoticeKind) {
  const cleaned = stripTechnicalText(message)
  const lowerMessage = cleaned.toLowerCase()

  if (!cleaned) {
    return kind === "success" ? "Done." : "Please try again."
  }
  if (lowerMessage.includes("email rate limit exceeded") || lowerMessage.includes("too many requests")) {
    return "You've tried that a few times already. Please wait a little, then try again."
  }
  if (lowerMessage.includes("invalid login credentials") || lowerMessage.includes("invalid credentials")) {
    return "That email or password doesn't look right. Please try again."
  }
  if (lowerMessage.includes("email and password are required")) {
    return "Please enter your email and password."
  }
  if (lowerMessage.includes("email is required for password reset") || lowerMessage.includes("enter the email")) {
    return "Please enter your email address."
  }
  if (lowerMessage.includes("restaurant name is required")) {
    return "Please enter a restaurant name."
  }
  if (lowerMessage.includes("customer name is required")) {
    return "Please enter the customer's name."
  }
  if (lowerMessage.includes("add at least one menu item to save") || lowerMessage === "add at least one menu item.") {
    return "Please add at least one menu item before saving."
  }
  if (lowerMessage.includes("add at least one order item")) {
    return "Please add at least one item before saving the order."
  }
  if (lowerMessage.includes("create/select a restaurant first") || lowerMessage.includes("select a restaurant first")) {
    return "Please choose a restaurant first."
  }
  if (lowerMessage.includes("scan an image or paste ocr menu text")) {
    return "Please add a menu photo or paste the menu text first."
  }
  if (lowerMessage.includes("restaurant profile saved")) {
    return "Restaurant details saved."
  }
  if (lowerMessage.includes("menu updates (including prices) saved")) {
    return "Your menu changes have been saved."
  }
  if (lowerMessage.includes("menu items and customizations stored in supabase")) {
    return "Your menu has been saved."
  }
  if (lowerMessage.includes("order saved successfully")) {
    return "The order has been saved."
  }
  if (lowerMessage.includes("order updated successfully")) {
    return "The order has been updated."
  }
  if (lowerMessage.includes("order removed")) {
    return "The order has been removed."
  }
  if (lowerMessage.includes("existing workspace agent linked successfully")) {
    return "Your voice assistant has been linked."
  }
  if (lowerMessage.includes("linked voice agent:")) {
    return "Your voice assistant is ready to use."
  }
  if (lowerMessage.includes("confirmation email sent to")) {
    const email = cleaned.replace(/^confirmation email sent to\s+/i, "").replace(/\..*$/, "").trim()
    return email ? `We sent a confirmation email to ${email}. Open it, then come back and sign in.` : "We sent you a confirmation email. Open it, then come back and sign in."
  }
  if (lowerMessage.includes("reset link has been sent")) {
    return cleaned
  }
  if (lowerMessage.includes("this email is already registered")) {
    return "That email is already in use. Try signing in instead."
  }
  if (lowerMessage.includes("password is too short")) {
    return "Choose a password with at least 6 characters."
  }
  if (lowerMessage.includes("new account creation is turned off")) {
    return "New account creation is turned off right now."
  }
  if (lowerMessage.includes("email format is invalid")) {
    return "Please check the email address and try again."
  }
  if (lowerMessage.includes("no account found for this email")) {
    return "We couldn't find an account with that email."
  }
  if (lowerMessage.includes("please verify your email first")) {
    return "Please open the confirmation email we sent earlier, then sign in."
  }
  if (lowerMessage.includes("failed to initialize supabase connection")) {
    return "The app isn't fully connected yet. Please check the setup and try again."
  }
  if (lowerMessage.includes("supabase config missing")) {
    return "The app setup is incomplete. Please finish the connection details and try again."
  }
  if (lowerMessage.includes("supabase table")) {
    return "The database setup still needs one more step before this can work."
  }
  if (lowerMessage.includes("failed to save restaurant")) {
    return "We couldn't save the restaurant details. Please try again."
  }
  if (lowerMessage.includes("failed to update menu")) {
    return "We couldn't save those menu changes. Please try again."
  }
  if (lowerMessage.includes("failed to save menu")) {
    return "We couldn't save the menu just yet. Please try again."
  }
  if (lowerMessage.includes("failed to save order")) {
    return "We couldn't save that order. Please try again."
  }
  if (lowerMessage.includes("failed to remove order")) {
    return "We couldn't remove that order. Please try again."
  }
  if (lowerMessage.includes("failed to refresh orders")) {
    return "We couldn't refresh the orders just now. Please try again."
  }
  if (lowerMessage.includes("failed to connect voice agent")) {
    return "We couldn't connect the voice assistant right now."
  }
  if (lowerMessage.includes("failed to link existing agent")) {
    return "We couldn't link that voice assistant right now."
  }
  if (lowerMessage.includes("failed to parse and store menu scan")) {
    return "We couldn't read that menu just yet. Please try again."
  }
  if (lowerMessage.includes("gemini api key is missing")) {
    return "AI menu reading isn't connected yet. Please finish the setup and try again."
  }
  if (lowerMessage.includes("gemini returned empty output") || lowerMessage.includes("gemini output was not valid json")) {
    return "We couldn't read that menu clearly. Please try another image or add a little more text."
  }
  if (lowerMessage.includes("gemini rate limit reached")) {
    return "The AI menu reader is busy right now. Please wait a little, then try again."
  }
  if (lowerMessage.includes("gemini request failed")) {
    return "We couldn't reach the AI menu reader right now. Please try again."
  }
  if (lowerMessage.includes("camera/media permission is required")) {
    return "Please allow camera or photo access to continue."
  }
  if (lowerMessage.includes("could not capture image from camera input")) {
    return "We couldn't open the camera just now. Please try again or use a photo from your gallery."
  }
  if (lowerMessage.includes("failed to read image base64 content")) {
    return "We couldn't read that image. Please try a different one."
  }
  if (lowerMessage.includes("workspace url, email, and password are required")) {
    return "Please fill in the workspace details before continuing."
  }
  if (lowerMessage.includes("workspace url and agent id are required")) {
    return "Please enter the workspace details before linking the assistant."
  }
  if (lowerMessage.includes("failed to authenticate with ibara workspace")) {
    return "We couldn't sign in to the voice assistant workspace. Please check the details and try again."
  }
  if (lowerMessage.includes("failed to create voice agent in workspace")) {
    return "We couldn't create the voice assistant right now. Please try again."
  }
  if (lowerMessage.includes("workspace did not return an agent_id") || lowerMessage.includes("workspace did not return an agent id")) {
    return "We couldn't finish linking the voice assistant. Please try again."
  }
  if (lowerMessage.includes("network request failed") || lowerMessage.includes("failed to fetch")) {
    return "We couldn't reach the server. Please check your internet and try again."
  }

  return cleaned
}

function parseCustomizationText(value: string): MenuCustomizationDraft[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/(.+)\+(\d+(?:\.\d{1,2})?)$/)
      if (match) {
        return {
          label: match[1].trim(),
          value: null,
          priceDelta: Number(match[2]),
          isRequired: false,
        }
      }
      return {
        label: part,
        value: null,
        priceDelta: 0,
        isRequired: false,
      }
    })
}

function fromMenuItem(item: MenuItemDraft): UiDraftItem {
  return {
    name: item.name || "",
    description: item.description || "",
    category: item.category || "",
    basePrice: String(item.basePrice || 0),
    stockQuantity: String(Math.max(0, Number(item.stockQuantity || 0))),
    customizationText: (item.customizations || [])
      .map((customization) =>
        customization.priceDelta ? `${customization.label}+${customization.priceDelta}` : customization.label,
      )
      .join(", "),
  }
}

function toMenuItem(item: UiDraftItem): MenuItemDraft {
  return {
    name: item.name.trim(),
    description: item.description.trim() || null,
    category: item.category.trim() || null,
    basePrice: Number(item.basePrice || 0),
    stockQuantity: Math.max(0, Number(item.stockQuantity || 0)),
    customizations: parseCustomizationText(item.customizationText),
  }
}

function toUiMenuItems(items: MenuItemDraft[]): UiDraftItem[] {
  if (items.length === 0) {
    return [fromMenuItem(createEmptyMenuItem())]
  }
  return items.map(fromMenuItem)
}

function normalizeMenuIdentityValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

function isMostlyUppercase(value: string): boolean {
  const lettersOnly = value.replace(/[^a-z]/gi, "")
  return lettersOnly.length > 0 && lettersOnly === lettersOnly.toUpperCase()
}

function pickPreferredMenuText(currentValue: string, incomingValue: string): string {
  const current = currentValue.trim()
  const incoming = incomingValue.trim()

  if (!current) return incoming
  if (!incoming) return current

  const currentIsUppercase = isMostlyUppercase(current)
  const incomingIsUppercase = isMostlyUppercase(incoming)

  if (currentIsUppercase && !incomingIsUppercase) {
    return incoming
  }

  return current
}

function pickBestDescription(currentValue: string, incomingValue: string): string {
  const current = currentValue.trim()
  const incoming = incomingValue.trim()

  if (!current) return incoming
  if (!incoming) return current

  if (normalizeMenuIdentityValue(current) === normalizeMenuIdentityValue(incoming)) {
    return pickPreferredMenuText(current, incoming)
  }

  return incoming.length > current.length ? incoming : current
}

function mergeCustomizationText(currentValue: string, incomingValue: string): string {
  const merged: string[] = []
  const seen = new Set<string>()

  for (const rawPart of `${currentValue},${incomingValue}`.split(",")) {
    const part = rawPart.trim()
    if (!part) {
      continue
    }

    const key = normalizeMenuIdentityValue(part)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    merged.push(part)
  }

  return merged.join(", ")
}

function getUiMenuItemKey(item: UiDraftItem): string {
  const normalizedName = normalizeMenuIdentityValue(item.name)
  if (!normalizedName) {
    return ""
  }

  const normalizedCategory = normalizeMenuIdentityValue(item.category)
  return normalizedCategory ? `${normalizedCategory}::${normalizedName}` : normalizedName
}

function mergeUiMenuItems(existingItem: UiDraftItem, incomingItem: UiDraftItem): UiDraftItem {
  const existingPrice = Number(existingItem.basePrice || 0)
  const incomingPrice = Number(incomingItem.basePrice || 0)
  const existingStock = Number(existingItem.stockQuantity || 0)
  const incomingStock = Number(incomingItem.stockQuantity || 0)

  return {
    ...existingItem,
    name: pickPreferredMenuText(existingItem.name, incomingItem.name),
    description: pickBestDescription(existingItem.description, incomingItem.description),
    category: pickPreferredMenuText(existingItem.category, incomingItem.category),
    basePrice: existingPrice > 0 ? existingItem.basePrice : incomingItem.basePrice,
    stockQuantity: String(Math.max(existingStock, incomingStock)),
    customizationText: mergeCustomizationText(existingItem.customizationText, incomingItem.customizationText),
  }
}

function dedupeUiMenuItems(items: UiDraftItem[]): UiDraftItem[] {
  const deduped: UiDraftItem[] = []
  const indexByKey = new Map<string, number>()

  for (const item of items) {
    const key = getUiMenuItemKey(item)
    if (!key) {
      deduped.push({ ...item })
      continue
    }

    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, deduped.length)
      deduped.push({ ...item })
      continue
    }

    deduped[existingIndex] = mergeUiMenuItems(deduped[existingIndex], item)
  }

  return deduped
}

function dedupeMenuItems(items: MenuItemDraft[]): MenuItemDraft[] {
  return dedupeUiMenuItems(items.map(fromMenuItem)).map(toMenuItem)
}

function formatOrderItemLine(item: RestaurantOrderRecord["items"][number]): string {
  const quantity = Math.max(1, Number(item.quantity || 1))
  const unitPrice = Number(item.unitPrice || 0)
  const normalizedPrice = Number.isFinite(unitPrice) ? unitPrice.toFixed(2) : "0.00"
  return `Item: ${item.name}\nQuantity: ${quantity}\nUnit price: ${normalizedPrice}`
}

function orderItemsToText(order: RestaurantOrderRecord): string {
  return (order.items || []).map(formatOrderItemLine).join("\n\n")
}

function orderToUiDraft(order: RestaurantOrderRecord): UiOrderDraft {
  return {
    id: order.id,
    customerName: order.customerName,
    customerPhone: order.customerPhone || "",
    shortOrderCode: order.shortOrderCode ?? null,
    orderCodeDate: order.orderCodeDate ?? null,
    status: order.status,
    notes: order.notes || "",
    itemsText: orderItemsToText(order),
    callReview: order.callReview || null,
  }
}

function hasMeaningfulDraftItem(item: UiDraftItem) {
  return Boolean(
    item.name.trim() ||
      item.description.trim() ||
      item.category.trim() ||
      item.customizationText.trim() ||
      Number(item.basePrice || 0) > 0 ||
      Number(item.stockQuantity || 0) > 0,
  )
}

function parseOrderItemsFromText(itemsText: string): RestaurantOrderRecord["items"] {
  return itemsText
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const normalizedBlock = block.replace(/\r?\n/g, " | ")
      const labeledMatch = normalizedBlock.match(
        /^(?:item\s*:\s*)?(.*?)\s*\|\s*(?:qty|quantity)\s*:\s*(\d+)\s*\|\s*(?:unit\s*price|price)\s*:\s*(\d+(?:\.\d{1,2})?)$/i,
      )

      let namePart = ""
      let qtyPart = ""
      let pricePart = ""

      if (labeledMatch) {
        namePart = labeledMatch[1]?.trim() || ""
        qtyPart = labeledMatch[2]?.trim() || ""
        pricePart = labeledMatch[3]?.trim() || ""
      } else if (block.includes("|") && !block.includes("\n")) {
        ;[namePart = "", qtyPart = "", pricePart = ""] = block.split("|").map((part) => part.trim())
      } else {
        const lines = block
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)

        for (const line of lines) {
          if (/^item\s*:/i.test(line)) {
            namePart = line.replace(/^item\s*:/i, "").trim()
            continue
          }
          if (/^(?:qty|quantity)\s*:/i.test(line)) {
            qtyPart = line.replace(/^(?:qty|quantity)\s*:/i, "").trim()
            continue
          }
          if (/^(?:unit\s*price|price)\s*:/i.test(line)) {
            pricePart = line.replace(/^(?:unit\s*price|price)\s*:/i, "").trim()
            continue
          }
          if (!namePart) {
            namePart = line
          }
        }
      }

      const quantity = Math.max(1, Number(qtyPart || 1))
      const unitPrice = Number(pricePart || 0)
      return {
        name: namePart,
        quantity: Number.isFinite(quantity) ? quantity : 1,
        unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      }
    })
    .filter((item) => item.name.length > 0)
}

function normalizeWebPortalMode(value: string | null | undefined): AppMode | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
  return normalized === "admin" || normalized === "pos" ? normalized : null
}

function resolveWebPortalMode(): AppMode {
  if (Platform.OS !== "web" || typeof window === "undefined") {
    return "admin"
  }

  const searchParams = new URLSearchParams(window.location.search)
  const hashValue = window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0]
  const pathValue = window.location.pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean)
    .pop()

  return (
    normalizeWebPortalMode(searchParams.get("portal")) ||
    normalizeWebPortalMode(searchParams.get("mode")) ||
    normalizeWebPortalMode(hashValue) ||
    normalizeWebPortalMode(pathValue) ||
    "pos"
  )
}

function getInitialAppMode(): AppMode {
  return Platform.OS === "web" ? resolveWebPortalMode() : "admin"
}

function formatShortOrderCode(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null
  }

  return String(Math.round(value)).padStart(3, "0")
}

function getOrderDraftKey(order: UiOrderDraft, index: number): string {
  return order.id || `draft-${index}`
}

function hasCallReviewContent(callReview: RestaurantOrderRecord["callReview"]) {
  return Boolean(callReview?.recordingUrl?.trim() || callReview?.transcriptText?.trim())
}

function parseTranscriptEntries(transcriptText: string) {
  const entries: Array<{ speaker: string; message: string; tone: "agent" | "user" | "neutral" }> = []

  for (const rawLine of transcriptText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const speakerMatch = line.match(/^([^:]{1,40}):\s*(.*)$/)
    if (!speakerMatch) {
      if (entries.length > 0) {
        entries[entries.length - 1].message = `${entries[entries.length - 1].message}\n${line}`.trim()
      } else {
        entries.push({ speaker: "Call", message: line, tone: "neutral" })
      }
      continue
    }

    const speaker = speakerMatch[1].trim()
    const message = speakerMatch[2].trim()
    const normalizedSpeaker = speaker.toLowerCase()
    const tone =
      normalizedSpeaker.includes("agent") || normalizedSpeaker.includes("assistant")
        ? "agent"
        : normalizedSpeaker.includes("user") || normalizedSpeaker.includes("caller") || normalizedSpeaker.includes("customer")
          ? "user"
          : "neutral"

    if (!message) {
      continue
    }

    entries.push({ speaker, message, tone })
  }

  return entries
}

function renderOrderItemCards(
  items: RestaurantOrderRecord["items"],
  params?: { isWeb?: boolean; emptyLabel?: string },
) {
  const isWeb = Boolean(params?.isWeb)
  const emptyLabel = params?.emptyLabel || "No items yet."

  if (items.length === 0) {
    return <Text style={styles.subtitle}>{emptyLabel}</Text>
  }

  return (
    <View style={[styles.orderItemsGrid, isWeb ? styles.orderItemsGridWeb : null]}>
      {items.map((item, index) => {
        const quantity = Math.max(1, Number(item.quantity || 1))
        const unitPrice = Number(item.unitPrice || 0)
        const normalizedUnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0
        const lineTotal = normalizedUnitPrice * quantity

        return (
          <View key={`order-item-${item.id || item.name}-${index}`} style={[styles.orderItemCard, isWeb ? styles.orderItemCardWeb : null]}>
            <Text style={styles.orderItemTitle}>{item.name}</Text>
            <View style={styles.orderItemStatsRow}>
              <View style={styles.orderItemStat}>
                <Text style={styles.orderItemStatLabel}>Qty</Text>
                <Text style={styles.orderItemStatValue}>{quantity}</Text>
              </View>
              <View style={styles.orderItemStat}>
                <Text style={styles.orderItemStatLabel}>Unit</Text>
                <Text style={styles.orderItemStatValue}>{normalizedUnitPrice.toFixed(2)}</Text>
              </View>
              <View style={styles.orderItemStat}>
                <Text style={styles.orderItemStatLabel}>Total</Text>
                <Text style={styles.orderItemStatValue}>{lineTotal.toFixed(2)}</Text>
              </View>
            </View>
          </View>
        )
      })}
    </View>
  )
}

export default function App() {
  const isWeb = Platform.OS === "web"
  const { width: viewportWidth } = useWindowDimensions()
  const useWideOrderLayout = isWeb && viewportWidth >= 980
  const isCompactViewport = viewportWidth < 640
  const webSafeStyle =
    Platform.OS === "web" ? (({ minHeight: "100dvh", width: "100%" } as unknown) as ViewStyle) : null

  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [user, setUser] = useState<SessionUser | null>(null)

  const [restaurants, setRestaurants] = useState<RestaurantRecord[]>([])
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string | null>(null)
  const selectedRestaurant = useMemo(
    () => restaurants.find((restaurant) => restaurant.id === selectedRestaurantId) || null,
    [restaurants, selectedRestaurantId],
  )

  const [restaurantName, setRestaurantName] = useState("")
  const [restaurantPhone, setRestaurantPhone] = useState("")
  const [restaurantAddress, setRestaurantAddress] = useState("")

  const [imageUri, setImageUri] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState("")
  const [imageMimeType, setImageMimeType] = useState("image/jpeg")
  const [rawMenuText, setRawMenuText] = useState("")
  const [scanId, setScanId] = useState<string | null>(null)
  const [draftItems, setDraftItems] = useState<UiDraftItem[]>([])
  const [parseInsertMode, setParseInsertMode] = useState<ParseInsertMode>("replace")
  const [savedItems, setSavedItems] = useState<MenuItemDraft[]>([])
  const [editableMenuItems, setEditableMenuItems] = useState<UiDraftItem[]>([])
  const [orders, setOrders] = useState<RestaurantOrderRecord[]>([])
  const [orderDrafts, setOrderDrafts] = useState<UiOrderDraft[]>([])
  const [expandedOrderEditors, setExpandedOrderEditors] = useState<Record<string, boolean>>({})
  const [activeCallReview, setActiveCallReview] = useState<{
    title: string
    callReview: RestaurantOrderRecord["callReview"]
  } | null>(null)

  const [workspaceBaseUrl, setWorkspaceBaseUrl] = useState(DEFAULT_IBARA_BASE_URL)
  const [workspaceEmail, setWorkspaceEmail] = useState("")
  const [workspacePassword, setWorkspacePassword] = useState("")
  const [manualAgentId, setManualAgentId] = useState("")
  const [voiceAgentLink, setVoiceAgentLink] = useState<VoiceAgentLinkRecord | null>(null)

  useEffect(() => {
    if (!appNotice) {
      return
    }

    const timeoutId = setTimeout(() => {
      setAppNotice((current) => (current === appNotice ? null : current))
    }, NOTICE_TIMEOUT_MS)

    return () => clearTimeout(timeoutId)
  }, [appNotice])
  const [activeTab, setActiveTab] = useState<MainTab>(() => (getInitialAppMode() === "pos" ? "orders" : "overview"))
  const [appMode, setAppMode] = useState<AppMode>(getInitialAppMode)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        await initDatabase()
        const session = await getSession()
        if (mounted && session?.user) {
          setUser(session.user)
        }
      } catch (error) {
        if (mounted) {
          showNotification("Error", error instanceof Error ? error.message : "Failed to initialize Supabase connection.")
        }
      } finally {
        if (mounted) {
          setBooting(false)
        }
      }
    })()

    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    if (!user) {
      return
    }
    refreshRestaurants(user.id)
  }, [user])

  useEffect(() => {
    if (appMode === "pos" && activeTab !== "orders") {
      setActiveTab("orders")
    }
  }, [appMode, activeTab])

  useEffect(() => {
    if (!isWeb || typeof window === "undefined") {
      return
    }

    const syncPortalModeFromUrl = () => {
      const nextMode = resolveWebPortalMode()
      setAppMode(nextMode)
      setActiveTab((currentTab) => (nextMode === "pos" ? "orders" : currentTab === "orders" ? "overview" : currentTab))
    }

    window.addEventListener("hashchange", syncPortalModeFromUrl)
    window.addEventListener("popstate", syncPortalModeFromUrl)

    return () => {
      window.removeEventListener("hashchange", syncPortalModeFromUrl)
      window.removeEventListener("popstate", syncPortalModeFromUrl)
    }
  }, [isWeb])

  useEffect(() => {
    if (!selectedRestaurant) {
      setRestaurantName("")
      setRestaurantPhone("")
      setRestaurantAddress("")
      setImageUri(null)
      setImageBase64("")
      setRawMenuText("")
      setScanId(null)
      setDraftItems([])
      setSavedItems([])
      setEditableMenuItems([])
      setOrders([])
      setOrderDrafts([])
      setExpandedOrderEditors({})
      setActiveCallReview(null)
      setVoiceAgentLink(null)
      return
    }
    let cancelled = false
    setRestaurantName(selectedRestaurant.name)
    setRestaurantPhone(selectedRestaurant.phone || "")
    setRestaurantAddress(selectedRestaurant.address || "")
    setImageUri(null)
    setImageBase64("")
    setRawMenuText("")
    setScanId(null)
    setDraftItems([])
    setExpandedOrderEditors({})
    setActiveCallReview(null)
    ;(async () => {
      try {
        const [items, fetchedOrders, voiceLink] = await Promise.all([
          listRestaurantMenuItems(selectedRestaurant.id),
          listRestaurantOrders(selectedRestaurant.id),
          getVoiceAgentLink(selectedRestaurant.id),
        ])

        if (cancelled) {
          return
        }

        const uniqueItems = dedupeMenuItems(items)
        setSavedItems(uniqueItems)
        setEditableMenuItems(toUiMenuItems(uniqueItems))
        setOrders(fetchedOrders)
        setOrderDrafts(fetchedOrders.map(orderToUiDraft))
        setVoiceAgentLink(voiceLink)
        setManualAgentId(voiceLink?.workspace_agent_id || "")
      } catch (error) {
        if (cancelled) {
          return
        }
        const message = error instanceof Error ? error.message : "Failed to load restaurant data."
        showNotification("Load Failed", message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedRestaurantId, selectedRestaurant])

  async function refreshRestaurants(ownerUserId: string) {
    const rows = await listRestaurants(ownerUserId)
    setRestaurants(rows)
    if (rows.length > 0) {
      setSelectedRestaurantId((previousValue) => previousValue || rows[0].id)
    } else {
      setSelectedRestaurantId(null)
    }
  }

  async function refreshOrders(restaurantId: string) {
    const fetchedOrders = await listRestaurantOrders(restaurantId)
    setOrders(fetchedOrders)
    setOrderDrafts(fetchedOrders.map(orderToUiDraft))
  }

  async function handleAuth() {
    if (!email.trim() || !password.trim()) {
      showNotification("Validation", "Email and password are required.")
      return
    }
    setBusy(true)
    try {
      const sessionUser =
        authMode === "register"
          ? await registerWithEmail(email.trim(), password)
          : await loginWithEmail(email.trim(), password)
      await saveSession({ user: sessionUser })
      setUser(sessionUser)
      setPassword("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to authenticate."
      if (authMode === "register" && message.includes("Confirmation email sent")) {
        showNotification("Signup Pending", message, "info")
      } else {
        showNotification("Authentication Failed", message, "error")
      }
    } finally {
      setBusy(false)
    }
  }

  function showNotification(title: string, message: string, kind: NoticeKind = "info") {
    const friendlyMessage = makeFriendlyMessage(message, kind)
    const resolvedKind = resolveNoticeKind(title, friendlyMessage, kind)
    const friendlyTitle = makeFriendlyTitle(title, resolvedKind, friendlyMessage)
    setAppNotice({ title: friendlyTitle, message: friendlyMessage, kind: resolvedKind })
  }

  function renderNotice() {
    if (!appNotice) return null
    const noticeStyle =
      appNotice.kind === "success"
        ? styles.noticeSuccess
        : appNotice.kind === "error"
          ? styles.noticeError
          : appNotice.kind === "warning"
            ? styles.noticeWarning
            : styles.noticeInfo

    return (
      <View style={[styles.notice, noticeStyle]}>
        <Text style={styles.noticeTitle}>{appNotice.title}</Text>
        <Text style={styles.noticeMessage}>{appNotice.message}</Text>
      </View>
    )
  }

  async function handleResetPassword() {
    if (!email.trim()) {
      showNotification("Validation", "Please enter the email for your account.")
      return
    }

    setBusy(true)
    try {
      await resetPasswordWithEmail(email.trim())
      showNotification(
        "Password Reset",
        `If an account exists for ${email.trim()}, a reset link has been sent. Please check your inbox and spam folder.`,
      )
    } catch (error) {
      showNotification(
        "Password Reset Failed",
        error instanceof Error ? error.message : "Could not send reset link.",
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    await clearSession()
    setUser(null)
    setRestaurants([])
    setSelectedRestaurantId(null)
    setDraftItems([])
    setSavedItems([])
    setEditableMenuItems([])
    setOrders([])
    setOrderDrafts([])
    setExpandedOrderEditors({})
    setActiveCallReview(null)
    setVoiceAgentLink(null)
    setManualAgentId("")
  }

  function openOrderCallReview(title: string, callReview: RestaurantOrderRecord["callReview"]) {
    if (!hasCallReviewContent(callReview)) {
      showNotification("Call Review", "The call details are not ready yet.")
      return
    }
    setActiveCallReview({ title, callReview })
  }

  function closeOrderCallReview() {
    setActiveCallReview(null)
  }

  async function handleOpenCallRecording(recordingUrl: string) {
    const normalizedUrl = recordingUrl.trim()
    if (!normalizedUrl) {
      showNotification("Call Review", "The call recording is not available yet.")
      return
    }

    try {
      await Linking.openURL(normalizedUrl)
    } catch (error) {
      showNotification(
        "Call Review",
        error instanceof Error ? error.message : "Couldn't open the call recording.",
        "error",
      )
    }
  }

  function renderCallReviewModal() {
    if (!activeCallReview) {
      return null
    }

    const transcriptText = activeCallReview.callReview?.transcriptText?.trim() || ""
    const recordingUrl = activeCallReview.callReview?.recordingUrl?.trim() || ""
    const hasTranscript = transcriptText.length > 0
    const hasRecording = recordingUrl.length > 0
    const analysisStatus = activeCallReview.callReview?.analysisStatus?.trim()
    const transcriptEntries = hasTranscript ? parseTranscriptEntries(transcriptText) : []

    const modalWidth = Math.max(280, Math.min(viewportWidth - 24, isCompactViewport ? viewportWidth : 760))

    return (
      <Modal visible transparent animationType="fade" onRequestClose={closeOrderCallReview}>
        <View style={[styles.callReviewOverlay, isCompactViewport ? styles.callReviewOverlayCompact : null]}>
          <Pressable style={styles.callReviewBackdrop} onPress={closeOrderCallReview} />
          <View
            style={[
              styles.callReviewModal,
              isWeb ? styles.callReviewModalWeb : null,
              isCompactViewport ? styles.callReviewModalCompact : null,
              { width: modalWidth },
            ]}
          >
            <View style={[styles.callReviewHeader, isCompactViewport ? styles.callReviewHeaderCompact : null]}>
              <View style={styles.headerTextWrap}>
                <Text style={styles.callReviewTitle}>Call review</Text>
                <Text style={styles.callReviewSubtitle}>{activeCallReview.title}</Text>
                <Text style={styles.callReviewMeta}>
                  {analysisStatus
                    ? `Status: ${analysisStatus}`
                    : "Use the audio or transcript if anything in the order needs a quick double-check."}
                </Text>
              </View>
              <View
                style={[
                  styles.callReviewHeaderActions,
                  isCompactViewport ? styles.callReviewHeaderActionsCompact : null,
                ]}
              >
                <Pressable
                  style={[styles.callReviewCloseButton, isCompactViewport ? styles.callReviewCloseButtonCompact : null]}
                  onPress={closeOrderCallReview}
                >
                  <Text style={styles.callReviewCloseText}>{isCompactViewport ? "Done" : "Close"}</Text>
                </Pressable>
              </View>
            </View>
            {hasRecording ? (
              <Pressable
                style={[styles.callReviewActionButton, isCompactViewport ? styles.callReviewActionButtonCompact : null]}
                onPress={() => handleOpenCallRecording(recordingUrl)}
              >
                <Text style={styles.callReviewActionText}>Open Audio</Text>
              </Pressable>
            ) : null}
            {hasTranscript ? (
              <View style={[styles.callReviewTranscriptBox, isCompactViewport ? styles.callReviewTranscriptBoxCompact : null]}>
                <Text style={styles.fieldLabel}>Transcript</Text>
                <ScrollView
                  nestedScrollEnabled
                  style={[styles.callReviewTranscriptScroll, isCompactViewport ? styles.callReviewTranscriptScrollCompact : null]}
                >
                  <View style={styles.callReviewTranscriptList}>
                    {transcriptEntries.length > 0 ? (
                      transcriptEntries.map((entry, index) => (
                        <View
                          key={`transcript-entry-${index}`}
                          style={[
                            styles.callReviewTranscriptEntry,
                            entry.tone === "agent"
                              ? styles.callReviewTranscriptEntryAgent
                              : entry.tone === "user"
                                ? styles.callReviewTranscriptEntryUser
                                : styles.callReviewTranscriptEntryNeutral,
                            index < transcriptEntries.length - 1 ? styles.callReviewTranscriptEntryDivider : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.callReviewTranscriptSpeaker,
                              entry.tone === "agent"
                                ? styles.callReviewTranscriptSpeakerAgent
                                : entry.tone === "user"
                                  ? styles.callReviewTranscriptSpeakerUser
                                  : null,
                            ]}
                          >
                            {entry.speaker}
                          </Text>
                          <Text style={styles.callReviewTranscriptMessage}>{entry.message}</Text>
                        </View>
                      ))
                    ) : (
                      <Text style={styles.orderTranscriptText}>{transcriptText}</Text>
                    )}
                  </View>
                </ScrollView>
              </View>
            ) : (
              <Text style={styles.callReviewHint}>Transcript is not available yet.</Text>
            )}
            {!hasRecording ? <Text style={styles.callReviewHint}>Audio is not available yet.</Text> : null}
          </View>
        </View>
      </Modal>
    )
  }

  async function handleSaveRestaurant() {
    if (!user) return
    if (!restaurantName.trim()) {
      showNotification("Validation", "Restaurant name is required.")
      return
    }
    setBusy(true)
    try {
      const id = await saveRestaurant({
        ownerUserId: user.id,
        restaurantId: selectedRestaurantId || undefined,
        name: restaurantName.trim(),
        phone: restaurantPhone.trim() || null,
        address: restaurantAddress.trim() || null,
      })
      await refreshRestaurants(user.id)
      setSelectedRestaurantId(id)
      showNotification("Saved", "Restaurant profile saved.")
    } catch (error) {
      showNotification("Save Failed", error instanceof Error ? error.message : "Failed to save restaurant.")
    } finally {
      setBusy(false)
    }
  }

  function setSelectedImage(input: { uri: string; base64: string; mimeType?: string | null }) {
    setImageUri(input.uri)
    setImageBase64(input.base64)
    setImageMimeType(input.mimeType || "image/jpeg")
  }

  async function pickImageFromWebCameraInput() {
    if (typeof document === "undefined") {
      return false
    }

    return new Promise<boolean>((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      input.accept = "image/*"
      input.setAttribute("capture", "environment")

      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) {
          resolve(false)
          return
        }

        const reader = new FileReader()
        reader.onload = () => {
          const result = typeof reader.result === "string" ? reader.result : ""
          const separatorIndex = result.indexOf(",")
          if (separatorIndex <= 0) {
            resolve(false)
            return
          }

          const metadata = result.slice(0, separatorIndex)
          const base64 = result.slice(separatorIndex + 1)
          const mimeMatch = metadata.match(/data:(.*?);base64/i)
          const mimeType = mimeMatch?.[1] || file.type || "image/jpeg"
          const uri = URL.createObjectURL(file)

          setSelectedImage({ uri, base64, mimeType })
          resolve(true)
        }
        reader.onerror = () => resolve(false)
        reader.readAsDataURL(file)
      }

      input.click()
    })
  }

  async function pickImage(fromCamera: boolean) {
    if (fromCamera && Platform.OS === "web") {
      const success = await pickImageFromWebCameraInput()
      if (!success) {
        showNotification("Capture Failed", "Could not capture image from camera input. Try gallery upload.")
      }
      return
    }

    const permission = fromCamera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync()

    if (!permission.granted) {
      showNotification("Permission", "Camera/media permission is required.")
      return
    }

    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: "images",
          base64: true,
          quality: 0.8,
          exif: false,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: "images",
          base64: true,
          quality: 0.8,
        })

    if (result.canceled || result.assets.length === 0) {
      return
    }

    const asset = result.assets[0]
    if (!asset.base64) {
      showNotification("Image Error", "Failed to read image base64 content. Please try another image.")
      return
    }

    setSelectedImage({
      uri: asset.uri,
      base64: asset.base64,
      mimeType: asset.mimeType || "image/jpeg",
    })
  }

  async function handleParseMenu() {
    if (!selectedRestaurant) {
      showNotification("Restaurant Required", "Create/select a restaurant first.")
      return
    }

    if (!rawMenuText.trim() && !imageBase64) {
      showNotification("Input Required", "Scan an image or paste OCR menu text.")
      return
    }

    setBusy(true)
    try {
      let parsed: MenuItemDraft[] = []
      let aiSummary = ""
      let aiWarnings: string[] = []

      if (imageBase64) {
        try {
          const aiExtraction = await parseMenuFromImageWithGemini({
            imageBase64,
            imageMimeType,
            promptHint: rawMenuText.trim() || undefined,
          })
          parsed = aiExtraction.items
          aiSummary = aiExtraction.summary
          aiWarnings = aiExtraction.warnings

          if (!rawMenuText.trim() && aiSummary) {
            setRawMenuText(aiSummary)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "AI image parsing failed."
          if (!rawMenuText.trim()) {
            showNotification("AI Parse Failed", message)
          } else {
            showNotification("AI Parse Warning", `${message}\nFalling back to text parsing.`)
          }
        }
      }

      if (parsed.length === 0 && rawMenuText.trim()) {
        parsed = parseMenuText(rawMenuText.trim())
      }

      const rawParsedItems = parsed.length > 0 ? toUiMenuItems(parsed) : []
      const parsedItems = dedupeUiMenuItems(rawParsedItems)
      const currentDraftItems = draftItems.some(hasMeaningfulDraftItem) ? draftItems : []
      const savedDraftItems = savedItems.length > 0 ? toUiMenuItems(savedItems) : []
      const existingItems = dedupeUiMenuItems(currentDraftItems.length > 0 ? currentDraftItems : savedDraftItems)
      const mergedItems = dedupeUiMenuItems(
        parsedItems.length === 0
          ? existingItems.length > 0
            ? existingItems
            : [fromMenuItem(createEmptyMenuItem())]
          : parseInsertMode === "prepend"
            ? [...parsedItems, ...existingItems]
            : parseInsertMode === "append"
              ? [...existingItems, ...parsedItems]
              : parsedItems,
      )

      const parsedItemCount = rawParsedItems.filter(hasMeaningfulDraftItem).length
      const existingItemCount = existingItems.filter(hasMeaningfulDraftItem).length
      const mergedItemCount = mergedItems.filter(hasMeaningfulDraftItem).length
      const addedItemCount =
        parseInsertMode === "replace" ? mergedItemCount : Math.max(0, mergedItemCount - existingItemCount)
      const duplicateItemCount = Math.max(0, parsedItemCount - addedItemCount)

      setDraftItems(mergedItems)

      const generatedScanId = await insertMenuScan({
        restaurantId: selectedRestaurant.id,
        imageUri,
        rawMenuText: aiSummary || rawMenuText,
        extractedPayload: parsedItems.map(toMenuItem),
      })
      setScanId(generatedScanId)

      if (parsedItems.length > 0) {
        let placementMessage =
          parseInsertMode === "prepend"
            ? addedItemCount > 0
              ? `Added ${addedItemCount} new item${addedItemCount === 1 ? "" : "s"} to the top of your draft menu.`
              : "Everything from this menu photo is already in your draft menu."
            : parseInsertMode === "append"
              ? addedItemCount > 0
                ? `Added ${addedItemCount} new item${addedItemCount === 1 ? "" : "s"} to the bottom of your draft menu.`
                : "Everything from this menu photo is already in your draft menu."
              : `Found ${mergedItemCount} item${mergedItemCount === 1 ? "" : "s"} from this menu photo.`

        if (duplicateItemCount > 0) {
          placementMessage += ` Skipped ${duplicateItemCount} duplicate item${duplicateItemCount === 1 ? "" : "s"}.`
        }

        showNotification("Saved", placementMessage, "success")
      } else if (existingItems.length > 0) {
        showNotification("AI Parse Warning", "We couldn't find any new menu items in that photo.")
      }

      if (aiWarnings.length > 0) {
        showNotification("AI Parsing Notes", aiWarnings.slice(0, 3).join("\n"))
      }
    } catch (error) {
      showNotification("Parse Failed", error instanceof Error ? error.message : "Failed to parse and store menu scan.")
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(index: number, patch: Partial<UiDraftItem>) {
    setDraftItems((previousValue) =>
      previousValue.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    )
  }

  function addDraftItem() {
    setDraftItems((previousValue) => [...previousValue, fromMenuItem(createEmptyMenuItem())])
  }

  function updateEditableMenuItem(index: number, patch: Partial<UiDraftItem>) {
    setEditableMenuItems((previousValue) =>
      previousValue.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    )
  }

  function addEditableMenuItem() {
    setEditableMenuItems((previousValue) => [...previousValue, fromMenuItem(createEmptyMenuItem())])
  }

  function removeEditableMenuItem(index: number) {
    setEditableMenuItems((previousValue) => previousValue.filter((_, itemIndex) => itemIndex !== index))
  }

  async function handleSaveEditedMenu() {
    if (!selectedRestaurant) return

    const normalized = dedupeMenuItems(editableMenuItems.map(toMenuItem).filter((item) => item.name.length > 0))
    if (normalized.length === 0) {
      showNotification("Validation", "Add at least one menu item to save.")
      return
    }

    setBusy(true)
    try {
      await replaceRestaurantMenuItems({
        restaurantId: selectedRestaurant.id,
        scanId,
        items: normalized,
      })
      const refreshed = dedupeMenuItems(await listRestaurantMenuItems(selectedRestaurant.id))
      setSavedItems(refreshed)
      setEditableMenuItems(toUiMenuItems(refreshed))
      showNotification("Saved", "Menu updates (including prices) saved.")
    } catch (error) {
      showNotification("Save Failed", error instanceof Error ? error.message : "Failed to update menu.")
    } finally {
      setBusy(false)
    }
  }

  function updateOrderDraft(index: number, patch: Partial<UiOrderDraft>) {
    setOrderDrafts((previousValue) =>
      previousValue.map((order, orderIndex) => (orderIndex === index ? { ...order, ...patch } : order)),
    )
  }

  function toggleOrderRawEditor(orderKey: string) {
    setExpandedOrderEditors((previousValue) => ({
      ...previousValue,
      [orderKey]: !previousValue[orderKey],
    }))
  }

  function addOrderDraft() {
    setOrderDrafts((previousValue) => [
      ...previousValue,
      {
        customerName: "",
        customerPhone: "",
        shortOrderCode: null,
        orderCodeDate: null,
        status: "pending",
        notes: "",
        itemsText: "",
      },
    ])
  }

  async function removeOrderDraft(index: number) {
    const draft = orderDrafts[index]
    if (!draft) {
      return
    }

    if (!draft.id) {
      setOrderDrafts((previousValue) => previousValue.filter((_, orderIndex) => orderIndex !== index))
      return
    }

    if (!selectedRestaurant) {
      return
    }

    setBusy(true)
    try {
      await deleteRestaurantOrder({
        restaurantId: selectedRestaurant.id,
        orderId: draft.id,
      })
      await refreshOrders(selectedRestaurant.id)
      showNotification("Removed", "Order removed.", "success")
    } catch (error) {
      showNotification("Remove Failed", error instanceof Error ? error.message : "Failed to remove order.", "error")
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveOrder(index: number) {
    if (!selectedRestaurant) return

    const draft = orderDrafts[index]
    if (!draft || !draft.customerName.trim()) {
      showNotification("Validation", "Customer name is required.")
      return
    }
    if (!draft.customerPhone.trim()) {
      showNotification("Validation", "Customer phone is required.")
      return
    }

    const items = parseOrderItemsFromText(draft.itemsText)
    if (items.length === 0) {
      showNotification(
        "Validation",
        "Add at least one order item, for example: Item: Chicken Fillet Burger Meal, Quantity: 1, Unit price: 5.99",
      )
      return
    }

    setBusy(true)
    try {
      const savedOrderId = await saveRestaurantOrder({
        restaurantId: selectedRestaurant.id,
        orderId: draft.id,
        customerName: draft.customerName.trim(),
        customerPhone: draft.customerPhone.trim(),
        status: draft.status,
        notes: draft.notes.trim() || null,
        items,
      })

      await refreshOrders(selectedRestaurant.id)
      showNotification("Saved", `Order ${savedOrderId ? "saved" : "updated"} successfully.`)
    } catch (error) {
      showNotification("Order Save Failed", error instanceof Error ? error.message : "Failed to save order.")
    } finally {
      setBusy(false)
    }
  }

  async function handleRefreshOrders() {
    if (!selectedRestaurant) return
    setBusy(true)
    try {
      await refreshOrders(selectedRestaurant.id)
    } catch (error) {
      showNotification("Refresh Failed", error instanceof Error ? error.message : "Failed to refresh orders.")
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveMenu() {
    if (!selectedRestaurant) return
    const normalized = dedupeMenuItems(draftItems.map(toMenuItem).filter((item) => item.name.length > 0))
    if (normalized.length === 0) {
      showNotification("Validation", "Add at least one menu item.")
      return
    }
    setBusy(true)
    try {
      await replaceRestaurantMenuItems({
        restaurantId: selectedRestaurant.id,
        scanId,
        items: normalized,
      })
      const saved = dedupeMenuItems(await listRestaurantMenuItems(selectedRestaurant.id))
      setSavedItems(saved)
      setEditableMenuItems(toUiMenuItems(saved))
      showNotification("Saved", "Menu items and customizations stored in Supabase.")
    } catch (error) {
      showNotification("Save Failed", error instanceof Error ? error.message : "Failed to save menu.")
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateAgent() {
    if (!selectedRestaurant) {
      showNotification("Restaurant Required", "Select a restaurant first.")
      return
    }
    if (!workspaceBaseUrl.trim() || !workspaceEmail.trim() || !workspacePassword.trim()) {
      showNotification("Validation", "Workspace URL, email, and password are required.")
      return
    }
    setBusy(true)
    try {
      const workspaceSession = await loginToIbaraWorkspace({
        baseUrl: workspaceBaseUrl,
        email: workspaceEmail,
        password: workspacePassword,
      })
      const created = await createRestaurantVoiceAgent({
        baseUrl: workspaceSession.baseUrl,
        token: workspaceSession.token,
        restaurantName: selectedRestaurant.name,
        phone: selectedRestaurant.phone,
        address: selectedRestaurant.address,
      })
      await saveVoiceAgentLink({
        restaurantId: selectedRestaurant.id,
        workspaceBaseUrl: workspaceSession.baseUrl,
        workspaceAgentId: created.agentId,
      })
      const link = await getVoiceAgentLink(selectedRestaurant.id)
      setVoiceAgentLink(link)
      setManualAgentId(created.agentId)
      showNotification("Connected", `Linked voice agent: ${created.agentId}`)
    } catch (error) {
      showNotification("Voice Agent Error", error instanceof Error ? error.message : "Failed to connect voice agent.")
    } finally {
      setBusy(false)
    }
  }

  async function handleLinkManualAgent() {
    if (!selectedRestaurant) return
    if (!workspaceBaseUrl.trim() || !manualAgentId.trim()) {
      showNotification("Validation", "Workspace URL and agent ID are required.")
      return
    }
    setBusy(true)
    try {
      await saveVoiceAgentLink({
        restaurantId: selectedRestaurant.id,
        workspaceBaseUrl: workspaceBaseUrl.trim(),
        workspaceAgentId: manualAgentId.trim(),
      })
      const link = await getVoiceAgentLink(selectedRestaurant.id)
      setVoiceAgentLink(link)
      showNotification("Linked", "Existing workspace agent linked successfully.")
    } catch (error) {
      showNotification("Link Failed", error instanceof Error ? error.message : "Failed to link existing agent.")
    } finally {
      setBusy(false)
    }
  }

  const pendingOrderCount = orders.filter((order) => order.status === "pending").length
  const closedOrderCount = orders.filter((order) => order.status === "closed").length
  const currentTitle = appMode === "admin" ? "Operations Console" : "POS Terminal"
  const currentTag = appMode === "admin" ? "RESTAURANT CONTROL" : "RESTAURANT POS"
  const currentSubtitle =
    appMode === "admin"
      ? `Signed in as ${user?.email || ""}`
      : selectedRestaurant
        ? `Serving ${selectedRestaurant.name}`
        : "Select a restaurant in Admin mode to use POS"

  if (booting) {
    return (
      <SafeAreaView style={[styles.center, webSafeStyle]}>
        <StatusBar style="light" />
        <ActivityIndicator color={THEME.primary} />
      </SafeAreaView>
    )
  }

  if (!user) {
    return (
      <SafeAreaView style={[styles.safe, webSafeStyle]}>
        <StatusBar style="light" />
        <View style={styles.authBackgroundTop} />
        <View style={styles.authBackgroundBottom} />
        <View style={styles.authWrap}>
          <View style={styles.authCard}>
            <Text style={styles.brandTag}>RESTAURANT OPS</Text>
            <Text style={styles.title}>Smart Menu Onboarding</Text>
            <Text style={styles.subtitle}>Scan menus, manage orders, and link voice agents from one mobile app.</Text>
            {renderNotice()}
            {authMode === "reset" ? (
              <>
                <Text style={styles.section}>Reset Password</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
                <Pressable style={styles.primary} onPress={handleResetPassword} disabled={busy}>
                  <Text style={styles.primaryText}>Send Reset Link</Text>
                </Pressable>
                <Pressable onPress={() => setAuthMode("login")} disabled={busy}>
                  <Text
                    style={[
                      styles.secondaryText,
                      {
                        textAlign: "center",
                        marginTop: 10,
                        textDecorationLine: "underline",
                      },
                    ]}
                  >
                    Back to Login
                  </Text>
                </Pressable>
              </>
            ) : (
              <>
                <View style={styles.row}>
                  <Pressable
                    style={[styles.tab, authMode === "login" ? styles.tabActive : null]}
                    onPress={() => setAuthMode("login")}
                  >
                    <Text style={[styles.tabText, authMode === "login" ? styles.tabTextActive : null]}>Login</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.tab, authMode === "register" ? styles.tabActive : null]}
                    onPress={() => setAuthMode("register")}
                  >
                    <Text style={[styles.tabText, authMode === "register" ? styles.tabTextActive : null]}>Register</Text>
                  </Pressable>
                </View>
                <TextInput style={styles.input} placeholder="Email" placeholderTextColor={INPUT_PLACEHOLDER_COLOR} value={email} onChangeText={setEmail} />
                <TextInput
                  style={styles.input}
                  placeholder="Password"
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  secureTextEntry
                  value={password}
                  onChangeText={setPassword}
                />
                <Pressable style={styles.primary} onPress={handleAuth} disabled={busy}>
                  <Text style={styles.primaryText}>{authMode === "login" ? "Login" : "Create Account"}</Text>
                </Pressable>
                {authMode === "login" ? (
                  <Pressable onPress={() => setAuthMode("reset")} disabled={busy}>
                    <Text
                      style={[
                        styles.secondaryText,
                        {
                          textAlign: "center",
                          marginTop: 10,
                          textDecorationLine: "underline",
                        },
                      ]}
                    >
                      Forgot Password?
                    </Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </View>
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={[styles.safe, webSafeStyle]}>
      <StatusBar style="light" />
      <View style={styles.appBackgroundTop} />
      <View style={styles.appBackgroundBottom} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {renderNotice()}
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View style={styles.headerTextWrap}>
              <Text style={styles.brandTag}>{currentTag}</Text>
              <Text style={styles.title}>{currentTitle}</Text>
              <Text style={styles.subtitle}>{currentSubtitle}</Text>
            </View>
            <Pressable style={styles.secondaryCompact} onPress={handleLogout}>
              <Text style={styles.secondaryText}>Logout</Text>
            </Pressable>
          </View>
          {!isWeb ? (
            <View style={styles.modeSwitch}>
              <Pressable
                style={[styles.modeSwitchButton, appMode === "admin" ? styles.modeSwitchButtonActive : null]}
                onPress={() => setAppMode("admin")}
              >
                <Text style={[styles.modeSwitchText, appMode === "admin" ? styles.modeSwitchTextActive : null]}>Admin</Text>
              </Pressable>
              <Pressable
                style={[styles.modeSwitchButton, appMode === "pos" ? styles.modeSwitchButtonActive : null]}
                onPress={() => setAppMode("pos")}
              >
                <Text style={[styles.modeSwitchText, appMode === "pos" ? styles.modeSwitchTextActive : null]}>POS</Text>
              </Pressable>
            </View>
          ) : null}
        </View>

        {appMode === "admin" ? (
          <View style={styles.metricsRow}>
            <View style={styles.metricCard}>
              <Text style={styles.metricValue}>{savedItems.length}</Text>
              <Text style={styles.metricLabel}>Menu Items</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricValue}>{pendingOrderCount}</Text>
              <Text style={styles.metricLabel}>Pending</Text>
            </View>
            <View style={styles.metricCard}>
              <Text style={styles.metricValue}>{closedOrderCount}</Text>
              <Text style={styles.metricLabel}>Closed</Text>
            </View>
          </View>
        ) : null}

        {appMode === "admin" ? (
          <View style={styles.mainTabs}>
            <Pressable
              style={[styles.mainTabButton, activeTab === "overview" ? styles.mainTabButtonActive : null]}
              onPress={() => setActiveTab("overview")}
            >
              <Text style={[styles.mainTabText, activeTab === "overview" ? styles.mainTabTextActive : null]}>Overview</Text>
            </Pressable>
            <Pressable
              style={[styles.mainTabButton, activeTab === "menu" ? styles.mainTabButtonActive : null]}
              onPress={() => setActiveTab("menu")}
            >
              <Text style={[styles.mainTabText, activeTab === "menu" ? styles.mainTabTextActive : null]}>Menu</Text>
            </Pressable>
            <Pressable
              style={[styles.mainTabButton, activeTab === "orders" ? styles.mainTabButtonActive : null]}
              onPress={() => setActiveTab("orders")}
            >
              <Text style={[styles.mainTabText, activeTab === "orders" ? styles.mainTabTextActive : null]}>Orders</Text>
            </Pressable>
            <Pressable
              style={[styles.mainTabButton, activeTab === "voice" ? styles.mainTabButtonActive : null]}
              onPress={() => setActiveTab("voice")}
            >
              <Text style={[styles.mainTabText, activeTab === "voice" ? styles.mainTabTextActive : null]}>Voice</Text>
            </Pressable>
          </View>
        ) : null}

        {appMode === "admin" && activeTab === "overview" ? (
          <>
        <View style={styles.card}>
          <Text style={styles.section}>Restaurant Profile</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
              {restaurants.map((restaurant) => (
                <Pressable
                  key={restaurant.id}
                  style={[styles.chip, selectedRestaurantId === restaurant.id ? styles.chipActive : null]}
                  onPress={() => setSelectedRestaurantId(restaurant.id)}
                >
                  <Text style={[styles.chipText, selectedRestaurantId === restaurant.id ? styles.chipTextActive : null]}>
                    {restaurant.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <TextInput
            style={styles.input}
            placeholder="Restaurant Name"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={restaurantName}
            onChangeText={setRestaurantName}
          />
          <TextInput style={styles.input} placeholder="Phone" placeholderTextColor={INPUT_PLACEHOLDER_COLOR} value={restaurantPhone} onChangeText={setRestaurantPhone} />
          <TextInput
            style={[styles.input, styles.multi]}
            multiline
            placeholder="Address"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={restaurantAddress}
            onChangeText={setRestaurantAddress}
          />
          <Pressable style={styles.primary} onPress={handleSaveRestaurant} disabled={busy}>
            <Text style={styles.primaryText}>{selectedRestaurant ? "Update Restaurant" : "Create Restaurant"}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.section}>Menu Scan + Parse</Text>
          <Text style={styles.subtitle}>Capture one menu photo at a time. OCR text is optional context.</Text>
          <Text style={styles.subtitle}>If the menu needs another photo, choose where the new items should go.</Text>
          <View style={styles.parseModeRow}>
            <Pressable
              style={[styles.tab, styles.parseModeTab, parseInsertMode === "replace" ? styles.tabActive : null]}
              onPress={() => setParseInsertMode("replace")}
            >
              <Text style={[styles.tabText, parseInsertMode === "replace" ? styles.tabTextActive : null]}>Replace Draft</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, styles.parseModeTab, parseInsertMode === "prepend" ? styles.tabActive : null]}
              onPress={() => setParseInsertMode("prepend")}
            >
              <Text style={[styles.tabText, parseInsertMode === "prepend" ? styles.tabTextActive : null]}>Add on Top</Text>
            </Pressable>
            <Pressable
              style={[styles.tab, styles.parseModeTab, parseInsertMode === "append" ? styles.tabActive : null]}
              onPress={() => setParseInsertMode("append")}
            >
              <Text style={[styles.tabText, parseInsertMode === "append" ? styles.tabTextActive : null]}>Add at Bottom</Text>
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable style={styles.secondary} onPress={() => pickImage(true)}>
              <Text style={styles.secondaryText}>Capture</Text>
            </Pressable>
            <Pressable style={styles.secondary} onPress={() => pickImage(false)}>
              <Text style={styles.secondaryText}>Gallery</Text>
            </Pressable>
          </View>
          {imageUri ? <Image source={{ uri: imageUri }} style={styles.image as ImageStyle} /> : null}
          <TextInput
            style={[styles.input, styles.multiLarge]}
            multiline
            placeholder="Optional: paste OCR notes to improve AI extraction..."
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={rawMenuText}
            onChangeText={setRawMenuText}
          />
          <Pressable style={styles.primary} onPress={handleParseMenu} disabled={busy}>
            <Text style={styles.primaryText}>Parse With AI</Text>
          </Pressable>
          {draftItems.map((item, index) => (
            <View key={`draft-${index}`} style={styles.item}>
              <Text style={styles.subtitle}>Item {index + 1}</Text>
              <TextInput
                style={styles.input}
                placeholder="Name"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.name}
                onChangeText={(value) => updateDraft(index, { name: value })}
              />
              <TextInput
                style={styles.input}
                placeholder="Category"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.category}
                onChangeText={(value) => updateDraft(index, { category: value })}
              />
              <TextInput
                style={[styles.input, styles.multi]}
                placeholder="Description or combo contents"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.description}
                onChangeText={(value) => updateDraft(index, { description: value })}
                multiline
              />
              <TextInput
                style={styles.input}
                placeholder="Base Price"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                keyboardType="decimal-pad"
                value={item.basePrice}
                onChangeText={(value) => updateDraft(index, { basePrice: value })}
              />
              <TextInput
                style={styles.input}
                placeholder="Stock Quantity"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                keyboardType="number-pad"
                value={item.stockQuantity}
                onChangeText={(value) => updateDraft(index, { stockQuantity: value })}
              />
              <TextInput
                style={[styles.input, styles.multi]}
                placeholder="Customizations (comma-separated, e.g. Extra Cheese+30, Spice Level)"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                multiline
                value={item.customizationText}
                onChangeText={(value) => updateDraft(index, { customizationText: value })}
              />
            </View>
          ))}
          {draftItems.length > 0 ? (
            <View style={styles.row}>
              <Pressable style={styles.secondary} onPress={addDraftItem}>
                <Text style={styles.secondaryText}>Add Item</Text>
              </Pressable>
              <Pressable style={styles.primaryWide} onPress={handleSaveMenu} disabled={busy}>
                <Text style={styles.primaryText}>Save Menu</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
          </>
        ) : null}

        {activeTab === "menu" ? (
          <>
        <View style={styles.card}>
          <Text style={styles.section}>View Menu</Text>
          {savedItems.length === 0 ? <Text style={styles.subtitle}>No saved items yet.</Text> : null}
          {savedItems.map((item, index) => (
            <View key={`${item.id || "saved"}-${index}`} style={styles.saved}>
              <Text style={styles.savedName}>
                {item.name} - {item.basePrice.toFixed(2)}
              </Text>
              {item.description ? <Text style={styles.subtitle}>Includes: {item.description}</Text> : null}
              <Text style={styles.subtitle}>Stock: {item.stockQuantity}</Text>
              {(item.customizations || []).length > 0 ? (
                <Text style={styles.subtitle}>
                  Options:{" "}
                  {(item.customizations || [])
                    .map((customization) =>
                      customization.priceDelta ? `${customization.label}+${customization.priceDelta}` : customization.label,
                    )
                    .join(", ")}
                </Text>
              ) : !item.description ? (
                <Text style={styles.subtitle}>No extra details</Text>
              ) : null}
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.section}>Edit Menu (Including Prices)</Text>
          {editableMenuItems.length === 0 ? <Text style={styles.subtitle}>No menu items to edit yet.</Text> : null}
          {editableMenuItems.map((item, index) => (
            <View key={`editable-menu-${index}`} style={styles.item}>
              <Text style={styles.subtitle}>Menu Item {index + 1}</Text>
              <TextInput
                style={styles.input}
                placeholder="Name"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.name}
                onChangeText={(value) => updateEditableMenuItem(index, { name: value })}
              />
              <TextInput
                style={styles.input}
                placeholder="Category"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.category}
                onChangeText={(value) => updateEditableMenuItem(index, { category: value })}
              />
              <TextInput
                style={[styles.input, styles.multi]}
                placeholder="Description or combo contents"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.description}
                onChangeText={(value) => updateEditableMenuItem(index, { description: value })}
                multiline
              />
              <TextInput
                style={styles.input}
                placeholder="Base Price"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                keyboardType="decimal-pad"
                value={item.basePrice}
                onChangeText={(value) => updateEditableMenuItem(index, { basePrice: value })}
              />
              <TextInput
                style={styles.input}
                placeholder="Stock Quantity"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                keyboardType="number-pad"
                value={item.stockQuantity}
                onChangeText={(value) => updateEditableMenuItem(index, { stockQuantity: value })}
              />
              <TextInput
                style={[styles.input, styles.multi]}
                placeholder="Customizations (e.g. Extra Cheese+30, Spice Level)"
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={item.customizationText}
                onChangeText={(value) => updateEditableMenuItem(index, { customizationText: value })}
                multiline
              />
              <Pressable style={styles.secondary} onPress={() => removeEditableMenuItem(index)}>
                <Text style={styles.secondaryText}>Remove Item</Text>
              </Pressable>
            </View>
          ))}
          <View style={styles.row}>
            <Pressable style={styles.secondary} onPress={addEditableMenuItem}>
              <Text style={styles.secondaryText}>Add Menu Item</Text>
            </Pressable>
            <Pressable style={styles.primaryWide} onPress={handleSaveEditedMenu} disabled={busy}>
              <Text style={styles.primaryText}>Save Menu Changes</Text>
            </Pressable>
          </View>
        </View>
          </>
        ) : null}

        {activeTab === "orders" ? (
          <>
            <View style={[styles.card, isWeb ? styles.orderSectionCardWeb : null]}>
              <View style={styles.rowBetween}>
                <Text style={styles.section}>View Orders</Text>
                <Pressable style={styles.secondary} onPress={handleRefreshOrders} disabled={busy}>
                  <Text style={styles.secondaryText}>Refresh</Text>
                </Pressable>
              </View>
              {orders.length === 0 ? <Text style={styles.subtitle}>No orders yet.</Text> : null}
              <View style={[styles.ordersCollection, useWideOrderLayout ? styles.ordersCollectionWeb : null]}>
                {orders.map((order, index) => {
                  const orderCodeText = formatShortOrderCode(order.shortOrderCode)
                  const orderIdBadgeLabel = orderCodeText ? "ORDER ID" : order.status === "closed" ? "STATUS" : "NEW"
                  const orderIdBadgeValue = orderCodeText || (order.status === "closed" ? "DONE" : "NEW")
                  const hasOrderCallReview = hasCallReviewContent(order.callReview)

                  return (
                    <View
                      key={`${order.id || "order"}-${index}`}
                      style={[styles.saved, styles.orderSummaryCard, useWideOrderLayout ? styles.orderSummaryCardWeb : null]}
                    >
                      <View style={[styles.rowBetween, !useWideOrderLayout ? styles.orderCardHeaderCompact : null]}>
                        <View style={styles.headerTextWrap}>
                          <Text style={styles.orderReferenceText}>
                            {orderCodeText
                              ? `Order ID ${orderCodeText}`
                              : order.status === "closed"
                                ? "Completed order"
                                : "Order ID pending"}
                          </Text>
                          <Text style={styles.savedName}>{order.customerName || "Voice Caller"}</Text>
                          <Text style={styles.subtitle}>{order.customerPhone ? `Phone: ${order.customerPhone}` : "Phone not captured"}</Text>
                          <Text style={styles.subtitle}>{order.notes || "No notes"}</Text>
                        </View>
                        <View style={[styles.orderMetaStack, !useWideOrderLayout ? styles.orderMetaStackCompact : null]}>
                          <View
                            style={[
                              styles.orderCodeBadge,
                              !useWideOrderLayout ? styles.orderCodeBadgeCompact : null,
                              orderCodeText ? styles.orderCodeBadgeReady : styles.orderCodeBadgeEmpty,
                            ]}
                          >
                            <Text style={styles.orderCodeBadgeLabel}>{orderIdBadgeLabel}</Text>
                            <Text style={styles.orderCodeBadgeText}>{orderIdBadgeValue}</Text>
                          </View>
                          <View
                            style={[
                              styles.orderStatusBadge,
                              order.status === "closed" ? styles.orderStatusBadgeClosed : styles.orderStatusBadgePending,
                            ]}
                          >
                            <Text style={styles.orderStatusBadgeText}>{order.status.toUpperCase()}</Text>
                          </View>
                          {hasOrderCallReview ? (
                            <Pressable
                              style={styles.orderCallChip}
                              onPress={() => openOrderCallReview(order.customerName || `Order ${index + 1}`, order.callReview)}
                            >
                              <Text style={styles.orderCallChipText}>Review Call</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </View>
                      <Text style={styles.orderTotalText}>Total: {order.totalPrice.toFixed(2)}</Text>
                      {renderOrderItemCards(order.items, {
                        isWeb: useWideOrderLayout,
                        emptyLabel: "No items in this order yet.",
                      })}
                    </View>
                  )
                })}
              </View>
            </View>

            <View style={[styles.card, isWeb ? styles.orderSectionCardWeb : null]}>
              <Text style={styles.section}>Edit Orders</Text>
              {orderDrafts.length === 0 ? <Text style={styles.subtitle}>No order drafts yet. Add one below.</Text> : null}
              {orderDrafts.map((order, index) => {
                const draftItemsPreview = parseOrderItemsFromText(order.itemsText)
                const displayOrderCode = formatShortOrderCode(order.shortOrderCode)
                const orderDraftKey = getOrderDraftKey(order, index)
                const isRawEditorOpen = Boolean(expandedOrderEditors[orderDraftKey])
                const orderDraftBadgeLabel = displayOrderCode ? "ORDER ID" : order.status === "closed" ? "STATUS" : "DRAFT"
                const orderDraftBadgeValue = displayOrderCode || (order.status === "closed" ? "DONE" : "NEW")
                const hasDraftCallReview = hasCallReviewContent(order.callReview)

                return (
                  <View key={`order-draft-${order.id || index}`} style={[styles.item, isWeb ? styles.orderDraftCardWeb : null]}>
                    <View style={[styles.rowBetween, !useWideOrderLayout ? styles.orderCardHeaderCompact : null]}>
                      <View style={styles.headerTextWrap}>
                        <Text style={styles.orderDraftEyebrow}>Order {index + 1}</Text>
                        <Text style={styles.orderDraftTitle}>{order.customerName.trim() || "New customer order"}</Text>
                        <Text style={styles.orderHeaderHint}>
                          {displayOrderCode
                            ? "Visible only while this order is still pending"
                            : order.status === "closed"
                              ? "Closed orders do not keep a live order ID"
                              : "Save once to generate the 3-digit order ID"}
                        </Text>
                      </View>
                      <View style={[styles.orderMetaStack, !useWideOrderLayout ? styles.orderMetaStackCompact : null]}>
                        <View
                          style={[
                            styles.orderCodeBadge,
                            !useWideOrderLayout ? styles.orderCodeBadgeCompact : null,
                            displayOrderCode ? styles.orderCodeBadgeReady : styles.orderCodeBadgeEmpty,
                          ]}
                        >
                          <Text style={styles.orderCodeBadgeLabel}>{orderDraftBadgeLabel}</Text>
                          <Text style={styles.orderCodeBadgeText}>{orderDraftBadgeValue}</Text>
                        </View>
                        {hasDraftCallReview ? (
                          <Pressable
                            style={styles.orderCallChip}
                            onPress={() => openOrderCallReview(order.customerName.trim() || `Order ${index + 1}`, order.callReview)}
                          >
                            <Text style={styles.orderCallChipText}>Review Call</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    </View>
                    <View style={[styles.orderDraftGrid, useWideOrderLayout ? styles.orderDraftGridWeb : null]}>
                      <View style={styles.orderDraftSection}>
                        <Text style={styles.orderSectionLabel}>Customer details</Text>
                        <Text style={styles.fieldLabel}>Customer name</Text>
                        <TextInput
                          style={styles.input}
                          placeholder="Customer Name"
                          placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                          value={order.customerName}
                          onChangeText={(value) => updateOrderDraft(index, { customerName: value })}
                        />
                        <Text style={styles.fieldLabel}>Phone</Text>
                        <TextInput
                          style={styles.input}
                          placeholder="Customer Phone"
                          placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                          value={order.customerPhone}
                          onChangeText={(value) => updateOrderDraft(index, { customerPhone: value })}
                          keyboardType="phone-pad"
                        />
                        <Text style={styles.orderEditorHint}>Used by staff if they need to reach the customer.</Text>
                      </View>
                      <View style={styles.orderDraftSection}>
                        <Text style={styles.orderSectionLabel}>Status and notes</Text>
                        <View style={[styles.row, useWideOrderLayout ? styles.orderStatusRowWeb : styles.orderStatusRowCompact]}>
                          <Pressable
                            style={[
                              styles.tab,
                              useWideOrderLayout ? styles.orderStatusTabWeb : styles.orderStatusTabCompact,
                              order.status === "pending" ? styles.tabActive : null,
                            ]}
                            onPress={() => updateOrderDraft(index, { status: "pending" })}
                          >
                            <Text style={[styles.tabText, order.status === "pending" ? styles.tabTextActive : null]}>Pending</Text>
                          </Pressable>
                          <Pressable
                            style={[
                              styles.tab,
                              useWideOrderLayout ? styles.orderStatusTabWeb : styles.orderStatusTabCompact,
                              order.status === "closed" ? styles.tabActive : null,
                            ]}
                            onPress={() => updateOrderDraft(index, { status: "closed" })}
                          >
                            <Text style={[styles.tabText, order.status === "closed" ? styles.tabTextActive : null]}>Closed</Text>
                          </Pressable>
                        </View>
                        <Text style={styles.fieldLabel}>Notes</Text>
                        <TextInput
                          style={[styles.input, styles.multi]}
                          placeholder="Notes"
                          placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                          value={order.notes}
                          onChangeText={(value) => updateOrderDraft(index, { notes: value })}
                          multiline
                        />
                      </View>
                    </View>
                    <View style={styles.orderPreviewBox}>
                      <View style={styles.rowBetween}>
                        <Text style={styles.orderPreviewTitle}>Items Preview</Text>
                        <Text style={styles.orderPreviewMeta}>
                          {draftItemsPreview.length === 0
                            ? "No items yet"
                            : `${draftItemsPreview.length} item${draftItemsPreview.length === 1 ? "" : "s"}`}
                        </Text>
                      </View>
                      {renderOrderItemCards(draftItemsPreview, {
                        isWeb: useWideOrderLayout,
                        emptyLabel: "Add item details below to see a live preview here.",
                      })}
                    </View>
                    <Pressable style={styles.orderEditorToggle} onPress={() => toggleOrderRawEditor(orderDraftKey)}>
                      <Text style={styles.orderEditorToggleText}>
                        {isRawEditorOpen ? "Hide raw item editor" : "Edit raw item text"}
                      </Text>
                    </Pressable>
                    {isRawEditorOpen ? (
                      <View style={styles.orderRawEditorBox}>
                        <Text style={styles.fieldLabel}>Raw item editor</Text>
                        <TextInput
                          style={[styles.input, styles.orderItemsInput]}
                          placeholder="Example: Item: Chicken Fillet Burger Meal, Quantity: 1, Unit price: 5.99"
                          placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                          value={order.itemsText}
                          onChangeText={(value) => updateOrderDraft(index, { itemsText: value })}
                          multiline
                        />
                        <Text style={styles.orderEditorHint}>
                          Use one item block per order line. Keep quantity and unit price on separate labeled lines.
                        </Text>
                      </View>
                    ) : null}
                    <View style={[styles.orderActionRow, useWideOrderLayout ? styles.orderActionRowWeb : null]}>
                      <Pressable
                        style={[styles.primaryWide, useWideOrderLayout ? styles.orderPrimaryActionWeb : null]}
                        onPress={() => handleSaveOrder(index)}
                        disabled={busy}
                      >
                        <Text style={styles.primaryText}>Save Order</Text>
                      </Pressable>
                      <Pressable style={[styles.secondary, !isWeb ? styles.orderSecondaryActionMobile : null]} onPress={() => removeOrderDraft(index)}>
                        <Text style={styles.secondaryText}>Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                )
              })}
              <Pressable style={styles.secondary} onPress={addOrderDraft}>
                <Text style={styles.secondaryText}>Add Order</Text>
              </Pressable>
            </View>
          </>
        ) : null}

        {appMode === "admin" && activeTab === "voice" ? (
        <View style={styles.card}>
          <Text style={styles.section}>Voice Agent (Ibara Workspace)</Text>
          <TextInput
            style={styles.input}
            placeholder="Ibara Base URL"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={workspaceBaseUrl}
            onChangeText={setWorkspaceBaseUrl}
          />
          <TextInput
            style={styles.input}
            placeholder="Workspace Email"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={workspaceEmail}
            onChangeText={setWorkspaceEmail}
          />
          <TextInput
            style={styles.input}
            placeholder="Workspace Password"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            secureTextEntry
            value={workspacePassword}
            onChangeText={setWorkspacePassword}
          />
          <Pressable style={styles.primary} onPress={handleCreateAgent} disabled={busy}>
            <Text style={styles.primaryText}>Create Agent in Workspace</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder="Or existing workspace agent_id"
            placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
            value={manualAgentId}
            onChangeText={setManualAgentId}
          />
          <Pressable style={styles.secondary} onPress={handleLinkManualAgent} disabled={busy}>
            <Text style={styles.secondaryText}>Link Existing Agent</Text>
          </Pressable>
          {voiceAgentLink ? (
            <Text style={styles.subtitle}>Linked agent: {voiceAgentLink.workspace_agent_id}</Text>
          ) : (
            <Text style={styles.subtitle}>No voice agent linked.</Text>
          )}
        </View>
        ) : null}

      </ScrollView>
      {renderCallReviewModal()}
      {busy ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={THEME.accent} size="large" />
        </View>
      ) : null}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safe: { flex: 1, width: "100%", backgroundColor: THEME.background },
  center: { flex: 1, width: "100%", backgroundColor: THEME.background, alignItems: "center", justifyContent: "center" },
  scroll: { flex: 1, backgroundColor: THEME.background },
  content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 12, gap: 14, paddingBottom: 56 },
  authWrap: { padding: 20, justifyContent: "center", flex: 1 },
  authCard: {
    backgroundColor: THEME.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 18,
    gap: 12,
    ...AUTH_CARD_SHADOW,
    elevation: 3,
  },
  authBackgroundTop: {
    position: "absolute",
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: THEME.primary,
    top: -110,
    right: -80,
    opacity: 0.28,
  },
  authBackgroundBottom: {
    position: "absolute",
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: THEME.accent,
    bottom: -130,
    left: -120,
    opacity: 0.24,
  },
  appBackgroundTop: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: THEME.primary,
    top: -90,
    right: -70,
    opacity: 0.16,
  },
  appBackgroundBottom: {
    position: "absolute",
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: THEME.accent,
    bottom: -120,
    left: -100,
    opacity: 0.12,
  },
  card: {
    backgroundColor: THEME.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 14,
    gap: 10,
    ...CARD_SHADOW,
    elevation: 2,
  },
  brandTag: {
    color: THEME.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    fontFamily: FONT_SANS,
  },
  title: { color: THEME.text, fontSize: 24, fontWeight: "700", fontFamily: FONT_SANS },
  section: { color: THEME.text, fontSize: 18, fontWeight: "700", fontFamily: FONT_SANS },
  subtitle: { color: THEME.mutedText, fontSize: 13, lineHeight: 18, fontFamily: FONT_SANS },
  orderSectionCardWeb: { width: "100%", maxWidth: 1320, alignSelf: "center" },
  ordersCollection: { gap: 10 },
  ordersCollectionWeb: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" },
  orderSummaryCard: { gap: 10 },
  orderSummaryCardWeb: { flexBasis: "49%", minWidth: 320, flexGrow: 1 },
  orderMetaStack: { alignItems: "flex-end", gap: 8 },
  orderMetaStackCompact: { width: "100%", flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" },
  orderCardHeaderCompact: { flexDirection: "column", alignItems: "stretch", gap: 12 },
  orderHeaderHint: { color: THEME.mutedText, fontSize: 12, lineHeight: 16, fontFamily: FONT_SANS },
  orderDraftEyebrow: { color: THEME.accent, fontSize: 11, fontWeight: "700", letterSpacing: 0.8, fontFamily: FONT_SANS },
  orderDraftTitle: { color: THEME.text, fontSize: 18, fontWeight: "700", lineHeight: 22, fontFamily: FONT_SANS },
  orderReferenceText: { color: THEME.accent, fontSize: 13, fontWeight: "700", fontFamily: FONT_SANS },
  orderCodeBadge: {
    minWidth: 72,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: "center",
    gap: 2,
  },
  orderCodeBadgeCompact: {
    minWidth: 88,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  orderCodeBadgeLabel: { color: THEME.mutedText, fontSize: 9, fontWeight: "700", letterSpacing: 1, fontFamily: FONT_SANS },
  orderCodeBadgeReady: {
    backgroundColor: "rgba(69, 211, 193, 0.16)",
    borderColor: "rgba(69, 211, 193, 0.4)",
  },
  orderCodeBadgeEmpty: {
    backgroundColor: "rgba(63, 134, 255, 0.12)",
    borderColor: "rgba(63, 134, 255, 0.22)",
  },
  orderCodeBadgeText: { color: THEME.text, fontSize: 18, fontWeight: "800", letterSpacing: 1.1, fontFamily: FONT_SANS },
  orderStatusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  orderStatusBadgePending: {
    backgroundColor: "rgba(78, 207, 196, 0.18)",
    borderColor: "rgba(78, 207, 196, 0.45)",
  },
  orderStatusBadgeClosed: {
    backgroundColor: "rgba(76, 128, 255, 0.14)",
    borderColor: "rgba(76, 128, 255, 0.35)",
  },
  orderStatusBadgeText: { color: THEME.text, fontSize: 11, fontWeight: "700", letterSpacing: 0.6, fontFamily: FONT_SANS },
  orderCallChip: {
    minWidth: 110,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(63, 134, 255, 0.26)",
    backgroundColor: THEME.primarySoft,
    alignItems: "center",
  },
  orderCallChipText: { color: THEME.chipText, fontSize: 12, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
    alignItems: "center",
    padding: 14,
    zIndex: 60,
    elevation: 60,
  },
  callReviewOverlayCompact: {
    padding: 0,
    justifyContent: "flex-end",
  },
  callReviewBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7, 14, 26, 0.78)",
  },
  callReviewModal: {
    width: "100%",
    alignSelf: "center",
    maxWidth: 840,
    maxHeight: "82%",
    backgroundColor: THEME.card,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 20,
    gap: 14,
    ...CARD_SHADOW,
    overflow: "hidden",
  },
  callReviewModalWeb: { minWidth: 680 },
  callReviewModalCompact: {
    maxWidth: "100%",
    maxHeight: "92%",
    minHeight: "74%",
    padding: 16,
    paddingBottom: 22,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    gap: 12,
    minWidth: 0,
  },
  callReviewHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    paddingBottom: 4,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(151, 171, 199, 0.12)",
  },
  callReviewHeaderCompact: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  callReviewHeaderActions: { flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 0 },
  callReviewHeaderActionsCompact: { width: "auto", flexDirection: "row", alignItems: "flex-start", gap: 8 },
  callReviewTitle: { color: THEME.text, fontSize: 20, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewSubtitle: { color: THEME.accent, fontSize: 13, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewMeta: { color: THEME.mutedText, fontSize: 12, lineHeight: 18, fontFamily: FONT_SANS },
  callReviewActionButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(69, 211, 193, 0.3)",
    backgroundColor: "rgba(69, 211, 193, 0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  callReviewActionButtonCompact: { width: "100%", marginTop: 2, marginBottom: 2 },
  callReviewActionText: { color: THEME.accent, fontSize: 12, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewCloseButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(151, 171, 199, 0.22)",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  callReviewCloseButtonCompact: {
    minWidth: 78,
    alignItems: "center",
  },
  callReviewCloseText: { color: THEME.text, fontSize: 12, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewHint: { color: THEME.mutedText, fontSize: 12, lineHeight: 18, fontFamily: FONT_SANS },
  callReviewTranscriptBox: {
    backgroundColor: "rgba(255, 255, 255, 0.03)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(151, 171, 199, 0.14)",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
    overflow: "hidden",
  },
  callReviewTranscriptBoxCompact: {
    flex: 1,
    minHeight: 0,
  },
  callReviewTranscriptScroll: { maxHeight: 460 },
  callReviewTranscriptScrollCompact: { flex: 1, maxHeight: undefined },
  callReviewTranscriptList: { gap: 0 },
  callReviewTranscriptEntry: {
    width: "100%",
    minWidth: 0,
    paddingVertical: 12,
    gap: 5,
    paddingHorizontal: 2,
    borderLeftWidth: 3,
    overflow: "hidden",
  },
  callReviewTranscriptEntryAgent: { borderLeftColor: "#5f8dff" },
  callReviewTranscriptEntryUser: { borderLeftColor: THEME.accent },
  callReviewTranscriptEntryNeutral: { borderLeftColor: "rgba(151, 171, 199, 0.24)" },
  callReviewTranscriptEntryDivider: {
    borderBottomWidth: 1,
    borderBottomColor: "rgba(151, 171, 199, 0.1)",
  },
  callReviewTranscriptSpeaker: {
    color: THEME.mutedText,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
    textTransform: "uppercase",
  },
  callReviewTranscriptSpeakerAgent: { color: "#8cb7ff" },
  callReviewTranscriptSpeakerUser: { color: THEME.accent },
  callReviewTranscriptMessage: { color: THEME.text, fontSize: 14, lineHeight: 22, fontFamily: FONT_SANS, flexShrink: 1 },
  orderTranscriptText: { color: THEME.text, fontSize: 13, lineHeight: 19, fontFamily: FONT_SANS },
  orderTotalText: { color: THEME.accent, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderItemsGrid: { gap: 8 },
  orderItemsGridWeb: { flexDirection: "row", flexWrap: "wrap" },
  orderItemCard: {
    backgroundColor: THEME.cardAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 12,
    gap: 8,
  },
  orderItemCardWeb: { flexBasis: "49%", minWidth: 240, flexGrow: 1 },
  orderItemTitle: { color: THEME.text, fontSize: 15, fontWeight: "700", fontFamily: FONT_SANS },
  orderItemStatsRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  orderItemStat: {
    minWidth: 72,
    backgroundColor: THEME.chip,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },
  orderItemStatLabel: { color: THEME.mutedText, fontSize: 11, fontWeight: "600", fontFamily: FONT_SANS },
  orderItemStatValue: { color: THEME.text, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderDraftCardWeb: { width: "100%", maxWidth: 1120, alignSelf: "center" },
  orderDraftGrid: { gap: 12 },
  orderDraftGridWeb: { flexDirection: "row", alignItems: "stretch" },
  orderDraftSection: {
    flex: 1,
    paddingVertical: 4,
    gap: 10,
  },
  orderSectionLabel: { color: THEME.text, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderStatusRowWeb: { flexWrap: "wrap" },
  orderStatusTabWeb: { flexGrow: 0, minWidth: 180 },
  orderStatusRowCompact: { flexDirection: "column", gap: 10 },
  orderStatusTabCompact: { width: "100%" },
  fieldLabel: { color: THEME.mutedText, fontSize: 12, fontWeight: "700", letterSpacing: 0.3, fontFamily: FONT_SANS },
  orderPreviewBox: {
    paddingTop: 12,
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(151, 171, 199, 0.12)",
  },
  orderPreviewTitle: { color: THEME.text, fontSize: 15, fontWeight: "700", fontFamily: FONT_SANS },
  orderPreviewMeta: { color: THEME.mutedText, fontSize: 12, fontWeight: "600", fontFamily: FONT_SANS },
  orderEditorToggle: {
    backgroundColor: THEME.cardAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingVertical: 10,
    paddingHorizontal: 12,
    alignItems: "center",
  },
  orderEditorToggleText: { color: THEME.accent, fontWeight: "700", fontFamily: FONT_SANS },
  orderRawEditorBox: {
    backgroundColor: THEME.cardAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 12,
    gap: 8,
  },
  orderEditorHint: { color: THEME.mutedText, fontSize: 12, lineHeight: 17, fontFamily: FONT_SANS },
  orderItemsInput: { minHeight: 96, textAlignVertical: "top" },
  orderActionRow: { gap: 10 },
  orderActionRowWeb: { flexDirection: "row", alignItems: "center" },
  orderPrimaryActionWeb: { flexGrow: 0, minWidth: 240 },
  orderSecondaryActionMobile: { alignSelf: "stretch", justifyContent: "center" },
  errorText: { color: "#ff8f8f", fontSize: 12, lineHeight: 17, fontFamily: FONT_SANS },
  headerTextWrap: { flex: 1, gap: 2 },
  row: { flexDirection: "row", gap: 8 },
  parseModeRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  parseModeTab: { flexGrow: 1, minWidth: 108 },
  rowBetween: { flexDirection: "row", gap: 8, justifyContent: "space-between", alignItems: "center" },
  metricsRow: { flexDirection: "row", gap: 8 },
  metricCard: {
    flex: 1,
    backgroundColor: THEME.cardAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingVertical: 12,
    alignItems: "center",
    ...METRIC_CARD_SHADOW,
    elevation: 1,
  },
  metricValue: { color: THEME.accent, fontSize: 22, fontWeight: "700", fontFamily: FONT_SANS },
  metricLabel: { color: THEME.mutedText, fontSize: 12, fontWeight: "600", fontFamily: FONT_SANS },
  mainTabs: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: THEME.cardAlt,
    borderRadius: 14,
    padding: 6,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  mainTabButton: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: "center",
  },
  mainTabButtonActive: {
    backgroundColor: THEME.primary,
  },
  mainTabText: { color: THEME.mutedText, fontWeight: "600", fontSize: 12, fontFamily: FONT_SANS },
  mainTabTextActive: { color: THEME.text, fontWeight: "700", fontFamily: FONT_SANS },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: THEME.chipBorder,
    alignItems: "center",
    backgroundColor: THEME.chip,
  },
  tabActive: { backgroundColor: THEME.accent, borderColor: THEME.accent },
  tabText: { color: THEME.chipText, fontWeight: "600", fontFamily: FONT_SANS },
  tabTextActive: { color: THEME.activeTextDark, fontWeight: "700", fontFamily: FONT_SANS },
  input: {
    backgroundColor: THEME.cardAlt,
    color: THEME.text,
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: FONT_SANS,
  },
  multi: { minHeight: 70, textAlignVertical: "top" },
  multiLarge: { minHeight: 110, textAlignVertical: "top" },
  modeSwitch: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: THEME.cardAlt,
    borderRadius: 12,
    padding: 4,
    borderWidth: 1,
    borderColor: THEME.border,
  },
  modeSwitchButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
  },
  modeSwitchButtonActive: {
    backgroundColor: THEME.accent,
  },
  modeSwitchText: { color: THEME.mutedText, fontWeight: "700", fontFamily: FONT_SANS },
  modeSwitchTextActive: { color: THEME.activeTextDark, fontWeight: "700", fontFamily: FONT_SANS },
  primary: { backgroundColor: THEME.primary, borderRadius: 12, alignItems: "center", paddingVertical: 11 },
  primaryDisabled: { opacity: 0.6 },
  primaryWide: {
    flex: 1,
    backgroundColor: THEME.primary,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 11,
  },
  primaryText: { color: THEME.text, fontWeight: "700", fontFamily: FONT_SANS },
  secondary: {
    backgroundColor: THEME.primarySoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.accentSoft,
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryCompact: {
    backgroundColor: THEME.primarySoft,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    minWidth: 88,
  },
  secondaryText: { color: THEME.accent, fontWeight: "700", fontFamily: FONT_SANS },
  chip: {
    backgroundColor: THEME.chip,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.chipBorder,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  chipActive: { backgroundColor: THEME.primary, borderColor: THEME.primary },
  chipText: { color: THEME.chipText, fontWeight: "600", fontFamily: FONT_SANS },
  chipTextActive: { color: THEME.text, fontFamily: FONT_SANS },
  image: { width: "100%", height: 190, borderRadius: 12 },
  item: {
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    padding: 10,
    gap: 8,
    marginTop: 2,
    backgroundColor: THEME.cardAlt,
  },
  saved: {
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 12,
    padding: 10,
    gap: 4,
    backgroundColor: THEME.cardAlt,
  },
  savedName: { color: THEME.text, fontWeight: "700", fontSize: 14, fontFamily: FONT_SANS },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: THEME.loadingOverlay,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 4,
    marginBottom: 10,
  },
  noticeTitle: {
    color: THEME.text,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  noticeMessage: {
    color: THEME.mutedText,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: FONT_SANS,
  },
  noticeSuccess: {
    backgroundColor: "rgba(69, 211, 193, 0.12)",
    borderColor: THEME.accent,
  },
  noticeError: {
    backgroundColor: "rgba(255, 143, 143, 0.12)",
    borderColor: "#ff8f8f",
  },
  noticeWarning: {
    backgroundColor: "rgba(255, 200, 107, 0.12)",
    borderColor: "#ffca6b",
  },
  noticeInfo: {
    backgroundColor: "rgba(63, 134, 255, 0.12)",
    borderColor: THEME.primary,
  },
})
