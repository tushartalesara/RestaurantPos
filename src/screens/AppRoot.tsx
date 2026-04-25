import AsyncStorage from "@react-native-async-storage/async-storage"
import * as ImagePicker from "expo-image-picker"
import * as Print from "expo-print"
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio"
import { StatusBar as ExpoStatusBar } from "expo-status-bar"
import { useEffect, useMemo, useRef, useState, type RefObject } from "react"
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Switch,
  StyleSheet,
  StatusBar,
  Text,
  TextInput,
  TouchableOpacity,
  findNodeHandle,
  useWindowDimensions,
  View,
} from "react-native"
import type { ImageStyle, KeyboardEvent, StyleProp, TextStyle, ViewStyle } from "react-native"
import { COLORS } from "../constants/colors"
import { FONT_MONO, FONT_SANS, INPUT_PLACEHOLDER_COLOR, RADIUS, SAFE_AREA, SPACING, TYPOGRAPHY } from "../constants/layout"
import {
  clearSession,
  completeAuthRedirectFromUrl,
  getSession,
  loginWithEmail,
  registerWithEmail,
  resetPasswordWithEmail,
  saveSession,
} from "../auth"
import {
  deleteRestaurantOrder,
  getBillingConfig,
  getCountryTaxRates,
  getVoiceAgentLink,
  initDatabase,
  insertMenuScan,
  listRestaurantOrders,
  listRestaurantMenuItems,
  listRestaurants,
  replaceRestaurantMenuItems,
  saveBillingConfig,
  saveRestaurantOrder,
  saveRestaurantPaymentPin,
  saveRestaurant,
  updateRestaurantOrderPayment,
  saveVoiceAgentLink,
} from "../db"
import { useRestaurantRealtime } from "../hooks/useRestaurantRealtime"
import { getSupportedBillingCountry, SUPPORTED_BILLING_COUNTRIES } from "../constants/billing"
import { createEmptyMenuItem, parseMenuText } from "../menu-parser"
import { parseMenuFromImageWithGemini } from "../gemini-parser"
import type {
  AppMode,
  AppNotice,
  AuthMode,
  BillingConfig,
  FulfillmentType,
  MenuCustomizationDraft,
  MenuItemDraft,
  MainTab,
  NoticeKind,
  OrderStatusFilter,
  PaymentCollection,
  PaymentMethod,
  PaymentStatus,
  ParseInsertMode,
  RestaurantOrderRecord,
  RestaurantRecord,
  SessionUser,
  UiDraftItem,
  UiOrderDraft,
  VoiceAgentLinkRecord,
} from "../types"
import { billingConfigToDraftBreakdown, getTipAmountFromPercent, normalizeOrderBillingBreakdown } from "../utils/billing"
import {
  cacheRecordingAudio,
  getCachedRecordingUri,
  loadCachedRestaurantSnapshot,
  loadCachedRestaurants,
  saveCachedRestaurantSnapshot,
  saveCachedRestaurants,
  type RestaurantOfflineSnapshot,
} from "../utils/offlineCache"
import {
  generateCombinedReceiptHTML as generateCombinedReceiptHTMLUtil,
  generateReceiptHTML as generateReceiptHTMLUtil,
  printReceiptHtml,
} from "../utils/printUtils"
import { getCurrencySymbol as getCurrencySymbolUtil } from "../utils/formatters"
import { CallReviewModal } from "../modals/CallReviewModal"
import { ReceiptPreviewModal } from "../modals/ReceiptPreviewModal"
import { AppIcon, type AppIconName } from "../components/AppIcon"
import { ChannelBadge } from "../components/ChannelBadge"
import { Sidebar } from "../components/Sidebar"
import { MenuScreen } from "./MenuScreen"
import { createRestaurantVoiceAgent, ELEVENLABS_API_ORIGIN } from "../workspace-api"

const ELEVENLABS_API_KEY_STORAGE_PREFIX = "restaurant-elevenlabs-api-key:"
const PRINT_PREFERENCES_STORAGE_PREFIX = "restaurant-print-preferences:"

type PrintPreferencesState = {
  autoPrintEnabled: boolean
  selectedPrinterId: string
  selectedPrinterName: string
  selectedPrinterUrl: string | null
}

const DEFAULT_PRINT_PREFERENCES: PrintPreferencesState = {
  autoPrintEnabled: false,
  selectedPrinterId: "",
  selectedPrinterName: "",
  selectedPrinterUrl: null,
}

type PrinterOption = {
  id: string
  name: string
  printerUrl: string | null
}

const SYSTEM_PRINT_SHEET_ID = "system-print-sheet"

type DaySummarySnapshot = {
  reportDateLabel: string
  printedAtLabel: string
  currencyCode: string
  totalOrders: number
  pendingOrders: number
  completedOrders: number
  grossTotal: number
  cashTotal: number
  creditTotal: number
  codOutstandingTotal: number
  unpaidOutstandingTotal: number
}

type WebSpeechUtteranceLike = {
  rate: number
  pitch: number
  volume: number
  onend: null | (() => void)
  onerror: null | (() => void)
}

type WebSpeechSynthesisLike = {
  cancel: () => void
  speak: (utterance: WebSpeechUtteranceLike) => void
}

type WebSpeechUtteranceCtor = new (text: string) => WebSpeechUtteranceLike

function getElevenLabsApiKeyStorageKey(restaurantId: string) {
  return `${ELEVENLABS_API_KEY_STORAGE_PREFIX}${restaurantId}`
}

function getPrintPreferencesStorageKey(restaurantId: string) {
  return `${PRINT_PREFERENCES_STORAGE_PREFIX}${restaurantId}`
}

async function loadStoredElevenLabsApiKey(restaurantId: string) {
  const key = await AsyncStorage.getItem(getElevenLabsApiKeyStorageKey(restaurantId))
  return key?.trim() || ""
}

async function saveStoredElevenLabsApiKey(restaurantId: string, apiKey: string) {
  await AsyncStorage.setItem(getElevenLabsApiKeyStorageKey(restaurantId), apiKey.trim())
}

async function loadStoredPrintPreferences(restaurantId: string): Promise<PrintPreferencesState> {
  try {
    const rawValue = await AsyncStorage.getItem(getPrintPreferencesStorageKey(restaurantId))
    if (!rawValue) {
      return DEFAULT_PRINT_PREFERENCES
    }

    const parsed = JSON.parse(rawValue) as Partial<PrintPreferencesState> | null
    const legacyPrinterName = typeof (parsed as { preferredPrinterName?: unknown } | null)?.preferredPrinterName === "string"
      ? String((parsed as { preferredPrinterName?: unknown }).preferredPrinterName || "").trim()
      : ""
    const selectedPrinterId =
      typeof parsed?.selectedPrinterId === "string" && parsed.selectedPrinterId.trim()
        ? parsed.selectedPrinterId.trim()
        : legacyPrinterName
          ? `legacy:${legacyPrinterName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
          : ""
    const selectedPrinterName =
      typeof parsed?.selectedPrinterName === "string" && parsed.selectedPrinterName.trim()
        ? parsed.selectedPrinterName.trim()
        : legacyPrinterName
    const selectedPrinterUrl =
      typeof parsed?.selectedPrinterUrl === "string" && parsed.selectedPrinterUrl.trim()
        ? parsed.selectedPrinterUrl.trim()
        : null

    return {
      autoPrintEnabled: Boolean(parsed?.autoPrintEnabled) && Boolean(selectedPrinterId),
      selectedPrinterId,
      selectedPrinterName,
      selectedPrinterUrl,
    }
  } catch {
    return DEFAULT_PRINT_PREFERENCES
  }
}

async function saveStoredPrintPreferences(restaurantId: string, preferences: PrintPreferencesState) {
  const payload: PrintPreferencesState = {
    autoPrintEnabled: Boolean(preferences.autoPrintEnabled),
    selectedPrinterId: preferences.selectedPrinterId.trim(),
    selectedPrinterName: preferences.selectedPrinterName.trim(),
    selectedPrinterUrl: preferences.selectedPrinterUrl?.trim() || null,
  }

  await AsyncStorage.setItem(getPrintPreferencesStorageKey(restaurantId), JSON.stringify(payload))
}

function getDefaultPrinterOptions(): PrinterOption[] {
  if (Platform.OS === "ios") {
    return []
  }

  return [
    {
      id: SYSTEM_PRINT_SHEET_ID,
      name: "System print sheet",
      printerUrl: null,
    },
  ]
}

function mergePrinterOptions(...optionGroups: Array<PrinterOption[]>): PrinterOption[] {
  const uniqueOptions = new Map<string, PrinterOption>()

  optionGroups.flat().forEach((option) => {
    const optionId = option.id.trim()
    const optionName = option.name.trim()
    if (!optionId || !optionName) {
      return
    }

    const mapKey = option.printerUrl?.trim() || optionId
    if (!uniqueOptions.has(mapKey)) {
      uniqueOptions.set(mapKey, {
        id: optionId,
        name: optionName,
        printerUrl: option.printerUrl?.trim() || null,
      })
    }
  })

  return Array.from(uniqueOptions.values())
}

function getStoredPrinterOption(preferences: PrintPreferencesState): PrinterOption[] {
  if (!preferences.selectedPrinterId.trim() || !preferences.selectedPrinterName.trim()) {
    return []
  }

  return [
    {
      id: preferences.selectedPrinterId.trim(),
      name: preferences.selectedPrinterName.trim(),
      printerUrl: preferences.selectedPrinterUrl?.trim() || null,
    },
  ]
}

function getWebSpeechRuntime(): { synthesis: WebSpeechSynthesisLike; UtteranceCtor: WebSpeechUtteranceCtor } | null {
  if (Platform.OS !== "web") {
    return null
  }

  const root = globalThis as typeof globalThis & {
    speechSynthesis?: WebSpeechSynthesisLike
    SpeechSynthesisUtterance?: WebSpeechUtteranceCtor
  }

  if (!root.speechSynthesis || !root.SpeechSynthesisUtterance) {
    return null
  }

  return {
    synthesis: root.speechSynthesis,
    UtteranceCtor: root.SpeechSynthesisUtterance,
  }
}

function maskApiKey(value: string) {
  const trimmed = value.trim()
  if (!trimmed) {
    return ""
  }
  if (trimmed.length <= 8) {
    return "Saved"
  }
  return `${trimmed.slice(0, 4)}${"\u2022".repeat(Math.max(4, trimmed.length - 8))}${trimmed.slice(-4)}`
}

const SIGNUP_PASSWORD_MIN_LENGTH = 8
const SIGNUP_PASSWORD_RECOMMENDED_LENGTH = 12

function hasUppercaseCharacter(value: string) {
  return /[A-Z]/.test(value)
}

function hasSpecialCharacter(value: string) {
  return /[^A-Za-z0-9\s]/.test(value)
}

function validateSignupPassword(password: string) {
  if (password.length < SIGNUP_PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${SIGNUP_PASSWORD_MIN_LENGTH} characters long.`
  }

  if (!/\S/.test(password)) {
    return "Password cannot be only spaces."
  }

  if (!hasUppercaseCharacter(password)) {
    return "Password must include at least one uppercase letter."
  }

  if (!hasSpecialCharacter(password)) {
    return "Password must include at least one special character."
  }

  return ""
}

const THEME = {
  background: COLORS.BACKGROUND,
  card: COLORS.SURFACE,
  cardAlt: COLORS.SURFACE_RAISED,
  border: COLORS.BORDER,
  text: COLORS.TEXT_PRIMARY,
  mutedText: COLORS.TEXT_SECONDARY,
  primary: COLORS.ACCENT,
  primarySoft: COLORS.ACCENT_LIGHT,
  accent: COLORS.ACCENT,
  accentSoft: COLORS.SURFACE_BORDER_SOFT,
  chip: COLORS.SURFACE_RAISED,
  chipBorder: COLORS.SURFACE_BORDER_SOFT,
  chipText: COLORS.TEXT_SECONDARY,
  activeTextDark: COLORS.SURFACE,
  loadingOverlay: "rgba(244, 241, 234, 0.76)",
}

const CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 20px 48px rgba(8, 16, 29, 0.10)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: 0.12,
      shadowRadius: 24,
    }) as Record<string, unknown>

const METRIC_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 14px 30px rgba(8, 16, 29, 0.08)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.09,
      shadowRadius: 18,
    }) as Record<string, unknown>

const SOFT_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 10px 24px rgba(8, 16, 29, 0.06)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.07,
      shadowRadius: 14,
    }) as Record<string, unknown>

const FAB_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 16px 24px rgba(8, 16, 29, 0.16)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.16,
      shadowRadius: 18,
    }) as Record<string, unknown>

const PAPER_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px 22px 42px rgba(0, 0, 0, 0.22)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: 0.22,
      shadowRadius: 20,
    }) as Record<string, unknown>

const SHEET_CARD_SHADOW = (Platform.OS === "web"
  ? {
      boxShadow: "0px -12px 30px rgba(8, 16, 29, 0.10)",
    }
  : {
      shadowColor: COLORS.SHADOW,
      shadowOffset: { width: 0, height: -8 },
      shadowOpacity: 0.1,
      shadowRadius: 18,
    }) as Record<string, unknown>

const WEB_TEXT_INPUT_RESET = (Platform.OS === "web"
  ? {
      outlineStyle: "none",
      outlineWidth: 0,
      outlineColor: "transparent",
      boxShadow: "none",
    }
  : {}) as Record<string, unknown>

const NOTICE_TIMEOUT_MS = 4500
const ORDER_STATUS_PENDING = COLORS.WARNING
const ORDER_STATUS_COMPLETE = COLORS.SUCCESS
const ORDER_STATUS_CANCELLED = COLORS.DANGER

type ButtonLabelProps = {
  icon: AppIconName
  label: string
  color: string
  size?: number
  textStyle: StyleProp<TextStyle>
}

function ButtonLabel({ icon, label, color, size = 16, textStyle }: ButtonLabelProps) {
  return (
    <View style={styles.buttonLabelRow}>
      <AppIcon name={icon} size={size} color={color} />
      <Text style={textStyle}>{label}</Text>
    </View>
  )
}

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
  if (lowerMessage.includes("existing elevenlabs agent linked successfully")) {
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
  if (lowerMessage.includes("elevenlabs api key is required")) {
    return "Please enter your ElevenLabs API key."
  }
  if (lowerMessage.includes("agent id is required")) {
    return "Please enter the agent ID before linking the assistant."
  }
  if (lowerMessage.includes("elevenlabs api error (401)")) {
    return "That ElevenLabs API key doesn't look valid. Please check it and try again."
  }
  if (lowerMessage.includes("failed to create voice agent in elevenlabs")) {
    return "We couldn't create the voice assistant right now. Please try again."
  }
  if (lowerMessage.includes("failed to configure elevenlabs post-call webhook")) {
    return "We couldn't finish the call review webhook setup. Please try again."
  }
  if (lowerMessage.includes("did not return a post-call webhook id and secret")) {
    return "We couldn't finish the call review webhook setup. Please try again."
  }
  if (lowerMessage.includes("elevenlabs did not return an agent_id") || lowerMessage.includes("elevenlabs did not return an agent id")) {
    return "We couldn't finish linking the voice assistant. Please try again."
  }
  if (lowerMessage.includes("restaurant tools could not be attached")) {
    return "The agent was created, but we couldn't finish the restaurant setup automatically. Please try again."
  }
  if (lowerMessage.includes("supabase functions base url is not configured")) {
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
      const valuedMatch = part.match(/^(.*?):\s*(.+?)(?:\s*\+(\d+(?:\.\d{1,2})?))?$/)
      if (valuedMatch) {
        return {
          label: valuedMatch[1].trim(),
          value: valuedMatch[2].trim() || null,
          priceDelta: Number(valuedMatch[3] || 0),
          isRequired: false,
        }
      }

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

function formatCustomizationText(customization: MenuCustomizationDraft): string {
  const label = customization.label.trim()
  const value = customization.value?.trim() || ""
  const priceSuffix = customization.priceDelta ? `+${Number(customization.priceDelta || 0).toFixed(2)}` : ""

  if (label && value) {
    return `${label}: ${value}${priceSuffix ? ` ${priceSuffix}` : ""}`
  }

  if (!label) {
    return value
  }

  return `${label}${priceSuffix}`
}

function fromMenuItem(item: MenuItemDraft): UiDraftItem {
  return {
    name: item.name || "",
    description: item.description || "",
    category: item.category || "",
    basePrice: String(item.basePrice || 0),
    stockQuantity: String(Math.max(0, Number(item.stockQuantity || 0))),
    customizationText: (item.customizations || []).map(formatCustomizationText).join(", "),
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

function getMenuItemKey(item: MenuItemDraft): string {
  const normalizedName = normalizeMenuIdentityValue(item.name)
  if (!normalizedName) {
    return ""
  }

  const normalizedCategory = normalizeMenuIdentityValue(item.category || "")
  return normalizedCategory ? `${normalizedCategory}::${normalizedName}` : normalizedName
}

function getMenuCustomizationIdentityKey(customization: MenuCustomizationDraft): string {
  if (customization.id?.trim()) {
    return `id::${customization.id.trim()}`
  }

  return [
    normalizeMenuIdentityValue(customization.label),
    normalizeMenuIdentityValue(customization.value || ""),
    Number(customization.priceDelta || 0).toFixed(2),
    customization.isRequired ? "1" : "0",
  ].join("::")
}

function mergeMenuCustomization(
  existingCustomization: MenuCustomizationDraft,
  incomingCustomization: MenuCustomizationDraft,
): MenuCustomizationDraft {
  const existingValue = existingCustomization.value?.trim() || ""
  const incomingValue = incomingCustomization.value?.trim() || ""
  const resolvedValue = existingValue || incomingValue

  return {
    id: existingCustomization.id || incomingCustomization.id,
    label: pickPreferredMenuText(existingCustomization.label, incomingCustomization.label),
    value: resolvedValue || null,
    priceDelta:
      Number(existingCustomization.priceDelta || 0) !== 0
        ? Number(existingCustomization.priceDelta || 0)
        : Number(incomingCustomization.priceDelta || 0),
    isRequired: Boolean(existingCustomization.isRequired || incomingCustomization.isRequired),
  }
}

function mergeMenuItemCustomizations(
  existingCustomizations: MenuCustomizationDraft[],
  incomingCustomizations: MenuCustomizationDraft[],
): MenuCustomizationDraft[] {
  const merged: MenuCustomizationDraft[] = []
  const indexByKey = new Map<string, number>()

  for (const customization of [...existingCustomizations, ...incomingCustomizations]) {
    const key = getMenuCustomizationIdentityKey(customization)
    if (!key) {
      merged.push({ ...customization })
      continue
    }

    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length)
      merged.push({ ...customization })
      continue
    }

    merged[existingIndex] = mergeMenuCustomization(merged[existingIndex], customization)
  }

  return merged
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
  const deduped: MenuItemDraft[] = []
  const indexByKey = new Map<string, number>()

  for (const item of items) {
    const key = getMenuItemKey(item)
    if (!key) {
      deduped.push({
        ...item,
        customizations: (item.customizations || []).map((customization) => ({ ...customization })),
      })
      continue
    }

    const existingIndex = indexByKey.get(key)
    if (existingIndex === undefined) {
      indexByKey.set(key, deduped.length)
      deduped.push({
        ...item,
        customizations: (item.customizations || []).map((customization) => ({ ...customization })),
      })
      continue
    }

    const existingItem = deduped[existingIndex]
    const existingPrice = Number(existingItem.basePrice || 0)
    const incomingPrice = Number(item.basePrice || 0)
    const existingStock = Number(existingItem.stockQuantity || 0)
    const incomingStock = Number(item.stockQuantity || 0)

    deduped[existingIndex] = {
      ...existingItem,
      name: pickPreferredMenuText(existingItem.name, item.name),
      description: pickBestDescription(existingItem.description || "", item.description || "") || null,
      category: pickPreferredMenuText(existingItem.category || "", item.category || "") || null,
      basePrice: existingPrice > 0 ? existingPrice : incomingPrice,
      stockQuantity: Math.max(existingStock, incomingStock),
      customizations: mergeMenuItemCustomizations(existingItem.customizations || [], item.customizations || []),
    }
  }

  return deduped
}

function formatOrderItemLine(item: RestaurantOrderRecord["items"][number]): string {
  const quantity = Math.max(1, Number(item.quantity || 1))
  const unitPrice = Number(item.unitPrice || 0)
  const normalizedPrice = Number.isFinite(unitPrice) ? unitPrice.toFixed(2) : "0.00"
  const menuItemIdLine = item.menuItemId?.trim() ? `\nMenu item id: ${item.menuItemId.trim()}` : ""
  return `Item: ${stripOrderItemMetadata(item.name)}${menuItemIdLine}\nQuantity: ${quantity}\nUnit price: ${normalizedPrice}`
}

function orderItemsToText(order: RestaurantOrderRecord): string {
  return (order.items || []).map(formatOrderItemLine).join("\n\n")
}

function orderItemsListToText(items: RestaurantOrderRecord["items"]): string {
  return (items || []).map(formatOrderItemLine).join("\n\n")
}

function orderToUiDraft(order: RestaurantOrderRecord): UiOrderDraft {
  return {
    id: order.id,
    customerName: order.customerName,
    customerPhone: order.customerPhone || "",
    fulfillmentType: order.fulfillmentType || "pickup",
    deliveryPostcode: order.deliveryPostcode || "",
    deliveryAddress: order.deliveryAddress || "",
    paymentCollection: order.paymentCollection || "unpaid",
    paymentStatus: order.paymentStatus || "unpaid",
    paymentMethod: order.paymentMethod || "",
    cardTransactionId: order.cardTransactionId || "",
    shortOrderCode: order.shortOrderCode ?? null,
    orderCodeDate: order.orderCodeDate ?? null,
    createdAt: order.created_at ?? null,
    status: order.status,
    notes: order.notes || "",
    subtotalAmount: Number(order.subtotalAmount || 0),
    taxAmount: Number(order.taxAmount || 0),
    taxRatePercent: Number(order.taxRatePercent || 0),
    taxInclusive: Boolean(order.taxInclusive),
    taxLabel: order.taxLabel || "VAT",
    serviceFeeAmount: Number(order.serviceFeeAmount || 0),
    serviceFeeLabel: order.serviceFeeLabel || "Service Charge",
    tipAmount: Number(order.tipAmount || 0),
    tipLabel: order.tipLabel || "Gratuity",
    currencyCode: order.currencyCode || DEFAULT_CURRENCY_CODE,
    itemsText: orderItemsToText(order),
    callReview: order.callReview || null,
  }
}

function cloneOrderDraft(draft: UiOrderDraft): UiOrderDraft {
  return {
    ...draft,
    callReview: draft.callReview ? { ...draft.callReview } : draft.callReview,
  }
}

function createEmptyOrderDraft(): UiOrderDraft {
  return {
    customerName: "",
    customerPhone: "",
    fulfillmentType: "pickup",
    deliveryPostcode: "",
    deliveryAddress: "",
    paymentCollection: "unpaid",
    paymentStatus: "unpaid",
    paymentMethod: "",
    cardTransactionId: "",
    shortOrderCode: null,
    orderCodeDate: null,
    createdAt: null,
    status: "pending",
    notes: "",
    subtotalAmount: 0,
    taxAmount: 0,
    taxRatePercent: 0,
    taxInclusive: false,
    taxLabel: "VAT",
    serviceFeeAmount: 0,
    serviceFeeLabel: "Service Charge",
    tipAmount: 0,
    tipLabel: "Gratuity",
    currencyCode: DEFAULT_CURRENCY_CODE,
    itemsText: "",
  }
}

function getCustomizationOptionKey(customization: MenuCustomizationDraft, fallbackSeed = ""): string {
  const customizationId = customization.id?.trim()
  if (customizationId) {
    return `id::${customizationId}`
  }

  return [
    normalizeMenuIdentityValue(customization.label || "option"),
    normalizeMenuIdentityValue(customization.value || ""),
    Number(customization.priceDelta || 0).toFixed(2),
    customization.isRequired ? "1" : "0",
    normalizeMenuIdentityValue(fallbackSeed),
  ].join("::")
}

function getCustomizationOptionValue(groupLabel: string, customization: MenuCustomizationDraft): string {
  const explicitValue = customization.value?.trim() || ""
  if (explicitValue) {
    return explicitValue
  }

  const optionLabel = customization.label.trim()
  if (!optionLabel) {
    return ""
  }

  if (groupLabel === "Flavour") {
    const normalizedFlavorLabel = optionLabel.replace(/\s+flavou?r$/i, "").trim()
    if (
      normalizedFlavorLabel &&
      normalizeMenuIdentityValue(normalizedFlavorLabel) !== normalizeMenuIdentityValue(groupLabel)
    ) {
      return normalizedFlavorLabel
    }
  }

  if (normalizeMenuIdentityValue(optionLabel) !== normalizeMenuIdentityValue(groupLabel)) {
    return optionLabel
  }

  return ""
}

function getCustomizationGroupLabel(customization: MenuCustomizationDraft): string {
  const label = customization.label.trim()
  const normalizedLabel = label.toLowerCase()

  if (!label) {
    return ""
  }

  if (/\bflavou?r\b/.test(normalizedLabel)) {
    return "Flavour"
  }

  return label
}

function groupMenuCustomizations(customizations: MenuCustomizationDraft[]): MenuCustomizationGroup[] {
  const grouped = new Map<string, MenuCustomizationDraft[]>()

  for (const customization of customizations || []) {
    const label = getCustomizationGroupLabel(customization)
    if (!label) {
      continue
    }

    const existing = grouped.get(label) || []
    existing.push({ ...customization })
    grouped.set(label, existing)
  }

  return Array.from(grouped.entries()).map(([label, options]) => {
    const normalizedOptions = options.map((option, optionIndex) => {
      const generatedKey = getCustomizationOptionKey(option, `${label}-${optionIndex}`)
      return {
        ...option,
        id: option.id?.trim() ? option.id : `generated-${generatedKey}-${optionIndex}`,
      }
    })

    const hasMeaningfulValue = normalizedOptions.some((option) => Boolean(getCustomizationOptionValue(label, option)))
    const filteredOptions = normalizedOptions.filter((option) => {
      const optionValue = getCustomizationOptionValue(label, option)
      if (!hasMeaningfulValue) {
        return true
      }

      const labelLooksGeneric = normalizeMenuIdentityValue(option.label) === normalizeMenuIdentityValue(label)
      return Boolean(optionValue) || !labelLooksGeneric
    })

    const dedupedOptions: MenuCustomizationDraft[] = []
    const seenOptionKeys = new Set<string>()
    for (const [optionIndex, option] of filteredOptions.entries()) {
      const optionIdentity = [
        normalizeMenuIdentityValue(label),
        normalizeMenuIdentityValue(getCustomizationOptionValue(label, option)),
        Number(option.priceDelta || 0).toFixed(2),
        option.isRequired ? "1" : "0",
      ].join("::")

      if (seenOptionKeys.has(optionIdentity)) {
        continue
      }

      seenOptionKeys.add(optionIdentity)
      dedupedOptions.push({
        ...option,
        id: option.id?.trim() ? option.id : `generated-${optionIdentity}-${optionIndex}`,
      })
    }

    const resolvedOptions = dedupedOptions.length > 0 ? dedupedOptions : normalizedOptions
    const hasDistinctValues = resolvedOptions.some((option) => Boolean(getCustomizationOptionValue(label, option)))
    const mode: MenuCustomizationGroup["mode"] = resolvedOptions.length > 1 || hasDistinctValues ? "single" : "toggle"

    return {
      label,
      required: resolvedOptions.some((option) => Boolean(option.isRequired)),
      mode,
      options: resolvedOptions,
    }
  })
}

function getCustomizationChoiceLabel(group: MenuCustomizationGroup, option: MenuCustomizationDraft): string {
  const optionValue = getCustomizationOptionValue(group.label, option)
  if (group.mode === "single" && optionValue) {
    return optionValue
  }
  return option.label.trim() || group.label
}

function formatCustomizationPriceDelta(priceDelta: number, currencyCode?: string | null): string {
  const normalized = Number(priceDelta || 0)
  if (!normalized) {
    return ""
  }
  return ` (+${formatCurrencyDisplay(normalized, currencyCode)})`
}

function stripOrderItemMetadata(value: string): string {
  return value
    .replace(/\s*\|\s*menu\s*item\s*id\s*:[^|\n\r]+/gi, "")
    .replace(/\r?\n\s*menu\s*item\s*id\s*:[^\n\r]+/gi, "")
    .trim()
}

function matchesMenuItemSelection(orderItemName: string, menuItemName: string): boolean {
  const normalizedItemName = stripOrderItemMetadata(orderItemName).toLowerCase()
  const normalizedMenuName = menuItemName.trim().toLowerCase()
  return normalizedItemName === normalizedMenuName || normalizedItemName.startsWith(`${normalizedMenuName} (`)
}

function matchesDraftOrderItemToMenuItem(
  orderItem: RestaurantOrderRecord["items"][number],
  menuItem: MenuItemDraft,
): boolean {
  const normalizedMenuItemId = menuItem.id?.trim() || ""
  const normalizedOrderMenuItemId = orderItem.menuItemId?.trim() || ""

  if (normalizedMenuItemId && normalizedOrderMenuItemId) {
    return normalizedMenuItemId === normalizedOrderMenuItemId
  }

  return matchesMenuItemSelection(orderItem.name, menuItem.name)
}

function resolveMenuItemIdForOrderItem(
  orderItem: RestaurantOrderRecord["items"][number],
  menuItems: MenuItemDraft[],
): string | null {
  const existingMenuItemId = orderItem.menuItemId?.trim() || ""
  if (existingMenuItemId) {
    return existingMenuItemId
  }

  const matchingMenuItems = menuItems.filter(
    (menuItem) => Boolean(menuItem.id?.trim()) && matchesDraftOrderItemToMenuItem(orderItem, menuItem),
  )

  if (matchingMenuItems.length === 0) {
    return null
  }

  if (matchingMenuItems.length === 1) {
    return matchingMenuItems[0].id?.trim() || null
  }

  const exactNameMatch = matchingMenuItems.find(
    (menuItem) =>
      normalizeMenuIdentityValue(stripOrderItemMetadata(orderItem.name)) === normalizeMenuIdentityValue(menuItem.name),
  )

  return exactNameMatch?.id?.trim() || matchingMenuItems[0].id?.trim() || null
}

function resolveOrderItemsMenuItemIds(
  items: RestaurantOrderRecord["items"],
  menuItems: MenuItemDraft[],
): { items: RestaurantOrderRecord["items"]; changed: boolean } {
  let changed = false

  const resolvedItems = items.map((item) => {
    const resolvedMenuItemId = resolveMenuItemIdForOrderItem(item, menuItems)
    if (!resolvedMenuItemId || resolvedMenuItemId === (item.menuItemId?.trim() || "")) {
      return item
    }

    changed = true
    return {
      ...item,
      menuItemId: resolvedMenuItemId,
    }
  })

  return {
    items: resolvedItems,
    changed,
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
        /^(?:item\s*:\s*)?(.*?)(?:\s*\|\s*menu\s*item\s*id\s*:\s*([^|]+?))?\s*\|\s*(?:qty|quantity)\s*:\s*(\d+)\s*\|\s*(?:unit\s*price|price)\s*:\s*(\d+(?:\.\d{1,2})?)$/i,
      )

      let namePart = ""
      let menuItemIdPart = ""
      let qtyPart = ""
      let pricePart = ""

      if (labeledMatch) {
        namePart = labeledMatch[1]?.trim() || ""
        menuItemIdPart = labeledMatch[2]?.trim() || ""
        qtyPart = labeledMatch[3]?.trim() || ""
        pricePart = labeledMatch[4]?.trim() || ""
      } else if (block.includes("|") && !block.includes("\n")) {
        const parts = block
          .split("|")
          .map((part) => part.trim())
          .filter(Boolean)

        for (const part of parts) {
          if (/^item\s*:/i.test(part)) {
            namePart = part.replace(/^item\s*:/i, "").trim()
            continue
          }
          if (/^menu\s*item\s*id\s*:/i.test(part)) {
            menuItemIdPart = part.replace(/^menu\s*item\s*id\s*:/i, "").trim()
            continue
          }
          if (/^(?:qty|quantity)\s*:/i.test(part)) {
            qtyPart = part.replace(/^(?:qty|quantity)\s*:/i, "").trim()
            continue
          }
          if (/^(?:unit\s*price|price)\s*:/i.test(part)) {
            pricePart = part.replace(/^(?:unit\s*price|price)\s*:/i, "").trim()
            continue
          }
          if (!namePart) {
            namePart = part
          }
        }
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
          if (/^menu\s*item\s*id\s*:/i.test(line)) {
            menuItemIdPart = line.replace(/^menu\s*item\s*id\s*:/i, "").trim()
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
        menuItemId: menuItemIdPart || null,
        name: stripOrderItemMetadata(namePart),
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
    return "pos"
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
  return Platform.OS === "web" ? resolveWebPortalMode() : "pos"
}

function formatShortOrderCode(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null
  }

  return String(Math.round(value)).padStart(3, "0")
}

const DEFAULT_CURRENCY_CODE = "GBP"
const HTML_CURRENCY_ENTITY = "&pound;"

function getCurrencySymbol(currencyCode?: string | null) {
  return getCurrencySymbolUtil(currencyCode || DEFAULT_CURRENCY_CODE)
}

function formatCurrencyDisplay(value: number | null | undefined, currencyCode?: string | null): string {
  const normalizedValue = Number(value || 0)
  if (!Number.isFinite(normalizedValue)) {
    return `${getCurrencySymbol(currencyCode)}0.00`
  }

  return `${getCurrencySymbol(currencyCode)}${normalizedValue.toFixed(2)}`
}

function formatAudioTime(value: number | null | undefined): string {
  const normalizedValue = Math.max(0, Number(value || 0))
  if (!Number.isFinite(normalizedValue)) {
    return "0:00"
  }

  const roundedSeconds = Math.floor(normalizedValue)
  const minutes = Math.floor(roundedSeconds / 60)
  const seconds = roundedSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}

function getOrderStatusTone(status: string | null | undefined): "pending" | "complete" | "cancelled" {
  const normalizedStatus = String(status || "")
    .trim()
    .toLowerCase()

  if (normalizedStatus === "closed" || normalizedStatus === "complete") {
    return "complete"
  }
  if (normalizedStatus === "cancelled") {
    return "cancelled"
  }
  return "pending"
}

function getOrderStatusLabel(status: string | null | undefined): string {
  const tone = getOrderStatusTone(status)
  if (tone === "complete") {
    return "COMPLETE"
  }
  if (tone === "cancelled") {
    return "CANCELLED"
  }
  return "PENDING"
}

function matchesOrderStatusFilter(status: string | null | undefined, filter: OrderStatusFilter): boolean {
  if (filter === "all") {
    return true
  }
  return getOrderStatusTone(status) === filter
}

function normalizeFulfillmentType(value: unknown): FulfillmentType {
  return String(value || "").trim().toLowerCase() === "delivery" ? "delivery" : "pickup"
}

function normalizeUkPostcode(value: unknown): string {
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

function looksLikeUkPostcode(value: string): boolean {
  return /^[A-Z]{1,2}\d[A-Z\d]?\s\d[A-Z]{2}$/.test(value)
}

function resolvePaymentCollection(
  fulfillmentType: FulfillmentType,
  explicitValue?: PaymentCollection | string | null,
): PaymentCollection {
  const normalized = String(explicitValue || "")
    .trim()
    .toLowerCase()

  if (normalized === "cod" || normalized === "unpaid") {
    return normalized as PaymentCollection
  }

  return fulfillmentType === "delivery" ? "cod" : "unpaid"
}

function normalizePaymentStatus(value: unknown): PaymentStatus {
  return String(value || "").trim().toLowerCase() === "paid" ? "paid" : "unpaid"
}

function normalizePaymentMethod(value: unknown): PaymentMethod | null {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "cash" || normalized === "card") {
    return normalized as PaymentMethod
  }
  return null
}

function getFulfillmentTypeLabel(value: FulfillmentType | string | null | undefined): string {
  return normalizeFulfillmentType(value) === "delivery" ? "DELIVERY" : "PICKUP"
}

function getPaymentCollectionLabel(value: PaymentCollection | string | null | undefined): string {
  return String(value || "").trim().toLowerCase() === "cod" ? "COD" : "UNPAID"
}

function getOrderPaymentDisplayLabel(params: {
  fulfillmentType?: FulfillmentType | string | null
  paymentCollection?: PaymentCollection | string | null
  paymentStatus?: PaymentStatus | string | null
  paymentMethod?: PaymentMethod | string | null
}): string {
  const paymentStatus = normalizePaymentStatus(params.paymentStatus)
  const paymentMethod = normalizePaymentMethod(params.paymentMethod)
  const paymentCollection = resolvePaymentCollection(
    normalizeFulfillmentType(params.fulfillmentType),
    params.paymentCollection,
  )

  if (paymentStatus === "paid") {
    if (paymentMethod === "card") {
      return "CARD"
    }
    if (paymentMethod === "cash") {
      return "CASH"
    }
  }

  if (paymentCollection === "cod") {
    return "COD"
  }

  return "UNPAID"
}

type ReceiptLineItem = {
  name?: string | null
  item_name?: string | null
  quantity?: number | string | null
  qty?: number | string | null
  price?: number | string | null
  unit_price?: number | string | null
}

type ReceiptOrder = {
  id?: string
  short_code?: string | number | null
  status?: string | null
  created_at?: string | null
  fulfillment_type?: FulfillmentType | string | null
  payment_collection?: PaymentCollection | string | null
  payment_status?: PaymentStatus | string | null
  payment_method?: PaymentMethod | string | null
  customer_name?: string | null
  contact_name?: string | null
  customer_phone?: string | null
  contact_phone?: string | null
  delivery_postcode?: string | null
  delivery_address?: string | null
  card_transaction_id?: string | null
  notes?: string | null
  special_instructions?: string | null
  subtotal_amount?: number | string | null
  tax_amount?: number | string | null
  tax_rate_percent?: number | string | null
  tax_inclusive?: boolean | null
  tax_label?: string | null
  service_fee_amount?: number | string | null
  service_fee_label?: string | null
  tip_amount?: number | string | null
  tip_label?: string | null
  currency_code?: string | null
  total_amount?: number | string | null
  total?: number | string | null
  items?: ReceiptLineItem[]
  order_items?: ReceiptLineItem[]
}

type ActiveOrderItemPickerState = {
  index: number
  orderKey: string
  snapshotItemsText: string
}

type ActiveOrderEditorState = {
  mode: "edit" | "add"
  index: number
  snapshot: UiOrderDraft
}

type ActivePaymentUpdateState = {
  index: number
  pin: string
  paymentMethod: PaymentMethod
  cardTransactionId: string
  tipAmount: string
}

type MenuCustomizationGroup = {
  label: string
  required: boolean
  mode: "single" | "toggle"
  options: MenuCustomizationDraft[]
}

type ActiveItemCustomizationState = {
  orderIndex: number
  menuItem: MenuItemDraft
  selectedSingleKeys: Record<string, string>
  selectedToggleKeys: Record<string, boolean>
}

function escapeReceiptHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function formatReceiptDate(value: string | null | undefined): string {
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

function getReceiptNumericString(value: number | string | null | undefined): string {
  const parsedValue = Number.parseFloat(String(value ?? 0))
  return Number.isFinite(parsedValue) ? parsedValue.toFixed(2) : "0.00"
}

function getItemsSubtotalAmount(items: Array<{ quantity?: number | string | null; unitPrice?: number | string | null; price?: number | string | null }>) {
  return items.reduce((sum, item) => {
    const quantity = Math.max(1, Number(item.quantity || 1))
    const unitPrice = item.unitPrice !== undefined ? Number(item.unitPrice || 0) : Number(item.price || 0) / quantity
    return sum + quantity * unitPrice
  }, 0)
}

function getUiOrderBillingBreakdown(
  order: UiOrderDraft,
  options?: {
    fallbackSubtotalAmount?: number
    fallbackCurrencyCode?: string
    fallbackTipLabel?: string
  },
) {
  return normalizeOrderBillingBreakdown(order, {
    fallbackSubtotalAmount: options?.fallbackSubtotalAmount,
    fallbackCurrencyCode: order.currencyCode || options?.fallbackCurrencyCode || DEFAULT_CURRENCY_CODE,
    fallbackTipLabel: order.tipLabel || options?.fallbackTipLabel || "Gratuity",
  })
}

type ThermalPreviewModalProps = {
  visible: boolean
  order: ReceiptOrder | null
  restaurantName: string
  onClose: () => void
  onPrint: () => void
}

function renderReceiptContent(order: ReceiptOrder | null, restaurantName: string) {
  if (!order) {
    return <Text style={styles.thermalReceiptEmptyText}>No order data</Text>
  }

  const items = order?.items || order?.order_items || []
  const total = formatCurrencyDisplay(Number(getReceiptNumericString(order?.total_amount || order?.total || 0)))
  const customerName = String(order?.customer_name || order?.contact_name || "Guest")
  const customerPhone = String(order?.customer_phone || order?.contact_phone || "").trim()
  const fulfillmentType = getFulfillmentTypeLabel(order?.fulfillment_type)
  const paymentCollection = getOrderPaymentDisplayLabel({
    fulfillmentType: order?.fulfillment_type,
    paymentCollection: order?.payment_collection,
    paymentStatus: order?.payment_status,
    paymentMethod: order?.payment_method,
  })
  const cardTransactionId = String(order?.card_transaction_id || "").trim()
  const deliveryPostcode = normalizeUkPostcode(order?.delivery_postcode)
  const deliveryAddress = String(order?.delivery_address || "").trim()
  const notes = String(order?.notes || order?.special_instructions || "").trim()
  const orderCode = String(order?.short_code || order?.id || "\u2014")
  const status = getOrderStatusLabel(order?.status)
  const receiptDate = formatReceiptDate(order?.created_at)

  return (
    <>
      <Text style={styles.thermalReceiptRestaurantName}>{(restaurantName.trim() || "Restaurant").toUpperCase()}</Text>
      <Text style={styles.thermalReceiptSubtitle}>Voice Ordering System</Text>
      <Text style={styles.thermalReceiptDividerSolid}>================================</Text>

      <Text style={styles.thermalReceiptOrderCode}>ORDER #{orderCode}</Text>
      <Text style={styles.thermalReceiptStatus}>[ {status} ]</Text>
      <Text style={styles.thermalReceiptDividerDashed}>--------------------------------</Text>

      <View style={styles.thermalReceiptMetaRow}>
        <Text style={styles.thermalReceiptMetaLabel}>Date:</Text>
        <Text style={styles.thermalReceiptMetaValue}>{receiptDate}</Text>
      </View>
      <View style={styles.thermalReceiptMetaRow}>
        <Text style={styles.thermalReceiptMetaLabel}>Customer:</Text>
        <Text style={styles.thermalReceiptMetaValue}>{customerName}</Text>
      </View>
      <View style={styles.thermalReceiptMetaRow}>
        <Text style={styles.thermalReceiptMetaLabel}>Order Type:</Text>
        <Text style={styles.thermalReceiptMetaValue}>{fulfillmentType}</Text>
      </View>
      <View style={styles.thermalReceiptMetaRow}>
        <Text style={styles.thermalReceiptMetaLabel}>Payment:</Text>
        <Text style={styles.thermalReceiptMetaValue}>{paymentCollection}</Text>
      </View>
      {customerPhone ? (
        <View style={styles.thermalReceiptMetaRow}>
          <Text style={styles.thermalReceiptMetaLabel}>Phone:</Text>
          <Text style={styles.thermalReceiptMetaValue}>{customerPhone}</Text>
        </View>
      ) : null}
      {deliveryPostcode ? (
        <View style={styles.thermalReceiptMetaRow}>
          <Text style={styles.thermalReceiptMetaLabel}>Postcode:</Text>
          <Text style={styles.thermalReceiptMetaValue}>{deliveryPostcode}</Text>
        </View>
      ) : null}
      {deliveryAddress ? (
        <View style={styles.thermalReceiptMetaRow}>
          <Text style={styles.thermalReceiptMetaLabel}>Address:</Text>
          <Text style={styles.thermalReceiptMetaValue}>{deliveryAddress}</Text>
        </View>
      ) : null}
      {cardTransactionId ? (
        <View style={styles.thermalReceiptMetaRow}>
          <Text style={styles.thermalReceiptMetaLabel}>Card Ref:</Text>
          <Text style={styles.thermalReceiptMetaValue}>{cardTransactionId}</Text>
        </View>
      ) : null}
      {notes ? (
        <View style={styles.thermalReceiptMetaRow}>
          <Text style={styles.thermalReceiptMetaLabel}>Notes:</Text>
          <Text style={styles.thermalReceiptMetaValue}>{notes}</Text>
        </View>
      ) : null}

      <Text style={styles.thermalReceiptDividerDashed}>--------------------------------</Text>

      <View style={styles.thermalReceiptItemsHeader}>
        <Text style={styles.thermalReceiptItemsHeaderName}>ITEM</Text>
        <Text style={styles.thermalReceiptItemsHeaderQty}>QTY</Text>
        <Text style={styles.thermalReceiptItemsHeaderPrice}>PRICE</Text>
      </View>

      {items.length > 0 ? (
        items.map((item, index) => (
          <View key={`receipt-item-${index}-${item.name || item.item_name || "item"}`} style={styles.thermalReceiptItemRow}>
            <Text style={styles.thermalReceiptItemName}>{String(item.name || item.item_name || "").toUpperCase()}</Text>
            <Text style={styles.thermalReceiptItemQty}>{String(item.quantity || item.qty || 1)}</Text>
            <Text style={styles.thermalReceiptItemPrice}>
              {formatCurrencyDisplay(Number(getReceiptNumericString(item.price || item.unit_price || 0)))}
            </Text>
          </View>
        ))
      ) : (
        <Text style={styles.thermalReceiptEmptyText}>No items</Text>
      )}

      <Text style={styles.thermalReceiptDividerSolid}>================================</Text>

      <View style={styles.thermalReceiptTotalRow}>
        <Text style={styles.thermalReceiptTotalLabel}>TOTAL</Text>
        <Text style={styles.thermalReceiptTotalAmount}>{total}</Text>
      </View>

      <Text style={styles.thermalReceiptDividerDashed}>--------------------------------</Text>

      <Text style={styles.thermalReceiptFooterTitle}>Thank You!</Text>
      <Text style={styles.thermalReceiptFooterText}>Please retain this receipt</Text>
    </>
  )
}

function ThermalPreviewModal({ visible, order, restaurantName, onClose, onPrint }: ThermalPreviewModalProps) {
  if (!visible || !order) {
    return null
  }

  return (
    <Modal visible animationType="slide" transparent={false} onRequestClose={onClose} statusBarTranslucent={false}>
      <SafeAreaView style={styles.thermalPreviewScreen}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.PAPER_SURROUND} translucent={false} />
        <View style={styles.thermalPreviewHeader}>
          <Text style={styles.thermalPreviewTitle}>Receipt Preview</Text>
          <View style={styles.thermalPreviewHeaderActions}>
            <Pressable style={styles.thermalPreviewPrintButton} onPress={onPrint}>
              <ButtonLabel icon="printer" label="Print" color={COLORS.HEADER_TEXT} textStyle={styles.thermalPreviewPrintButtonText} />
            </Pressable>
            <Pressable style={styles.thermalPreviewCloseButton} onPress={onClose}>
              <ButtonLabel icon="x" label="Close" color={COLORS.HEADER_TEXT} textStyle={styles.thermalPreviewCloseButtonText} />
            </Pressable>
          </View>
        </View>
        <Text style={styles.thermalPreviewPaperLabel}>80mm thermal · Monochrome preview</Text>
        <ScrollView
          style={styles.thermalPreviewScroll}
          contentContainerStyle={styles.thermalPreviewScrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.thermalReceiptPaper}>{renderReceiptContent(order, restaurantName)}</View>
          <View style={styles.thermalReceiptTearRow}>
            {Array.from({ length: 18 }).map((_, index) => (
              <View key={`receipt-tooth-${index}`} style={styles.thermalReceiptTearTooth} />
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  )
}

function getLegacyReceiptBodyMarkup(order: ReceiptOrder, restaurantName: string): string {
  const itemRows = (order.items || order.order_items || [])
    .map((item) => `
      <tr>
        <td class="desc">${escapeReceiptHtml(String(item.name || item.item_name || "")).toUpperCase()}</td>
        <td class="qty">${escapeReceiptHtml(String(item.quantity || item.qty || 1))}</td>
        <td class="price">${HTML_CURRENCY_ENTITY}${getReceiptNumericString(item.price || item.unit_price || 0)}</td>
      </tr>
    `)
    .join("")

  const total = getReceiptNumericString(order.total_amount || order.total || 0)
  const orderCode = escapeReceiptHtml(String(order.short_code || order.id || ""))
  const customerName = escapeReceiptHtml(String(order.customer_name || order.contact_name || "Guest"))
  const phone = escapeReceiptHtml(String(order.customer_phone || order.contact_phone || ""))
  const fulfillmentType = escapeReceiptHtml(getFulfillmentTypeLabel(order.fulfillment_type))
  const paymentCollection = escapeReceiptHtml(
    getOrderPaymentDisplayLabel({
      fulfillmentType: order.fulfillment_type,
      paymentCollection: order.payment_collection,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
    }),
  )
  const deliveryPostcode = escapeReceiptHtml(normalizeUkPostcode(order.delivery_postcode || ""))
  const deliveryAddress = escapeReceiptHtml(String(order.delivery_address || "").trim())
  const cardTransactionId = escapeReceiptHtml(String(order.card_transaction_id || "").trim())
  const notes = escapeReceiptHtml(String(order.notes || order.special_instructions || ""))
  const dateStr = formatReceiptDate(order.created_at)

  return `
  <!-- Restaurant Header -->
  <div class="restaurant-name">${escapeReceiptHtml(restaurantName || "Restaurant")}</div>
  <div class="tagline">Voice Ordering System</div>
  <hr class="solid">

  <!-- Order Number & Status -->
  <div class="order-number">ORDER #${orderCode}</div>
  <div class="status-row">
    <span class="status-badge">${escapeReceiptHtml(String(order.status || "PENDING")).toUpperCase()}</span>
  </div>
  <hr class="dashed">

  <!-- Order Meta -->
  <div class="meta-row">
    <span>Date:</span>
    <span>${escapeReceiptHtml(dateStr)}</span>
  </div>
  <div class="meta-row">
    <span>Customer:</span>
    <span class="bold">${customerName}</span>
  </div>
  <div class="meta-row">
    <span>Order Type:</span>
    <span>${fulfillmentType}</span>
  </div>
  <div class="meta-row">
    <span>Payment:</span>
    <span>${paymentCollection}</span>
  </div>
  ${phone ? `<div class="meta-row"><span>Phone:</span><span>${phone}</span></div>` : ""}
  ${deliveryPostcode ? `<div class="meta-row"><span>Postcode:</span><span>${deliveryPostcode}</span></div>` : ""}
  ${deliveryAddress ? `<div class="meta-row"><span>Address:</span><span>${deliveryAddress}</span></div>` : ""}
  ${cardTransactionId ? `<div class="meta-row"><span>Card Ref:</span><span>${cardTransactionId}</span></div>` : ""}
  ${notes ? `<div class="meta-row"><span>Notes:</span><span>${notes}</span></div>` : ""}
  <hr class="dashed">

  <!-- Items -->
  <table>
    <thead>
      <tr>
        <th class="desc">Item</th>
        <th class="qty">Qty</th>
        <th class="price">Price</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
  <hr class="solid">

  <!-- Total -->
  <div class="total-row">
    <span>TOTAL</span>
    <span>${HTML_CURRENCY_ENTITY}${total}</span>
  </div>
  <hr class="dashed">

  <!-- Footer -->
  <div class="footer">
    <div class="thankyou">Thank You!</div>
    <div>Order placed via Voice AI &#127897;</div>
    <div>Please retain this receipt</div>
  </div>
  `
}

function getLegacyReceiptStyles(): string {
  return `
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 13px;
      background: #fff;
      color: #000;
      width: 80mm;
      margin: 0 auto;
      padding: 6mm 4mm;
    }
    .center { text-align: center; }
    .right  { text-align: right; }
    .bold   { font-weight: bold; }

    /* ── Header ── */
    .restaurant-name {
      font-size: 20px;
      font-weight: bold;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 2px;
    }
    .tagline {
      font-size: 10px;
      text-align: center;
      color: #555;
      margin-bottom: 6px;
    }

    /* ── Dividers ── */
    .dashed {
      border: none;
      border-top: 1px dashed #000;
      margin: 5px 0;
    }
    .solid {
      border: none;
      border-top: 2px solid #000;
      margin: 5px 0;
    }

    /* ── Order meta ── */
    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin: 2px 0;
      gap: 8px;
    }
    .meta-row span:last-child {
      text-align: right;
      word-break: break-word;
    }
    .order-number {
      font-size: 18px;
      font-weight: bold;
      text-align: center;
      margin: 5px 0 2px 0;
      letter-spacing: 2px;
    }
    .status-badge {
      display: inline-block;
      font-size: 10px;
      font-weight: bold;
      padding: 1px 8px;
      border: 1px solid #000;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .status-row {
      text-align: center;
      margin-bottom: 4px;
    }

    /* ── Items table ── */
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 4px 0;
    }
    thead tr th {
      font-size: 11px;
      font-weight: bold;
      text-transform: uppercase;
      padding: 2px 0;
      border-bottom: 1px dashed #000;
    }
    th.desc, td.desc { text-align: left; width: 60%; }
    th.qty,  td.qty  { text-align: center; width: 15%; }
    th.price,td.price{ text-align: right; width: 25%; }
    tbody tr td {
      font-size: 12px;
      padding: 3px 0;
      vertical-align: top;
    }

    /* ── Total ── */
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 16px;
      font-weight: bold;
      padding: 4px 0 2px 0;
    }

    /* ── Footer ── */
    .footer {
      text-align: center;
      font-size: 10px;
      color: #444;
      margin-top: 8px;
      line-height: 1.6;
    }
    .footer .thankyou {
      font-size: 13px;
      font-weight: bold;
      margin-bottom: 2px;
    }

    /* ── Print media: hide everything except body ── */
    @media print {
      html, body {
        width: 80mm;
        margin: 0;
        padding: 4mm 2mm;
      }
    }
  `
}

function generateLegacyReceiptHTML(order: ReceiptOrder, restaurantName: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt #${escapeReceiptHtml(String(order.short_code || order.id || ""))}</title>
  <style>
    ${getReceiptStyles()}
  </style>
</head>
<body>
${getReceiptBodyMarkup(order, restaurantName)}
</body>
</html>`
}

function generateLegacyCombinedReceiptHTML(orders: ReceiptOrder[], restaurantName: string): string {
  const receipts = orders
    .map((order, index) => {
      const pageBreak = index < orders.length - 1 ? 'page-break-after: always;' : ""
      return `<div style="${pageBreak}">${getReceiptBodyMarkup(order, restaurantName)}</div>`
    })
    .join("")

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipts</title>
  <style>
    ${getReceiptStyles()}
  </style>
</head>
<body>
${receipts}
</body>
</html>`
}

function getReceiptBodyMarkup(order: ReceiptOrder, restaurantName: string): string {
  const itemRows = (order.items || order.order_items || [])
    .map((item) => `
      <tr>
        <td class="desc">${escapeReceiptHtml(String(item.name || item.item_name || "")).toUpperCase()}</td>
        <td class="qty">${escapeReceiptHtml(String(item.quantity || item.qty || 1))}</td>
        <td class="price">${HTML_CURRENCY_ENTITY}${getReceiptNumericString(item.price || item.unit_price || 0)}</td>
      </tr>
    `)
    .join("")

  const total = getReceiptNumericString(order.total_amount || order.total || 0)
  const orderCode = escapeReceiptHtml(String(order.short_code || order.id || ""))
  const customerName = escapeReceiptHtml(String(order.customer_name || order.contact_name || "Guest"))
  const phone = escapeReceiptHtml(String(order.customer_phone || order.contact_phone || ""))
  const fulfillmentType = escapeReceiptHtml(getFulfillmentTypeLabel(order.fulfillment_type))
  const paymentCollection = escapeReceiptHtml(
    getOrderPaymentDisplayLabel({
      fulfillmentType: order.fulfillment_type,
      paymentCollection: order.payment_collection,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
    }),
  )
  const deliveryPostcode = escapeReceiptHtml(normalizeUkPostcode(order.delivery_postcode || ""))
  const deliveryAddress = escapeReceiptHtml(String(order.delivery_address || "").trim())
  const cardTransactionId = escapeReceiptHtml(String(order.card_transaction_id || "").trim())
  const notes = escapeReceiptHtml(String(order.notes || order.special_instructions || ""))
  const dateStr = formatReceiptDate(order.created_at)

  return `
  <div class="restaurant-name">${escapeReceiptHtml(restaurantName || "Restaurant")}</div>
  <div class="tagline">Voice Ordering System</div>
  <div class="divider bold-div">================================</div>

  <div class="order-number">ORDER #${orderCode}</div>
  <div class="status-row">
    <span class="status-badge">${escapeReceiptHtml(String(order.status || "PENDING")).toUpperCase()}</span>
  </div>
  <div class="divider">--------------------------------</div>

  <div class="meta-row">
    <span>Date:</span>
    <span>${escapeReceiptHtml(dateStr)}</span>
  </div>
  <div class="meta-row">
    <span>Customer:</span>
    <span class="bold">${customerName}</span>
  </div>
  <div class="meta-row">
    <span>Order Type:</span>
    <span>${fulfillmentType}</span>
  </div>
  <div class="meta-row">
    <span>Payment:</span>
    <span>${paymentCollection}</span>
  </div>
  ${phone ? `<div class="meta-row"><span>Phone:</span><span>${phone}</span></div>` : ""}
  ${deliveryPostcode ? `<div class="meta-row"><span>Postcode:</span><span>${deliveryPostcode}</span></div>` : ""}
  ${deliveryAddress ? `<div class="meta-row"><span>Address:</span><span>${deliveryAddress}</span></div>` : ""}
  ${cardTransactionId ? `<div class="meta-row"><span>Card Ref:</span><span>${cardTransactionId}</span></div>` : ""}
  ${notes ? `<div class="meta-row"><span>Notes:</span><span>${notes}</span></div>` : ""}
  <div class="divider">--------------------------------</div>

  <table>
    <thead>
      <tr>
        <th class="desc">Item</th>
        <th class="qty">Qty</th>
        <th class="price">Price</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>
  <div class="divider bold-div">================================</div>

  <div class="total-row">
    <span>TOTAL</span>
    <span>${HTML_CURRENCY_ENTITY}${total}</span>
  </div>
  <div class="divider">--------------------------------</div>

  <div class="footer">
    <div class="thankyou">Thank You!</div>
    <div>Order placed via Voice AI &#127897;</div>
    <div>Please retain this receipt</div>
  </div>
  `
}

function getReceiptStyles(paperWidth: "58mm" | "80mm" = "80mm"): string {
  return `
    @page {
      size: ${paperWidth} auto;
      margin: 0mm;
    }

    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      width: ${paperWidth};
      margin: 0 !important;
      padding: 0 !important;
      background: #fff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      line-height: 1.4;
      color: #000;
      width: ${paperWidth};
      padding: 4mm 3mm !important;
    }

    .center { text-align: center; }
    .right  { text-align: right; }
    .bold   { font-weight: bold; }

    .restaurant-name {
      font-size: 20px;
      font-weight: bold;
      text-align: center;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 2px;
    }

    .tagline {
      font-size: 10px;
      text-align: center;
      color: #555;
      margin-bottom: 6px;
    }

    .divider {
      margin: 5px 0;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      letter-spacing: 0.2px;
    }

    .bold-div {
      font-weight: bold;
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin: 2px 0;
      gap: 8px;
    }

    .meta-row span:last-child {
      text-align: right;
      word-break: break-word;
    }

    .order-number {
      font-size: 18px;
      font-weight: bold;
      text-align: center;
      margin: 5px 0 2px 0;
      letter-spacing: 2px;
    }

    .status-badge {
      display: inline-block;
      border: 1.5px solid #000;
      background: transparent;
      color: #000;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: bold;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    .status-row {
      text-align: center;
      margin-bottom: 4px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      margin: 4px 0;
    }

    th, td {
      font-size: 11px;
      padding: 2px 0;
      vertical-align: top;
    }

    thead tr th {
      font-weight: bold;
      text-transform: uppercase;
      border-bottom: 1px dashed #000;
    }

    .desc { width: 55%; text-align: left; }
    .qty  { width: 10%; text-align: center; }
    .price{ width: 35%; text-align: right; }

    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 16px;
      font-weight: bold;
      padding: 4px 0 2px 0;
    }

    .footer {
      text-align: center;
      font-size: 10px;
      color: #444;
      margin-top: 8px;
      line-height: 1.6;
    }

    .footer .thankyou {
      font-size: 13px;
      font-weight: bold;
      margin-bottom: 2px;
    }

    @media print {
      html, body {
        width: ${paperWidth};
        margin: 0 !important;
        padding: 0 !important;
      }

      body {
        width: ${paperWidth};
        padding: 4mm 3mm !important;
      }
    }
  `
}

function generateReceiptHTML(
  order: ReceiptOrder,
  restaurantName: string,
  paperWidth: "58mm" | "80mm" = "80mm",
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipt #${escapeReceiptHtml(String(order.short_code || order.id || ""))}</title>
  <style>
    ${getReceiptStyles(paperWidth)}
  </style>
</head>
<body>
${getReceiptBodyMarkup(order, restaurantName)}
</body>
</html>`
}

function generateCombinedReceiptHTML(
  orders: ReceiptOrder[],
  restaurantName: string,
  paperWidth: "58mm" | "80mm" = "80mm",
): string {
  const receipts = orders
    .map((order, index) => {
      const pageBreak = index < orders.length - 1 ? 'page-break-after: always;' : ""
      return `<div style="${pageBreak}">${getReceiptBodyMarkup(order, restaurantName)}</div>`
    })
    .join("")

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Receipts</title>
  <style>
    ${getReceiptStyles(paperWidth)}
  </style>
</head>
<body>
${receipts}
</body>
</html>`
}

function printHtmlInHiddenIframe(html: string) {
  if (typeof document === "undefined") {
    throw new Error("Document is unavailable for web printing.")
  }

  const iframe = document.createElement("iframe")
  iframe.style.position = "fixed"
  iframe.style.right = "0"
  iframe.style.bottom = "0"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "none"
  document.body.appendChild(iframe)

  let didPrint = false
  let didCleanup = false

  const cleanup = () => {
    if (didCleanup) {
      return
    }
    didCleanup = true
    if (iframe.parentNode) {
      iframe.parentNode.removeChild(iframe)
    }
  }

  const printFrame = () => {
    if (didPrint) {
      return
    }

    const frameWindow = iframe.contentWindow
    if (!frameWindow) {
      cleanup()
      throw new Error("Print frame is unavailable.")
    }

    didPrint = true
    frameWindow.focus()
    frameWindow.print()
    window.setTimeout(cleanup, 1000)
  }

  iframe.onload = () => {
    window.setTimeout(() => {
      try {
        printFrame()
      } catch (error) {
        cleanup()
        console.error("Iframe print error:", error)
      }
    }, 300)
  }

  const frameDocument = iframe.contentWindow?.document
  if (!frameDocument) {
    cleanup()
    throw new Error("Unable to access print frame document.")
  }

  frameDocument.open()
  frameDocument.write(html)
  frameDocument.close()

  window.setTimeout(() => {
    try {
      printFrame()
    } catch {
      cleanup()
    }
  }, 500)
}

function getOrderDraftKey(order: UiOrderDraft, index: number): string {
  return order.id || `draft-${index}`
}

function hasCallReviewContent(callReview: RestaurantOrderRecord["callReview"]) {
  return Boolean(callReview?.localRecordingUri?.trim() || callReview?.recordingUrl?.trim() || callReview?.transcriptText?.trim())
}

function getCallReviewPlaybackUri(callReview: RestaurantOrderRecord["callReview"]) {
  return callReview?.localRecordingUri?.trim() || callReview?.recordingUrl?.trim() || ""
}

function getCallReviewCacheKey(callReview: RestaurantOrderRecord["callReview"]) {
  return callReview?.recordingStoragePath?.trim() || callReview?.recordingUrl?.trim() || ""
}

function setCallReviewLocalRecordingUri(
  callReview: RestaurantOrderRecord["callReview"],
  localRecordingUri: string,
): RestaurantOrderRecord["callReview"] {
  if (!callReview) {
    return callReview
  }

  return {
    ...callReview,
    localRecordingUri,
  } as RestaurantOrderRecord["callReview"]
}

function formatSyncTimestamp(value: string | null | undefined) {
  if (!value) {
    return ""
  }

  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return ""
  }

  return parsedDate.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
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

function renderCompactOrderLines(items: RestaurantOrderRecord["items"], params?: { emptyLabel?: string; currencyCode?: string }) {
  const emptyLabel = params?.emptyLabel || "No items yet."
  const currencyCode = params?.currencyCode || DEFAULT_CURRENCY_CODE

  if (items.length === 0) {
    return <Text style={styles.orderItemsEmptyText}>{emptyLabel}</Text>
  }

  return (
    <View style={styles.orderItemsList}>
      {items.map((item, index) => {
        const quantity = Math.max(1, Number(item.quantity || 1))
        const unitPrice = Number(item.unitPrice || 0)
        const normalizedUnitPrice = Number.isFinite(unitPrice) ? unitPrice : 0
        const lineTotal = normalizedUnitPrice * quantity

        return (
          <View key={`order-item-${item.id || item.name}-${index}`} style={styles.orderItemRow}>
            <Text style={styles.orderItemName} numberOfLines={1}>
              {item.name} × {quantity}
            </Text>
            <Text style={styles.orderItemPrice}>{formatCurrencyDisplay(lineTotal, currencyCode)}</Text>
          </View>
        )
      })}
    </View>
  )
}

function isSameLocalCalendarDay(value: string | null | undefined, referenceDate: Date) {
  if (!value) {
    return false
  }

  const parsedDate = new Date(value)
  if (Number.isNaN(parsedDate.getTime())) {
    return false
  }

  return (
    parsedDate.getFullYear() === referenceDate.getFullYear() &&
    parsedDate.getMonth() === referenceDate.getMonth() &&
    parsedDate.getDate() === referenceDate.getDate()
  )
}

export default function App() {
  const isWeb = Platform.OS === "web"
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions()
  const keyboardAvoidingBehavior: "height" | "padding" | undefined = Platform.select({
    ios: "padding",
    android: "height",
    default: undefined,
  })
  const isTablet = viewportWidth >= 768
  const isLandscape = viewportWidth > viewportHeight
  const showPosSidebar = isTablet && isLandscape
  const usePosGridLayout = isTablet && isLandscape
  const isTabletLandscape = isTablet && isLandscape
  const isWideTabletLandscape = isTabletLandscape && viewportWidth >= 1280
  const isCompactViewport = viewportWidth < 640
  const useStackedOrderFields = viewportWidth < 420
  const baseScrollBottomInset = (Platform.OS === "ios" ? 32 : 16) + SAFE_AREA.bottom
  const posPhoneScrollBottomInset = (Platform.OS === "ios" ? 132 : 120) + SAFE_AREA.bottom
  const posFabBottomInset = (Platform.OS === "ios" ? 36 : 28) + SAFE_AREA.bottom
  const authBaseBottomInset = (Platform.OS === "ios" ? 44 : 56) + SAFE_AREA.bottom
  const adminBaseBottomInset = (Platform.OS === "ios" ? 72 : 56) + SAFE_AREA.bottom
  const webSafeStyle =
    Platform.OS === "web" ? (({ minHeight: "100dvh", width: "100%" } as unknown) as ViewStyle) : null

  const [booting, setBooting] = useState(true)
  const [busy, setBusy] = useState(false)
  const [appNotice, setAppNotice] = useState<AppNotice | null>(null)
  const [orderFlowNotice, setOrderFlowNotice] = useState<AppNotice | null>(null)
  const [authMode, setAuthMode] = useState<AuthMode>("login")
  const [authCompletionState, setAuthCompletionState] = useState<{
    title: string
    message: string
    buttonLabel: string
  } | null>(null)
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [authKeyboardInset, setAuthKeyboardInset] = useState(0)
  const [isPasswordHidden, setIsPasswordHidden] = useState(true)
  const [focusedField, setFocusedField] = useState<"email" | "password" | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const authScrollRef = useRef<ScrollView | null>(null)
  const authEmailInputRef = useRef<TextInput | null>(null)
  const authPasswordInputRef = useRef<TextInput | null>(null)
  const authRedirectInFlightRef = useRef(false)
  const handledAuthRedirectUrlsRef = useRef<Set<string>>(new Set())
  const isRegisterMode = authMode === "register"
  const isResetMode = authMode === "reset"
  const authContentMinHeight = isLandscape ? Math.max(560, viewportHeight * 0.96) : viewportHeight * 0.85
  const passwordRules = [
    { label: `At least ${SIGNUP_PASSWORD_MIN_LENGTH} characters`, met: password.length >= SIGNUP_PASSWORD_MIN_LENGTH },
    { label: "One uppercase letter", met: hasUppercaseCharacter(password) },
    { label: "One special character", met: hasSpecialCharacter(password) },
    { label: `Use ${SIGNUP_PASSWORD_RECOMMENDED_LENGTH}+ characters for stronger security`, met: password.length >= SIGNUP_PASSWORD_RECOMMENDED_LENGTH },
  ]

  const [restaurants, setRestaurants] = useState<RestaurantRecord[]>([])
  const [selectedRestaurantId, setSelectedRestaurantId] = useState<string | null>(null)
  const selectedRestaurant = useMemo(
    () => restaurants.find((restaurant) => restaurant.id === selectedRestaurantId) || null,
    [restaurants, selectedRestaurantId],
  )

  const [restaurantName, setRestaurantName] = useState("")
  const [restaurantPhone, setRestaurantPhone] = useState("")
  const [restaurantAddress, setRestaurantAddress] = useState("")
  const [restaurantPaymentPin, setRestaurantPaymentPin] = useState("")
  const [restaurantPaymentPinConfirm, setRestaurantPaymentPinConfirm] = useState("")
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null)
  const selectedCurrencyCode = billingConfig?.currencyCode || selectedRestaurant?.currencyCode || DEFAULT_CURRENCY_CODE

  const [imageUri, setImageUri] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState("")
  const [imageMimeType, setImageMimeType] = useState("image/jpeg")
  const [rawMenuText, setRawMenuText] = useState("")
  const [scanId, setScanId] = useState<string | null>(null)
  const [draftItems, setDraftItems] = useState<UiDraftItem[]>([])
  const [parseInsertMode, setParseInsertMode] = useState<ParseInsertMode>("replace")
  const [savedItems, setSavedItems] = useState<MenuItemDraft[]>([])
  const [editableMenuItems, setEditableMenuItems] = useState<UiDraftItem[]>([])
  const [menuLoading, setMenuLoading] = useState(false)
  const [orders, setOrders] = useState<RestaurantOrderRecord[]>([])
  const [orderDrafts, setOrderDrafts] = useState<UiOrderDraft[]>([])
  const [isOfflineMode, setIsOfflineMode] = useState(false)
  const [isSyncingRestaurantData, setIsSyncingRestaurantData] = useState(false)
  const [restaurantDataLastSyncedAt, setRestaurantDataLastSyncedAt] = useState<string | null>(null)
  const [printPreferences, setPrintPreferences] = useState<PrintPreferencesState>(DEFAULT_PRINT_PREFERENCES)
  const [availablePrinterOptions, setAvailablePrinterOptions] = useState<PrinterOption[]>(() => getDefaultPrinterOptions())
  const [isPrintCenterVisible, setIsPrintCenterVisible] = useState(false)
  const [isPrinterDropdownOpen, setIsPrinterDropdownOpen] = useState(false)
  const [statusFilter, setStatusFilter] = useState<OrderStatusFilter>("pending")
  const [previewOrder, setPreviewOrder] = useState<UiOrderDraft | null>(null)
  const previewLongPressKeyRef = useRef<string | null>(null)
  const [activeOrderEditor, setActiveOrderEditor] = useState<ActiveOrderEditorState | null>(null)
  const [activeOrderItemPicker, setActiveOrderItemPicker] = useState<ActiveOrderItemPickerState | null>(null)
  const [activeItemCustomization, setActiveItemCustomization] = useState<ActiveItemCustomizationState | null>(null)
  const [orderItemPickerSearch, setOrderItemPickerSearch] = useState("")
  const [activeCallReview, setActiveCallReview] = useState<{
    title: string
    callReview: RestaurantOrderRecord["callReview"]
  } | null>(null)
  const [activePaymentUpdate, setActivePaymentUpdate] = useState<ActivePaymentUpdateState | null>(null)
  const activeCallReviewPlaybackUri = getCallReviewPlaybackUri(activeCallReview?.callReview || null)
  const callReviewPlayer = useAudioPlayer(activeCallReviewPlaybackUri || undefined, { updateInterval: 250 })
  const callReviewPlayerStatus = useAudioPlayerStatus(callReviewPlayer)
  const newOrderChimePlayer = useAudioPlayer(require("../../assets/audio/order-chime.wav"), { updateInterval: 250 })
  const newOrderChimeStatus = useAudioPlayerStatus(newOrderChimePlayer)
  const knownOrderIdsRef = useRef<Set<string>>(new Set())
  const orderRefreshInFlightRef = useRef(false)
  const queuedNewOrderAlertCountsRef = useRef<number[]>([])
  const activeNewOrderAlertCountRef = useRef(0)
  const newOrderAlertInFlightRef = useRef(false)
  const newOrderSpeechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [elevenLabsApiKey, setElevenLabsApiKey] = useState("")
  const [savedElevenLabsApiKey, setSavedElevenLabsApiKey] = useState("")
  const [isEditingElevenLabsApiKey, setIsEditingElevenLabsApiKey] = useState(false)
  const [manualAgentId, setManualAgentId] = useState("")
  const [voiceAgentLink, setVoiceAgentLink] = useState<VoiceAgentLinkRecord | null>(null)
  const orderRefreshPaused =
    busy || Boolean(activeOrderEditor) || Boolean(activeOrderItemPicker) || Boolean(activeItemCustomization) || Boolean(activePaymentUpdate)
  const orderRealtimeStatus = useRestaurantRealtime({
    restaurantId: selectedRestaurant?.id || null,
    enabled: Boolean(user?.id && selectedRestaurant?.id && !orderRefreshPaused),
    onRestaurantChange: () => {
      if (!selectedRestaurant?.id || orderRefreshInFlightRef.current) {
        return
      }

      void refreshOrders(selectedRestaurant.id, { suppressNewOrderExperience: false, showRefreshErrors: false })
    },
  })

  function clearQueuedNewOrderSpeechTimeout() {
    if (!newOrderSpeechTimeoutRef.current) {
      return
    }

    clearTimeout(newOrderSpeechTimeoutRef.current)
    newOrderSpeechTimeoutRef.current = null
  }

  function finishQueuedNewOrderAlert() {
    clearQueuedNewOrderSpeechTimeout()
    activeNewOrderAlertCountRef.current = 0
    newOrderAlertInFlightRef.current = false

    const webSpeechRuntime = getWebSpeechRuntime()
    if (webSpeechRuntime) {
      try {
        webSpeechRuntime.synthesis.cancel()
      } catch {}
    }

    if (queuedNewOrderAlertCountsRef.current.length === 0) {
      return
    }

    const nextCount = queuedNewOrderAlertCountsRef.current.shift() || 0
    if (!nextCount) {
      finishQueuedNewOrderAlert()
      return
    }

    activeNewOrderAlertCountRef.current = nextCount
    newOrderAlertInFlightRef.current = true

    try {
      newOrderChimePlayer.pause()
      newOrderChimePlayer.seekTo(0)
    } catch {}

    try {
      newOrderChimePlayer.play()
    } catch {
      finishQueuedNewOrderAlert()
    }
  }

  function speakQueuedNewOrderAlert(count: number) {
    const announcementText = count > 1 ? `${count} new orders` : "New order"
    const webSpeechRuntime = getWebSpeechRuntime()

    if (!webSpeechRuntime) {
      finishQueuedNewOrderAlert()
      return
    }

    try {
      webSpeechRuntime.synthesis.cancel()
      const utterance = new webSpeechRuntime.UtteranceCtor(announcementText)
      utterance.rate = 0.92
      utterance.pitch = 1
      utterance.volume = 1
      utterance.onend = () => finishQueuedNewOrderAlert()
      utterance.onerror = () => finishQueuedNewOrderAlert()
      clearQueuedNewOrderSpeechTimeout()
      newOrderSpeechTimeoutRef.current = setTimeout(() => finishQueuedNewOrderAlert(), 3500)
      webSpeechRuntime.synthesis.speak(utterance)
    } catch {
      finishQueuedNewOrderAlert()
    }
  }

  function queueNewOrderAlert(count: number) {
    if (count <= 0) {
      return
    }

    queuedNewOrderAlertCountsRef.current.push(count)
    if (!newOrderAlertInFlightRef.current) {
      finishQueuedNewOrderAlert()
    }
  }

  async function hydrateOrdersWithCachedAudio(nextOrders: RestaurantOrderRecord[]) {
    return await Promise.all(
      nextOrders.map(async (order) => {
        const recordingUrl = order.callReview?.recordingUrl?.trim() || ""
        const recordingCacheKey = getCallReviewCacheKey(order.callReview)
        if (!recordingUrl || !recordingCacheKey) {
          return order
        }

        const localRecordingUri = await getCachedRecordingUri(recordingCacheKey)
        if (!localRecordingUri) {
          return order
        }

        return {
          ...order,
          callReview: setCallReviewLocalRecordingUri(order.callReview, localRecordingUri),
        }
      }),
    )
  }

  function applyLocalRecordingUri(recordingCacheKey: string, localRecordingUri: string) {
    const normalizedKey = recordingCacheKey.trim()
    const normalizedLocalUri = localRecordingUri.trim()
    if (!normalizedKey || !normalizedLocalUri) {
      return
    }

    setOrders((current) =>
      current.map((order) =>
        getCallReviewCacheKey(order.callReview) === normalizedKey
          ? {
              ...order,
              callReview: setCallReviewLocalRecordingUri(order.callReview, normalizedLocalUri),
            }
          : order,
      ),
    )
    setOrderDrafts((current) =>
      current.map((order) =>
        getCallReviewCacheKey(order.callReview) === normalizedKey
          ? {
              ...order,
              callReview: setCallReviewLocalRecordingUri(order.callReview, normalizedLocalUri),
            }
          : order,
      ),
    )
    setActiveCallReview((current) =>
      current && getCallReviewCacheKey(current.callReview) === normalizedKey
        ? {
            ...current,
            callReview: setCallReviewLocalRecordingUri(current.callReview, normalizedLocalUri),
          }
        : current,
    )
  }

  async function ensureLocalCallRecording(callReview: RestaurantOrderRecord["callReview"]) {
    const normalizedUrl = callReview?.recordingUrl?.trim() || ""
    const recordingCacheKey = getCallReviewCacheKey(callReview)
    if (!normalizedUrl || !recordingCacheKey) {
      return null
    }

    const localRecordingUri = await cacheRecordingAudio(normalizedUrl, recordingCacheKey)
    if (localRecordingUri) {
      applyLocalRecordingUri(recordingCacheKey, localRecordingUri)
    }
    return localRecordingUri
  }

  async function prefetchRecentCallReviewAudio(nextOrders: RestaurantOrderRecord[]) {
    const recentCallReviews = nextOrders
      .map((order) => order.callReview || null)
      .filter((callReview, index, values) => {
        const cacheKey = getCallReviewCacheKey(callReview)
        return Boolean(callReview?.recordingUrl?.trim() && cacheKey) && values.findIndex((entry) => getCallReviewCacheKey(entry) === cacheKey) === index
      })
      .slice(0, 6)

    await Promise.allSettled(recentCallReviews.map((callReview) => ensureLocalCallRecording(callReview)))
  }

  function applyRestaurantSnapshot(
    snapshot: Pick<RestaurantOfflineSnapshot, "savedAt" | "menuItems" | "orders" | "voiceAgentLink" | "billingConfig">,
  ) {
    const uniqueItems = dedupeMenuItems(snapshot.menuItems)
    setSavedItems(uniqueItems)
    setEditableMenuItems(toUiMenuItems(uniqueItems))
    setOrders(snapshot.orders)
    setOrderDrafts(snapshot.orders.map(orderToUiDraft))
    setVoiceAgentLink(snapshot.voiceAgentLink)
    setManualAgentId(snapshot.voiceAgentLink?.workspace_agent_id || "")
    setBillingConfig(snapshot.billingConfig)
    setRestaurantDataLastSyncedAt(snapshot.savedAt)
    knownOrderIdsRef.current = new Set(
      snapshot.orders.map((order) => String(order.id || "").trim()).filter((orderId) => orderId.length > 0),
    )
  }

  async function persistRestaurantSnapshot(params: {
    restaurantId: string
    menuItems?: MenuItemDraft[]
    orders?: RestaurantOrderRecord[]
    voiceAgentLink?: VoiceAgentLinkRecord | null
    billingConfig?: BillingConfig | null
    savedAt?: string
  }) {
    const savedAt = params.savedAt || new Date().toISOString()
    await saveCachedRestaurantSnapshot({
      restaurantId: params.restaurantId,
      savedAt,
      menuItems: params.menuItems ?? savedItems,
      orders: params.orders ?? orders,
      voiceAgentLink: params.voiceAgentLink === undefined ? voiceAgentLink : params.voiceAgentLink,
      billingConfig: params.billingConfig === undefined ? billingConfig : params.billingConfig,
    })
    setRestaurantDataLastSyncedAt(savedAt)
  }

  async function syncSelectedRestaurantData(options?: { showSuccessNotice?: boolean }) {
    if (!selectedRestaurant) {
      return
    }

    setBusy(true)
    setIsSyncingRestaurantData(true)

    try {
      const [items, fetchedOrders, nextVoiceAgentLink, nextBillingConfig] = await Promise.all([
        listRestaurantMenuItems(selectedRestaurant.id),
        listRestaurantOrders(selectedRestaurant.id),
        getVoiceAgentLink(selectedRestaurant.id),
        getBillingConfig(selectedRestaurant.id),
      ])
      const hydratedOrders = await hydrateOrdersWithCachedAudio(fetchedOrders)
      const savedAt = new Date().toISOString()

      applyRestaurantSnapshot({
        savedAt,
        menuItems: items,
        orders: hydratedOrders,
        voiceAgentLink: nextVoiceAgentLink,
        billingConfig: nextBillingConfig,
      })
      setIsOfflineMode(false)
      await persistRestaurantSnapshot({
        restaurantId: selectedRestaurant.id,
        savedAt,
        menuItems: dedupeMenuItems(items),
        orders: hydratedOrders,
        voiceAgentLink: nextVoiceAgentLink,
        billingConfig: nextBillingConfig,
      })
      void prefetchRecentCallReviewAudio(hydratedOrders)

      if (options?.showSuccessNotice) {
        showNotification("Synced", "Latest changes are loaded for this restaurant.", "success")
      }
    } catch (error) {
      setIsOfflineMode(true)
      showNotification(
        "Sync Failed",
        error instanceof Error ? error.message : "Couldn't load the latest changes. Cached data stays available.",
        "warning",
      )
    } finally {
      setIsSyncingRestaurantData(false)
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!appNotice) {
      return
    }

    const timeoutId = setTimeout(() => {
      setAppNotice((current) => (current === appNotice ? null : current))
    }, NOTICE_TIMEOUT_MS)

    return () => clearTimeout(timeoutId)
  }, [appNotice])

  useEffect(() => {
    if (Platform.OS === "web") {
      return
    }

    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow"
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide"

    const handleKeyboardShow = (event: KeyboardEvent) => {
      setAuthKeyboardInset(Math.max(event.endCoordinates.height - SAFE_AREA.bottom, 0))
    }

    const handleKeyboardHide = () => {
      setAuthKeyboardInset(0)
    }

    const showSubscription = Keyboard.addListener(showEvent, handleKeyboardShow)
    const hideSubscription = Keyboard.addListener(hideEvent, handleKeyboardHide)

    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "duckOthers",
      shouldPlayInBackground: false,
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!callReviewPlayerStatus.didJustFinish) {
      return
    }

    try {
      callReviewPlayer.pause()
      callReviewPlayer.seekTo(0)
    } catch {}
  }, [callReviewPlayer, callReviewPlayerStatus.didJustFinish])

  useEffect(() => {
    if (!newOrderChimeStatus.didJustFinish || !newOrderAlertInFlightRef.current) {
      return
    }

    try {
      newOrderChimePlayer.pause()
      newOrderChimePlayer.seekTo(0)
    } catch {}

    speakQueuedNewOrderAlert(Math.max(1, activeNewOrderAlertCountRef.current || 1))
  }, [newOrderChimePlayer, newOrderChimeStatus.didJustFinish])

  useEffect(() => {
    return () => {
      clearQueuedNewOrderSpeechTimeout()
      const webSpeechRuntime = getWebSpeechRuntime()
      if (webSpeechRuntime) {
        try {
          webSpeechRuntime.synthesis.cancel()
        } catch {}
      }
    }
  }, [])

  useEffect(() => {
    if (!activeOrderItemPicker) {
      return
    }
    if (!orderDrafts[activeOrderItemPicker.index]) {
      setActiveOrderItemPicker(null)
      setOrderItemPickerSearch("")
    }
  }, [activeOrderItemPicker, orderDrafts])

  useEffect(() => {
    if (!activeItemCustomization) {
      return
    }
    if (!orderDrafts[activeItemCustomization.orderIndex]) {
      setActiveItemCustomization(null)
    }
  }, [activeItemCustomization, orderDrafts])

  useEffect(() => {
    if (!activeOrderEditor) {
      return
    }
    if (!orderDrafts[activeOrderEditor.index]) {
      setActiveOrderEditor(null)
    }
  }, [activeOrderEditor, orderDrafts])

  useEffect(() => {
    if (!activePaymentUpdate) {
      return
    }
    if (!orderDrafts[activePaymentUpdate.index]) {
      setActivePaymentUpdate(null)
    }
  }, [activePaymentUpdate, orderDrafts])

  const [activeTab, setActiveTab] = useState<MainTab>(() => (getInitialAppMode() === "pos" ? "orders" : "overview"))
  const [appMode, setAppMode] = useState<AppMode>(getInitialAppMode)
  const [settingsReturnTab, setSettingsReturnTab] = useState<MainTab | null>(null)

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        await initDatabase()
        const initialUrl = await Linking.getInitialURL()
        if (mounted && initialUrl) {
          try {
            await handleAuthRedirectUrl(initialUrl)
          } catch (error) {
            showNotification(
              "Verification Failed",
              makeFriendlyMessage(error instanceof Error ? error.message : "Could not verify that link.", "error"),
              "error",
            )
          }
        }
        const session = await getSession()
        if (mounted && session?.user) {
          setAppMode("pos")
          setActiveTab("orders")
          setSettingsReturnTab(null)
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
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void (async () => {
        try {
          await handleAuthRedirectUrl(url)
        } catch (error) {
          showNotification(
            "Verification Failed",
            makeFriendlyMessage(error instanceof Error ? error.message : "Could not verify that link.", "error"),
            "error",
          )
        }
      })()
    })

    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!user) {
      return
    }
    void refreshRestaurants(user.id).catch((error) => {
      showNotification("Load Failed", error instanceof Error ? error.message : "Failed to load restaurants.", "error")
    })
  }, [user])

  useEffect(() => {
    if (appMode === "pos" && activeTab !== "orders" && activeTab !== "summary") {
      setActiveTab("orders")
    }
  }, [appMode, activeTab])

  useEffect(() => {
    if (appMode === "admin") {
      return
    }

    setIsPrintCenterVisible(false)
    setIsPrinterDropdownOpen(false)
  }, [appMode])

  useEffect(() => {
    if (printPreferences.selectedPrinterId.trim() || !printPreferences.autoPrintEnabled) {
      return
    }

    setPrintPreferences((current) => ({ ...current, autoPrintEnabled: false }))
  }, [printPreferences.autoPrintEnabled, printPreferences.selectedPrinterId])

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
      setIsOfflineMode(false)
      setRestaurantDataLastSyncedAt(null)
      setBillingConfig(null)
      setImageUri(null)
      setImageBase64("")
      setRawMenuText("")
      setScanId(null)
      setDraftItems([])
      setSavedItems([])
      setEditableMenuItems([])
      setMenuLoading(false)
      setOrders([])
      setOrderDrafts([])
      setPreviewOrder(null)
      previewLongPressKeyRef.current = null
      setActiveOrderEditor(null)
      setActiveOrderItemPicker(null)
      setActiveItemCustomization(null)
      setOrderItemPickerSearch("")
      setActiveCallReview(null)
      setVoiceAgentLink(null)
      setElevenLabsApiKey("")
      setSavedElevenLabsApiKey("")
      setIsEditingElevenLabsApiKey(false)
      setManualAgentId("")
      setRestaurantPaymentPin("")
      setRestaurantPaymentPinConfirm("")
      setPrintPreferences(DEFAULT_PRINT_PREFERENCES)
      setAvailablePrinterOptions(getDefaultPrinterOptions())
      setIsPrintCenterVisible(false)
      setIsPrinterDropdownOpen(false)
      knownOrderIdsRef.current = new Set()
      return
    }
    let cancelled = false
    setRestaurantName(selectedRestaurant.name)
    setRestaurantPhone(selectedRestaurant.phone || "")
    setRestaurantAddress(selectedRestaurant.address || "")
    setRestaurantPaymentPin("")
    setRestaurantPaymentPinConfirm("")
    setIsOfflineMode(false)
    setRestaurantDataLastSyncedAt(null)
    setBillingConfig(null)
    setImageUri(null)
    setImageBase64("")
    setRawMenuText("")
    setScanId(null)
    setDraftItems([])
    setSavedItems([])
    setEditableMenuItems([])
    setMenuLoading(true)
    setOrders([])
    setOrderDrafts([])
    setPreviewOrder(null)
    setPrintPreferences(DEFAULT_PRINT_PREFERENCES)
    setAvailablePrinterOptions(getDefaultPrinterOptions())
    setIsPrinterDropdownOpen(false)
    knownOrderIdsRef.current = new Set()
    setActiveOrderEditor(null)
    setActiveOrderItemPicker(null)
    setActiveItemCustomization(null)
    setOrderItemPickerSearch("")
    setActiveCallReview(null)
    setVoiceAgentLink(null)
    setElevenLabsApiKey("")
    setSavedElevenLabsApiKey("")
    setIsEditingElevenLabsApiKey(false)
    setManualAgentId("")
    ;(async () => {
      try {
        const [storedApiKey, storedPrintPreferences, cachedSnapshot] = await Promise.all([
          loadStoredElevenLabsApiKey(selectedRestaurant.id),
          loadStoredPrintPreferences(selectedRestaurant.id),
          loadCachedRestaurantSnapshot(selectedRestaurant.id),
        ])

        if (cancelled) {
          return
        }

        setSavedElevenLabsApiKey(storedApiKey)
        setElevenLabsApiKey(storedApiKey)
        setPrintPreferences(storedPrintPreferences)
        setAvailablePrinterOptions(mergePrinterOptions(getDefaultPrinterOptions(), getStoredPrinterOption(storedPrintPreferences)))

        if (cachedSnapshot) {
          const hydratedCachedOrders = await hydrateOrdersWithCachedAudio(cachedSnapshot.orders)
          if (cancelled) {
            return
          }

          applyRestaurantSnapshot({
            savedAt: cachedSnapshot.savedAt,
            menuItems: cachedSnapshot.menuItems,
            orders: hydratedCachedOrders,
            voiceAgentLink: cachedSnapshot.voiceAgentLink,
            billingConfig: cachedSnapshot.billingConfig,
          })
          setIsEditingElevenLabsApiKey(Boolean(cachedSnapshot.voiceAgentLink) && !storedApiKey)
        }

        try {
          const [items, fetchedOrders, voiceLink, loadedBillingConfig] = await Promise.all([
            listRestaurantMenuItems(selectedRestaurant.id),
            listRestaurantOrders(selectedRestaurant.id),
            getVoiceAgentLink(selectedRestaurant.id),
            getBillingConfig(selectedRestaurant.id),
          ])
          const hydratedOrders = await hydrateOrdersWithCachedAudio(fetchedOrders)
          if (cancelled) {
            return
          }

          const savedAt = new Date().toISOString()
          applyRestaurantSnapshot({
            savedAt,
            menuItems: items,
            orders: hydratedOrders,
            voiceAgentLink: voiceLink,
            billingConfig: loadedBillingConfig,
          })
          setIsEditingElevenLabsApiKey(Boolean(voiceLink) && !storedApiKey)
          setIsOfflineMode(false)
          await persistRestaurantSnapshot({
            restaurantId: selectedRestaurant.id,
            savedAt,
            menuItems: dedupeMenuItems(items),
            orders: hydratedOrders,
            voiceAgentLink: voiceLink,
            billingConfig: loadedBillingConfig,
          })
          void prefetchRecentCallReviewAudio(hydratedOrders)
        } catch (error) {
          if (cancelled) {
            return
          }

          if (cachedSnapshot) {
            setIsOfflineMode(true)
            return
          }

          const message = error instanceof Error ? error.message : "Failed to load restaurant data."
          showNotification("Load Failed", message)
        }
      } catch (error) {
        if (cancelled) {
          return
        }
        const message = error instanceof Error ? error.message : "Failed to load restaurant data."
        showNotification("Load Failed", message)
      } finally {
        if (!cancelled) {
          setMenuLoading(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [selectedRestaurantId, selectedRestaurant])

  useEffect(() => {
    if (!selectedRestaurant || !billingConfig?.countryCode) {
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        const nextRates = await getCountryTaxRates(billingConfig.countryCode)
        if (cancelled) {
          return
        }

        setBillingConfig((current) => {
          if (!current || current.countryCode !== billingConfig.countryCode) {
            return current
          }

          const nextSelectedTaxRate =
            nextRates.find((rate) => rate.id === current.taxRateId) ||
            nextRates.find((rate) => rate.isDefault) ||
            nextRates[0] ||
            null

          return {
            ...current,
            availableTaxRates: nextRates,
            taxRateId: nextSelectedTaxRate?.id || null,
            taxLabel: current.taxLabel || nextSelectedTaxRate?.taxName || "VAT",
            resolvedTaxRatePercent:
              current.taxRateOverride !== null && current.taxRateOverride !== undefined
                ? current.taxRateOverride
                : nextSelectedTaxRate?.ratePercent || 0,
          }
        })
      } catch {}
    })()

    return () => {
      cancelled = true
    }
  }, [billingConfig?.countryCode, selectedRestaurant?.id])

  useEffect(() => {
    queuedNewOrderAlertCountsRef.current = []
    activeNewOrderAlertCountRef.current = 0
    newOrderAlertInFlightRef.current = false
    clearQueuedNewOrderSpeechTimeout()

    const webSpeechRuntime = getWebSpeechRuntime()
    if (webSpeechRuntime) {
      try {
        webSpeechRuntime.synthesis.cancel()
      } catch {}
    }

    try {
      newOrderChimePlayer.pause()
      newOrderChimePlayer.seekTo(0)
    } catch {}
  }, [newOrderChimePlayer, selectedRestaurantId])

  async function refreshRestaurants(ownerUserId: string) {
    try {
      const rows = await listRestaurants(ownerUserId)
      setRestaurants(rows)
      await saveCachedRestaurants(rows)
      if (rows.length > 0) {
        setSelectedRestaurantId((previousValue) => previousValue || rows[0].id)
      } else {
        setSelectedRestaurantId(null)
      }
    } catch (error) {
      const cachedRows = await loadCachedRestaurants()
      if (cachedRows.length > 0) {
        setRestaurants(cachedRows)
        setSelectedRestaurantId((previousValue) => previousValue || cachedRows[0].id)
        setIsOfflineMode(true)
        return
      }

      throw error
    }
  }

  async function refreshOrders(
    restaurantId: string,
    options?: { suppressNewOrderExperience?: boolean; showRefreshErrors?: boolean },
  ) {
    if (orderRefreshInFlightRef.current) {
      return
    }

    orderRefreshInFlightRef.current = true

    try {
      const [fetchedOrders, fetchedMenuItems] = await Promise.all([
        listRestaurantOrders(restaurantId),
        listRestaurantMenuItems(restaurantId),
      ])
      const hydratedOrders = await hydrateOrdersWithCachedAudio(fetchedOrders)
      const uniqueItems = dedupeMenuItems(fetchedMenuItems)
      const nextKnownOrderIds = new Set(
        hydratedOrders.map((order) => String(order.id || "").trim()).filter((orderId) => orderId.length > 0),
      )
      const newOrders = hydratedOrders.filter((order) => {
        const orderId = String(order.id || "").trim()
        return orderId.length > 0 && !knownOrderIdsRef.current.has(orderId)
      })

      knownOrderIdsRef.current = nextKnownOrderIds
      setSavedItems(uniqueItems)
      setOrders(hydratedOrders)
      setOrderDrafts(hydratedOrders.map(orderToUiDraft))
      setIsOfflineMode(false)
      setRestaurantDataLastSyncedAt(new Date().toISOString())
      await persistRestaurantSnapshot({
        restaurantId,
        menuItems: uniqueItems,
        orders: hydratedOrders,
      })
      void prefetchRecentCallReviewAudio(hydratedOrders)

      if (!options?.suppressNewOrderExperience && newOrders.length > 0) {
        void handleIncomingOrders(newOrders)
      }
    } catch (error) {
      setIsOfflineMode(true)
      if (options?.showRefreshErrors === false) {
        console.error("Background order refresh error:", error)
        return
      }
      throw error
    } finally {
      orderRefreshInFlightRef.current = false
    }
  }

  async function handleAuth() {
    Keyboard.dismiss()

    if (!email.trim()) {
      showNotification("Missing Info", "Please enter your email address.", "warning")
      return
    }

    if (!password) {
      showNotification("Missing Info", "Please enter your password.", "warning")
      return
    }

    if (isRegisterMode) {
      const passwordValidationMessage = validateSignupPassword(password)
      if (passwordValidationMessage) {
        showNotification("Weak Password", passwordValidationMessage, "warning")
        return
      }
    }

    setBusy(true)

    try {
      const sessionUser =
        isRegisterMode
          ? await registerWithEmail(email.trim(), password)
          : await loginWithEmail(email.trim(), password)
      await saveSession({ user: sessionUser })
      setAppMode("pos")
      setActiveTab("orders")
      setSettingsReturnTab(null)
      setUser(sessionUser)
      setPassword("")
      setFocusedField(null)
      setIsPasswordHidden(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to authenticate."
      if (isRegisterMode && message.includes("Confirmation email sent")) {
        const friendlyMessage = makeFriendlyMessage(message, "info")
        setAuthStage("login")
        showNotification("Signup Pending", friendlyMessage, "info")
      } else {
        showNotification("Authentication Failed", makeFriendlyMessage(message, "error"), "error")
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

  function showOrderFlowNotification(title: string, message: string, kind: NoticeKind = "info") {
    const friendlyMessage = makeFriendlyMessage(message, kind)
    const resolvedKind = resolveNoticeKind(title, friendlyMessage, kind)
    const friendlyTitle = makeFriendlyTitle(title, resolvedKind, friendlyMessage)
    setOrderFlowNotice({ title: friendlyTitle, message: friendlyMessage, kind: resolvedKind })
  }

  function renderNoticeBanner(notice: AppNotice | null) {
    if (!notice) return null
    const noticeStyle =
      notice.kind === "success"
        ? styles.noticeSuccess
        : notice.kind === "error"
          ? styles.noticeError
          : notice.kind === "warning"
            ? styles.noticeWarning
            : styles.noticeInfo

    return (
      <View style={[styles.notice, noticeStyle]}>
        <Text style={styles.noticeTitle}>{notice.title}</Text>
        <Text style={styles.noticeMessage}>{notice.message}</Text>
      </View>
    )
  }

  function renderNotice() {
    return renderNoticeBanner(appNotice)
  }

  function renderOrderFlowNotice() {
    return renderNoticeBanner(orderFlowNotice)
  }

  function scrollAuthInputIntoView(inputRef: RefObject<TextInput | null>) {
    if (Platform.OS === "web") {
      return
    }

    requestAnimationFrame(() => {
      const scrollResponder = authScrollRef.current?.getScrollResponder?.() as
        | {
            scrollResponderScrollNativeHandleToKeyboard?: (
              nodeHandle: number,
              additionalOffset: number,
              preventNegativeScrollOffset: boolean,
            ) => void
          }
        | undefined
      const nodeHandle = inputRef.current ? findNodeHandle(inputRef.current) : null

      if (scrollResponder?.scrollResponderScrollNativeHandleToKeyboard && typeof nodeHandle === "number") {
        scrollResponder.scrollResponderScrollNativeHandleToKeyboard(nodeHandle, 36, true)
        return
      }

      authScrollRef.current?.scrollToEnd({ animated: true })
    })
  }

  function setAuthStage(nextMode: AuthMode) {
    Keyboard.dismiss()
    setAuthCompletionState(null)
    setAuthMode(nextMode)
    setPassword("")
    setFocusedField(null)
    setIsPasswordHidden(true)
  }

  function renderBranding() {
    return (
      <View style={styles.authBrandingContainer}>
        <Text style={styles.authBrandingLabel}>RESTAURANT OPS</Text>
      </View>
    )
  }

  function renderTabToggle() {
    return (
      <View style={styles.authSegmentedControl}>
        {(["login", "register"] as const).map((mode) => {
          const isActive = mode === authMode
          const label = mode === "login" ? "Login" : "Register"

          return (
            <TouchableOpacity
              key={mode}
              style={[styles.authSegmentTab, isActive ? styles.authSegmentTabActive : null]}
              onPress={() => setAuthStage(mode)}
              activeOpacity={0.7}
              disabled={busy}
            >
              <Text style={[styles.authSegmentTabText, isActive ? styles.authSegmentTabTextActive : null]}>{label}</Text>
            </TouchableOpacity>
          )
        })}
      </View>
    )
  }

  function renderEmailField() {
    return (
      <View style={[styles.authInputWrapper, focusedField === "email" ? styles.authFieldFocused : null]}>
        <Text style={styles.authInputIcon}>✉</Text>
        <TextInput
          ref={authEmailInputRef}
          style={[styles.authInputField, styles.authInputFieldFlex]}
          placeholder="Email Address"
          placeholderTextColor={COLORS.TEXT_MUTED}
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType={isResetMode ? "send" : "next"}
          blurOnSubmit={isResetMode}
          onFocus={() => {
            setFocusedField("email")
            scrollAuthInputIntoView(authEmailInputRef)
          }}
          onBlur={() => setFocusedField((currentValue) => (currentValue === "email" ? null : currentValue))}
          onSubmitEditing={() => {
            if (isResetMode) {
              void handleResetPassword()
              return
            }

            authPasswordInputRef.current?.focus()
          }}
        />
      </View>
    )
  }

  function renderPasswordField() {
    return (
      <View style={[styles.authInputWrapper, focusedField === "password" ? styles.authFieldFocused : null]}>
        <Text style={styles.authInputIcon}>🔒</Text>
        <TextInput
          ref={authPasswordInputRef}
          style={[styles.authInputField, styles.authInputFieldFlex]}
          placeholder="Password"
          placeholderTextColor={COLORS.TEXT_MUTED}
          value={password}
          onChangeText={setPassword}
          secureTextEntry={isPasswordHidden}
          autoComplete={isRegisterMode ? "new-password" : "current-password"}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onFocus={() => {
            setFocusedField("password")
            scrollAuthInputIntoView(authPasswordInputRef)
          }}
          onBlur={() => setFocusedField((currentValue) => (currentValue === "password" ? null : currentValue))}
          onSubmitEditing={() => {
            void handleAuth()
          }}
        />
        <TouchableOpacity
          onPress={() => setIsPasswordHidden((currentValue) => !currentValue)}
          style={styles.authShowHideButton}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
          disabled={busy}
        >
          <Text style={styles.authShowHideText}>{isPasswordHidden ? "Show" : "Hide"}</Text>
        </TouchableOpacity>
      </View>
    )
  }

  function renderPasswordGuidelines() {
    if (!isRegisterMode) {
      return null
    }

    return (
      <View style={styles.authGuidelinesCard}>
        <Text style={styles.authGuidelinesTitle}>Password Guidelines</Text>
        {passwordRules.map((rule) => (
          <View key={rule.label} style={styles.authGuidelineRow}>
            <View style={[styles.authGuidelineCheck, rule.met ? styles.authGuidelineCheckMet : null]}>
              <AppIcon name="check" size={12} color={rule.met ? COLORS.SURFACE : COLORS.TEXT_MUTED} />
            </View>
            <Text style={styles.authGuidelineText}>{rule.label}</Text>
          </View>
        ))}
      </View>
    )
  }

  function renderSubmitButton() {
    const buttonLabel = isResetMode ? "Send Reset Link" : isRegisterMode ? "Create Account" : "Sign In"

    return (
      <TouchableOpacity
        style={[styles.authSubmitButton, busy ? styles.authSubmitButtonDisabled : null]}
        onPress={() => {
          if (isResetMode) {
            void handleResetPassword()
            return
          }

          void handleAuth()
        }}
        disabled={busy}
        activeOpacity={0.85}
      >
        {busy ? <ActivityIndicator color={COLORS.SURFACE} size="small" /> : <Text style={styles.authSubmitButtonText}>{buttonLabel}</Text>}
      </TouchableOpacity>
    )
  }

  function renderForgotPassword() {
    return (
      <TouchableOpacity
        style={styles.authForgotPasswordButton}
        onPress={() => setAuthStage("reset")}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        activeOpacity={0.7}
        disabled={busy}
      >
        <Text style={styles.authForgotPasswordText}>Forgot Password?</Text>
      </TouchableOpacity>
    )
  }

  async function handleAuthRedirectUrl(rawUrl: string) {
    const redirectResult = await completeAuthRedirectFromUrl(rawUrl)
    if (!redirectResult) {
      return false
    }

    try {
      await handleLogout()
    } catch {}

    if (redirectResult.email) {
      setEmail(redirectResult.email)
    }

    setAuthMode("login")
    setPassword("")
    setFocusedField(null)
    setIsPasswordHidden(true)

    if (redirectResult.type === "recovery") {
      setAuthCompletionState({
        title: "Reset Link Opened",
        message: redirectResult.email
          ? `We recognized the password reset link for ${redirectResult.email}. Finish resetting the password in a web browser, then sign in here.`
          : "We recognized the password reset link. Finish resetting the password in a web browser, then sign in here.",
        buttonLabel: "Back to Sign In",
      })
      return true
    }

    setAuthCompletionState({
      title: "Email Verified",
      message: redirectResult.email
        ? `${redirectResult.email} is verified. You can sign in now.`
        : "Your email has been verified. You can sign in now.",
      buttonLabel: "Continue to Sign In",
    })
    return true
  }

  async function handleResetPassword() {
    Keyboard.dismiss()

    if (!email.trim()) {
      showNotification("Missing Info", "Please enter the email address for your account.", "warning")
      return
    }

    setBusy(true)
    try {
      await resetPasswordWithEmail(email.trim())
      setAuthStage("login")
      showNotification(
        "Password Reset",
        `If an account exists for ${email.trim()}, a reset link has been sent. Please check your inbox and spam folder.`,
        "success",
      )
    } catch (error) {
      showNotification(
        "Password Reset Failed",
        makeFriendlyMessage(error instanceof Error ? error.message : "Could not send reset link.", "error"),
        "error",
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleLogout() {
    await clearSession()
    setAppMode("pos")
    setActiveTab("orders")
    setSettingsReturnTab(null)
    setUser(null)
    setRestaurants([])
    setSelectedRestaurantId(null)
    setBillingConfig(null)
    setDraftItems([])
    setSavedItems([])
    setEditableMenuItems([])
    setOrders([])
    setOrderDrafts([])
    setActiveOrderEditor(null)
    setActiveItemCustomization(null)
    setActiveCallReview(null)
    setVoiceAgentLink(null)
    setManualAgentId("")
    setStatusFilter("pending")
  }

  function openOrderCallReview(title: string, callReview: RestaurantOrderRecord["callReview"]) {
    if (!hasCallReviewContent(callReview)) {
      showNotification("Call Review", "The call details are not ready yet.")
      return
    }

    setActiveCallReview({ title, callReview })
    if (callReview?.recordingUrl?.trim()) {
      void ensureLocalCallRecording(callReview)
    }
  }

  function openPaymentUpdateModal(index: number) {
    const draft = orderDrafts[index]
    if (!draft) {
      return
    }

    if (!draft.id) {
      showNotification("Save Required", "Save the order before updating payment status.", "warning")
      return
    }

    setActivePaymentUpdate({
      index,
      pin: "",
      paymentMethod: normalizePaymentMethod(draft.paymentMethod) || "cash",
      cardTransactionId: draft.cardTransactionId || "",
      tipAmount: Number(draft.tipAmount || 0).toFixed(2),
    })
  }

  function closePaymentUpdateModal() {
    setActivePaymentUpdate(null)
  }

  async function submitOrderPaymentUpdate(params: {
    index: number
    paymentStatus: PaymentStatus
    paymentMethod?: PaymentMethod | null
    cardTransactionId?: string | null
    tipAmount?: number | null
    successTitle: string
    successMessage: string
  }) {
    if (!selectedRestaurant) {
      return
    }

    const draft = orderDrafts[params.index]
    if (!draft?.id || !activePaymentUpdate) {
      return
    }

    if (!activePaymentUpdate.pin.trim()) {
      showNotification("PIN Required", "Enter the payment PIN before updating payment status.", "warning")
      return
    }

    setBusy(true)
    try {
      await updateRestaurantOrderPayment({
        restaurantId: selectedRestaurant.id,
        orderId: draft.id,
        pin: activePaymentUpdate.pin.trim(),
        paymentStatus: params.paymentStatus,
        paymentMethod: params.paymentMethod || null,
        cardTransactionId: params.cardTransactionId || null,
        tipAmount: params.tipAmount ?? 0,
      })
      await refreshOrders(selectedRestaurant.id, { suppressNewOrderExperience: true })
      setActivePaymentUpdate(null)
      showNotification(params.successTitle, params.successMessage, "success")
    } catch (error) {
      showNotification(
        "Payment Update Failed",
        error instanceof Error ? error.message : "Failed to update payment status.",
        "error",
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirmPaidOrder() {
    if (!activePaymentUpdate) {
      return
    }

    const paymentMethod = activePaymentUpdate.paymentMethod
    const parsedTipAmount = Number.parseFloat(activePaymentUpdate.tipAmount)
    const tipAmount = Number.isFinite(parsedTipAmount) ? Math.max(0, parsedTipAmount) : 0

    await submitOrderPaymentUpdate({
      index: activePaymentUpdate.index,
      paymentStatus: "paid",
      paymentMethod,
      cardTransactionId: paymentMethod === "card" ? activePaymentUpdate.cardTransactionId.trim() || null : null,
      tipAmount,
      successTitle: "Payment Updated",
      successMessage: paymentMethod === "card" ? "Order marked as card paid." : "Order marked as cash paid.",
    })
  }

  async function handleResetOrderToUnpaid() {
    if (!activePaymentUpdate) {
      return
    }

    await submitOrderPaymentUpdate({
      index: activePaymentUpdate.index,
      paymentStatus: "unpaid",
      paymentMethod: null,
      cardTransactionId: null,
      tipAmount: 0,
      successTitle: "Payment Updated",
      successMessage: "Order moved back to unpaid.",
    })
  }

  function closeOrderCallReview() {
    try {
      callReviewPlayer.pause()
      callReviewPlayer.seekTo(0)
    } catch {}
    setActiveCallReview(null)
  }

  async function handleOpenCallRecording() {
    const playbackUri = getCallReviewPlaybackUri(activeCallReview?.callReview || null)
    const remoteCallReview = activeCallReview?.callReview || null
    if (!playbackUri) {
      showNotification("Call Review", "The call recording is not available yet.")
      return
    }

    try {
      if (!activeCallReview?.callReview?.localRecordingUri?.trim() && remoteCallReview?.recordingUrl?.trim()) {
        void ensureLocalCallRecording(remoteCallReview)
      }

      if (callReviewPlayerStatus.playing) {
        callReviewPlayer.pause()
        return
      }

      const playbackEnded =
        callReviewPlayerStatus.didJustFinish ||
        (callReviewPlayerStatus.duration > 0 &&
          callReviewPlayerStatus.currentTime >= Math.max(0, callReviewPlayerStatus.duration - 0.25))

      if (playbackEnded) {
        callReviewPlayer.seekTo(0)
      }

      callReviewPlayer.play()
    } catch (error) {
      showNotification(
        "Call Review",
        error instanceof Error ? error.message : "Couldn't play the call recording.",
        "error",
      )
    }
  }

  function renderCallReviewModal() {
    if (!activeCallReview) {
      return null
    }

    const transcriptText = activeCallReview.callReview?.transcriptText?.trim() || ""
    const recordingUrl = getCallReviewPlaybackUri(activeCallReview.callReview)
    const hasTranscript = transcriptText.length > 0
    const hasRecording = recordingUrl.length > 0
    const analysisStatus = activeCallReview.callReview?.analysisStatus?.trim()
    const transcriptEntries = hasTranscript ? parseTranscriptEntries(transcriptText) : []
    const customerName = activeCallReview.title.trim() || "Guest"
    const normalizedStatus = (analysisStatus || "available").trim().toLowerCase()
    const statusLabel = (analysisStatus || "available").replace(/_/g, " ")
    const statusToneStyle =
      normalizedStatus === "processing" || normalizedStatus === "done"
        ? styles.callReviewStatusBadgeSuccess
        : normalizedStatus === "pending"
          ? styles.callReviewStatusBadgePending
          : styles.callReviewStatusBadgeDefault
    const statusTextToneStyle =
      normalizedStatus === "processing" || normalizedStatus === "done"
        ? styles.callReviewStatusBadgeTextSuccess
        : normalizedStatus === "pending"
          ? styles.callReviewStatusBadgeTextPending
          : styles.callReviewStatusBadgeTextDefault
    const recordingCurrentTime = Math.max(0, Number(callReviewPlayerStatus.currentTime || 0))
    const recordingDuration = Math.max(0, Number(callReviewPlayerStatus.duration || 0))
    const recordingProgress = recordingDuration > 0 ? Math.min(1, recordingCurrentTime / recordingDuration) : 0

    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={closeOrderCallReview}
        statusBarTranslucent={false}
      >
        <SafeAreaView style={styles.callReviewScreen}>
          <StatusBar barStyle="dark-content" backgroundColor={COLORS.SURFACE} translucent={false} />
          <View style={styles.callReviewHeader}>
            <View style={styles.callReviewHeaderContent}>
              <Text style={styles.callReviewTitle}>Call Review</Text>
              <Text style={styles.callReviewSubtitle}>{customerName}</Text>
              <View style={[styles.callReviewStatusBadge, statusToneStyle]}>
                <Text style={[styles.callReviewStatusBadgeText, statusTextToneStyle]}>{statusLabel}</Text>
              </View>
            </View>
            <Pressable style={styles.callReviewCloseButton} onPress={closeOrderCallReview}>
              <ButtonLabel icon="check" label="Done" color={COLORS.TEXT_PRIMARY} textStyle={styles.callReviewCloseText} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.callReviewBodyScroll}
            contentContainerStyle={styles.callReviewBodyScrollContent}
            showsVerticalScrollIndicator
          >
            <View style={styles.callReviewAudioRow}>
              <Pressable
                style={[styles.callReviewAudioButton, !hasRecording ? styles.callReviewAudioButtonDisabled : null]}
                onPress={hasRecording ? () => handleOpenCallRecording() : undefined}
                disabled={!hasRecording}
              >
                <View
                  style={[
                    styles.callReviewAudioIconWrap,
                    callReviewPlayerStatus.playing ? styles.callReviewAudioIconStop : styles.callReviewAudioIconPlay,
                    !hasRecording ? styles.callReviewAudioIconDisabled : null,
                  ]}
                >
                  {callReviewPlayerStatus.playing ? (
                    <AppIcon name="square" size={18} color={COLORS.HEADER_TEXT} />
                  ) : (
                    <AppIcon name="play" size={20} color={COLORS.HEADER_TEXT} />
                  )}
                </View>
              </Pressable>
              {hasRecording ? (
                <>
                  <View style={styles.callReviewAudioProgressTrack}>
                    <View
                      style={[
                        styles.callReviewAudioProgressFill,
                        recordingProgress > 0 ? { width: `${recordingProgress * 100}%` } : null,
                      ]}
                    />
                  </View>
                  {recordingDuration > 0 ? <Text style={styles.callReviewAudioDuration}>{formatAudioTime(recordingDuration)}</Text> : null}
                </>
              ) : null}
            </View>

            <View style={styles.callReviewTranscriptSectionHeader}>
              <Text style={styles.callReviewSectionLabel}>TRANSCRIPT</Text>
            </View>

            {transcriptEntries.length > 0 ? (
              transcriptEntries.map((entry, index) => {
                if (entry.tone === "agent") {
                  return (
                    <View key={`transcript-entry-${index}`} style={[styles.callReviewTranscriptGroup, styles.callReviewTranscriptRowPadding]}>
                      <View style={styles.callReviewTranscriptAgentGroup}>
                        <View style={styles.transcriptSpeakerRow}>
                          <AppIcon name="mic" size={14} color={COLORS.VOICE_COLOR} />
                          <Text style={[styles.callReviewTranscriptSpeaker, styles.callReviewTranscriptSpeakerAgent]}>Agent</Text>
                        </View>
                        <View style={styles.callReviewTranscriptAgentBubble}>
                          <Text style={styles.callReviewTranscriptMessage}>{entry.message}</Text>
                        </View>
                      </View>
                    </View>
                  )
                }

                if (entry.tone === "user") {
                  return (
                    <View key={`transcript-entry-${index}`} style={[styles.callReviewTranscriptGroup, styles.callReviewTranscriptRowPadding]}>
                      <View style={styles.callReviewTranscriptUserGroup}>
                        <View style={styles.callReviewTranscriptUserBubble}>
                          <Text style={styles.callReviewTranscriptMessage}>{entry.message}</Text>
                        </View>
                        <View style={styles.transcriptSpeakerRow}>
                          <AppIcon name="user" size={14} color={COLORS.TEXT_SECONDARY} />
                          <Text style={[styles.callReviewTranscriptSpeaker, styles.callReviewTranscriptSpeakerUser]}>Customer</Text>
                        </View>
                      </View>
                    </View>
                  )
                }

                return (
                  <View key={`transcript-entry-${index}`} style={[styles.callReviewTranscriptGroup, styles.callReviewTranscriptRowPadding]}>
                    <View style={styles.callReviewTranscriptNeutralGroup}>
                      <Text style={[styles.callReviewTranscriptSpeaker, styles.callReviewTranscriptSpeakerNeutral]}>{entry.speaker}</Text>
                      <View style={styles.callReviewTranscriptNeutralBubble}>
                        <Text style={styles.callReviewTranscriptMessage}>{entry.message}</Text>
                      </View>
                    </View>
                  </View>
                )
              })
            ) : hasTranscript ? (
              <View style={[styles.callReviewTranscriptFallback, styles.callReviewTranscriptRowPadding]}>
                <Text style={styles.orderTranscriptText}>{transcriptText}</Text>
              </View>
            ) : (
              <View style={styles.callReviewTranscriptEmptyWrap}>
                <Text style={styles.callReviewTranscriptEmpty}>No transcript available</Text>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
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

  async function handleSaveRestaurantPaymentPin() {
    if (!selectedRestaurant) {
      showNotification("Restaurant Required", "Create or select a restaurant first.", "warning")
      return
    }

    const normalizedPin = restaurantPaymentPin.replace(/[^\d]/g, "")
    const normalizedConfirmation = restaurantPaymentPinConfirm.replace(/[^\d]/g, "")

    if (!/^\d{4,8}$/.test(normalizedPin)) {
      showNotification("Validation", "Use a payment PIN that is 4 to 8 digits long.", "warning")
      return
    }

    if (normalizedPin !== normalizedConfirmation) {
      showNotification("Validation", "Payment PIN confirmation does not match.", "warning")
      return
    }

    setBusy(true)
    try {
      await saveRestaurantPaymentPin({
        restaurantId: selectedRestaurant.id,
        pin: normalizedPin,
      })

      const nextRestaurants = restaurants.map((restaurant) =>
        restaurant.id === selectedRestaurant.id
          ? {
              ...restaurant,
              hasPaymentPin: true,
            }
          : restaurant,
      )

      setRestaurants(nextRestaurants)
      await saveCachedRestaurants(nextRestaurants)
      setRestaurantPaymentPin("")
      setRestaurantPaymentPinConfirm("")
      showNotification("Saved", "Restaurant payment PIN updated.", "success")
    } catch (error) {
      showNotification(
        "Save Failed",
        error instanceof Error ? error.message : "Failed to save the restaurant payment PIN.",
        "error",
      )
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
            restaurantId: selectedRestaurant.id,
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
          : parseInsertMode === "replace"
            ? parsedItems
            : [...existingItems, ...parsedItems],
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
          parseInsertMode === "replace"
            ? `Found ${mergedItemCount} item${mergedItemCount === 1 ? "" : "s"} from this menu photo.`
            : addedItemCount > 0
              ? `Added ${addedItemCount} new item${addedItemCount === 1 ? "" : "s"} to your current menu draft.`
              : "Everything from this menu photo is already in your current menu draft."

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

  function replaceOrderDraft(index: number, nextDraft: UiOrderDraft) {
    setOrderDrafts((previousValue) =>
      previousValue.map((order, orderIndex) => (orderIndex === index ? cloneOrderDraft(nextDraft) : order)),
    )
  }

  function showOrderValidationAlert(message: string) {
    if (activeOrderEditor || activeItemCustomization) {
      showOrderFlowNotification("Validation", message, "warning")
      return
    }

    Alert.alert("Validation", message)
  }

  function showOrderErrorAlert(title: string, message: string) {
    if (activeOrderEditor || activeItemCustomization) {
      showOrderFlowNotification(title, message, "error")
      return
    }

    Alert.alert(title, message)
  }

  function getPersistedOrderForDraft(index: number) {
    const draft = orderDrafts[index]
    const draftOrderId = draft?.id?.trim()
    if (!draftOrderId) {
      return null
    }

    return orders.find((order) => String(order.id || "").trim() === draftOrderId) || null
  }

  function getSelectedMenuItemQuantity(
    items: RestaurantOrderRecord["items"],
    menuItem: MenuItemDraft,
  ) {
    return items
      .filter((entry) => matchesDraftOrderItemToMenuItem(entry, menuItem))
      .reduce((sum, entry) => sum + Math.max(1, Number(entry.quantity || 1)), 0)
  }

  function getLocalSelectableQuantityForMenuItem(index: number, menuItem: MenuItemDraft) {
    const liveStockQuantity = Math.max(0, Number(menuItem.stockQuantity || 0))
    const persistedOrder = getPersistedOrderForDraft(index)
    const persistedReservedQuantity = persistedOrder
      ? getSelectedMenuItemQuantity(persistedOrder.items || [], menuItem)
      : 0

    return Math.max(0, liveStockQuantity + persistedReservedQuantity)
  }

  function getRemainingLocalQuantityForMenuItem(index: number, menuItem: MenuItemDraft) {
    const draft = orderDrafts[index]
    if (!draft) {
      return Math.max(0, Number(menuItem.stockQuantity || 0))
    }

    const selectedItems = parseOrderItemsFromText(draft.itemsText)
    const selectedQuantity = getSelectedMenuItemQuantity(selectedItems, menuItem)
    const maxSelectableQuantity = getLocalSelectableQuantityForMenuItem(index, menuItem)
    return Math.max(0, maxSelectableQuantity - selectedQuantity)
  }

  function ensureDraftCanAddMenuItem(index: number, menuItem: MenuItemDraft, incrementBy = 1) {
    const draft = orderDrafts[index]
    if (!draft) {
      return false
    }

    const selectedItems = parseOrderItemsFromText(draft.itemsText)
    const selectedQuantity = getSelectedMenuItemQuantity(selectedItems, menuItem)
    const maxSelectableQuantity = getLocalSelectableQuantityForMenuItem(index, menuItem)

    if (selectedQuantity + incrementBy <= maxSelectableQuantity) {
      return true
    }

    if (maxSelectableQuantity <= 0) {
      showOrderValidationAlert(`${menuItem.name} is out of stock right now.`)
      return false
    }

    showOrderValidationAlert(`Only ${maxSelectableQuantity} available for ${menuItem.name} right now.`)
    return false
  }

  function validateDraftItemsAgainstLocalStock(
    index: number,
    items: RestaurantOrderRecord["items"],
  ) {
    const groupedRequestedQuantities = new Map<string, number>()

    for (const item of items) {
      const menuItemId = item.menuItemId?.trim() || ""
      if (!menuItemId) {
        continue
      }

      groupedRequestedQuantities.set(
        menuItemId,
        (groupedRequestedQuantities.get(menuItemId) || 0) + Math.max(1, Number(item.quantity || 1)),
      )
    }

    for (const [menuItemId, requestedQuantity] of groupedRequestedQuantities.entries()) {
      const menuItem = savedItems.find((candidate) => candidate.id?.trim() === menuItemId)
      if (!menuItem) {
        continue
      }

      const maxSelectableQuantity = getLocalSelectableQuantityForMenuItem(index, menuItem)
      if (requestedQuantity > maxSelectableQuantity) {
        if (maxSelectableQuantity <= 0) {
          return `${menuItem.name} is out of stock right now.`
        }
        return `Only ${maxSelectableQuantity} available for ${menuItem.name} right now.`
      }
    }

    return ""
  }

  function updateOrderDraftItems(
    index: number,
    transform: (items: RestaurantOrderRecord["items"]) => RestaurantOrderRecord["items"],
  ) {
    setOrderDrafts((previousValue) =>
      previousValue.map((order, orderIndex) => {
        if (orderIndex !== index) {
          return order
        }

        const nextItems = transform(parseOrderItemsFromText(order.itemsText))
        return {
          ...order,
          itemsText: orderItemsListToText(nextItems),
        }
      }),
    )
  }

  function removeOrderDraftItem(index: number, itemIndex: number) {
    updateOrderDraftItems(index, (currentItems) => currentItems.filter((_, currentIndex) => currentIndex !== itemIndex))
  }

  function openEditOrderModal(index: number) {
    const draft = orderDrafts[index]
    if (!draft) {
      return
    }

    setOrderFlowNotice(null)
    setActiveOrderEditor({
      mode: "edit",
      index,
      snapshot: cloneOrderDraft(draft),
    })
  }

  function addOrderDraft() {
    const nextIndex = orderDrafts.length
    const blankDraft = createEmptyOrderDraft()
    setOrderDrafts((previousValue) => [...previousValue, blankDraft])
    setOrderFlowNotice(null)
    setActiveOrderEditor({
      mode: "add",
      index: nextIndex,
      snapshot: cloneOrderDraft(blankDraft),
    })
  }

  function closeOrderEditor(options?: { discardChanges?: boolean }) {
    if (!activeOrderEditor) {
      return
    }

    const { index, mode, snapshot } = activeOrderEditor

    if (activeOrderItemPicker?.index === index) {
      closeOrderItemPicker({ revert: Boolean(options?.discardChanges) })
    }
    if (activeItemCustomization?.orderIndex === index) {
      setActiveItemCustomization(null)
    }

    if (options?.discardChanges) {
      if (mode === "add" && !orderDrafts[index]?.id) {
        setOrderDrafts((previousValue) => previousValue.filter((_, orderIndex) => orderIndex !== index))
      } else if (orderDrafts[index]) {
        replaceOrderDraft(index, snapshot)
      }
    }

    setActiveOrderEditor(null)
    setOrderFlowNotice(null)
  }

  function openOrderItemPicker(index: number) {
    const draft = orderDrafts[index]
    if (!draft) {
      return
    }

    setOrderItemPickerSearch("")
    setActiveOrderItemPicker({
      index,
      orderKey: getOrderDraftKey(draft, index),
      snapshotItemsText: draft.itemsText,
    })
  }

  function openMenuItemCustomization(orderIndex: number, menuItem: MenuItemDraft) {
    if (!ensureDraftCanAddMenuItem(orderIndex, menuItem, 1)) {
      return
    }

    const groups = groupMenuCustomizations(menuItem.customizations || [])
    const selectedSingleKeys: Record<string, string> = {}
    const selectedToggleKeys: Record<string, boolean> = {}

    for (const group of groups) {
      if (group.required && group.mode === "toggle" && group.options.length === 1) {
        selectedToggleKeys[getCustomizationOptionKey(group.options[0], `${group.label}-0`)] = true
      }
    }

    setOrderFlowNotice(null)
    setActiveItemCustomization({
      orderIndex,
      menuItem,
      selectedSingleKeys,
      selectedToggleKeys,
    })
  }

  function closeOrderItemPicker(options?: { revert?: boolean }) {
    if (options?.revert && activeOrderItemPicker) {
      updateOrderDraft(activeOrderItemPicker.index, {
        itemsText: activeOrderItemPicker.snapshotItemsText,
      })
    }

    setActiveOrderItemPicker(null)
    setOrderItemPickerSearch("")
  }

  function incrementDraftMenuItem(index: number, item: MenuItemDraft) {
    if (!ensureDraftCanAddMenuItem(index, item, 1)) {
      return
    }

    updateOrderDraftItems(index, (currentItems) => {
      const normalizedMenuItemId = item.id?.trim() || ""
      const existingIndex = currentItems.findIndex((entry) => matchesDraftOrderItemToMenuItem(entry, item))

      if (existingIndex >= 0) {
        return currentItems.map((entry, entryIndex) =>
          entryIndex === existingIndex
            ? {
                ...entry,
                menuItemId: entry.menuItemId?.trim() || normalizedMenuItemId || null,
                quantity: Math.max(1, Number(entry.quantity || 1)) + 1,
              }
            : entry,
        )
      }

      return [
        ...currentItems,
        {
          menuItemId: normalizedMenuItemId || null,
          name: item.name.trim(),
          quantity: 1,
          unitPrice: Number(item.basePrice || 0),
        },
      ]
    })
  }

  function decrementDraftMenuItem(index: number, item: MenuItemDraft) {
    updateOrderDraftItems(index, (currentItems) => {
      const existingIndex = currentItems.findIndex((entry) => matchesDraftOrderItemToMenuItem(entry, item))

      if (existingIndex < 0) {
        return currentItems
      }

      const existingItem = currentItems[existingIndex]
      const nextQuantity = Math.max(0, Number(existingItem.quantity || 1) - 1)

      if (nextQuantity <= 0) {
        return currentItems.filter((_, entryIndex) => entryIndex !== existingIndex)
      }

      return currentItems.map((entry, entryIndex) =>
        entryIndex === existingIndex ? { ...entry, quantity: nextQuantity } : entry,
      )
    })
  }

  function decrementMenuItemSelection(index: number, item: MenuItemDraft) {
    if ((item.customizations || []).length === 0) {
      decrementDraftMenuItem(index, item)
      return
    }

    updateOrderDraftItems(index, (currentItems) => {
      const matchingIndexes = currentItems
        .map((entry, entryIndex) => ({ entry, entryIndex }))
        .filter(({ entry }) => matchesDraftOrderItemToMenuItem(entry, item))

      const match = matchingIndexes[matchingIndexes.length - 1]
      if (!match) {
        return currentItems
      }

      const nextQuantity = Math.max(0, Number(match.entry.quantity || 1) - 1)
      if (nextQuantity <= 0) {
        return currentItems.filter((_, entryIndex) => entryIndex !== match.entryIndex)
      }

      return currentItems.map((entry, entryIndex) =>
        entryIndex === match.entryIndex ? { ...entry, quantity: nextQuantity } : entry,
      )
    })
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
      await refreshOrders(selectedRestaurant.id, { suppressNewOrderExperience: true })
      showNotification("Removed", "Order removed.", "success")
    } catch (error) {
      showOrderErrorAlert("Remove Failed", error instanceof Error ? error.message : "Failed to remove order.")
    } finally {
      setBusy(false)
    }
  }

  function updateLocalBillingConfig(patch: Partial<BillingConfig>) {
    setBillingConfig((current) => (current ? { ...current, ...patch } : current))
  }

  function getDraftBillingSnapshot(
    order: UiOrderDraft,
    parsedItems?: RestaurantOrderRecord["items"],
    options?: { tipAmountOverride?: number | null },
  ) {
    const nextParsedItems = parsedItems || parseOrderItemsFromText(order.itemsText)
    const fallbackSubtotalAmount = getItemsSubtotalAmount(nextParsedItems)
    const normalizedStoredBilling = getUiOrderBillingBreakdown(order, {
      fallbackSubtotalAmount,
      fallbackCurrencyCode: selectedCurrencyCode,
      fallbackTipLabel: billingConfig?.tipLabel || "Gratuity",
    })
    const baseBilling = normalizedStoredBilling.hasStoredBreakdown
      ? normalizedStoredBilling
      : billingConfigToDraftBreakdown(billingConfig, fallbackSubtotalAmount, Number(order.tipAmount || 0))

    if (options?.tipAmountOverride === undefined || options.tipAmountOverride === null) {
      return baseBilling
    }

    const tipAmountOverride = Number(options.tipAmountOverride)
    const normalizedTipAmount = Number.isFinite(tipAmountOverride)
      ? Math.max(0, Math.round((tipAmountOverride + Number.EPSILON) * 100) / 100)
      : 0

    return {
      ...baseBilling,
      tipAmount: normalizedTipAmount,
      totalAmount: Math.round((baseBilling.totalBeforeTip + normalizedTipAmount + Number.EPSILON) * 100) / 100,
    }
  }

  function handleBillingCountryChange(countryCode: string) {
    const selectedCountry = getSupportedBillingCountry(countryCode)
    setBillingConfig((current) =>
      current
        ? {
            ...current,
            countryCode,
            currencyCode: selectedCountry?.currencyCode || current.currencyCode,
            taxRateId: null,
            taxRateOverride: null,
            resolvedTaxRatePercent: 0,
            taxLabel: selectedCountry?.defaultTaxLabel || current.taxLabel || "VAT",
            availableTaxRates: [],
          }
        : current,
    )
  }

  function handleBillingTaxRateSelect(taxRateId: string) {
    setBillingConfig((current) => {
      if (!current) {
        return current
      }

      const selectedTaxRate = current.availableTaxRates.find((taxRate) => taxRate.id === taxRateId) || null

      return {
        ...current,
        taxRateId,
        taxRateOverride: null,
        resolvedTaxRatePercent: selectedTaxRate?.ratePercent || 0,
        taxLabel: selectedTaxRate?.taxName || current.taxLabel,
      }
    })
  }

  function handleBillingTaxRateOverrideChange(value: string) {
    const sanitizedValue = value.replace(/[^0-9.]/g, "")
    const decimalIndex = sanitizedValue.indexOf(".")
    const normalizedValue =
      decimalIndex >= 0
        ? `${sanitizedValue.slice(0, decimalIndex + 1)}${sanitizedValue.slice(decimalIndex + 1).replace(/\./g, "")}`
        : sanitizedValue

    setBillingConfig((current) => {
      if (!current) {
        return current
      }

      if (!normalizedValue.trim()) {
        const selectedTaxRate = current.availableTaxRates.find((taxRate) => taxRate.id === current.taxRateId) || null
        return {
          ...current,
          taxRateOverride: null,
          resolvedTaxRatePercent: selectedTaxRate?.ratePercent || 0,
        }
      }

      const parsedRate = Number.parseFloat(normalizedValue)
      const nextRate = Number.isFinite(parsedRate) ? Math.max(0, parsedRate) : 0

      return {
        ...current,
        taxRateOverride: nextRate,
        resolvedTaxRatePercent: nextRate,
      }
    })
  }

  async function handleSaveBillingConfiguration() {
    if (!selectedRestaurant || !billingConfig) {
      return
    }

    setBusy(true)
    try {
      const savedConfig = await saveBillingConfig(billingConfig)
      const nextRestaurants = restaurants.map((restaurant) =>
        restaurant.id === selectedRestaurant.id
          ? {
              ...restaurant,
              countryCode: savedConfig.countryCode,
              currencyCode: savedConfig.currencyCode,
            }
          : restaurant,
      )
      setBillingConfig(savedConfig)
      setRestaurants(nextRestaurants)
      await saveCachedRestaurants(nextRestaurants)
      await persistRestaurantSnapshot({
        restaurantId: selectedRestaurant.id,
        billingConfig: savedConfig,
      })
      showNotification("Saved", "Billing settings updated.", "success")
    } catch (error) {
      showNotification(
        "Save Failed",
        error instanceof Error ? error.message : "Failed to save billing settings.",
        "error",
      )
    } finally {
      setBusy(false)
    }
  }

  async function persistOrderDraft(index: number, patch?: Partial<UiOrderDraft>) {
    if (!selectedRestaurant) return null

    const existingDraft = orderDrafts[index]
    const draft = existingDraft ? { ...existingDraft, ...patch } : null
    if (!draft || !draft.customerName.trim()) {
      showOrderValidationAlert("Customer name is required.")
      return null
    }
    if (!draft.customerPhone.trim()) {
      showOrderValidationAlert("Customer phone is required.")
      return null
    }

    const fulfillmentType = normalizeFulfillmentType(draft.fulfillmentType)
    const paymentCollection = resolvePaymentCollection(fulfillmentType, draft.paymentCollection)
    const deliveryPostcode = fulfillmentType === "delivery" ? normalizeUkPostcode(draft.deliveryPostcode) : ""
    const deliveryAddress = fulfillmentType === "delivery" ? draft.deliveryAddress.trim() : ""

    if (fulfillmentType === "delivery" && !deliveryPostcode) {
      showOrderValidationAlert("Delivery postcode is required for delivery orders.")
      return null
    }

    if (fulfillmentType === "delivery" && !looksLikeUkPostcode(deliveryPostcode)) {
      showOrderValidationAlert("Please enter a valid UK postcode for delivery orders.")
      return null
    }

    if (fulfillmentType === "delivery" && !deliveryAddress) {
      showOrderValidationAlert("Select or enter the delivery address before saving the order.")
      return null
    }

    const parsedItems = parseOrderItemsFromText(draft.itemsText)
    const { items, changed } = resolveOrderItemsMenuItemIds(parsedItems, savedItems)

    if (changed) {
      updateOrderDraft(index, {
        itemsText: orderItemsListToText(items),
      })
    }

    const localStockValidationMessage = validateDraftItemsAgainstLocalStock(index, items)
    if (localStockValidationMessage) {
      showOrderValidationAlert(localStockValidationMessage)
      return null
    }

    if (items.length === 0) {
      showOrderValidationAlert("Please add at least one item before saving the order.")
      return null
    }

    setBusy(true)
    try {
      const shouldTriggerNewOrderExperience = !existingDraft?.id && draft.status === "pending"
      const savedOrderId = await saveRestaurantOrder({
        restaurantId: selectedRestaurant.id,
        orderId: draft.id,
        customerName: draft.customerName.trim(),
        customerPhone: draft.customerPhone.trim(),
        fulfillmentType,
        deliveryPostcode: deliveryPostcode || null,
        deliveryAddress: deliveryAddress || null,
        paymentCollection,
        status: draft.status,
        notes: draft.notes.trim() || null,
        items,
      })

      await refreshOrders(selectedRestaurant.id, { suppressNewOrderExperience: !shouldTriggerNewOrderExperience })
      if (patch?.status && patch.status !== existingDraft?.status) {
        setOrderFlowNotice(null)
        showNotification(
          "Saved",
          patch.status === "closed" ? "Order marked complete." : "Order moved back to pending.",
          "success",
        )
      } else {
        setOrderFlowNotice(null)
        showNotification("Saved", `Order ${savedOrderId ? "saved" : "updated"} successfully.`)
      }
      return savedOrderId
    } catch (error) {
      showOrderErrorAlert("Order Save Failed", error instanceof Error ? error.message : "Failed to save order.")
      return null
    } finally {
      setBusy(false)
    }
  }

  async function handleSaveOrder(index: number) {
    const savedOrderId = await persistOrderDraft(index)

    if (!savedOrderId) {
      return false
    }

    if (activeOrderItemPicker?.index === index) {
      closeOrderItemPicker()
    }

    setActiveOrderEditor((current) => (current?.index === index ? null : current))
    return true
  }

  async function handlePlaceOrder() {
    if (!activeOrderEditor || activeOrderEditor.mode !== "add") {
      return
    }

    await handleSaveOrder(activeOrderEditor.index)
  }

  async function handleRemoveOrderFromEditor() {
    if (!activeOrderEditor) {
      return
    }

    const activeIndex = activeOrderEditor.index
    if (activeOrderItemPicker?.index === activeIndex) {
      closeOrderItemPicker()
    }

    await removeOrderDraft(activeIndex)
    setActiveOrderEditor(null)
  }

  function closeItemCustomization() {
    setActiveItemCustomization(null)
    setOrderFlowNotice(null)
  }

  function toggleItemCustomizationChoice(group: MenuCustomizationGroup, option: MenuCustomizationDraft, optionKey: string) {

    if (!activeItemCustomization) {
      return
    }

    if (group.mode === "single") {
      setActiveItemCustomization((current) =>
        current
          ? {
              ...current,
              selectedSingleKeys: {
                ...current.selectedSingleKeys,
                [group.label]: optionKey,
              },
            }
          : current,
      )
      return
    }

    setActiveItemCustomization((current) =>
      current
        ? {
            ...current,
            selectedToggleKeys: {
              ...current.selectedToggleKeys,
              [optionKey]: !current.selectedToggleKeys[optionKey],
            },
          }
        : current,
    )
  }

  async function handleQuickToggleOrderStatus(index: number) {
    const draft = orderDrafts[index]
    if (!draft) {
      return
    }

    const nextStatus = draft.status === "pending" ? "closed" : "pending"
    await persistOrderDraft(index, { status: nextStatus })
  }

  function applyItemCustomizationSelection() {
    if (!activeItemCustomization) {
      return
    }

    if (!ensureDraftCanAddMenuItem(activeItemCustomization.orderIndex, activeItemCustomization.menuItem, 1)) {
      return
    }

    const groups = groupMenuCustomizations(activeItemCustomization.menuItem.customizations || [])
    const selectedSummary: string[] = []
    let totalPriceDelta = 0

    for (const group of groups) {
      if (group.mode === "single") {
        const selectedKey = activeItemCustomization.selectedSingleKeys[group.label]
        const selectedOption = group.options.find(
          (option, optionIndex) => getCustomizationOptionKey(option, `${group.label}-${optionIndex}`) === selectedKey,
        )

        if (!selectedOption) {
          if (group.required) {
            showOrderValidationAlert(`Please choose a ${group.label.toLowerCase()} option.`)
            return
          }
          continue
        }

        const summaryLabel = getCustomizationChoiceLabel(group, selectedOption)
        selectedSummary.push(summaryLabel === group.label ? summaryLabel : `${group.label}: ${summaryLabel}`)
        totalPriceDelta += Number(selectedOption.priceDelta || 0)
        continue
      }

      const selectedToggleOptions = group.options.filter(
        (option, optionIndex) =>
          activeItemCustomization.selectedToggleKeys[getCustomizationOptionKey(option, `${group.label}-${optionIndex}`)],
      )

      if (group.required && selectedToggleOptions.length === 0) {
        showOrderValidationAlert(`Please choose ${group.label.toLowerCase()}.`)
        return
      }

      for (const selectedOption of selectedToggleOptions) {
        selectedSummary.push(getCustomizationChoiceLabel(group, selectedOption))
        totalPriceDelta += Number(selectedOption.priceDelta || 0)
      }
    }

    const baseName = activeItemCustomization.menuItem.name.trim()
    const customizedName = selectedSummary.length > 0 ? `${baseName} (${selectedSummary.join(", ")})` : baseName
    const basePrice = Number(activeItemCustomization.menuItem.basePrice || 0)
    const resolvedUnitPrice = Math.max(0, basePrice + totalPriceDelta)

    updateOrderDraftItems(activeItemCustomization.orderIndex, (currentItems) => {
      const existingIndex = currentItems.findIndex(
        (entry) =>
          entry.name.trim().toLowerCase() === customizedName.trim().toLowerCase() &&
          Number(entry.unitPrice || 0) === resolvedUnitPrice,
      )

      if (existingIndex >= 0) {
        return currentItems.map((entry, entryIndex) =>
          entryIndex === existingIndex
            ? {
                ...entry,
                menuItemId: entry.menuItemId?.trim() || activeItemCustomization.menuItem.id?.trim() || null,
                quantity: Math.max(1, Number(entry.quantity || 1)) + 1,
              }
            : entry,
        )
      }

      return [
        ...currentItems,
        {
          menuItemId: activeItemCustomization.menuItem.id?.trim() || null,
          name: customizedName,
          quantity: 1,
          unitPrice: resolvedUnitPrice,
        },
      ]
    })

    setOrderFlowNotice(null)
    setActiveItemCustomization(null)
  }

  function renderOrderItemPickerModal() {
    if (!activeOrderItemPicker) {
      return null
    }

    const draft = orderDrafts[activeOrderItemPicker.index]
    if (!draft) {
      return null
    }

    const selectedItems = parseOrderItemsFromText(draft.itemsText)
    const normalizedQuery = orderItemPickerSearch.trim().toLowerCase()
    const availableMenuItems = savedItems.filter((item) => {
      if (item.name.trim().length === 0) {
        return false
      }

      const selectedQuantity = getSelectedMenuItemQuantity(selectedItems, item)
      const maxSelectableQuantity = getLocalSelectableQuantityForMenuItem(activeOrderItemPicker.index, item)
      return maxSelectableQuantity > 0 || selectedQuantity > 0
    })
    const filteredMenuItems = normalizedQuery
      ? availableMenuItems.filter((item) => {
          const name = item.name.trim().toLowerCase()
          const category = item.category?.trim().toLowerCase() || ""
          return name.includes(normalizedQuery) || category.includes(normalizedQuery)
        })
      : availableMenuItems
    const selectedTotal = selectedItems.reduce(
      (sum, item) => sum + Math.max(1, Number(item.quantity || 1)) * Number(item.unitPrice || 0),
      0,
    )
    const orderItemPickerColumns = viewportWidth >= 1320 ? 4 : viewportWidth >= 760 ? 3 : 2
    const useOrderItemGrid = orderItemPickerColumns > 1

    return (
      <Modal
        visible
        transparent
        animationType="slide"
        onRequestClose={() => closeOrderItemPicker({ revert: true })}
      >
        <View style={styles.orderItemPickerOverlay}>
          <Pressable style={styles.orderItemPickerBackdrop} onPress={() => closeOrderItemPicker({ revert: true })} />
          <View style={styles.orderItemPickerSheet}>
            <View style={styles.orderItemPickerHandle} />

            <View style={styles.orderItemPickerHeader}>
              <Text style={styles.orderItemPickerTitle}>Add Items</Text>
              <View style={styles.orderItemPickerHeaderActions}>
                <Pressable style={styles.orderItemPickerSecondaryButton} onPress={() => closeOrderItemPicker({ revert: true })}>
                  <Text style={styles.orderItemPickerSecondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable style={styles.orderItemPickerPrimaryButton} onPress={() => closeOrderItemPicker()}>
                  <Text style={styles.orderItemPickerPrimaryButtonText}>Done</Text>
                </Pressable>
              </View>
            </View>

            <TextInput
              style={styles.orderItemPickerSearchInput}
              placeholder="Search menu items..."
              placeholderTextColor={COLORS.TEXT_MUTED}
              value={orderItemPickerSearch}
              onChangeText={setOrderItemPickerSearch}
            />

            <ScrollView
              style={styles.orderItemPickerScroll}
              contentContainerStyle={[styles.orderItemPickerList, useOrderItemGrid ? styles.orderItemPickerListGrid : null]}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {filteredMenuItems.length === 0 ? (
                <View style={styles.orderItemPickerEmptyState}>
                  <Text style={styles.orderItemPickerEmptyTitle}>No available menu items</Text>
                  <Text style={styles.orderItemPickerEmptyText}>
                    Add menu items with stock before creating a manual order.
                  </Text>
                </View>
              ) : (
                filteredMenuItems.map((item, itemIndex) => {
                  const hasCustomizations = (item.customizations || []).length > 0
                  const matchingSelectedVariants = selectedItems.filter((selected) =>
                    matchesDraftOrderItemToMenuItem(selected, item),
                  )
                  const selectedVariantCount = matchingSelectedVariants.reduce(
                    (sum, selected) => sum + Math.max(1, Number(selected.quantity || 1)),
                    0,
                  )
                  const maxSelectableQuantity = getLocalSelectableQuantityForMenuItem(activeOrderItemPicker.index, item)
                  const remainingQuantity = Math.max(0, maxSelectableQuantity - selectedVariantCount)
                  const canAddMore = remainingQuantity > 0
                  const customizationGroups = groupMenuCustomizations(item.customizations || [])
                  const customizationSummary = customizationGroups.map((group) => group.label).join(" • ")

                  return (
                    <View
                      key={`picker-item-${item.id || item.name}-${itemIndex}`}
                      style={[
                        styles.orderItemPickerRow,
                        useOrderItemGrid ? styles.orderItemPickerRowGrid : null,
                        orderItemPickerColumns === 2 ? styles.orderItemPickerRowGridTwo : null,
                        orderItemPickerColumns === 3 ? styles.orderItemPickerRowGridThree : null,
                        orderItemPickerColumns >= 4 ? styles.orderItemPickerRowGridFour : null,
                      ]}
                    >
                      <View style={[styles.orderItemPickerRowText, useOrderItemGrid ? styles.orderItemPickerRowTextGrid : null]}>
                        <Text style={styles.orderItemPickerRowTitle}>{item.name}</Text>
                        {item.category ? <Text style={styles.orderItemPickerRowMeta}>{item.category}</Text> : null}
                        <Text
                          style={[
                            styles.orderItemPickerStockMeta,
                            !canAddMore ? styles.orderItemPickerStockMetaWarning : null,
                          ]}
                        >
                          {canAddMore ? `${remainingQuantity} left` : "Stock full"}
                        </Text>
                        {hasCustomizations ? (
                          <Text style={styles.orderItemPickerCustomizationMeta} numberOfLines={2}>
                            {customizationSummary}
                          </Text>
                        ) : null}
                        <Text style={styles.orderItemPickerRowPrice}>{formatCurrencyDisplay(Number(item.basePrice || 0), selectedCurrencyCode)}</Text>
                      </View>

                      <View style={[styles.orderItemPickerActionWrap, useOrderItemGrid ? styles.orderItemPickerActionWrapGrid : null]}>
                      {hasCustomizations && selectedVariantCount > 0 ? (
                        <View style={[styles.orderItemPickerQuantityRow, useOrderItemGrid ? styles.orderItemPickerQuantityRowGrid : null]}>
                          <Pressable
                            style={[styles.orderItemPickerQtyButton, styles.orderItemPickerQtyButtonDanger]}
                            onPress={() => decrementMenuItemSelection(activeOrderItemPicker.index, item)}
                          >
                            <Text style={styles.orderItemPickerQtyButtonText}>{"\u2212"}</Text>
                          </Pressable>
                          <Text style={styles.orderItemPickerQtyValue}>{selectedVariantCount}</Text>
                          <Pressable
                            style={[
                              styles.orderItemPickerQtyButton,
                              styles.orderItemPickerQtyButtonAccent,
                              !canAddMore ? styles.orderItemPickerControlDisabled : null,
                            ]}
                            onPress={() => openMenuItemCustomization(activeOrderItemPicker.index, item)}
                            disabled={!canAddMore}
                          >
                            <Text style={styles.orderItemPickerQtyButtonText}>+</Text>
                          </Pressable>
                        </View>
                      ) : hasCustomizations ? (
                        <Pressable
                          style={[styles.orderItemPickerAddButton, !canAddMore ? styles.orderItemPickerControlDisabled : null]}
                          onPress={() => openMenuItemCustomization(activeOrderItemPicker.index, item)}
                          disabled={!canAddMore}
                        >
                          <Text style={styles.orderItemPickerAddButtonText}>{canAddMore ? "Add" : "Full"}</Text>
                        </Pressable>
                      ) : selectedVariantCount > 0 ? (
                        <View style={[styles.orderItemPickerQuantityRow, useOrderItemGrid ? styles.orderItemPickerQuantityRowGrid : null]}>
                          <Pressable
                            style={[styles.orderItemPickerQtyButton, styles.orderItemPickerQtyButtonDanger]}
                            onPress={() => decrementMenuItemSelection(activeOrderItemPicker.index, item)}
                          >
                            <Text style={styles.orderItemPickerQtyButtonText}>{"\u2212"}</Text>
                          </Pressable>
                          <Text style={styles.orderItemPickerQtyValue}>{selectedVariantCount}</Text>
                          <Pressable
                            style={[
                              styles.orderItemPickerQtyButton,
                              styles.orderItemPickerQtyButtonAccent,
                              !canAddMore ? styles.orderItemPickerControlDisabled : null,
                            ]}
                            onPress={() => incrementDraftMenuItem(activeOrderItemPicker.index, item)}
                            disabled={!canAddMore}
                          >
                            <Text style={styles.orderItemPickerQtyButtonText}>+</Text>
                          </Pressable>
                        </View>
                      ) : (
                        <Pressable
                          style={[styles.orderItemPickerAddButton, !canAddMore ? styles.orderItemPickerControlDisabled : null]}
                          onPress={() => incrementDraftMenuItem(activeOrderItemPicker.index, item)}
                          disabled={!canAddMore}
                        >
                          <Text style={styles.orderItemPickerAddButtonText}>{canAddMore ? "Add" : "Full"}</Text>
                        </Pressable>
                      )}
                      </View>
                    </View>
                  )
                })
              )}
            </ScrollView>

            {selectedItems.length > 0 ? (
              <View style={styles.orderItemPickerFooter}>
                <Text style={styles.orderItemPickerFooterText}>{selectedItems.length} item(s) selected</Text>
                <Text style={styles.orderItemPickerFooterTotal}>{formatCurrencyDisplay(selectedTotal, selectedCurrencyCode)}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>
    )
  }

  function renderItemCustomizationModal() {
    if (!activeItemCustomization) {
      return null
    }

    const customizationGroups = groupMenuCustomizations(activeItemCustomization.menuItem.customizations || [])

    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={closeItemCustomization}
        statusBarTranslucent={false}
      >
        <SafeAreaView style={editModalStyles.safe}>
          <StatusBar barStyle="dark-content" backgroundColor={COLORS.BACKGROUND} translucent={false} />
          <View style={editModalStyles.header}>
            <Pressable onPress={closeItemCustomization} style={editModalStyles.headerSideButton}>
              <Text style={editModalStyles.cancelText}>Back</Text>
            </Pressable>
            <Text style={editModalStyles.headerTitle}>Customize Item</Text>
            <Pressable onPress={applyItemCustomizationSelection} style={editModalStyles.headerSideButton}>
              <Text style={editModalStyles.saveText}>Add</Text>
            </Pressable>
          </View>

          {orderFlowNotice ? <View style={editModalStyles.noticeWrap}>{renderOrderFlowNotice()}</View> : null}

          <ScrollView
            contentContainerStyle={editModalStyles.formContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={editModalStyles.customizationIntroCard}>
              <Text style={editModalStyles.customizationItemTitle}>{activeItemCustomization.menuItem.name}</Text>
              <Text style={editModalStyles.customizationItemPrice}>
                {formatCurrencyDisplay(Number(activeItemCustomization.menuItem.basePrice || 0), selectedCurrencyCode)}
              </Text>
              <Text style={editModalStyles.customizationItemHint}>
                Choose sauces, combos, and extras before adding this item to the order.
              </Text>
            </View>

            {customizationGroups.map((group) => (
              <View key={group.label} style={editModalStyles.customizationGroup}>
                <View style={editModalStyles.customizationGroupHeader}>
                  <Text style={editModalStyles.sectionLabelInline}>{group.label}</Text>
                  {group.required ? <Text style={editModalStyles.customizationRequiredBadge}>Required</Text> : null}
                </View>

                <View style={editModalStyles.customizationChoiceWrap}>
                  {group.options.map((option, optionIndex) => {
                    const optionKey = getCustomizationOptionKey(option, `${group.label}-${optionIndex}`)
                    const isActive =
                      group.mode === "single"
                        ? activeItemCustomization.selectedSingleKeys[group.label] === optionKey
                        : Boolean(activeItemCustomization.selectedToggleKeys[optionKey])

                    return (
                      <Pressable
                        key={optionKey}
                        style={[
                          editModalStyles.customizationChoiceChip,
                          isActive ? editModalStyles.customizationChoiceChipActive : null,
                        ]}
                        onPress={() => toggleItemCustomizationChoice(group, option, optionKey)}
                      >
                        <Text
                          style={[
                            editModalStyles.customizationChoiceText,
                            isActive ? editModalStyles.customizationChoiceTextActive : null,
                          ]}
                        >
                          {getCustomizationChoiceLabel(group, option)}
                          {formatCustomizationPriceDelta(Number(option.priceDelta || 0), selectedCurrencyCode)}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    )
  }

  function renderOrderEditorModal() {
    if (!activeOrderEditor) {
      return null
    }

    const editorDraft = orderDrafts[activeOrderEditor.index]
    if (!editorDraft) {
      return null
    }

    const editorItems = parseOrderItemsFromText(editorDraft.itemsText)
    const editorSubtotalAmount = getItemsSubtotalAmount(editorItems)
    const editorBilling = billingConfigToDraftBreakdown(
      billingConfig,
      editorSubtotalAmount,
      Number(editorDraft.tipAmount || 0),
    )
    const editorFulfillmentType = normalizeFulfillmentType(editorDraft.fulfillmentType)
    const editorPaymentCollection = resolvePaymentCollection(editorFulfillmentType, editorDraft.paymentCollection)
    const editorPaymentStatus = normalizePaymentStatus(editorDraft.paymentStatus)
    const editorPaymentMethod = normalizePaymentMethod(editorDraft.paymentMethod)
    const editorPaymentDisplayLabel = getOrderPaymentDisplayLabel({
      fulfillmentType: editorFulfillmentType,
      paymentCollection: editorPaymentCollection,
      paymentStatus: editorPaymentStatus,
      paymentMethod: editorPaymentMethod,
    })
    const editorOrderReference = formatShortOrderCode(editorDraft.shortOrderCode) || editorDraft.id || `${activeOrderEditor.index + 1}`
    const isAddingOrder = activeOrderEditor.mode === "add"

    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => closeOrderEditor({ discardChanges: true })}
        statusBarTranslucent={false}
      >
        <SafeAreaView style={editModalStyles.safe}>
          <StatusBar barStyle="dark-content" backgroundColor={COLORS.BACKGROUND} translucent={false} />
          <View style={editModalStyles.header}>
            <Pressable onPress={() => closeOrderEditor({ discardChanges: true })} style={editModalStyles.headerSideButton}>
              <Text style={editModalStyles.cancelText}>Cancel</Text>
            </Pressable>
            <Text style={editModalStyles.headerTitle}>{isAddingOrder ? "New Order" : `Edit Order #${editorOrderReference}`}</Text>
            <Pressable
              onPress={isAddingOrder ? handlePlaceOrder : () => handleSaveOrder(activeOrderEditor.index)}
              style={editModalStyles.headerSideButton}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color={COLORS.ACCENT} size="small" /> : <Text style={editModalStyles.saveText}>{isAddingOrder ? "Place Order" : "Save"}</Text>}
            </Pressable>
          </View>

          {orderFlowNotice ? <View style={editModalStyles.noticeWrap}>{renderOrderFlowNotice()}</View> : null}

          <KeyboardAvoidingView style={editModalStyles.keyboardFill} behavior={Platform.OS === "ios" ? "padding" : "height"}>
            <ScrollView
              contentContainerStyle={editModalStyles.formContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
              showsVerticalScrollIndicator={false}
            >
              <Text style={editModalStyles.sectionLabel}>Customer Details</Text>
              <View style={[editModalStyles.row, isCompactViewport ? editModalStyles.rowStacked : null]}>
                <View style={[editModalStyles.fieldColumn, isCompactViewport ? null : editModalStyles.fieldColumnLeft]}>
                  <Text style={editModalStyles.fieldLabel}>Customer Name</Text>
                  <TextInput
                    style={editModalStyles.textInput}
                    value={editorDraft.customerName}
                    onChangeText={(value) => updateOrderDraft(activeOrderEditor.index, { customerName: value })}
                    placeholder="Customer name"
                    placeholderTextColor={COLORS.TEXT_MUTED}
                  />
                </View>
                <View style={[editModalStyles.fieldColumn, isCompactViewport ? null : editModalStyles.fieldColumnRight]}>
                  <Text style={editModalStyles.fieldLabel}>Phone Number</Text>
                  <TextInput
                    style={editModalStyles.textInput}
                    value={editorDraft.customerPhone}
                    onChangeText={(value) => updateOrderDraft(activeOrderEditor.index, { customerPhone: value })}
                    placeholder="Phone number"
                    keyboardType="phone-pad"
                    placeholderTextColor={COLORS.TEXT_MUTED}
                  />
                </View>
              </View>

              <Text style={editModalStyles.sectionLabel}>Fulfilment</Text>
              <View style={editModalStyles.statusRow}>
                {[
                  { label: "Pickup", value: "pickup" as const },
                  { label: "Delivery", value: "delivery" as const },
                ].map((option) => {
                  const isActive = editorFulfillmentType === option.value
                  return (
                    <Pressable
                      key={option.value}
                      style={[editModalStyles.statusButton, isActive ? editModalStyles.statusButtonActive : null]}
                      onPress={() =>
                        updateOrderDraft(activeOrderEditor.index, {
                          fulfillmentType: option.value,
                          paymentCollection: option.value === "delivery" ? "cod" : "unpaid",
                          deliveryPostcode: option.value === "delivery" ? editorDraft.deliveryPostcode : "",
                          deliveryAddress: option.value === "delivery" ? editorDraft.deliveryAddress : "",
                        })
                      }
                    >
                      <Text style={[editModalStyles.statusButtonText, isActive ? editModalStyles.statusButtonTextActive : null]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>

              <View style={editModalStyles.fulfillmentSummaryCard}>
                <Text style={editModalStyles.fieldLabel}>Payment Collection</Text>
                <View style={editModalStyles.fulfillmentSummaryBadge}>
                  <Text style={editModalStyles.fulfillmentSummaryBadgeText}>
                    {editorPaymentDisplayLabel}
                  </Text>
                </View>
              </View>

              {editorFulfillmentType === "delivery" ? (
                <>
                  <View style={editModalStyles.deliveryGuidanceCard}>
                    <Text style={editModalStyles.deliveryGuidanceTitle}>Delivery orders</Text>
                    <Text style={editModalStyles.deliveryGuidanceText}>
                      Enter the UK postcode first, then store the exact delivery address selected for the customer.
                    </Text>
                  </View>

                  <View style={[editModalStyles.row, isCompactViewport ? editModalStyles.rowStacked : null]}>
                    <View style={[editModalStyles.fieldColumn, isCompactViewport ? null : editModalStyles.fieldColumnLeft]}>
                      <Text style={editModalStyles.fieldLabel}>Delivery Postcode</Text>
                      <TextInput
                        style={editModalStyles.textInput}
                        value={editorDraft.deliveryPostcode}
                        onChangeText={(value) =>
                          updateOrderDraft(activeOrderEditor.index, { deliveryPostcode: normalizeUkPostcode(value) })
                        }
                        placeholder="SW1A 1AA"
                        autoCapitalize="characters"
                        placeholderTextColor={COLORS.TEXT_MUTED}
                      />
                    </View>
                    <View style={[editModalStyles.fieldColumn, isCompactViewport ? null : editModalStyles.fieldColumnRight]}>
                      <Text style={editModalStyles.fieldLabel}>Payment</Text>
                      <View style={editModalStyles.deliveryReadOnlyField}>
                        <Text style={editModalStyles.deliveryReadOnlyFieldText}>COD</Text>
                      </View>
                    </View>
                  </View>

                  <Text style={editModalStyles.fieldLabel}>Delivery Address</Text>
                  <TextInput
                    style={[editModalStyles.textInput, editModalStyles.notesInput]}
                    value={editorDraft.deliveryAddress}
                    onChangeText={(value) => updateOrderDraft(activeOrderEditor.index, { deliveryAddress: value })}
                    placeholder="Chosen address under the postcode lookup"
                    placeholderTextColor={COLORS.TEXT_MUTED}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                  />
                </>
              ) : null}

              <Text style={editModalStyles.sectionLabel}>Status</Text>
              <View style={editModalStyles.statusRow}>
                {[
                  { label: "Pending", value: "pending" as const },
                  { label: "Complete", value: "closed" as const },
                ].map((option) => {
                  const isActive = editorDraft.status === option.value
                  return (
                    <Pressable
                      key={option.value}
                      style={[editModalStyles.statusButton, isActive ? editModalStyles.statusButtonActive : null]}
                      onPress={() => updateOrderDraft(activeOrderEditor.index, { status: option.value })}
                    >
                      <Text style={[editModalStyles.statusButtonText, isActive ? editModalStyles.statusButtonTextActive : null]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>

              <Text style={editModalStyles.sectionLabel}>Notes</Text>
              <TextInput
                style={[editModalStyles.textInput, editModalStyles.notesInput]}
                value={editorDraft.notes}
                onChangeText={(value) => updateOrderDraft(activeOrderEditor.index, { notes: value })}
                placeholder="Notes or special instructions"
                placeholderTextColor={COLORS.TEXT_MUTED}
                multiline
                numberOfLines={3}
                textAlignVertical="top"
              />

              <View style={editModalStyles.itemsHeader}>
                <Text style={editModalStyles.sectionLabelInline}>Items</Text>
                <Pressable style={editModalStyles.addItemsButton} onPress={() => openOrderItemPicker(activeOrderEditor.index)}>
                  <Text style={editModalStyles.addItemsButtonText}>+ Add Items</Text>
                </Pressable>
              </View>

              <View style={editModalStyles.itemsCard}>
                {editorItems.length === 0 ? (
                  <Text style={editModalStyles.emptyItemsText}>No items added yet. Tap Add Items to choose from the saved menu.</Text>
                ) : (
                  editorItems.map((item, itemIndex) => {
                    const quantity = Math.max(1, Number(item.quantity || 1))
                    const unitPrice = Number(item.unitPrice || 0)
                    const lineTotal = quantity * unitPrice

                    return (
                      <View key={`order-editor-modal-item-${item.name}-${itemIndex}`} style={editModalStyles.itemRow}>
                        <View style={editModalStyles.itemBody}>
                          <Text style={editModalStyles.itemName} numberOfLines={2}>
                            {item.name}
                          </Text>
                          <Text style={editModalStyles.itemMeta}>
                            {quantity} {"\u00D7"} {formatCurrencyDisplay(unitPrice, editorBilling.currencyCode)}
                          </Text>
                        </View>
                        <View style={editModalStyles.itemActions}>
                          <View style={editModalStyles.itemQuantityBadge}>
                            <Text style={editModalStyles.itemQuantityBadgeText}>Qty {quantity}</Text>
                          </View>
                          <Text style={editModalStyles.itemPrice}>{formatCurrencyDisplay(lineTotal, editorBilling.currencyCode)}</Text>
                          <Pressable
                            style={editModalStyles.itemRemoveButton}
                            onPress={() => removeOrderDraftItem(activeOrderEditor.index, itemIndex)}
                            hitSlop={10}
                          >
                            <Text style={editModalStyles.itemRemoveButtonText}>{"\u00D7"}</Text>
                          </Pressable>
                        </View>
                      </View>
                    )
                  })
                )}
              </View>

              <View style={editModalStyles.totalRow}>
                <Text style={editModalStyles.totalLabel}>SUBTOTAL</Text>
                <Text style={editModalStyles.totalAmount}>{formatCurrencyDisplay(editorBilling.subtotalAmount, editorBilling.currencyCode)}</Text>
              </View>
              {editorBilling.taxAmount > 0 ? (
                <View style={editModalStyles.totalRow}>
                  <Text style={editModalStyles.totalLabel}>
                    {editorBilling.taxLabel.toUpperCase()} ({editorBilling.taxRatePercent.toFixed(2)}%)
                  </Text>
                  <Text style={editModalStyles.totalAmount}>{formatCurrencyDisplay(editorBilling.taxAmount, editorBilling.currencyCode)}</Text>
                </View>
              ) : null}
              {editorBilling.serviceFeeAmount > 0 ? (
                <View style={editModalStyles.totalRow}>
                  <Text style={editModalStyles.totalLabel}>{editorBilling.serviceFeeLabel.toUpperCase()}</Text>
                  <Text style={editModalStyles.totalAmount}>{formatCurrencyDisplay(editorBilling.serviceFeeAmount, editorBilling.currencyCode)}</Text>
                </View>
              ) : null}
              <View style={editModalStyles.totalRow}>
                <Text style={editModalStyles.totalLabel}>TOTAL</Text>
                <Text style={editModalStyles.totalAmount}>{formatCurrencyDisplay(editorBilling.totalAmount, editorBilling.currencyCode)}</Text>
              </View>

              <Pressable style={editModalStyles.removeOrderButton} onPress={handleRemoveOrderFromEditor} disabled={busy}>
                <Text style={editModalStyles.removeOrderButtonText}>{editorDraft.id ? "Remove Order" : "Discard Draft"}</Text>
              </Pressable>
            </ScrollView>
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    )
  }

  function renderPaymentUpdateModal() {
    if (!activePaymentUpdate) {
      return null
    }

    const draft = orderDrafts[activePaymentUpdate.index]
    if (!draft) {
      return null
    }

    const fulfillmentType = normalizeFulfillmentType(draft.fulfillmentType)
    const paymentCollection = resolvePaymentCollection(fulfillmentType, draft.paymentCollection)
    const paymentStatus = normalizePaymentStatus(draft.paymentStatus)
    const paymentMethod = normalizePaymentMethod(draft.paymentMethod)
    const displayLabel = getOrderPaymentDisplayLabel({
      fulfillmentType,
      paymentCollection,
      paymentStatus,
      paymentMethod,
    })
    const draftItemsPreview = parseOrderItemsFromText(draft.itemsText)
    const parsedTipAmount = Number.parseFloat(activePaymentUpdate.tipAmount)
    const tipAmountPreview = Number.isFinite(parsedTipAmount) ? Math.max(0, parsedTipAmount) : 0
    const billingPreview = getDraftBillingSnapshot(draft, draftItemsPreview, {
      tipAmountOverride: tipAmountPreview,
    })
    const showTipControls = fulfillmentType === "pickup" || billingPreview.tipAmount > 0
    const tipSuggestions = billingConfig?.tipSuggestions || []
    const showTipSuggestions = fulfillmentType === "pickup" && Boolean(billingConfig?.tipEnabled) && tipSuggestions.length > 0
    const canResetToUnpaid = paymentStatus === "paid"
    const paymentModalMaxHeight = Math.max(360, viewportHeight - 40)

    return (
      <Modal
        visible
        transparent
        animationType="fade"
        onRequestClose={closePaymentUpdateModal}
        statusBarTranslucent={false}
      >
        <View style={styles.paymentModalOverlay}>
          <Pressable style={styles.paymentModalBackdrop} onPress={closePaymentUpdateModal} />
          <View style={[styles.paymentModalCard, { maxHeight: paymentModalMaxHeight }]}>
            <ScrollView
              style={styles.paymentModalScroll}
              contentContainerStyle={styles.paymentModalScrollContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
            <Text style={styles.paymentModalTitle}>Update Payment</Text>
            <Text style={styles.paymentModalSubtitle}>
              {draft.customerName.trim() || "Guest"} · #{formatShortOrderCode(draft.shortOrderCode) || draft.id || activePaymentUpdate.index + 1}
            </Text>

            <View style={styles.paymentModalCurrentBadgeRow}>
              <View style={[styles.orderMetaBadge, styles.orderMetaBadgePayment]}>
                <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextPayment]}>{displayLabel}</Text>
              </View>
              {fulfillmentType === "delivery" ? (
                <View style={[styles.orderMetaBadge, styles.orderMetaBadgeDelivery]}>
                  <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextDelivery]}>DELIVERY</Text>
                </View>
              ) : null}
            </View>

            <View style={styles.posSummaryCard}>
              <View style={styles.posSummaryRow}>
                <Text style={styles.posSummaryLabel}>Subtotal</Text>
                <Text style={styles.posSummaryValue}>
                  {formatCurrencyDisplay(billingPreview.subtotalAmount, billingPreview.currencyCode)}
                </Text>
              </View>
              {billingPreview.taxAmount > 0 ? (
                <View style={styles.posSummaryRow}>
                  <Text style={styles.posSummaryLabel}>
                    {billingPreview.taxLabel} ({billingPreview.taxRatePercent.toFixed(2)}%)
                  </Text>
                  <Text style={styles.posSummaryValue}>
                    {formatCurrencyDisplay(billingPreview.taxAmount, billingPreview.currencyCode)}
                  </Text>
                </View>
              ) : null}
              {billingPreview.serviceFeeAmount > 0 ? (
                <View style={styles.posSummaryRow}>
                  <Text style={styles.posSummaryLabel}>{billingPreview.serviceFeeLabel}</Text>
                  <Text style={styles.posSummaryValue}>
                    {formatCurrencyDisplay(billingPreview.serviceFeeAmount, billingPreview.currencyCode)}
                  </Text>
                </View>
              ) : null}
              {showTipControls ? (
                <>
                  <View style={styles.posSummaryRow}>
                    <Text style={styles.posSummaryLabel}>Total Before Tip</Text>
                    <Text style={styles.posSummaryValue}>
                      {formatCurrencyDisplay(billingPreview.totalBeforeTip, billingPreview.currencyCode)}
                    </Text>
                  </View>
                  <View style={styles.posSummaryRow}>
                    <Text style={styles.posSummaryLabel}>{billingPreview.tipLabel}</Text>
                    <Text style={styles.posSummaryValue}>
                      {formatCurrencyDisplay(billingPreview.tipAmount, billingPreview.currencyCode)}
                    </Text>
                  </View>
                </>
              ) : null}
              <View style={[styles.posSummaryRow, styles.posSummaryRowStrong]}>
                <Text style={[styles.posSummaryLabel, styles.posSummaryLabelStrong]}>Final Total</Text>
                <Text style={[styles.posSummaryValue, styles.posSummaryValueStrong]}>
                  {formatCurrencyDisplay(billingPreview.totalAmount, billingPreview.currencyCode)}
                </Text>
              </View>
            </View>

            <Text style={styles.paymentModalFieldLabel}>Waiter PIN</Text>
            <TextInput
              style={styles.paymentModalInput}
              value={activePaymentUpdate.pin}
              onChangeText={(value) =>
                setActivePaymentUpdate((current) => (current ? { ...current, pin: value.replace(/[^\d]/g, "") } : current))
              }
              placeholder="Enter PIN"
              placeholderTextColor={COLORS.TEXT_MUTED}
              keyboardType="number-pad"
              secureTextEntry
              editable={!busy}
            />

            <Text style={styles.paymentModalFieldLabel}>Mark As</Text>
            <View style={styles.paymentMethodRow}>
              {([
                { label: "Cash", value: "cash" as const },
                { label: "Card", value: "card" as const },
              ]).map((option) => {
                const isActive = activePaymentUpdate.paymentMethod === option.value
                return (
                  <Pressable
                    key={option.value}
                    style={[styles.paymentMethodButton, isActive ? styles.paymentMethodButtonActive : null]}
                    onPress={() =>
                      setActivePaymentUpdate((current) =>
                        current
                          ? {
                              ...current,
                              paymentMethod: option.value,
                              cardTransactionId: option.value === "card" ? current.cardTransactionId : "",
                            }
                          : current,
                      )
                    }
                    disabled={busy}
                  >
                    <Text style={[styles.paymentMethodButtonText, isActive ? styles.paymentMethodButtonTextActive : null]}>
                      {option.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>

            {activePaymentUpdate.paymentMethod === "card" ? (
              <>
                <Text style={styles.paymentModalFieldLabel}>Card Transaction ID</Text>
                <TextInput
                  style={styles.paymentModalInput}
                  value={activePaymentUpdate.cardTransactionId}
                  onChangeText={(value) =>
                    setActivePaymentUpdate((current) => (current ? { ...current, cardTransactionId: value } : current))
                  }
                  placeholder="Optional transaction reference"
                  placeholderTextColor={COLORS.TEXT_MUTED}
                  autoCapitalize="characters"
                  editable={!busy}
                />
              </>
            ) : null}

            {showTipControls ? (
              <>
                <Text style={styles.paymentModalFieldLabel}>{billingPreview.tipLabel}</Text>
                {fulfillmentType === "pickup" ? (
                  <Text style={styles.printCenterHelperText}>
                    Add any pickup tip before marking the order as paid. It will be added to the final bill.
                  </Text>
                ) : null}
                {showTipSuggestions ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.scannerRestaurantSelector}
                  >
                    {[0, ...tipSuggestions].map((tipPercent) => {
                      const suggestedTipAmount =
                        tipPercent <= 0 ? 0 : getTipAmountFromPercent(billingPreview.subtotalAmount, tipPercent)
                      const isActive = Math.abs(tipAmountPreview - suggestedTipAmount) < 0.01

                      return (
                        <Pressable
                          key={`tip-suggestion-${tipPercent}`}
                          style={[
                            styles.scannerRestaurantChip,
                            isActive ? styles.scannerRestaurantChipActive : null,
                          ]}
                          onPress={() =>
                            setActivePaymentUpdate((current) =>
                              current ? { ...current, tipAmount: suggestedTipAmount.toFixed(2) } : current
                            )
                          }
                          disabled={busy}
                        >
                          <Text
                            style={[
                              styles.scannerRestaurantChipText,
                              isActive ? styles.scannerRestaurantChipTextActive : null,
                            ]}
                          >
                            {tipPercent <= 0
                              ? "No Tip"
                              : `${tipPercent}% - ${formatCurrencyDisplay(suggestedTipAmount, billingPreview.currencyCode)}`}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </ScrollView>
                ) : null}
                <TextInput
                  style={styles.paymentModalInput}
                  value={activePaymentUpdate.tipAmount}
                  onChangeText={(value) => {
                    const numericOnly = value.replace(/[^0-9.]/g, "")
                    const decimalIndex = numericOnly.indexOf(".")
                    const sanitizedValue =
                      decimalIndex >= 0
                        ? `${numericOnly.slice(0, decimalIndex + 1)}${numericOnly.slice(decimalIndex + 1).replace(/\./g, "")}`
                        : numericOnly

                    setActivePaymentUpdate((current) => (current ? { ...current, tipAmount: sanitizedValue } : current))
                  }}
                  placeholder="Enter tip amount"
                  placeholderTextColor={COLORS.TEXT_MUTED}
                  keyboardType="decimal-pad"
                  editable={!busy}
                />
              </>
            ) : null}

            <View style={styles.paymentModalActionStack}>
              <Pressable
                style={[styles.paymentModalPrimaryButton, busy ? styles.authSubmitButtonDisabled : null]}
                onPress={handleConfirmPaidOrder}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={COLORS.SURFACE} size="small" />
                ) : (
                  <Text style={styles.paymentModalPrimaryButtonText}>
                    Mark {activePaymentUpdate.paymentMethod === "card" ? "Card Paid" : "Cash Paid"}
                  </Text>
                )}
              </Pressable>

              {canResetToUnpaid ? (
                <Pressable
                  style={[styles.paymentModalSecondaryButton, busy ? styles.authSubmitButtonDisabled : null]}
                  onPress={handleResetOrderToUnpaid}
                  disabled={busy}
                >
                  <Text style={styles.paymentModalSecondaryButtonText}>Move Back To Unpaid</Text>
                </Pressable>
              ) : null}

              <Pressable style={styles.paymentModalCancelButton} onPress={closePaymentUpdateModal} disabled={busy}>
                <Text style={styles.paymentModalCancelButtonText}>Cancel</Text>
              </Pressable>
            </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    )
  }

  function getReceiptRestaurantName() {
    return selectedRestaurant?.name?.trim() || restaurantName.trim() || "Restaurant"
  }

  function getPreferredPrinterDisplayName() {
    return printPreferences.selectedPrinterName.trim() || "No printer selected"
  }

  function getSelectedPrinterUrl() {
    return printPreferences.selectedPrinterUrl?.trim() || null
  }

  function hasSelectedPrinterTarget() {
    return printPreferences.selectedPrinterId.trim().length > 0
  }

  function handleSelectPrinterOption(option: PrinterOption) {
    setPrintPreferences((current) => ({
      ...current,
      selectedPrinterId: option.id,
      selectedPrinterName: option.name,
      selectedPrinterUrl: option.printerUrl,
    }))
    setIsPrinterDropdownOpen(false)
  }

  async function handleChoosePrinterFromDevice() {
    if (Platform.OS !== "ios") {
      showNotification("Not Available", "This device only supports the system print sheet from the app.", "warning")
      return
    }

    setBusy(true)
    try {
      const selectedPrinter = await Print.selectPrinterAsync()
      const printerOption: PrinterOption = {
        id: selectedPrinter.url?.trim() || `ios:${selectedPrinter.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: selectedPrinter.name.trim() || "AirPrint printer",
        printerUrl: selectedPrinter.url?.trim() || null,
      }

      setAvailablePrinterOptions((current) => mergePrinterOptions(getDefaultPrinterOptions(), current, [printerOption]))
      setPrintPreferences((current) => ({
        ...current,
        selectedPrinterId: printerOption.id,
        selectedPrinterName: printerOption.name,
        selectedPrinterUrl: printerOption.printerUrl,
      }))
      setIsPrinterDropdownOpen(false)
      showNotification("Printer Selected", `${printerOption.name} is ready to use.`, "success")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not choose a printer."
      if (message.toLowerCase().includes("cancel")) {
        return
      }
      showNotification("Printer Lookup Failed", message, "error")
    } finally {
      setBusy(false)
    }
  }

  function buildDaySummarySnapshot(): DaySummarySnapshot {
    const now = new Date()
    const todayOrders = orders.filter((order) => isSameLocalCalendarDay(order.created_at, now))
    let pendingOrders = 0
    let completedOrders = 0
    let grossTotal = 0
    let cashTotal = 0
    let creditTotal = 0
    let codOutstandingTotal = 0
    let unpaidOutstandingTotal = 0

    for (const order of todayOrders) {
      const billing = normalizeOrderBillingBreakdown(order, {
        fallbackSubtotalAmount: Number(order.totalPrice || 0),
        fallbackCurrencyCode: order.currencyCode || selectedCurrencyCode,
        fallbackTipLabel: order.tipLabel || billingConfig?.tipLabel || "Gratuity",
      })
      const totalPrice = billing.totalAmount
      const fulfillmentType = normalizeFulfillmentType(order.fulfillmentType)
      const paymentCollection = resolvePaymentCollection(fulfillmentType, order.paymentCollection)
      const paymentStatus = normalizePaymentStatus(order.paymentStatus)
      const paymentMethod = normalizePaymentMethod(order.paymentMethod)

      grossTotal += totalPrice

      if (order.status === "closed") {
        completedOrders += 1
      } else {
        pendingOrders += 1
      }

      if (paymentStatus === "paid" && paymentMethod === "cash") {
        cashTotal += totalPrice
        continue
      }

      if (paymentStatus === "paid" && paymentMethod === "card") {
        creditTotal += totalPrice
        continue
      }

      if (paymentCollection === "cod") {
        codOutstandingTotal += totalPrice
      } else {
        unpaidOutstandingTotal += totalPrice
      }
    }

    return {
      reportDateLabel: now.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      }),
      printedAtLabel: now.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
      currencyCode: selectedCurrencyCode,
      totalOrders: todayOrders.length,
      pendingOrders,
      completedOrders,
      grossTotal,
      cashTotal,
      creditTotal,
      codOutstandingTotal,
      unpaidOutstandingTotal,
    }
  }

  async function handleSavePrintPreferences() {
    if (!selectedRestaurant) {
      return
    }

    const hasPrinterTarget = hasSelectedPrinterTarget()
    const nextPreferences: PrintPreferencesState = {
      autoPrintEnabled: hasPrinterTarget ? Boolean(printPreferences.autoPrintEnabled) : false,
      selectedPrinterId: hasPrinterTarget ? printPreferences.selectedPrinterId.trim() : "",
      selectedPrinterName: hasPrinterTarget ? printPreferences.selectedPrinterName.trim() : "",
      selectedPrinterUrl: hasPrinterTarget ? printPreferences.selectedPrinterUrl?.trim() || null : null,
    }

    setBusy(true)
    try {
      await saveStoredPrintPreferences(selectedRestaurant.id, nextPreferences)
      setPrintPreferences(nextPreferences)
      showNotification(
        "Saved",
        nextPreferences.selectedPrinterName
          ? `Print settings saved for ${nextPreferences.selectedPrinterName}.`
          : "Print settings saved.",
        "success",
      )
    } catch (error) {
      showNotification("Save Failed", error instanceof Error ? error.message : "Could not save print settings.", "error")
    } finally {
      setBusy(false)
    }
  }

  async function handleAutoPrintOrders(ordersToPrint: UiOrderDraft[]) {
    if (ordersToPrint.length === 0) {
      return
    }

    const html =
      ordersToPrint.length === 1
        ? generateReceiptHTMLUtil(buildReceiptOrder(ordersToPrint[0]), getReceiptRestaurantName())
        : generateCombinedReceiptHTMLUtil(ordersToPrint.map(buildReceiptOrder), getReceiptRestaurantName())

    await printReceiptHtml(html, getSelectedPrinterUrl())
  }

  async function handleIncomingOrders(newOrders: RestaurantOrderRecord[]) {
    if (newOrders.length === 0) {
      return
    }

    const newOrderDrafts = newOrders.map(orderToUiDraft)
    const newOrderCount = newOrderDrafts.length
    const printerLabel = printPreferences.selectedPrinterName.trim()
    const title = newOrderCount === 1 ? "New Order" : "New Orders"
    const messageBase =
      newOrderCount === 1
        ? `${newOrderDrafts[0]?.customerName?.trim() || "Guest"} placed a new order.`
        : `${newOrderCount} new orders have come in.`
    const message = printPreferences.autoPrintEnabled
      ? `${messageBase} ${printerLabel ? `Opening the print sheet for ${printerLabel}.` : "Opening the print sheet now."}`
      : messageBase

    queueNewOrderAlert(newOrderCount)
    showNotification(title, message, "info")

    if (!printPreferences.autoPrintEnabled) {
      return
    }

    try {
      await handleAutoPrintOrders(newOrderDrafts)
    } catch (error) {
      showNotification(
        "Auto Print Failed",
        error instanceof Error ? error.message : "Could not open the print sheet for the new order.",
        "warning",
      )
    }
  }

  function renderPrintCenterModal() {
    if (!isPrintCenterVisible || !selectedRestaurant || appMode !== "admin") {
      return null
    }

    const canChooseNativePrinter = Platform.OS === "ios"
    const canEnableAutoPrint = hasSelectedPrinterTarget()
    const printCenterMaxHeight = Math.max(360, viewportHeight - 40)

    return (
      <Modal
        visible
        transparent
        animationType="fade"
        onRequestClose={() => {
          setIsPrinterDropdownOpen(false)
          setIsPrintCenterVisible(false)
        }}
        statusBarTranslucent={false}
      >
        <View style={styles.paymentModalOverlay}>
          <Pressable
            style={styles.paymentModalBackdrop}
            onPress={() => {
              setIsPrinterDropdownOpen(false)
              setIsPrintCenterVisible(false)
            }}
          />
          <View style={[styles.paymentModalCard, styles.printCenterCard, { maxHeight: printCenterMaxHeight }]}>
            <ScrollView
              style={styles.printCenterScroll}
              contentContainerStyle={styles.printCenterScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.paymentModalTitle}>Printer Settings</Text>
              <Text style={styles.paymentModalSubtitle}>
                {getReceiptRestaurantName()} {"\u00B7"} {getPreferredPrinterDisplayName()}
              </Text>

              <Text style={styles.paymentModalFieldLabel}>Available Printers</Text>
              <Pressable
                style={[styles.paymentModalInput, styles.printerDropdownField, busy ? styles.authSubmitButtonDisabled : null]}
                onPress={() => {
                  if (availablePrinterOptions.length === 0 || busy) {
                    return
                  }
                  setIsPrinterDropdownOpen((current) => !current)
                }}
                disabled={availablePrinterOptions.length === 0 || busy}
              >
                <Text
                  style={[
                    styles.printerDropdownFieldText,
                    !printPreferences.selectedPrinterName.trim() ? styles.printerDropdownFieldPlaceholder : null,
                  ]}
                >
                  {printPreferences.selectedPrinterName.trim() || "Choose printer"}
                </Text>
                <Text style={styles.printerDropdownChevron}>{isPrinterDropdownOpen ? "▲" : "▼"}</Text>
              </Pressable>

              {isPrinterDropdownOpen ? (
                <View style={styles.printerDropdownMenu}>
                  {availablePrinterOptions.map((option) => {
                    const isActive = printPreferences.selectedPrinterId.trim() === option.id
                    return (
                      <Pressable
                        key={option.id}
                        style={[styles.printerDropdownItem, isActive ? styles.printerDropdownItemActive : null]}
                        onPress={() => handleSelectPrinterOption(option)}
                      >
                        <Text style={[styles.printerDropdownItemText, isActive ? styles.printerDropdownItemTextActive : null]}>
                          {option.name}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              ) : null}

              {canChooseNativePrinter ? (
                <Pressable style={styles.paymentModalSecondaryButton} onPress={handleChoosePrinterFromDevice} disabled={busy}>
                  <Text style={styles.paymentModalSecondaryButtonText}>Find Printer On This Device</Text>
                </Pressable>
              ) : null}

              <Text style={styles.paymentModalFieldLabel}>Auto Print New Orders</Text>
              <View style={styles.printToggleRow}>
                <View style={styles.printToggleTextWrap}>
                  <Text style={styles.printToggleTitle}>{printPreferences.autoPrintEnabled ? "Auto print is on" : "Auto print is off"}</Text>
                  <Text style={styles.printToggleHelperText}>
                    {canEnableAutoPrint
                      ? "New orders will open the print request automatically using the selected printer target."
                      : "Select a printer target first. The toggle stays off until a printer is chosen."}
                  </Text>
                </View>
                <Switch
                  value={Boolean(printPreferences.autoPrintEnabled) && canEnableAutoPrint}
                  onValueChange={(value) => setPrintPreferences((current) => ({ ...current, autoPrintEnabled: value }))}
                  disabled={!canEnableAutoPrint || busy}
                  trackColor={{ false: COLORS.BORDER, true: COLORS.ACCENT_LIGHT }}
                  thumbColor={Boolean(printPreferences.autoPrintEnabled) && canEnableAutoPrint ? COLORS.ACCENT : COLORS.SURFACE}
                />
              </View>

              <Text style={styles.printCenterHelperText}>
                Open any receipt preview if you want to print just one bill manually. Auto print uses the selected printer target
                whenever the device supports it.
              </Text>
              <Text style={styles.printCenterHelperText}>
                Browser and Android builds still rely on the device's own print sheet, so they cannot list every connected printer
                directly from the app.
              </Text>

              <View style={styles.paymentModalActionStack}>
                <Pressable
                  style={[styles.paymentModalPrimaryButton, busy ? styles.authSubmitButtonDisabled : null]}
                  onPress={handleSavePrintPreferences}
                  disabled={busy}
                >
                  <Text style={styles.paymentModalPrimaryButtonText}>Save Print Settings</Text>
                </Pressable>
                <Pressable style={styles.paymentModalSecondaryButton} onPress={handlePrintAllPending} disabled={busy}>
                  <Text style={styles.paymentModalSecondaryButtonText}>Print Pending Receipts</Text>
                </Pressable>
                <Pressable
                  style={styles.paymentModalCancelButton}
                  onPress={() => {
                    setIsPrinterDropdownOpen(false)
                    setIsPrintCenterVisible(false)
                  }}
                  disabled={busy}
                >
                  <Text style={styles.paymentModalCancelButtonText}>Close</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    )
  }

  function buildReceiptOrder(order: UiOrderDraft): ReceiptOrder {
    const parsedItems = parseOrderItemsFromText(order.itemsText)
    const items = parsedItems.map((item) => {
      const quantity = Math.max(1, Number(item.quantity || 1))
      const lineTotal = quantity * Number(item.unitPrice || 0)

      return {
        name: item.name,
        quantity,
        price: lineTotal,
      }
    })
    const billing = getDraftBillingSnapshot(order, parsedItems)
    const fulfillmentType = normalizeFulfillmentType(order.fulfillmentType)
    const paymentCollection = resolvePaymentCollection(fulfillmentType, order.paymentCollection)
    const paymentStatus = normalizePaymentStatus(order.paymentStatus)
    const paymentMethod = normalizePaymentMethod(order.paymentMethod)

    return {
      id: order.id,
      short_code: formatShortOrderCode(order.shortOrderCode) || order.id || "",
      status: getOrderStatusLabel(order.status),
      created_at: order.createdAt || new Date().toISOString(),
      fulfillment_type: fulfillmentType,
      payment_collection: paymentCollection,
      payment_status: paymentStatus,
      payment_method: paymentMethod,
      customer_name: order.customerName.trim() || "Voice Caller",
      customer_phone: order.customerPhone.trim() || null,
      delivery_postcode: fulfillmentType === "delivery" ? normalizeUkPostcode(order.deliveryPostcode) : null,
      delivery_address: fulfillmentType === "delivery" ? order.deliveryAddress.trim() || null : null,
      card_transaction_id: paymentStatus === "paid" && paymentMethod === "card" ? order.cardTransactionId.trim() || null : null,
      notes: order.notes.trim() || null,
      subtotal_amount: billing.subtotalAmount,
      tax_amount: billing.taxAmount,
      tax_rate_percent: billing.taxRatePercent,
      tax_inclusive: billing.taxInclusive,
      tax_label: billing.taxLabel,
      service_fee_amount: billing.serviceFeeAmount,
      service_fee_label: billing.serviceFeeLabel,
      tip_amount: billing.tipAmount,
      tip_label: billing.tipLabel,
      currency_code: billing.currencyCode,
      items,
      total_amount: billing.totalAmount,
      total: billing.totalAmount,
    }
  }

  async function handlePrint(order: UiOrderDraft) {
    try {
      const receiptOrder = buildReceiptOrder(order)
      const html = generateReceiptHTMLUtil(receiptOrder, getReceiptRestaurantName())
      await printReceiptHtml(html, getSelectedPrinterUrl())
    } catch (error) {
      Alert.alert("Print Error", "Could not print receipt. Please try again.")
      console.error("Print error:", error)
    }
  }

  function handlePrintAllPending() {
    const pendingOrders = orderDrafts.filter((order) => getOrderStatusTone(order.status) === "pending")
    if (pendingOrders.length === 0) {
      Alert.alert("No pending orders to print")
      return
    }

    Alert.alert("Print All Pending", `Print receipts for ${pendingOrders.length} pending orders?`, [
      {
        text: "Print All",
        onPress: async () => {
          try {
            const combinedHTML = generateCombinedReceiptHTMLUtil(
              pendingOrders.map(buildReceiptOrder),
              getReceiptRestaurantName(),
            )
            await printReceiptHtml(combinedHTML, getSelectedPrinterUrl())
          } catch (error) {
            Alert.alert("Print Error", "Could not print the pending receipts. Please try again.")
            console.error("Print all error:", error)
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ])
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
      await persistRestaurantSnapshot({
        restaurantId: selectedRestaurant.id,
        menuItems: saved,
      })
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
    if (!elevenLabsApiKey.trim()) {
      showNotification("Validation", "ElevenLabs API key is required.")
      return
    }
    setBusy(true)
    try {
      const created = await createRestaurantVoiceAgent({
        restaurantId: selectedRestaurant.id,
        apiKey: elevenLabsApiKey,
      })
      await saveStoredElevenLabsApiKey(selectedRestaurant.id, elevenLabsApiKey)
      const link = await getVoiceAgentLink(selectedRestaurant.id)
      setVoiceAgentLink(link)
      setManualAgentId(created.agentId)
      setSavedElevenLabsApiKey(elevenLabsApiKey.trim())
      setElevenLabsApiKey(elevenLabsApiKey.trim())
      setIsEditingElevenLabsApiKey(false)
      await persistRestaurantSnapshot({
        restaurantId: selectedRestaurant.id,
        voiceAgentLink: link,
      })
      showNotification("Connected", `Linked voice agent: ${created.agentId}`)
    } catch (error) {
      showNotification("Voice Agent Error", error instanceof Error ? error.message : "Failed to connect voice agent.")
    } finally {
      setBusy(false)
    }
  }

  async function handleLinkManualAgent() {
    if (!selectedRestaurant) return
    if (!manualAgentId.trim()) {
      showNotification("Validation", "Agent ID is required.")
      return
    }
    setBusy(true)
    try {
      await saveVoiceAgentLink({
        restaurantId: selectedRestaurant.id,
        workspaceBaseUrl: ELEVENLABS_API_ORIGIN,
        workspaceAgentId: manualAgentId.trim(),
      })
      const link = await getVoiceAgentLink(selectedRestaurant.id)
      setVoiceAgentLink(link)
      await persistRestaurantSnapshot({
        restaurantId: selectedRestaurant.id,
        voiceAgentLink: link,
      })
      showNotification("Linked", "Existing ElevenLabs agent linked successfully.")
    } catch (error) {
      showNotification("Link Failed", error instanceof Error ? error.message : "Failed to link existing agent.")
    } finally {
      setBusy(false)
    }
  }

  async function handleSyncRestaurantData() {
    await syncSelectedRestaurantData({ showSuccessNotice: true })
  }

  async function handleSaveElevenLabsApiKey() {
    if (!selectedRestaurant) {
      showNotification("Restaurant Required", "Select a restaurant first.")
      return
    }
    if (!elevenLabsApiKey.trim()) {
      showNotification("Validation", "ElevenLabs API key is required.")
      return
    }

    setBusy(true)
    try {
      await saveStoredElevenLabsApiKey(selectedRestaurant.id, elevenLabsApiKey)
      const trimmedApiKey = elevenLabsApiKey.trim()
      setSavedElevenLabsApiKey(trimmedApiKey)
      setElevenLabsApiKey(trimmedApiKey)
      setIsEditingElevenLabsApiKey(false)
      showNotification("Saved", "ElevenLabs API key updated.")
    } catch (error) {
      showNotification("Save Failed", error instanceof Error ? error.message : "Failed to save the API key.")
    } finally {
      setBusy(false)
    }
  }

  const pendingOrderCount = orderDrafts.filter((order) => getOrderStatusTone(order.status) === "pending").length
  const closedOrderCount = orderDrafts.filter((order) => getOrderStatusTone(order.status) === "complete").length
  const voiceOrderCount = orderDrafts.filter((order) => hasCallReviewContent(order.callReview)).length
  const filteredOrderCards = orderDrafts
    .map((order, index) => ({ order, index }))
    .filter(({ order }) => matchesOrderStatusFilter(order.status, statusFilter))
  const isSettingsMode = settingsReturnTab !== null
  const activeCallReviewTranscriptText = activeCallReview?.callReview?.transcriptText?.trim() || ""
  const activeCallReviewRecordingUrl = getCallReviewPlaybackUri(activeCallReview?.callReview || null)
  const activeCallReviewHasRecording = activeCallReviewRecordingUrl.length > 0
  const activeCallReviewAnalysisStatus = activeCallReview?.callReview?.analysisStatus?.trim() || "available"
  const activeCallReviewEntries = activeCallReviewTranscriptText
    ? parseTranscriptEntries(activeCallReviewTranscriptText)
    : []
  const activeCallReviewRecordingCurrentTime = Math.max(0, Number(callReviewPlayerStatus.currentTime || 0))
  const activeCallReviewRecordingDuration = Math.max(0, Number(callReviewPlayerStatus.duration || 0))
  const activeCallReviewRecordingProgress =
    activeCallReviewRecordingDuration > 0
      ? Math.min(1, activeCallReviewRecordingCurrentTime / activeCallReviewRecordingDuration)
      : 0
  const syncStatusLabel = isSyncingRestaurantData
    ? "Syncing latest changes..."
    : isOfflineMode
      ? restaurantDataLastSyncedAt
        ? `Offline mode - showing cached data from ${formatSyncTimestamp(restaurantDataLastSyncedAt)}`
        : "Offline mode - showing cached restaurant data."
      : orderRealtimeStatus === "subscribed"
        ? restaurantDataLastSyncedAt
          ? `Live sync connected. Last synced ${formatSyncTimestamp(restaurantDataLastSyncedAt)}`
          : "Live sync connected."
        : orderRealtimeStatus === "connecting"
          ? "Connecting live sync..."
      : restaurantDataLastSyncedAt
        ? `Last synced ${formatSyncTimestamp(restaurantDataLastSyncedAt)}`
        : "Tap Sync to load the latest changes."

  function openAdminSettings() {
    setSettingsReturnTab(activeTab === "overview" ? "orders" : activeTab)
    setAppMode("admin")
  }

  function closeAdminSettings() {
    setAppMode("pos")
    setActiveTab(settingsReturnTab || "orders")
    setSettingsReturnTab(null)
  }

  function handleAdminHeaderBack() {
    if (settingsReturnTab) {
      closeAdminSettings()
      return
    }

    setAppMode("pos")
    setActiveTab("orders")
  }

  function renderPosOrdersEmptyState() {
    return (
      <View style={styles.posEmptyState}>
        <View style={styles.emptyStateIconCircle}>
          <AppIcon name="clipboard" size={30} color={COLORS.ACCENT} />
        </View>
        <Text style={styles.posEmptyStateTitle}>No orders yet</Text>
        <Text style={styles.posEmptyStateSubtitle}>Voice agent orders appear here automatically</Text>
        <Pressable style={styles.posEmptyStateButton} onPress={handleRefreshOrders} disabled={busy}>
          <ButtonLabel icon="refresh-cw" label="Check for orders" color={COLORS.SURFACE} textStyle={styles.posEmptyStateButtonText} />
        </Pressable>
      </View>
    )
  }

  function renderPosOrdersHeaderCard() {
    const preferredPrinterLabel = printPreferences.selectedPrinterName.trim()
    const printStatusLabel = printPreferences.autoPrintEnabled
      ? preferredPrinterLabel
        ? `Auto print on · ${preferredPrinterLabel}`
        : "Auto print on · system print sheet"
      : "Use Day Summary for totals. Receipt preview stays on each order."
    void printStatusLabel
    const resolvedPrintStatusLabel = printPreferences.autoPrintEnabled
      ? preferredPrinterLabel
        ? `Auto print on - ${preferredPrinterLabel}`
        : "Auto print on - system print sheet"
      : "Use Day Summary for totals. Receipt preview stays on each order."
    const syncButtonDisabled = busy || isSyncingRestaurantData || !selectedRestaurant

    return (
      <View style={[styles.posOrdersHeaderCard, isTabletLandscape ? styles.posOrdersHeaderCardLandscape : null]}>
        <View style={styles.posOrdersHeaderTopRow}>
          <View style={styles.posOrdersHeadingRow}>
            <View style={styles.posOrdersHeadingTextWrap}>
              <Text style={styles.posOrdersTitle}>Orders</Text>
              <Text style={styles.posOrdersSubtitle}>{resolvedPrintStatusLabel}</Text>
              <Text style={[styles.posOrdersSyncStatus, isOfflineMode ? styles.posOrdersSyncStatusOffline : null]}>{syncStatusLabel}</Text>
            </View>
          </View>
          <View style={styles.posOrdersHeaderActionRow}>
            <Pressable style={styles.posPrintCenterButton} onPress={() => setActiveTab("summary")} disabled={busy}>
              <ButtonLabel icon="bar-chart-2" label="Day Summary" color={COLORS.TEXT_PRIMARY} textStyle={styles.posPrintCenterButtonText} />
            </Pressable>
            <Pressable style={styles.posHeaderSyncButton} onPress={() => { void handleSyncRestaurantData() }} disabled={syncButtonDisabled}>
              <ButtonLabel
                icon="refresh-cw"
                label={isSyncingRestaurantData ? "Syncing..." : "Sync"}
                color={COLORS.SURFACE}
                textStyle={styles.posHeaderSyncButtonText}
              />
            </Pressable>
          </View>
        </View>
      </View>
    )
  }

  function renderPosOrderFilters() {
    const filterOptions: Array<{ key: OrderStatusFilter; label: string; count: number }> = [
      { key: "all", label: "All", count: orderDrafts.length },
      { key: "pending", label: "Pending", count: pendingOrderCount },
      { key: "complete", label: "Complete", count: closedOrderCount },
    ]

    return (
      <View style={[styles.posFilterBar, isTabletLandscape ? styles.posFilterBarLandscape : null]}>
        {filterOptions.map((option) => {
          const isActive = statusFilter === option.key
          return (
            <Pressable
              key={option.key}
              style={[styles.posFilterTab, isActive ? styles.posFilterTabActive : null]}
              onPress={() => setStatusFilter(option.key)}
            >
              <Text style={styles.posFilterTabText}>
                <Text style={isActive ? styles.posFilterTabLabelActive : styles.posFilterTabLabelInactive}>{option.label}</Text>
                <Text style={styles.posFilterTabCount}> ({option.count})</Text>
              </Text>
            </Pressable>
          )
        })}
      </View>
    )
  }

  function renderPosOrderCard(order: UiOrderDraft, index: number) {
    const draftItemsPreview = parseOrderItemsFromText(order.itemsText)
    const billing = getDraftBillingSnapshot(order, draftItemsPreview)
    const displayOrderCode = formatShortOrderCode(order.shortOrderCode)
    const statusTone = getOrderStatusTone(order.status)
    const statusLabel = getOrderStatusLabel(order.status)
    const isVoiceOrder = hasCallReviewContent(order.callReview)
    const customerName = order.customerName.trim() || "Voice Caller"
    const customerPhone = order.customerPhone.trim()
    const fulfillmentType = normalizeFulfillmentType(order.fulfillmentType)
    const paymentCollection = resolvePaymentCollection(fulfillmentType, order.paymentCollection)
    const paymentStatus = normalizePaymentStatus(order.paymentStatus)
    const paymentMethod = normalizePaymentMethod(order.paymentMethod)
    const deliveryAddress = order.deliveryAddress.trim()
    const deliveryPostcode = normalizeUkPostcode(order.deliveryPostcode)
    const paymentDisplayLabel = getOrderPaymentDisplayLabel({
      fulfillmentType,
      paymentCollection,
      paymentStatus,
      paymentMethod,
    })
    const accentStyle = statusTone === "complete" ? styles.posOrderAccentSuccess : styles.posOrderAccentPending
    const statusPillStyle = statusTone === "complete" ? styles.posOrderStatusPillSuccess : styles.posOrderStatusPillPending
    const statusPillTextStyle = statusTone === "complete" ? styles.posOrderStatusPillTextSuccess : styles.posOrderStatusPillTextPending
    const completeAction = (
      <Pressable
        style={[
          styles.posOrderActionButton,
          statusTone === "pending" ? styles.posOrderActionSuccess : styles.posOrderActionOutline,
        ]}
        onPress={() => handleQuickToggleOrderStatus(index)}
        disabled={busy}
      >
        <ButtonLabel
          icon={statusTone === "pending" ? "check" : "rotate-ccw"}
          label={statusTone === "pending" ? "Complete" : "Pending"}
          color={statusTone === "pending" ? COLORS.SURFACE : COLORS.ACCENT}
          textStyle={[
            styles.posOrderActionButtonText,
            statusTone === "pending" ? styles.posOrderActionButtonTextOnDark : styles.posOrderActionButtonTextOutline,
          ]}
        />
      </Pressable>
    )
    const callReviewAction = isVoiceOrder ? (
      <Pressable
        style={[styles.posOrderActionButton, styles.posOrderActionVoice]}
        onPress={() => openOrderCallReview(customerName, order.callReview)}
      >
        <ButtonLabel
          icon="mic"
          label="Call Review"
          color={COLORS.VOICE_COLOR}
          textStyle={[styles.posOrderActionButtonText, styles.posOrderActionButtonTextVoice]}
        />
      </Pressable>
    ) : null
    const billPreviewAction = (
      <Pressable
        style={[styles.posOrderActionButton, styles.posOrderActionOutline]}
        onPress={() => setPreviewOrder(order)}
        accessibilityLabel="Bill preview"
      >
        <ButtonLabel
          icon="eye"
          label="Receipt Preview"
          color={COLORS.ACCENT}
          textStyle={[styles.posOrderActionButtonText, styles.posOrderActionButtonTextOutline]}
        />
      </Pressable>
    )
    const detailsToggleAction = order.id ? (
      <Pressable style={styles.posOrderEditorToggle} onPress={() => openEditOrderModal(index)}>
        <ButtonLabel icon="edit-3" label="Edit Details" color={COLORS.ACCENT} textStyle={styles.posOrderEditorToggleText} />
      </Pressable>
    ) : null

    return (
      <View
        key={`pos-order-card-${order.id || index}`}
        style={[
          styles.posOrderCard,
          usePosGridLayout ? styles.posOrderCardTablet : null,
          isWideTabletLandscape ? styles.posOrderCardTabletWide : null,
        ]}
      >
        <View style={[styles.posOrderAccentBar, accentStyle]} />
        <View style={styles.posOrderCardBody}>
          <View style={styles.posOrderTopRow}>
            <Text style={styles.posOrderCode}>#{displayOrderCode || (statusTone === "complete" ? "DONE" : "NEW")}</Text>
            <View style={[styles.posOrderStatusPill, statusPillStyle]}>
              <Text style={[styles.posOrderStatusPillText, statusPillTextStyle]}>{statusLabel}</Text>
            </View>
          </View>

          <View style={styles.posOrderCustomerRow}>
            <Text style={styles.posOrderCustomerNameText} numberOfLines={1}>
              {customerName}
            </Text>
            {customerPhone ? (
              <View style={styles.inlineMetaRow}>
                <AppIcon name="phone" size={14} color={COLORS.TEXT_SECONDARY} />
                <Text style={styles.posOrderCustomerPhone}>{customerPhone}</Text>
              </View>
            ) : null}
          </View>
          <View style={styles.orderMetaBadgeRow}>
            {fulfillmentType === "delivery" ? (
              <View style={[styles.orderMetaBadge, styles.orderMetaBadgeDelivery]}>
                <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextDelivery]}>
                  {getFulfillmentTypeLabel(fulfillmentType)}
                </Text>
              </View>
            ) : null}
            <Pressable
              style={[styles.orderMetaBadge, styles.orderMetaBadgePayment]}
              onPress={() => openPaymentUpdateModal(index)}
              disabled={!order.id || busy}
            >
              <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextPayment]}>
                {paymentDisplayLabel}
              </Text>
            </Pressable>
          </View>
          {fulfillmentType === "delivery" && (deliveryAddress || deliveryPostcode) ? (
            <Text style={styles.orderDeliveryAddressText} numberOfLines={2}>
              {deliveryAddress || deliveryPostcode}
            </Text>
          ) : null}
          <View style={styles.posOrderDivider} />

          <View style={styles.posOrderItemsList}>
            {draftItemsPreview.length > 0 ? (
              draftItemsPreview.map((item, itemIndex) => {
                const quantity = Math.max(1, Number(item.quantity || 1))
                const lineTotal = quantity * Number(item.unitPrice || 0)
                return (
                  <View key={`pos-order-item-${item.name}-${itemIndex}`} style={styles.posOrderItemRow}>
                    <Text style={styles.posOrderItemName}>{item.name} {"\u00D7"} {quantity}</Text>
                    <Text style={styles.posOrderItemPrice}>{formatCurrencyDisplay(lineTotal, billing.currencyCode)}</Text>
                  </View>
                )
              })
            ) : (
              <Text style={styles.posOrderItemEmpty}>No items yet.</Text>
            )}
          </View>

          <View style={styles.posOrderTotalRow}>
            <Text style={styles.posOrderTotalLabel}>TOTAL</Text>
            <Text style={styles.posOrderTotalAmount}>{formatCurrencyDisplay(billing.totalAmount, billing.currencyCode)}</Text>
          </View>

          <View style={styles.posOrderDivider} />

          <View style={styles.posOrderActionStack}>
            <View style={styles.posOrderActionRow}>
              {completeAction}
              {callReviewAction}
            </View>
            <View style={styles.posOrderActionRow}>{billPreviewAction}</View>
            {detailsToggleAction}
          </View>
        </View>
      </View>
    )
  }

  function renderPosOrdersTab() {
    return (
      <View style={[styles.posTabSection, isTabletLandscape ? styles.posTabSectionLandscape : null]}>
        {renderPosOrdersHeaderCard()}
        {renderPosOrderFilters()}

        {filteredOrderCards.length === 0 ? (
          renderPosOrdersEmptyState()
        ) : (
          <View
            style={[
              styles.posOrdersGrid,
              usePosGridLayout ? styles.posOrdersGridTablet : null,
              isTabletLandscape ? styles.posOrdersGridLandscape : null,
            ]}
          >
            {filteredOrderCards.map(({ order, index }) => renderPosOrderCard(order, index))}
          </View>
        )}
      </View>
    )
  }

  function renderPosSummaryTab() {
    const summary = buildDaySummarySnapshot()
    const outstandingTotal = summary.codOutstandingTotal + summary.unpaidOutstandingTotal

    return (
      <View style={[styles.posTabSection, isTabletLandscape ? styles.posTabSectionLandscape : null]}>
        <View style={[styles.posOrdersHeaderCard, isTabletLandscape ? styles.posOrdersHeaderCardLandscape : null]}>
          <View style={styles.posOrdersHeaderTopRow}>
            <View style={styles.posOrdersHeadingRow}>
              <View style={styles.posOrdersHeadingTextWrap}>
                <Text style={styles.posOrdersTitle}>Day Summary</Text>
                <Text style={styles.posOrdersSubtitle}>{summary.reportDateLabel}</Text>
              </View>
            </View>
            <View style={styles.posOrdersHeaderActionRow}>
              <Pressable style={styles.posPrintCenterButton} onPress={() => setActiveTab("orders")}>
                <ButtonLabel icon="arrow-left" label="Back To Orders" color={COLORS.TEXT_PRIMARY} textStyle={styles.posPrintCenterButtonText} />
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.posSummaryCard}>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Orders</Text>
            <Text style={styles.posSummaryValue}>{summary.totalOrders}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Pending</Text>
            <Text style={styles.posSummaryValue}>{summary.pendingOrders}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Completed</Text>
            <Text style={styles.posSummaryValue}>{summary.completedOrders}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Gross Sales</Text>
            <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(summary.grossTotal, summary.currencyCode)}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Cash</Text>
            <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(summary.cashTotal, summary.currencyCode)}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Card</Text>
            <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(summary.creditTotal, summary.currencyCode)}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>COD Outstanding</Text>
            <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(summary.codOutstandingTotal, summary.currencyCode)}</Text>
          </View>
          <View style={styles.posSummaryRow}>
            <Text style={styles.posSummaryLabel}>Unpaid Outstanding</Text>
            <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(summary.unpaidOutstandingTotal, summary.currencyCode)}</Text>
          </View>
          <View style={[styles.posSummaryRow, styles.posSummaryRowStrong]}>
            <Text style={[styles.posSummaryLabel, styles.posSummaryLabelStrong]}>Outstanding Total</Text>
            <Text style={[styles.posSummaryValue, styles.posSummaryValueStrong]}>
              {formatCurrencyDisplay(outstandingTotal, summary.currencyCode)}
            </Text>
          </View>
        </View>
      </View>
    )
  }

  function renderPosMenuTab() {
    return (
      <View style={styles.posTabSection}>
        <View style={styles.posPanelCard}>
          <Text style={styles.posPanelTitle}>Menu</Text>
          {savedItems.length === 0 ? (
            <Text style={styles.posPanelBody}>No menu items saved yet.</Text>
          ) : (
            savedItems.map((item, index) => (
              <View key={`${item.id || "pos-menu"}-${index}`} style={styles.posMenuItemCard}>
                <Text style={styles.posMenuItemTitle}>{item.name}</Text>
                <Text style={styles.posMenuItemMeta}>{formatCurrencyDisplay(item.basePrice, selectedCurrencyCode)}</Text>
                {item.description ? <Text style={styles.posMenuItemDescription}>{item.description}</Text> : null}
              </View>
            ))
          )}
        </View>
      </View>
    )
  }

  function renderPosVoiceTab() {
    return (
      <View style={styles.posTabSection}>
        <View style={styles.posPanelCard}>
          <Text style={styles.posPanelTitle}>Voice</Text>
          <ChannelBadge />
          <Text style={styles.posPanelBody}>
            {voiceAgentLink
              ? `Linked agent: ${voiceAgentLink.workspace_agent_id}`
              : "No voice agent linked yet. Open Settings to manage the ElevenLabs connection."}
          </Text>
          <Text style={styles.posPanelCaption}>Call review and customer audio stay attached to each order card.</Text>
        </View>
      </View>
    )
  }

  function renderPosHeader() {
    const activeRestaurantName = selectedRestaurant?.name?.trim() || restaurantName.trim() || "Select Restaurant"

    return (
      <View style={styles.posTopHeader}>
        <Text style={styles.posTopHeaderTitle} numberOfLines={2}>
          {activeRestaurantName}
        </Text>
        <View style={styles.posTopHeaderActions}>
          <Pressable style={styles.posSettingsButton} onPress={openAdminSettings} accessibilityLabel="Open settings">
            <AppIcon name="settings" size={18} color={COLORS.HEADER_TEXT} />
          </Pressable>
          <Pressable style={styles.posLogoutButton} onPress={handleLogout} accessibilityRole="button">
            <ButtonLabel icon="log-out" label="Logout" color={COLORS.HEADER_TEXT} size={15} textStyle={styles.posLogoutText} />
          </Pressable>
        </View>
      </View>
    )
  }

  function renderPosBottomTabs() {
    return null
  }

  function renderPosSidebar() {
    return <Sidebar activeTab={activeTab} onSelectTab={setActiveTab} onOpenSettings={openAdminSettings} />
  }

  function renderPosContent() {
    if (activeTab === "summary") {
      return renderPosSummaryTab()
    }

    return renderPosOrdersTab()
  }

  function renderBillingTab() {
    if (!selectedRestaurant) {
      return (
        <View style={[styles.settingsWideSection, isTabletLandscape ? styles.settingsWideSectionLandscape : null]}>
          <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
            <Text style={styles.scannerCardTitle}>Billing</Text>
            <Text style={styles.scannerDescription}>Select a restaurant first to configure taxes, service fees, tips, and currency.</Text>
          </View>
        </View>
      )
    }

    if (!billingConfig) {
      return (
        <View style={[styles.settingsWideSection, isTabletLandscape ? styles.settingsWideSectionLandscape : null]}>
          <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
            <Text style={styles.scannerCardTitle}>Billing</Text>
            <ActivityIndicator color={COLORS.ACCENT} size="small" />
            <Text style={styles.scannerDescription}>Loading billing settings...</Text>
          </View>
        </View>
      )
    }

    const previewTipPercent = billingConfig.tipEnabled ? Number(billingConfig.tipSuggestions[0] || 0) : 0
    const previewTipAmount = billingConfig.tipEnabled ? getTipAmountFromPercent(100, previewTipPercent) : 0
    const previewBilling = billingConfigToDraftBreakdown(billingConfig, 100, previewTipAmount)
    const selectedCountry = getSupportedBillingCountry(billingConfig.countryCode)
    const tipSuggestionsText = billingConfig.tipSuggestions.join(", ")
    const selectedTaxRate =
      billingConfig.availableTaxRates.find((taxRate) => taxRate.id === billingConfig.taxRateId) || null
    const customTaxRateText =
      billingConfig.taxRateOverride === null || billingConfig.taxRateOverride === undefined
        ? ""
        : String(billingConfig.taxRateOverride)
    const effectiveTaxRatePercent =
      billingConfig.taxRateOverride === null || billingConfig.taxRateOverride === undefined
        ? selectedTaxRate?.ratePercent || billingConfig.resolvedTaxRatePercent || 0
        : billingConfig.taxRateOverride

    return (
      <View style={[styles.settingsWideSection, isTabletLandscape ? styles.settingsWideSectionLandscape : null]}>
        <View style={[styles.settingsPanelsWrap, isTabletLandscape ? styles.settingsPanelsWrapLandscape : null]}>
          <View style={[isTabletLandscape ? styles.settingsPanelColumnLandscape : null]}>
            <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
              <Text style={styles.scannerCardTitle}>Billing Setup</Text>
              <Text style={styles.scannerDescription}>
                Taxes, service fees, tip prompts, receipts, and POS totals all use this configuration.
              </Text>

              <Text style={styles.paymentModalFieldLabel}>Country</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.scannerRestaurantSelector}
              >
                {SUPPORTED_BILLING_COUNTRIES.map((country) => {
                  const isActive = billingConfig.countryCode === country.code
                  return (
                    <Pressable
                      key={country.code}
                      style={[styles.scannerRestaurantChip, isActive ? styles.scannerRestaurantChipActive : null]}
                      onPress={() => handleBillingCountryChange(country.code)}
                      disabled={busy}
                    >
                      <Text
                        style={[
                          styles.scannerRestaurantChipText,
                          isActive ? styles.scannerRestaurantChipTextActive : null,
                        ]}
                      >
                        {country.name}
                      </Text>
                    </Pressable>
                  )
                })}
              </ScrollView>

              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Currency</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  value={billingConfig.currencyCode}
                  editable={false}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                />
              </View>

              <Text style={styles.paymentModalFieldLabel}>Are menu prices tax inclusive?</Text>
              <View style={styles.paymentMethodRow}>
                {([
                  { label: "Yes, tax included", value: true },
                  { label: "No, add tax", value: false },
                ]).map((option) => {
                  const isActive = billingConfig.taxInclusive === option.value
                  return (
                    <Pressable
                      key={`tax-mode-${String(option.value)}`}
                      style={[styles.paymentMethodButton, isActive ? styles.paymentMethodButtonActive : null]}
                      onPress={() => updateLocalBillingConfig({ taxInclusive: option.value })}
                      disabled={busy}
                    >
                      <Text style={[styles.paymentMethodButtonText, isActive ? styles.paymentMethodButtonTextActive : null]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>

              <Text style={styles.printCenterHelperText}>
                {billingConfig.taxInclusive
                  ? `${billingConfig.taxLabel} is already included in menu prices. Orders and receipts will still show the included tax amount.`
                  : `${billingConfig.taxLabel} will be added to the subtotal, so set the rate you want to charge below.`}
              </Text>

              <Text style={styles.paymentModalFieldLabel}>Tax Rate</Text>
              {billingConfig.availableTaxRates.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.scannerRestaurantSelector}
                >
                  {billingConfig.availableTaxRates.map((taxRate) => {
                    const isActive = billingConfig.taxRateId === taxRate.id
                    return (
                      <Pressable
                        key={taxRate.id}
                        style={[styles.scannerRestaurantChip, isActive ? styles.scannerRestaurantChipActive : null]}
                        onPress={() => handleBillingTaxRateSelect(taxRate.id)}
                        disabled={busy}
                      >
                        <Text
                          style={[
                            styles.scannerRestaurantChipText,
                            isActive ? styles.scannerRestaurantChipTextActive : null,
                          ]}
                        >
                          {taxRate.taxName} ({taxRate.ratePercent.toFixed(2)}%)
                        </Text>
                      </Pressable>
                    )
                  })}
                </ScrollView>
              ) : (
                <Text style={styles.printCenterHelperText}>
                  Tax rates are loading for {selectedCountry?.name || billingConfig.countryCode}. If nothing appears, run the billing SQL seeds first.
                </Text>
              )}

              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Custom Tax Rate Override (%)</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  value={customTaxRateText}
                  onChangeText={handleBillingTaxRateOverrideChange}
                  placeholder={selectedTaxRate ? `Use ${selectedTaxRate.ratePercent.toFixed(2)}%` : "Enter tax rate"}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  keyboardType="decimal-pad"
                  editable={!busy}
                />
              </View>

              <Text style={styles.printCenterHelperText}>
                {customTaxRateText
                  ? `Using a custom ${billingConfig.taxLabel} rate of ${effectiveTaxRatePercent.toFixed(2)}% for new order totals.`
                  : selectedTaxRate
                    ? `Using ${selectedTaxRate.taxName} at ${selectedTaxRate.ratePercent.toFixed(2)}% for this restaurant.`
                    : `Enter a custom rate or choose a seeded rate to calculate ${billingConfig.taxLabel.toLowerCase()} correctly.`}
              </Text>

              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Tax Label</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  value={billingConfig.taxLabel}
                  onChangeText={(value) => updateLocalBillingConfig({ taxLabel: value })}
                  placeholder="VAT"
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  editable={!busy}
                />
              </View>

              <Text style={styles.printCenterHelperText}>Active tax rate: {effectiveTaxRatePercent.toFixed(2)}%</Text>
            </View>
          </View>

          <View style={[isTabletLandscape ? styles.settingsPanelColumnLandscape : null]}>
            <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
              <Text style={styles.scannerCardTitle}>Service Fee & Tips</Text>

              <View style={styles.printToggleRow}>
                <View style={styles.printToggleTextWrap}>
                  <Text style={styles.printToggleTitle}>
                    {billingConfig.serviceFeeEnabled ? "Service fee is on" : "Service fee is off"}
                  </Text>
                  <Text style={styles.printToggleHelperText}>Add a flat fee or percentage automatically to each order.</Text>
                </View>
                <Switch
                  value={billingConfig.serviceFeeEnabled}
                  onValueChange={(value) =>
                    updateLocalBillingConfig({
                      serviceFeeEnabled: value,
                      serviceFeeType: value ? billingConfig.serviceFeeType || "percent" : null,
                      serviceFeeValue: value ? billingConfig.serviceFeeValue : 0,
                    })
                  }
                  disabled={busy}
                  trackColor={{ false: COLORS.BORDER, true: COLORS.ACCENT_LIGHT }}
                  thumbColor={billingConfig.serviceFeeEnabled ? COLORS.ACCENT : COLORS.SURFACE}
                />
              </View>

              {billingConfig.serviceFeeEnabled ? (
                <>
                  <Text style={styles.paymentModalFieldLabel}>Service Fee Type</Text>
                  <View style={styles.paymentMethodRow}>
                    {([
                      { label: "Percent", value: "percent" as const },
                      { label: "Flat Amount", value: "flat" as const },
                    ]).map((option) => {
                      const isActive = billingConfig.serviceFeeType === option.value
                      return (
                        <Pressable
                          key={`service-fee-${option.value}`}
                          style={[styles.paymentMethodButton, isActive ? styles.paymentMethodButtonActive : null]}
                          onPress={() => updateLocalBillingConfig({ serviceFeeType: option.value })}
                          disabled={busy}
                        >
                          <Text
                            style={[styles.paymentMethodButtonText, isActive ? styles.paymentMethodButtonTextActive : null]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </View>

                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>
                      Service Fee Value {billingConfig.serviceFeeType === "percent" ? "(%)" : `(${billingConfig.currencyCode})`}
                    </Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      value={billingConfig.serviceFeeValue ? String(billingConfig.serviceFeeValue) : ""}
                      onChangeText={(value) => {
                        const parsedValue = Number.parseFloat(value)
                        updateLocalBillingConfig({
                          serviceFeeValue: Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0,
                        })
                      }}
                      placeholder="0"
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      keyboardType="decimal-pad"
                      editable={!busy}
                    />
                  </View>

                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Service Fee Label</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      value={billingConfig.serviceFeeLabel}
                      onChangeText={(value) => updateLocalBillingConfig({ serviceFeeLabel: value })}
                      placeholder="Service Charge"
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      editable={!busy}
                    />
                  </View>
                </>
              ) : null}

              <View style={styles.printToggleRow}>
                <View style={styles.printToggleTextWrap}>
                  <Text style={styles.printToggleTitle}>{billingConfig.tipEnabled ? "Tips are on" : "Tips are off"}</Text>
                  <Text style={styles.printToggleHelperText}>Tip suggestions appear in the payment modal and roll into paid totals.</Text>
                </View>
                <Switch
                  value={billingConfig.tipEnabled}
                  onValueChange={(value) =>
                    updateLocalBillingConfig({
                      tipEnabled: value,
                      tipSuggestions: value && billingConfig.tipSuggestions.length === 0 ? [10, 12.5, 15, 20] : billingConfig.tipSuggestions,
                    })
                  }
                  disabled={busy}
                  trackColor={{ false: COLORS.BORDER, true: COLORS.ACCENT_LIGHT }}
                  thumbColor={billingConfig.tipEnabled ? COLORS.ACCENT : COLORS.SURFACE}
                />
              </View>

              {billingConfig.tipEnabled ? (
                <>
                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Tip Label</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      value={billingConfig.tipLabel}
                      onChangeText={(value) => updateLocalBillingConfig({ tipLabel: value })}
                      placeholder="Gratuity"
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      editable={!busy}
                    />
                  </View>

                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Tip Suggestions (%)</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      value={tipSuggestionsText}
                      onChangeText={(value) => {
                        const nextSuggestions = value
                          .split(",")
                          .map((entry) => Number.parseFloat(entry.trim()))
                          .filter((entry) => Number.isFinite(entry) && entry >= 0)
                        updateLocalBillingConfig({ tipSuggestions: nextSuggestions })
                      }}
                      placeholder="10, 12.5, 15, 20"
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      keyboardType="decimal-pad"
                      editable={!busy}
                    />
                  </View>

                  <Text style={styles.printCenterHelperText}>
                    Use comma-separated percentages. The payment modal calculates tips from the menu subtotal.
                  </Text>
                </>
              ) : null}

              <Text style={styles.paymentModalFieldLabel}>Live Preview</Text>
              <Text style={styles.printCenterHelperText}>
                Preview based on a {formatCurrencyDisplay(100, previewBilling.currencyCode)} menu subtotal.
              </Text>
              <View style={styles.posSummaryCard}>
                <View style={styles.posSummaryRow}>
                  <Text style={styles.posSummaryLabel}>Subtotal</Text>
                  <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(previewBilling.subtotalAmount, previewBilling.currencyCode)}</Text>
                </View>
                {previewBilling.taxAmount > 0 ? (
                  <View style={styles.posSummaryRow}>
                    <Text style={styles.posSummaryLabel}>
                      {previewBilling.taxLabel} ({previewBilling.taxRatePercent.toFixed(2)}%)
                    </Text>
                    <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(previewBilling.taxAmount, previewBilling.currencyCode)}</Text>
                  </View>
                ) : null}
                {previewBilling.serviceFeeAmount > 0 ? (
                  <View style={styles.posSummaryRow}>
                    <Text style={styles.posSummaryLabel}>{previewBilling.serviceFeeLabel}</Text>
                    <Text style={styles.posSummaryValue}>
                      {formatCurrencyDisplay(previewBilling.serviceFeeAmount, previewBilling.currencyCode)}
                    </Text>
                  </View>
                ) : null}
                {previewBilling.tipAmount > 0 ? (
                  <>
                    <View style={styles.posSummaryRow}>
                      <Text style={styles.posSummaryLabel}>Total Before Tip</Text>
                      <Text style={styles.posSummaryValue}>
                        {formatCurrencyDisplay(previewBilling.totalBeforeTip, previewBilling.currencyCode)}
                      </Text>
                    </View>
                    <View style={styles.posSummaryRow}>
                      <Text style={styles.posSummaryLabel}>{previewBilling.tipLabel}</Text>
                      <Text style={styles.posSummaryValue}>{formatCurrencyDisplay(previewBilling.tipAmount, previewBilling.currencyCode)}</Text>
                    </View>
                  </>
                ) : null}
                <View style={[styles.posSummaryRow, styles.posSummaryRowStrong]}>
                  <Text style={[styles.posSummaryLabel, styles.posSummaryLabelStrong]}>Total</Text>
                  <Text style={[styles.posSummaryValue, styles.posSummaryValueStrong]}>
                    {formatCurrencyDisplay(previewBilling.totalAmount, previewBilling.currencyCode)}
                  </Text>
                </View>
              </View>

              <Pressable style={styles.scannerPrimaryButton} onPress={handleSaveBillingConfiguration} disabled={busy}>
                <Text style={styles.scannerPrimaryButtonText}>{busy ? "Saving..." : "Save Billing Settings"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </View>
    )
  }

  function renderSettingsHeader() {
    if (appMode !== "admin") {
      return null
    }

    const isSettingsHeader = Boolean(settingsReturnTab)
    const syncButtonDisabled = busy || isSyncingRestaurantData || !selectedRestaurant

    return (
      <View style={styles.settingsHeader}>
        <Pressable
          style={styles.settingsBackButton}
          onPress={handleAdminHeaderBack}
        >
          <AppIcon name="arrow-left" size={18} color={COLORS.HEADER_TEXT} />
          <Text style={styles.settingsBackText}>Back</Text>
        </Pressable>
        <Text style={styles.settingsHeaderTitle}>{isSettingsHeader ? "Settings" : "Operations Console"}</Text>
        <View style={styles.settingsHeaderActions}>
          {isSettingsHeader ? <AppIcon name="settings" size={16} color={COLORS.HEADER_TEXT} /> : null}
          <Pressable style={styles.settingsHeaderSyncButton} onPress={() => { void handleSyncRestaurantData() }} disabled={syncButtonDisabled}>
            <ButtonLabel
              icon="refresh-cw"
              label={isSyncingRestaurantData ? "Syncing..." : "Sync"}
              color={COLORS.HEADER_TEXT}
              size={14}
              textStyle={styles.settingsHeaderSyncButtonText}
            />
          </Pressable>
          <Pressable style={styles.settingsHeaderPrinterButton} onPress={() => setIsPrintCenterVisible(true)}>
            <ButtonLabel icon="printer" label="Printer" color={COLORS.HEADER_TEXT} size={14} textStyle={styles.settingsHeaderPrinterButtonText} />
          </Pressable>
          <Pressable style={isSettingsHeader ? styles.settingsHeaderLogoutPlain : styles.settingsHeaderLogoutPill} onPress={handleLogout}>
            <ButtonLabel icon="log-out" label="Logout" color={COLORS.HEADER_TEXT} size={14} textStyle={styles.settingsHeaderLogoutText} />
          </Pressable>
        </View>
      </View>
    )
  }

  function renderOrdersEmptyState() {
    return (
      <View style={styles.ordersEmptyState}>
        <View style={styles.emptyStateIconCircle}>
          <AppIcon name="clipboard" size={28} color={COLORS.ACCENT} />
        </View>
        <Text style={styles.ordersEmptyTitle}>No orders yet</Text>
        <Text style={styles.ordersEmptySubtitle}>Orders from your voice agent will appear here</Text>
      </View>
    )
  }

  function renderOrdersHeader() {
    return (
      <View style={styles.ordersHeader}>
        <View style={styles.ordersHeaderText}>
          <Text style={[styles.ordersHeaderTitle, isCompactViewport ? styles.ordersHeaderTitleCompact : null]}>Orders</Text>
          <Text style={styles.ordersHeaderSubtitle}>{pendingOrderCount} pending</Text>
        </View>
        <View style={[styles.ordersHeaderActions, isCompactViewport ? styles.ordersHeaderActionsCompact : null]}>
          <Pressable style={styles.printAllButton} onPress={handlePrintAllPending} disabled={busy}>
            <ButtonLabel
              icon="printer"
              label={isCompactViewport ? "Print" : "Print All"}
              color={COLORS.SURFACE}
              textStyle={styles.printAllButtonText}
            />
          </Pressable>
          <Pressable
            style={[styles.ordersRefreshButton, isCompactViewport ? styles.ordersRefreshButtonCompact : null]}
            onPress={handleRefreshOrders}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Refresh orders"
          >
            <AppIcon name="refresh-cw" size={18} color={THEME.text} />
          </Pressable>
        </View>
      </View>
    )
  }

  function renderSettingsConsoleCard() {
    if (appMode !== "admin" || !settingsReturnTab) {
      return null
    }

    return (
      <View style={styles.voiceConsoleCard}>
        <View style={styles.voiceConsoleHeaderRow}>
          <View style={styles.voiceConsoleTextWrap}>
            <Text style={styles.voiceConsoleTitle}>Operations Console</Text>
            <Text style={styles.voiceConsoleEmail}>{user?.email || ""}</Text>
          </View>
        </View>
        {!isWeb ? (
          <View style={styles.voiceModeSwitch}>
            <Pressable style={[styles.voiceModeSwitchButton, styles.voiceModeSwitchButtonActive]} onPress={() => setAppMode("admin")}>
              <Text style={[styles.voiceModeSwitchText, styles.voiceModeSwitchTextActive]}>Admin</Text>
            </Pressable>
            <Pressable style={styles.voiceModeSwitchButton} onPress={() => setAppMode("pos")}>
              <Text style={styles.voiceModeSwitchText}>POS</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    )
  }

  function renderAdminTopContent() {
    return (
      <>
        {renderNotice()}
        {isSettingsMode ? null : (
          <View style={styles.adminIntroSection}>
            <View style={styles.adminSignedInRow}>
              <Text style={styles.adminSignedInLabel}>Signed in as</Text>
              <Text style={styles.adminSignedInValue}>{user?.email || ""}</Text>
            </View>
            {!isWeb ? (
              <View style={styles.modeSwitch}>
                <Pressable style={[styles.modeSwitchButton, styles.modeSwitchButtonActive]} onPress={() => setAppMode("admin")}>
                  <Text style={[styles.modeSwitchText, styles.modeSwitchTextActive]}>Admin</Text>
                </Pressable>
                <Pressable style={styles.modeSwitchButton} onPress={() => setAppMode("pos")}>
                  <Text style={styles.modeSwitchText}>POS</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        )}

        {renderSettingsConsoleCard()}

        {appMode === "admin" ? (
          <View style={[styles.metricsRow, isSettingsMode ? styles.settingsMetricsRow : null]}>
            <View style={[styles.metricCard, isSettingsMode ? styles.settingsMetricCard : null]}>
              <Text style={styles.metricValue}>{savedItems.length}</Text>
              <Text style={styles.metricLabel}>Menu Items</Text>
            </View>
            <View style={[styles.metricCard, isSettingsMode ? styles.settingsMetricCard : null]}>
              <Text style={styles.metricValue}>{pendingOrderCount}</Text>
              <Text style={styles.metricLabel}>Pending</Text>
            </View>
            <View style={[styles.metricCard, isSettingsMode ? styles.settingsMetricCard : null]}>
              <Text style={styles.metricValue}>{closedOrderCount}</Text>
              <Text style={styles.metricLabel}>Closed</Text>
            </View>
          </View>
        ) : null}

        {appMode === "admin" ? (
          <View style={[styles.mainTabs, isSettingsMode ? styles.settingsTabs : null]}>
            <Pressable
              style={[
                styles.mainTabButton,
                isSettingsMode ? styles.settingsTabButton : null,
                activeTab === "overview" ? styles.mainTabButtonActive : null,
                isSettingsMode && activeTab === "overview" ? styles.settingsTabButtonActive : null,
              ]}
              onPress={() => setActiveTab("overview")}
            >
              <Text
                style={[
                  styles.mainTabText,
                  activeTab === "overview" ? styles.mainTabTextActive : null,
                  isSettingsMode ? styles.settingsTabText : null,
                  isSettingsMode && activeTab === "overview" ? styles.settingsTabTextActive : null,
                ]}
              >
                Overview
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.mainTabButton,
                isSettingsMode ? styles.settingsTabButton : null,
                activeTab === "billing" ? styles.mainTabButtonActive : null,
                isSettingsMode && activeTab === "billing" ? styles.settingsTabButtonActive : null,
              ]}
              onPress={() => setActiveTab("billing")}
            >
              <Text
                style={[
                  styles.mainTabText,
                  activeTab === "billing" ? styles.mainTabTextActive : null,
                  isSettingsMode ? styles.settingsTabText : null,
                  isSettingsMode && activeTab === "billing" ? styles.settingsTabTextActive : null,
                ]}
              >
                Billing
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.mainTabButton,
                isSettingsMode ? styles.settingsTabButton : null,
                activeTab === "menu" ? styles.mainTabButtonActive : null,
                isSettingsMode && activeTab === "menu" ? styles.settingsTabButtonActive : null,
              ]}
              onPress={() => setActiveTab("menu")}
            >
              <Text
                style={[
                  styles.mainTabText,
                  activeTab === "menu" ? styles.mainTabTextActive : null,
                  isSettingsMode ? styles.settingsTabText : null,
                  isSettingsMode && activeTab === "menu" ? styles.settingsTabTextActive : null,
                ]}
              >
                Menu
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.mainTabButton,
                isSettingsMode ? styles.settingsTabButton : null,
                activeTab === "orders" ? styles.mainTabButtonActive : null,
                isSettingsMode && activeTab === "orders" ? styles.settingsTabButtonActive : null,
              ]}
              onPress={() => setActiveTab("orders")}
            >
              <Text
                style={[
                  styles.mainTabText,
                  activeTab === "orders" ? styles.mainTabTextActive : null,
                  isSettingsMode ? styles.settingsTabText : null,
                  isSettingsMode && activeTab === "orders" ? styles.settingsTabTextActive : null,
                ]}
              >
                Orders
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.mainTabButton,
                isSettingsMode ? styles.settingsTabButton : null,
                activeTab === "voice" ? styles.mainTabButtonActive : null,
                isSettingsMode && activeTab === "voice" ? styles.settingsTabButtonActive : null,
              ]}
              onPress={() => setActiveTab("voice")}
            >
              <Text
                style={[
                  styles.mainTabText,
                  activeTab === "voice" ? styles.mainTabTextActive : null,
                  isSettingsMode ? styles.settingsTabText : null,
                  isSettingsMode && activeTab === "voice" ? styles.settingsTabTextActive : null,
                ]}
              >
                Voice
              </Text>
            </Pressable>
          </View>
        ) : null}
      </>
    )
  }

  function renderOrderFilters() {
    const filterOptions: Array<{ key: OrderStatusFilter; label: string; count: number }> = [
      { key: "all", label: "All", count: orderDrafts.length },
      { key: "pending", label: "Pending", count: pendingOrderCount },
      { key: "complete", label: "Complete", count: closedOrderCount },
    ]

    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.ordersFilterRow}
      >
        {filterOptions.map((option) => {
          const isActive = statusFilter === option.key
          return (
            <Pressable
              key={option.key}
              style={[
                styles.ordersFilterPill,
                isCompactViewport ? styles.ordersFilterPillCompact : null,
                isActive ? styles.ordersFilterPillActive : null,
              ]}
              onPress={() => setStatusFilter(option.key)}
            >
              <Text
                style={[
                  styles.ordersFilterPillText,
                  isCompactViewport ? styles.ordersFilterPillTextCompact : null,
                  isActive ? styles.ordersFilterPillTextActive : null,
                ]}
              >
                {option.label} ({option.count})
              </Text>
            </Pressable>
          )
        })}
      </ScrollView>
    )
  }

  function renderOrderCard(order: UiOrderDraft, index: number) {
    const draftItemsPreview = parseOrderItemsFromText(order.itemsText)
    const billing = getDraftBillingSnapshot(order, draftItemsPreview)
    const displayOrderCode = formatShortOrderCode(order.shortOrderCode)
    const statusTone = getOrderStatusTone(order.status)
    const statusLabel = getOrderStatusLabel(order.status)
    const orderDraftKey = getOrderDraftKey(order, index)
    const hasDraftCallReview = hasCallReviewContent(order.callReview)
    const customerName = order.customerName.trim() || "Voice Caller"
    const customerPhone = order.customerPhone.trim()
    const fulfillmentType = normalizeFulfillmentType(order.fulfillmentType)
    const paymentCollection = resolvePaymentCollection(fulfillmentType, order.paymentCollection)
    const paymentStatus = normalizePaymentStatus(order.paymentStatus)
    const paymentMethod = normalizePaymentMethod(order.paymentMethod)
    const deliveryAddress = order.deliveryAddress.trim()
    const deliveryPostcode = normalizeUkPostcode(order.deliveryPostcode)
    const paymentDisplayLabel = getOrderPaymentDisplayLabel({
      fulfillmentType,
      paymentCollection,
      paymentStatus,
      paymentMethod,
    })
    const cardStatusStyle =
      statusTone === "complete"
        ? styles.orderPosCardComplete
        : statusTone === "cancelled"
          ? styles.orderPosCardCancelled
          : styles.orderPosCardPending
    const statusPillStyle =
      statusTone === "complete"
        ? styles.orderStatusPillComplete
        : statusTone === "cancelled"
          ? styles.orderStatusPillCancelled
          : styles.orderStatusPillPending
    const statusPillTextStyle =
      statusTone === "cancelled" ? styles.orderStatusPillTextLight : styles.orderStatusPillTextDark

    return (
      <View key={`order-card-${order.id || index}`} style={[styles.orderPosCard, cardStatusStyle]}>
        <View style={styles.orderCardTopRow}>
          <Text style={[styles.orderShortCode, useStackedOrderFields ? styles.orderShortCodeCompact : null]}>
            #{displayOrderCode || (statusTone === "complete" ? "DONE" : "NEW")}
          </Text>
          <View style={[styles.orderStatusPill, statusPillStyle]}>
            <Text style={[styles.orderStatusPillText, statusPillTextStyle]}>{statusLabel}</Text>
          </View>
        </View>
        <Text style={[styles.orderCustomerLine, useStackedOrderFields ? styles.orderCustomerLineCompact : null]} numberOfLines={1}>
          <Text style={[styles.orderCustomerName, useStackedOrderFields ? styles.orderCustomerNameCompact : null]}>
            {customerName}
          </Text>
          {customerPhone ? <Text style={styles.orderCustomerPhone}>  {customerPhone}</Text> : null}
        </Text>
        <View style={styles.orderMetaBadgeRow}>
          {fulfillmentType === "delivery" ? (
            <View style={[styles.orderMetaBadge, styles.orderMetaBadgeDelivery]}>
              <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextDelivery]}>
                {getFulfillmentTypeLabel(fulfillmentType)}
              </Text>
            </View>
          ) : null}
          <Pressable
            style={[styles.orderMetaBadge, styles.orderMetaBadgePayment]}
            onPress={() => openPaymentUpdateModal(index)}
            disabled={!order.id || busy}
          >
            <Text style={[styles.orderMetaBadgeText, styles.orderMetaBadgeTextPayment]}>
              {paymentDisplayLabel}
            </Text>
          </Pressable>
        </View>
        {fulfillmentType === "delivery" && (deliveryAddress || deliveryPostcode) ? (
          <Text style={styles.orderDeliveryAddressText} numberOfLines={2}>
            {deliveryAddress || deliveryPostcode}
          </Text>
        ) : null}

        <View style={styles.orderDivider} />
        {renderCompactOrderLines(draftItemsPreview, {
          emptyLabel: "No items yet.",
          currencyCode: billing.currencyCode,
        })}

        <View style={styles.orderDivider} />
        <View style={styles.orderTotalRow}>
          <Text style={styles.orderTotalLabel}>TOTAL</Text>
          <Text style={styles.orderTotalAmount}>{formatCurrencyDisplay(billing.totalAmount, billing.currencyCode)}</Text>
        </View>

        <View style={styles.orderDivider} />
        <View style={styles.orderCardActionStack}>
          <View style={[styles.orderCardActionRow, useStackedOrderFields ? styles.orderCardActionRowCompact : null]}>
            <Pressable
              style={[
                styles.orderCardActionButton,
                styles.orderCardPrimaryAction,
                !hasDraftCallReview ? styles.orderCardActionButtonFull : null,
              ]}
              onPress={() => handleQuickToggleOrderStatus(index)}
              disabled={busy}
            >
              <ButtonLabel
                icon={statusTone === "pending" ? "check" : "rotate-ccw"}
                label={statusTone === "pending" ? "Mark Complete" : "Mark Pending"}
                color={COLORS.SURFACE}
                textStyle={styles.orderCardPrimaryActionText}
              />
            </Pressable>
            {hasDraftCallReview ? (
              <Pressable
                style={[styles.orderCardActionButton, styles.orderCardSecondaryAction]}
                onPress={() => openOrderCallReview(customerName, order.callReview)}
              >
                <ButtonLabel icon="mic" label="Review Call" color={THEME.accent} textStyle={styles.orderCardSecondaryActionText} />
              </Pressable>
            ) : null}
          </View>
          <View style={[styles.orderCardActionRow, styles.orderCardActionRowSecondary]}>
            <Pressable
              style={[styles.orderCardActionButton, styles.orderPreviewButton]}
              onPress={() => setPreviewOrder(order)}
              accessibilityLabel="Preview receipt"
            >
              <AppIcon name="eye" size={18} color={COLORS.TEXT_SECONDARY} />
            </Pressable>
            <Pressable style={[styles.orderCardActionButton, styles.orderDetailsToggle]} onPress={() => openEditOrderModal(index)}>
              <ButtonLabel icon="edit-3" label="Edit Details" color={THEME.accent} textStyle={styles.orderDetailsToggleText} />
            </Pressable>
          </View>
        </View>
      </View>
    )
  }

  if (booting) {
    return (
      <SafeAreaView style={[styles.center, webSafeStyle]}>
        <StatusBar barStyle="dark-content" backgroundColor={COLORS.BACKGROUND} translucent={false} />
        <ActivityIndicator color={THEME.primary} />
      </SafeAreaView>
    )
  }

  if (!user) {
    return (
      <SafeAreaView style={[styles.safe, webSafeStyle]}>
        <ExpoStatusBar style="dark" backgroundColor={COLORS.BACKGROUND} />
        <KeyboardAvoidingView
          style={styles.keyboardAvoidingFill}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 12}
        >
          <ScrollView
            ref={authScrollRef}
            style={styles.authScroll}
            contentContainerStyle={[
              styles.authScrollContent,
              {
                minHeight: authContentMinHeight,
                paddingBottom: authKeyboardInset + authBaseBottomInset,
              },
            ]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
            showsVerticalScrollIndicator={false}
          >
            <View style={[styles.authCard, isTabletLandscape ? styles.authCardLandscape : null]}>
              {renderNotice()}
              {renderBranding()}
              {authCompletionState ? (
                <View style={styles.authCompletionCard}>
                  <View style={styles.authCompletionIconCircle}>
                    <AppIcon name="check" size={28} color={COLORS.ACCENT} />
                  </View>
                  <Text style={styles.authCompletionTitle}>{authCompletionState.title}</Text>
                  <Text style={styles.authCompletionMessage}>{authCompletionState.message}</Text>
                  <TouchableOpacity
                    style={[styles.authSubmitButton, styles.authCompletionButton]}
                    onPress={() => setAuthStage("login")}
                    activeOpacity={0.85}
                  >
                    <Text style={[styles.authSubmitButtonText, styles.authCompletionButtonText]}>{authCompletionState.buttonLabel}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  {isResetMode ? null : renderTabToggle()}
                  {renderEmailField()}
                  {isResetMode ? null : renderPasswordField()}
                  {renderPasswordGuidelines()}
                  {renderSubmitButton()}
                  {!isRegisterMode && !isResetMode ? renderForgotPassword() : null}
                  {isResetMode ? (
                    <TouchableOpacity
                      style={styles.authBackButton}
                      onPress={() => setAuthStage("login")}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                      activeOpacity={0.7}
                      disabled={busy}
                    >
                      <Text style={styles.authBackButtonText}>Back to Login</Text>
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  if (appMode === "pos") {
    return (
      <SafeAreaView style={[styles.posSafe, webSafeStyle]}>
        <StatusBar barStyle="light-content" backgroundColor={COLORS.HEADER_BG} translucent={false} />
        <KeyboardAvoidingView style={styles.keyboardAvoidingFill} behavior={keyboardAvoidingBehavior}>
          <View style={styles.posShell}>
            {showPosSidebar ? renderPosSidebar() : null}
            <View style={styles.posMainArea}>
              {renderPosHeader()}
              <ScrollView
                style={styles.posScroll}
                contentContainerStyle={[
                  styles.posScrollContent,
                  !isTablet ? styles.posScrollContentPhone : null,
                  { paddingBottom: !isTablet ? posPhoneScrollBottomInset : baseScrollBottomInset },
                ]}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
                showsVerticalScrollIndicator={false}
              >
                {renderNotice()}
                {renderPosContent()}
              </ScrollView>
              {activeTab === "orders" ? (
                <Pressable
                  style={[
                    styles.posAddOrderFab,
                    !isTablet ? styles.posAddOrderFabPhone : null,
                    { bottom: !isTablet ? posFabBottomInset : 20 },
                  ]}
                  onPress={addOrderDraft}
                >
                  <View style={styles.posAddOrderFabIcon}>
                    <View style={styles.posAddOrderFabIconHorizontal} />
                    <View style={styles.posAddOrderFabIconVertical} />
                  </View>
                </Pressable>
              ) : null}
            </View>
          </View>
          {!isTablet ? renderPosBottomTabs() : null}
          <CallReviewModal
            visible={Boolean(activeCallReview)}
            customerName={activeCallReview?.title.trim() || "Guest"}
            statusLabel={activeCallReviewAnalysisStatus.replace(/_/g, " ")}
            normalizedStatus={activeCallReviewAnalysisStatus.trim().toLowerCase()}
            transcriptText={activeCallReviewTranscriptText}
            transcriptEntries={activeCallReviewEntries}
            hasRecording={activeCallReviewHasRecording}
            isPlaying={callReviewPlayerStatus.playing}
            recordingDuration={activeCallReviewRecordingDuration}
            recordingProgress={activeCallReviewRecordingProgress}
            onToggleRecording={() => handleOpenCallRecording()}
            onClose={closeOrderCallReview}
            formatAudioTime={formatAudioTime}
          />
          <ReceiptPreviewModal
            visible={previewOrder !== null}
            order={previewOrder ? buildReceiptOrder(previewOrder) : null}
            restaurantName={getReceiptRestaurantName()}
            onClose={() => {
              previewLongPressKeyRef.current = null
              setPreviewOrder(null)
            }}
            onPrint={() => {
              if (!previewOrder) {
                return
              }
              previewLongPressKeyRef.current = null
              handlePrint(previewOrder)
              setPreviewOrder(null)
            }}
          />
          {renderItemCustomizationModal()}
          {renderPaymentUpdateModal()}
          {renderOrderEditorModal()}
          {renderOrderItemPickerModal()}
          {busy ? (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator color={COLORS.ACCENT} size="large" />
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView
      style={[
        styles.safe,
        webSafeStyle,
        isSettingsMode ? styles.settingsScreenSafe : null,
      ]}
    >
      <StatusBar
        barStyle={appMode === "admin" ? "light-content" : "dark-content"}
        backgroundColor={appMode === "admin" ? COLORS.HEADER_BG : COLORS.BACKGROUND}
        translucent={false}
      />
      <KeyboardAvoidingView style={styles.keyboardAvoidingFill} behavior={keyboardAvoidingBehavior}>
        {renderSettingsHeader()}
        <ScrollView
          style={[
            styles.scroll,
            isSettingsMode ? styles.settingsScreenScroll : null,
          ]}
          contentContainerStyle={[
            styles.content,
            { paddingBottom: adminBaseBottomInset },
          ]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          showsVerticalScrollIndicator={false}
        >
          {renderAdminTopContent()}

        {appMode === "admin" && activeTab === "overview" ? (
          <>
        <View style={[styles.settingsPanelsWrap, isTabletLandscape ? styles.settingsPanelsWrapLandscape : null]}>
          <View style={[isTabletLandscape ? styles.settingsPanelColumnLandscape : null]}>
            <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
              <Text style={styles.scannerCardTitle}>Restaurant Profile</Text>
              {restaurants.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.scannerRestaurantSelector}
                >
                  {restaurants.map((restaurant) => (
                    <Pressable
                      key={restaurant.id}
                      style={[
                        styles.scannerRestaurantChip,
                        selectedRestaurantId === restaurant.id ? styles.scannerRestaurantChipActive : null,
                      ]}
                      onPress={() => setSelectedRestaurantId(restaurant.id)}
                    >
                      <Text
                        style={[
                          styles.scannerRestaurantChipText,
                          selectedRestaurantId === restaurant.id ? styles.scannerRestaurantChipTextActive : null,
                        ]}
                      >
                        {restaurant.name}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Restaurant Name</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={restaurantName}
                  onChangeText={setRestaurantName}
                />
              </View>
              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Phone Number</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={restaurantPhone}
                  onChangeText={setRestaurantPhone}
                  keyboardType="phone-pad"
                />
              </View>
              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>City</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={restaurantAddress}
                  onChangeText={setRestaurantAddress}
                />
              </View>
              <Text style={styles.scannerDescription}>
                {selectedRestaurant?.hasPaymentPin
                  ? "Payment PIN is configured for this restaurant. Save a new 4 to 8 digit PIN below to rotate it."
                  : "Set a restaurant-specific 4 to 8 digit payment PIN for POS settlement approvals."}
              </Text>
              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Payment PIN</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={restaurantPaymentPin}
                  onChangeText={(value) => setRestaurantPaymentPin(value.replace(/[^\d]/g, ""))}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={8}
                />
              </View>
              <View style={styles.scannerFieldShell}>
                <Text style={styles.scannerFieldLabel}>Confirm Payment PIN</Text>
                <TextInput
                  style={styles.scannerFieldInput}
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  value={restaurantPaymentPinConfirm}
                  onChangeText={(value) => setRestaurantPaymentPinConfirm(value.replace(/[^\d]/g, ""))}
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={8}
                />
              </View>
              <Pressable style={styles.scannerPrimaryButton} onPress={handleSaveRestaurant} disabled={busy}>
                <Text style={styles.scannerPrimaryButtonText}>{busy ? "Updating..." : "Update"}</Text>
              </Pressable>
              <Pressable style={styles.scannerPrimaryButton} onPress={handleSaveRestaurantPaymentPin} disabled={busy}>
                <Text style={styles.scannerPrimaryButtonText}>{busy ? "Saving..." : "Save Payment PIN"}</Text>
              </Pressable>
            </View>
          </View>

          <View style={[isTabletLandscape ? styles.settingsPanelColumnLandscape : null]}>
            <View style={[styles.scannerCard, isTabletLandscape ? styles.scannerCardLandscape : null]}>
              <Text style={styles.scannerCardTitle}>Menu Scan + Parse</Text>
              <Text style={styles.scannerDescription}>
                Capture one menu photo at a time. OCR text is optional context. If the menu needs another photo, choose where the new items should go.
              </Text>

              <Pressable
                style={[
                  styles.scannerModeButton,
                  parseInsertMode === "replace" ? styles.scannerModeButtonActive : null,
                ]}
                onPress={() => setParseInsertMode("replace")}
              >
                <Text style={[styles.scannerModeButtonTitle, parseInsertMode === "replace" ? styles.scannerModeButtonTitleActive : null]}>New Menu</Text>
                <Text style={[styles.scannerModeButtonSubtitle, parseInsertMode === "replace" ? styles.scannerModeButtonSubtitleActive : null]}>Replace the current menu</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.scannerModeButton,
                  parseInsertMode !== "replace" ? styles.scannerModeButtonActive : null,
                ]}
                onPress={() => setParseInsertMode("append")}
              >
                <Text style={[styles.scannerModeButtonTitle, parseInsertMode !== "replace" ? styles.scannerModeButtonTitleActive : null]}>Add Items</Text>
                <Text style={[styles.scannerModeButtonSubtitle, parseInsertMode !== "replace" ? styles.scannerModeButtonSubtitleActive : null]}>Keep the current menu and add new items</Text>
              </Pressable>

              <View style={styles.scannerCaptureRow}>
                <Pressable style={styles.scannerCaptureButton} onPress={() => pickImage(true)}>
                  <AppIcon name="camera" size={18} color={COLORS.TEXT_PRIMARY} />
                  <Text style={styles.scannerCaptureButtonText}>Capture</Text>
                </Pressable>
                <Pressable style={styles.scannerCaptureButton} onPress={() => pickImage(false)}>
                  <AppIcon name="image" size={18} color={COLORS.TEXT_PRIMARY} />
                  <Text style={styles.scannerCaptureButtonText}>Gallery</Text>
                </Pressable>
              </View>

              {imageUri ? <Image source={{ uri: imageUri }} style={styles.scannerPreviewImage as ImageStyle} /> : null}
              <TextInput
                style={styles.scannerNotesInput}
                multiline
                placeholder="Optional: paste OCR notes to improve AI extraction..."
                placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                value={rawMenuText}
                onChangeText={setRawMenuText}
              />
              <Pressable style={styles.scannerPrimaryButton} onPress={handleParseMenu} disabled={busy}>
                <Text style={styles.scannerPrimaryButtonText}>{busy ? "Parsing..." : "Parse With AI"}</Text>
              </Pressable>
              {draftItems.map((item, index) => (
                <View key={`draft-${index}`} style={styles.scannerDraftItemCard}>
                  <Text style={styles.scannerDraftItemLabel}>Item {index + 1}</Text>
                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Item Name</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      value={item.name}
                      onChangeText={(value) => updateDraft(index, { name: value })}
                    />
                  </View>
                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Category</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      value={item.category}
                      onChangeText={(value) => updateDraft(index, { category: value })}
                    />
                  </View>
                  <View style={[styles.scannerFieldShell, styles.scannerFieldShellMultiline]}>
                    <Text style={styles.scannerFieldLabel}>Includes / Description</Text>
                    <TextInput
                      style={[styles.scannerFieldInput, styles.scannerFieldInputMultiline]}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      value={item.description}
                      onChangeText={(value) => updateDraft(index, { description: value })}
                      multiline
                    />
                  </View>
                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Base Price</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      keyboardType="decimal-pad"
                      value={item.basePrice}
                      onChangeText={(value) => updateDraft(index, { basePrice: value })}
                    />
                  </View>
                  <View style={styles.scannerFieldShell}>
                    <Text style={styles.scannerFieldLabel}>Stock Quantity</Text>
                    <TextInput
                      style={styles.scannerFieldInput}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      keyboardType="number-pad"
                      value={item.stockQuantity}
                      onChangeText={(value) => updateDraft(index, { stockQuantity: value })}
                    />
                  </View>
                  <View style={[styles.scannerFieldShell, styles.scannerFieldShellMultiline]}>
                    <Text style={styles.scannerFieldLabel}>Options / Customizations</Text>
                    <TextInput
                      style={[styles.scannerFieldInput, styles.scannerFieldInputMultiline]}
                      placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                      multiline
                      value={item.customizationText}
                      onChangeText={(value) => updateDraft(index, { customizationText: value })}
                    />
                  </View>
                </View>
              ))}
              {draftItems.length > 0 ? (
                <View style={styles.scannerDraftActionRow}>
                  <Pressable style={styles.scannerSecondaryActionButton} onPress={addDraftItem}>
                    <Text style={styles.scannerSecondaryActionText}>Add Item</Text>
                  </Pressable>
                  <Pressable style={styles.scannerPrimaryWideButton} onPress={handleSaveMenu} disabled={busy}>
                    <Text style={styles.scannerPrimaryButtonText}>Save Menu</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        </View>
          </>
        ) : null}

        {activeTab === "menu" ? (
          <View style={[styles.settingsWideSection, isTabletLandscape ? styles.settingsWideSectionLandscape : null]}>
            <MenuScreen
              savedItems={savedItems}
              editableMenuItems={editableMenuItems}
              currencyCode={selectedCurrencyCode}
              busy={busy}
              loading={menuLoading}
              onUpdateEditableMenuItem={updateEditableMenuItem}
              onAddEditableMenuItem={addEditableMenuItem}
              onRemoveEditableMenuItem={removeEditableMenuItem}
              onSaveEditedMenu={handleSaveEditedMenu}
            />
          </View>
        ) : null}

        {appMode === "admin" && activeTab === "billing" ? renderBillingTab() : null}

        {activeTab === "orders" ? (
          renderPosOrdersTab()
        ) : null}

        {appMode === "admin" && activeTab === "voice" ? (
        <>
        <View style={[styles.voiceConfigCard, isTabletLandscape ? styles.voiceConfigCardLandscape : null]}>
          <View style={[styles.voiceConfigContent, isTabletLandscape ? styles.voiceConfigContentLandscape : null]}>
            <View style={[styles.voiceConfigMainColumn, isTabletLandscape ? styles.voiceConfigMainColumnLandscape : null]}>
              <Text style={styles.voiceConfigTitle}>Voice Agent Configuration</Text>
              <Text style={styles.voiceConfigLabel}>ElevenLabs API Key</Text>
              {voiceAgentLink && savedElevenLabsApiKey && !isEditingElevenLabsApiKey ? (
                <View style={styles.voiceSavedKeyBox}>
                  <Text style={styles.voiceSavedKeyText}>{maskApiKey(savedElevenLabsApiKey)}</Text>
                </View>
              ) : (
                <TextInput
                  style={styles.voiceConfigInput}
                  placeholder="Enter your API Key"
                  placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={elevenLabsApiKey}
                  onChangeText={setElevenLabsApiKey}
                />
              )}
              {voiceAgentLink ? (
                voiceAgentLink && savedElevenLabsApiKey && !isEditingElevenLabsApiKey ? (
                  <View style={styles.voiceConfigActionStack}>
                    <Pressable style={styles.voiceConfigPrimaryButton} onPress={handleCreateAgent} disabled={busy}>
                      <Text style={styles.voiceConfigPrimaryButtonText}>Create Agent in ElevenLabs</Text>
                    </Pressable>
                    <Pressable
                      style={styles.voiceConfigSecondaryButton}
                      onPress={() => {
                        setElevenLabsApiKey(savedElevenLabsApiKey)
                        setIsEditingElevenLabsApiKey(true)
                      }}
                      disabled={busy}
                    >
                      <Text style={styles.voiceConfigSecondaryButtonText}>Edit API Key</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.voiceConfigActionStack}>
                    <Pressable style={styles.voiceConfigPrimaryButton} onPress={handleSaveElevenLabsApiKey} disabled={busy}>
                      <Text style={styles.voiceConfigPrimaryButtonText}>Save API Key</Text>
                    </Pressable>
                    {savedElevenLabsApiKey ? (
                      <Pressable
                        style={styles.voiceConfigSecondaryButton}
                        onPress={() => {
                          setElevenLabsApiKey(savedElevenLabsApiKey)
                          setIsEditingElevenLabsApiKey(false)
                        }}
                        disabled={busy}
                      >
                        <Text style={styles.voiceConfigSecondaryButtonText}>Cancel</Text>
                      </Pressable>
                    ) : null}
                  </View>
                )
              ) : (
                <View style={styles.voiceConfigActionStack}>
                  <Pressable style={styles.voiceConfigPrimaryButton} onPress={handleCreateAgent} disabled={busy}>
                    <Text style={styles.voiceConfigPrimaryButtonText}>Create Agent in ElevenLabs</Text>
                  </Pressable>
                  <TextInput
                    style={styles.voiceConfigInput}
                    placeholder="Or existing ElevenLabs agent_id"
                    placeholderTextColor={INPUT_PLACEHOLDER_COLOR}
                    value={manualAgentId}
                    onChangeText={setManualAgentId}
                  />
                  <Pressable style={styles.voiceConfigSecondaryButton} onPress={handleLinkManualAgent} disabled={busy}>
                    <Text style={styles.voiceConfigSecondaryButtonText}>Link Existing Agent</Text>
                  </Pressable>
                </View>
              )}
            </View>
            <View style={[styles.voiceConfigSidebar, isTabletLandscape ? styles.voiceConfigSidebarLandscape : null]}>
              {voiceAgentLink ? (
                <View style={[styles.voiceLinkedInfoBox, isTabletLandscape ? styles.voiceLinkedInfoBoxLandscape : null]}>
                  <Text style={styles.voiceLinkedInfoLabel}>Linked agent:</Text>
                  <Text style={styles.voiceLinkedInfoValue}>{voiceAgentLink.workspace_agent_id}</Text>
                </View>
              ) : (
                <View style={[styles.voiceLinkedInfoBox, isTabletLandscape ? styles.voiceLinkedInfoBoxLandscape : null]}>
                  <Text style={styles.voiceLinkedInfoLabel}>Linked agent:</Text>
                  <Text style={styles.voiceLinkedInfoValue}>No voice agent linked yet.</Text>
                </View>
              )}
            </View>
          </View>
        </View>
        </>
        ) : null}

        </ScrollView>
      </KeyboardAvoidingView>
      <CallReviewModal
        visible={Boolean(activeCallReview)}
        customerName={activeCallReview?.title.trim() || "Guest"}
        statusLabel={activeCallReviewAnalysisStatus.replace(/_/g, " ")}
        normalizedStatus={activeCallReviewAnalysisStatus.trim().toLowerCase()}
        transcriptText={activeCallReviewTranscriptText}
        transcriptEntries={activeCallReviewEntries}
        hasRecording={activeCallReviewHasRecording}
        isPlaying={callReviewPlayerStatus.playing}
        recordingDuration={activeCallReviewRecordingDuration}
        recordingProgress={activeCallReviewRecordingProgress}
        onToggleRecording={() => handleOpenCallRecording()}
        onClose={closeOrderCallReview}
        formatAudioTime={formatAudioTime}
      />
      <ReceiptPreviewModal
        visible={previewOrder !== null}
        order={previewOrder ? buildReceiptOrder(previewOrder) : null}
        restaurantName={getReceiptRestaurantName()}
        onClose={() => {
          previewLongPressKeyRef.current = null
          setPreviewOrder(null)
        }}
        onPrint={() => {
          if (!previewOrder) {
            return
          }
          previewLongPressKeyRef.current = null
          handlePrint(previewOrder)
          setPreviewOrder(null)
        }}
      />
      {renderItemCustomizationModal()}
      {renderPrintCenterModal()}
      {renderPaymentUpdateModal()}
      {renderOrderEditorModal()}
      {renderOrderItemPickerModal()}
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
  keyboardAvoidingFill: { flex: 1 },
  scroll: { flex: 1, backgroundColor: THEME.background },
  content: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 14,
    paddingBottom: (Platform.OS === "ios" ? 72 : 56) + SAFE_AREA.bottom,
  },
  authScroll: { flex: 1, backgroundColor: THEME.background },
  authScrollContent: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
  },
  authCard: {
    width: "100%",
    maxWidth: 560,
    alignSelf: "center",
    backgroundColor: "transparent",
    borderRadius: 0,
    paddingVertical: 14,
  },
  authCardLandscape: {
    maxWidth: 760,
    paddingVertical: 20,
  },
  authCompletionCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    paddingHorizontal: 28,
    paddingVertical: 32,
    alignItems: "center",
    gap: 16,
    ...CARD_SHADOW,
    elevation: 2,
  },
  authCompletionIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 24,
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  authCompletionIcon: {
    color: COLORS.ACCENT,
    fontSize: 30,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  authCompletionTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 26,
    fontWeight: "800",
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  authCompletionMessage: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  authCompletionButton: {
    alignSelf: "stretch",
    minHeight: 56,
    marginTop: 8,
    paddingHorizontal: 20,
    borderRadius: 14,
  },
  authCompletionButtonText: {
    textAlign: "center",
    lineHeight: 22,
  },
  authBrandingContainer: {
    marginBottom: 44,
    alignItems: "center",
    gap: 6,
  },
  authBrandingLabel: {
    fontSize: 12,
    fontWeight: "800",
    color: COLORS.ACCENT,
    letterSpacing: 2.4,
    fontFamily: FONT_SANS,
  },
  card: {
    backgroundColor: THEME.card,
    borderRadius: RADIUS.XL,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    padding: SPACING.LG,
    gap: SPACING.SM,
    ...CARD_SHADOW,
    elevation: 3,
  },
  brandTag: {
    color: THEME.accent,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    fontFamily: FONT_SANS,
  },
  buttonLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.XS,
  },
  inlineMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACING.XS,
  },
  emptyStateIconCircle: {
    width: 64,
    height: 64,
    borderRadius: RADIUS.LG,
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: THEME.text, fontSize: TYPOGRAPHY.DISPLAY, fontWeight: "800", fontFamily: FONT_SANS },
  section: { color: THEME.text, fontSize: TYPOGRAPHY.TITLE, fontWeight: "800", fontFamily: FONT_SANS },
  subtitle: { color: THEME.mutedText, fontSize: TYPOGRAPHY.BODY, lineHeight: 22, fontFamily: FONT_SANS },
  posSafe: { flex: 1, width: "100%", backgroundColor: COLORS.BACKGROUND },
  posShell: { flex: 1, flexDirection: "row", backgroundColor: COLORS.BACKGROUND },
  posSidebar: {
    width: 72,
    backgroundColor: COLORS.SURFACE_DARK,
    borderRightWidth: 1,
    borderRightColor: COLORS.SIDEBAR_BORDER,
    justifyContent: "space-between",
    paddingVertical: 12,
  },
  posSidebarTop: { gap: 4 },
  posSidebarItem: {
    height: 70,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
    gap: 4,
  },
  posSidebarItemActive: {
    backgroundColor: COLORS.SIDEBAR_TINT,
    borderLeftColor: COLORS.ACCENT,
  },
  posSidebarIcon: { color: COLORS.TEXT_MUTED, fontSize: 22, textAlign: "center", fontFamily: FONT_SANS },
  posSidebarIconActive: { color: COLORS.ACCENT },
  posSidebarLabel: {
    color: COLORS.TEXT_MUTED,
    fontSize: 9,
    fontWeight: "600",
    marginTop: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  posSidebarLabelActive: { color: COLORS.ACCENT },
  posMainArea: { flex: 1, backgroundColor: COLORS.BACKGROUND },
  posTopHeader: {
    backgroundColor: COLORS.HEADER_BG,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top + SPACING.SM : SPACING.SM,
    paddingHorizontal: SPACING.LG,
    paddingBottom: SPACING.SM,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.SM,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  posTopHeaderTitle: {
    flex: 1,
    color: COLORS.HEADER_TEXT,
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "800",
    lineHeight: 26,
    fontFamily: FONT_SANS,
  },
  posTopHeaderActions: { flexDirection: "row", alignItems: "center", gap: SPACING.SM },
  posSettingsButton: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.MD,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  posSettingsButtonText: { color: COLORS.HEADER_TEXT, fontSize: 20, fontFamily: FONT_SANS },
  posLogoutButton: {
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  posLogoutText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posScroll: { flex: 1, backgroundColor: COLORS.BACKGROUND },
  posScrollContent: {
    paddingHorizontal: SPACING.SM,
    paddingTop: SPACING.SM,
    paddingBottom: (Platform.OS === "ios" ? SPACING.XXL : SPACING.MD) + SAFE_AREA.bottom,
    gap: SPACING.SM,
    backgroundColor: COLORS.BACKGROUND,
  },
  posScrollContentPhone: { paddingBottom: (Platform.OS === "ios" ? 132 : 120) + SAFE_AREA.bottom },
  posTabSection: { width: "100%", gap: 0 },
  posTabSectionLandscape: { width: "100%", alignSelf: "stretch" },
  posOrdersHeaderCard: {
    width: "100%",
    alignSelf: "stretch",
    paddingHorizontal: SPACING.MD,
    paddingTop: SPACING.MD,
    paddingBottom: SPACING.MD,
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    ...METRIC_CARD_SHADOW,
  },
  posOrdersHeaderCardLandscape: {
    width: "100%",
    alignSelf: "stretch",
    paddingTop: 18,
    paddingBottom: 16,
  },
  posOrdersHeaderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: SPACING.SM,
  },
  posOrdersHeadingRow: { flexDirection: "row", alignItems: "center", gap: SPACING.XS },
  posOrdersHeadingTextWrap: { gap: SPACING.XXS },
  posOrdersTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.DISPLAY - 2,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posOrdersSubtitle: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  posOrdersSyncStatus: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  posOrdersSyncStatusOffline: {
    color: COLORS.WARNING,
  },
  posOrdersHeaderActionRow: { flexDirection: "row", alignItems: "center", gap: SPACING.XS },
  posPrintCenterButton: {
    minHeight: 44,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    paddingHorizontal: SPACING.MD,
    alignItems: "center",
    justifyContent: "center",
  },
  posPrintCenterButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posSummaryCard: {
    borderRadius: RADIUS.LG,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: SPACING.LG,
    paddingVertical: SPACING.MD,
    gap: SPACING.SM,
    ...SOFT_CARD_SHADOW,
  },
  posSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  posSummaryRowStrong: {
    marginTop: 2,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.BORDER,
  },
  posSummaryLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posSummaryLabelStrong: {
    color: COLORS.TEXT_PRIMARY,
    fontWeight: "800",
  },
  posSummaryValue: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    textAlign: "right",
  },
  posSummaryValueStrong: {
    color: COLORS.ACCENT,
  },
  posHeaderRefreshButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    alignItems: "center",
    justifyContent: "center",
  },
  posHeaderRefreshButtonText: {
    color: COLORS.ACCENT,
    fontSize: 18,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posHeaderSyncButton: {
    minHeight: 42,
    borderRadius: 14,
    backgroundColor: COLORS.ACCENT,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  posHeaderSyncButtonText: {
    color: COLORS.SURFACE,
    fontSize: 13,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posStatRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-around",
    gap: 12,
  },
  posStatItem: { alignItems: "center", minWidth: 72 },
  posStatBadgeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  posStatDot: { width: 8, height: 8, borderRadius: 4 },
  posStatDotWarning: { backgroundColor: COLORS.WARNING },
  posStatDotSuccess: { backgroundColor: COLORS.SUCCESS },
  posStatDotVoice: { backgroundColor: COLORS.VOICE_COLOR },
  posStatCount: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posStatLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 11,
    fontFamily: FONT_SANS,
  },
  posFilterBar: {
    flexDirection: "row",
    width: "100%",
    alignSelf: "stretch",
    marginHorizontal: 0,
    marginTop: 0,
    marginBottom: SPACING.SM,
    padding: SPACING.XXS,
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  posFilterBarLandscape: {
    width: "100%",
    alignSelf: "stretch",
    marginBottom: 16,
  },
  posFilterTab: {
    flex: 1,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: RADIUS.MD,
  },
  posFilterTabActive: { backgroundColor: COLORS.ACCENT_LIGHT, borderWidth: 1, borderColor: COLORS.ACCENT },
  posFilterTabText: {
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  posFilterTabLabelActive: { color: COLORS.ACCENT, fontWeight: "700" },
  posFilterTabLabelInactive: { color: COLORS.TEXT_MUTED, fontWeight: "400" },
  posFilterTabCount: { color: COLORS.TEXT_MUTED, fontWeight: "400" },
  posOrdersGrid: { width: "100%", gap: SPACING.SM },
  posOrdersGridTablet: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", justifyContent: "flex-start" },
  posOrdersGridLandscape: { gap: 12 },
  posOrderCard: {
    width: "100%",
    flexDirection: "row",
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    padding: 0,
    overflow: "hidden",
    ...SOFT_CARD_SHADOW,
  },
  posOrderCardTablet: { width: "48.8%" },
  posOrderCardTabletWide: { width: "32.5%" },
  posOrderAccentBar: { width: 6, alignSelf: "stretch" },
  posOrderAccentPending: { backgroundColor: COLORS.ACCENT },
  posOrderAccentSuccess: { backgroundColor: COLORS.SUCCESS },
  posOrderCardBody: { flex: 1, paddingHorizontal: SPACING.MD, paddingTop: SPACING.MD, paddingBottom: SPACING.MD },
  posOrderTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.XS,
    marginBottom: SPACING.XS,
  },
  posOrderCode: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 18,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posOrderStatusPill: {
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS - 2,
    borderRadius: RADIUS.PILL,
    borderWidth: 1,
  },
  posOrderStatusPillPending: { backgroundColor: COLORS.WARNING_BG, borderColor: COLORS.WARNING },
  posOrderStatusPillSuccess: { backgroundColor: COLORS.SUCCESS_BG, borderColor: COLORS.SUCCESS },
  posOrderStatusPillText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  posOrderStatusPillTextPending: { color: COLORS.WARNING },
  posOrderStatusPillTextSuccess: { color: COLORS.SUCCESS },
  posOrderCustomerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.XS,
    marginBottom: SPACING.XS,
  },
  posOrderCustomerNameText: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 16,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posOrderCustomerPhone: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  orderMetaBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: -2,
    marginBottom: 2,
  },
  orderMetaBadge: {
    minHeight: 28,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  orderMetaBadgePickup: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderColor: COLORS.ACCENT,
  },
  orderMetaBadgeDelivery: {
    backgroundColor: COLORS.WARNING_BG,
    borderColor: COLORS.WARNING,
  },
  orderMetaBadgePayment: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderColor: COLORS.BORDER,
  },
  orderMetaBadgeText: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: FONT_SANS,
  },
  orderMetaBadgeTextPickup: {
    color: COLORS.ACCENT,
  },
  orderMetaBadgeTextDelivery: {
    color: COLORS.WARNING,
  },
  orderMetaBadgeTextPayment: {
    color: COLORS.TEXT_PRIMARY,
  },
  orderDeliveryAddressText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  paymentModalOverlay: {
    flex: 1,
    backgroundColor: COLORS.MODAL_OVERLAY,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  paymentModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  paymentModalCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 26,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 12,
    ...CARD_SHADOW,
    elevation: 8,
  },
  paymentModalScroll: {
    width: "100%",
  },
  paymentModalScrollContent: {
    gap: 12,
    paddingBottom: 4,
  },
  printCenterCard: {
    maxWidth: 520,
  },
  printCenterScroll: {
    width: "100%",
  },
  printCenterScrollContent: {
    gap: 10,
    paddingBottom: 4,
  },
  paymentModalTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 22,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  paymentModalSubtitle: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  paymentModalCurrentBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
    marginBottom: 2,
  },
  paymentModalFieldLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginTop: 4,
    fontFamily: FONT_SANS,
  },
  paymentModalInput: {
    minHeight: 50,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  printerDropdownField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  printerDropdownFieldText: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontFamily: FONT_SANS,
  },
  printerDropdownFieldPlaceholder: {
    color: COLORS.TEXT_MUTED,
  },
  printerDropdownChevron: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    fontWeight: "700",
    marginLeft: 12,
    fontFamily: FONT_SANS,
  },
  printerDropdownMenu: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE,
    overflow: "hidden",
  },
  printerDropdownItem: {
    minHeight: 44,
    paddingHorizontal: 14,
    alignItems: "flex-start",
    justifyContent: "center",
    borderTopWidth: 1,
    borderTopColor: COLORS.SURFACE_BORDER_SOFT,
  },
  printerDropdownItemActive: {
    backgroundColor: COLORS.ACCENT_LIGHT,
  },
  printerDropdownItemText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  printerDropdownItemTextActive: {
    color: COLORS.ACCENT,
  },
  paymentMethodRow: {
    flexDirection: "row",
    gap: 10,
  },
  paymentMethodButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
  },
  paymentMethodButtonActive: {
    backgroundColor: COLORS.ACCENT,
    borderColor: COLORS.ACCENT,
  },
  paymentMethodButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  paymentMethodButtonTextActive: {
    color: COLORS.SURFACE,
  },
  printCenterHelperText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  printToggleRow: {
    minHeight: 56,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  printToggleTextWrap: {
    flex: 1,
    gap: 4,
  },
  printToggleTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  printToggleHelperText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    lineHeight: 17,
    fontFamily: FONT_SANS,
  },
  printCenterSummaryCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  printCenterSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  printCenterSummaryLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  printCenterSummaryValue: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    textAlign: "right",
  },
  paymentModalActionStack: {
    gap: 10,
    marginTop: 8,
  },
  paymentModalPrimaryButton: {
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  paymentModalPrimaryButtonText: {
    color: COLORS.SURFACE,
    fontSize: 15,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  paymentModalSecondaryButton: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.WARNING,
    backgroundColor: COLORS.WARNING_BG,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  paymentModalSecondaryButtonText: {
    color: COLORS.WARNING,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  paymentModalCancelButton: {
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  paymentModalCancelButtonText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posOrderDivider: {
    height: 1,
    backgroundColor: COLORS.BORDER,
    marginVertical: 10,
  },
  posOrderItemsList: { gap: 6, marginBottom: 8 },
  posOrderItemRow: { flexDirection: "row", marginBottom: 4, gap: 8 },
  posOrderItemName: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  posOrderItemPrice: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "right",
    fontFamily: FONT_SANS,
  },
  posOrderItemEmpty: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  posOrderTotalRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  posOrderTotalLabel: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posOrderTotalAmount: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posOrderActionStack: { gap: 10 },
  posOrderActionRow: { flexDirection: "row", gap: 10 },
  posOrderActionButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 8,
    borderWidth: 1,
  },
  posOrderActionSuccess: { backgroundColor: COLORS.SUCCESS, borderColor: COLORS.SUCCESS },
  posOrderActionOutline: { backgroundColor: "transparent", borderColor: COLORS.ACCENT },
  posOrderActionVoice: { backgroundColor: "transparent", borderColor: COLORS.VOICE_COLOR },
  posOrderActionButtonText: {
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    textAlign: "center",
  },
  posOrderActionButtonTextOnDark: { color: COLORS.SURFACE },
  posOrderActionButtonTextOutline: { color: COLORS.ACCENT },
  posOrderActionButtonTextVoice: { color: COLORS.VOICE_COLOR },
  posOrderDetailsSection: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.BORDER,
    gap: 10,
  },
  posOrderFieldGrid: { flexDirection: "row", gap: 10 },
  posOrderFieldGridStacked: { flexDirection: "column" },
  posOrderFieldColumn: { flex: 1, gap: 6 },
  posOrderFieldLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posOrderInput: {
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  posOrderNotesInput: {
    minHeight: 78,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    textAlignVertical: "top",
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  posOrderStatusToggleRow: { flexDirection: "row", gap: 8 },
  posOrderStatusToggle: {
    flex: 1,
    minHeight: 44,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
  },
  posOrderStatusToggleActive: { borderColor: COLORS.ACCENT, backgroundColor: COLORS.ACCENT_TINT },
  posOrderStatusToggleText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posOrderStatusToggleTextActive: { color: COLORS.ACCENT_DARK },
  posOrderEditorToggle: {
    minHeight: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
  },
  posOrderEditorToggleText: {
    color: COLORS.ACCENT_DARK,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posOrderRawEditor: { gap: 6 },
  posOrderItemsInput: {
    minHeight: 110,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    textAlignVertical: "top",
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  posOrderEditorHint: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  orderItemsEditorSection: {
    marginTop: 2,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    padding: 12,
    gap: 10,
  },
  orderItemsEditorHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  orderItemsEditorTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemsEditorAddButton: {
    minHeight: 34,
    borderRadius: 8,
    backgroundColor: COLORS.ACCENT_TINT,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemsEditorAddButtonText: {
    color: COLORS.ACCENT_DARK,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemsEditorEmptyState: {
    borderRadius: 8,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  orderItemsEditorEmptyText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  orderItemsEditorList: { gap: 8 },
  orderItemsEditorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  orderItemsEditorRowName: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  orderItemsEditorRowMeta: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    fontFamily: FONT_SANS,
  },
  orderItemsEditorRowPrice: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  orderItemsEditorTotalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 2,
    borderTopWidth: 1,
    borderTopColor: COLORS.BORDER,
  },
  orderItemsEditorTotalLabel: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  orderItemsEditorTotalAmount: {
    color: COLORS.ACCENT,
    fontSize: 14,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  posOrderEditorActions: { flexDirection: "row", gap: 8 },
  posOrderSaveButton: { backgroundColor: COLORS.ACCENT, borderColor: COLORS.ACCENT },
  posOrderRemoveButton: { backgroundColor: COLORS.DANGER_TINT, borderColor: COLORS.DANGER_TINT },
  posOrderRemoveButtonText: { color: COLORS.DANGER },
  posAddOrderFab: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
    ...FAB_SHADOW,
    elevation: 6,
  },
  posAddOrderFabPhone: { bottom: Platform.OS === "ios" ? 36 : 20 },
  posAddOrderFabIcon: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  posAddOrderFabIconHorizontal: {
    position: "absolute",
    width: 18,
    height: 2.5,
    borderRadius: 999,
    backgroundColor: COLORS.SURFACE,
  },
  posAddOrderFabIconVertical: {
    position: "absolute",
    width: 2.5,
    height: 18,
    borderRadius: 999,
    backgroundColor: COLORS.SURFACE,
  },
  posEmptyState: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    paddingHorizontal: SPACING.LG,
    paddingVertical: SPACING.XL,
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.SM,
    ...METRIC_CARD_SHADOW,
    elevation: 3,
  },
  posEmptyStateEmoji: { fontSize: 48, textAlign: "center" },
  posEmptyStateTitle: {
    marginTop: SPACING.SM,
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posEmptyStateSubtitle: {
    marginTop: SPACING.XXS + 2,
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY,
    textAlign: "center",
    lineHeight: 22,
    fontFamily: FONT_SANS,
  },
  posEmptyStateButton: {
    marginTop: SPACING.LG,
    minHeight: 44,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.ACCENT,
    paddingHorizontal: SPACING.MD,
    alignItems: "center",
    justifyContent: "center",
  },
  posEmptyStateButtonText: {
    color: COLORS.SURFACE,
    fontSize: TYPOGRAPHY.BODY - 1,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posPanelCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    padding: SPACING.MD,
    gap: SPACING.SM,
    ...METRIC_CARD_SHADOW,
    elevation: 3,
  },
  posPanelTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  posPanelBody: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY,
    lineHeight: 22,
    fontFamily: FONT_SANS,
  },
  posPanelCaption: {
    color: COLORS.TEXT_MUTED,
    fontSize: TYPOGRAPHY.CAPTION,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  posMenuItemCard: {
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: 10,
    backgroundColor: COLORS.SURFACE_RAISED,
    padding: 12,
    gap: 4,
  },
  posMenuItemTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posMenuItemMeta: {
    color: COLORS.ACCENT_DARK,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posMenuItemDescription: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  posVoiceBadge: {
    alignSelf: "flex-start",
    backgroundColor: COLORS.VOICE_TINT,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  posVoiceBadgeText: {
    color: COLORS.VOICE_COLOR,
    fontSize: 11,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  posBottomTabBar: {
    backgroundColor: COLORS.SURFACE,
    borderTopWidth: 1,
    borderTopColor: COLORS.BORDER,
    height: Platform.OS === "ios" ? 64 : 72,
    paddingBottom: Platform.OS === "ios" ? 8 : 10,
    flexDirection: "row",
  },
  posBottomTabItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  posBottomTabIcon: { color: COLORS.TEXT_MUTED, fontSize: 26, fontFamily: FONT_SANS },
  posBottomTabIconActive: { color: COLORS.ACCENT },
  posBottomTabLabel: {
    color: COLORS.TEXT_MUTED,
    fontSize: 10,
    fontWeight: "500",
    fontFamily: FONT_SANS,
  },
  posBottomTabLabelActive: { color: COLORS.ACCENT },
  ordersTabSection: { width: "100%", gap: SPACING.SM },
  ordersContentWrap: { width: "100%", maxWidth: 480, alignSelf: "center" },
  ordersHeader: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.XS,
  },
  ordersHeaderText: { flex: 1, gap: SPACING.XXS },
  ordersHeaderActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  ordersHeaderActionsCompact: { gap: 6 },
  ordersHeaderTitle: { color: THEME.text, fontSize: TYPOGRAPHY.DISPLAY, fontWeight: "800", fontFamily: FONT_SANS },
  ordersHeaderTitleCompact: { fontSize: TYPOGRAPHY.TITLE + 2 },
  ordersHeaderSubtitle: { color: THEME.mutedText, fontSize: TYPOGRAPHY.BODY - 1, fontWeight: "600", fontFamily: FONT_SANS },
  printAllButton: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
    borderRadius: RADIUS.SM,
    paddingVertical: 0,
    paddingHorizontal: SPACING.SM,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  printAllButtonText: { color: COLORS.ACCENT, fontSize: 12, fontWeight: "700", fontFamily: FONT_SANS },
  ordersRefreshButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: THEME.card,
  },
  ordersRefreshButtonCompact: { width: 42, height: 42, borderRadius: 21 },
  ordersRefreshIcon: { color: THEME.text, fontSize: 20, fontWeight: "700", fontFamily: FONT_SANS },
  ordersFilterRow: { gap: SPACING.XS, paddingVertical: SPACING.XXS, paddingRight: SPACING.XXS },
  ordersFilterPill: {
    minHeight: 42,
    paddingHorizontal: SPACING.MD,
    borderRadius: RADIUS.PILL,
    borderWidth: 1,
    borderColor: THEME.border,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  ordersFilterPillCompact: { minHeight: 40, paddingHorizontal: 14 },
  ordersFilterPillActive: {
    backgroundColor: THEME.accent,
    borderColor: THEME.accent,
  },
  ordersFilterPillText: { color: THEME.text, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  ordersFilterPillTextCompact: { fontSize: 13 },
  ordersFilterPillTextActive: { color: THEME.activeTextDark },
  ordersList: { width: "100%", gap: SPACING.SM, alignItems: "center" },
  ordersAddButton: { width: "100%", minHeight: 44, justifyContent: "center" },
  ordersEmptyState: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: SPACING.XL + SPACING.MD,
    paddingHorizontal: SPACING.XL,
    gap: SPACING.XS,
  },
  ordersEmptyEmoji: { fontSize: 34 },
  ordersEmptyTitle: { color: THEME.text, fontSize: TYPOGRAPHY.DISPLAY - 2, fontWeight: "700", fontFamily: FONT_SANS },
  ordersEmptySubtitle: {
    color: THEME.mutedText,
    fontSize: TYPOGRAPHY.BODY,
    lineHeight: 22,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  orderPosCard: {
    width: "100%",
    maxWidth: 480,
    alignSelf: "center",
    backgroundColor: THEME.card,
    borderRadius: RADIUS.LG,
    borderWidth: 1,
    borderLeftWidth: 6,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    padding: SPACING.MD,
    gap: SPACING.SM,
    ...CARD_SHADOW,
    elevation: 2,
  },
  orderPosCardPending: { borderLeftColor: ORDER_STATUS_PENDING },
  orderPosCardComplete: { borderLeftColor: ORDER_STATUS_COMPLETE },
  orderPosCardCancelled: { borderLeftColor: ORDER_STATUS_CANCELLED },
  orderCardTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  orderShortCode: { color: THEME.accent, fontSize: 26, fontWeight: "800", fontFamily: FONT_SANS, lineHeight: 30 },
  orderShortCodeCompact: { fontSize: 24, lineHeight: 28 },
  orderStatusPill: {
    minHeight: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  orderStatusPillPending: { backgroundColor: COLORS.WARNING_BG, borderColor: ORDER_STATUS_PENDING },
  orderStatusPillComplete: { backgroundColor: COLORS.SUCCESS_BG, borderColor: ORDER_STATUS_COMPLETE },
  orderStatusPillCancelled: { backgroundColor: COLORS.DANGER_BG, borderColor: ORDER_STATUS_CANCELLED },
  orderStatusPillText: { fontSize: 12, fontWeight: "800", letterSpacing: 0.4, fontFamily: FONT_SANS },
  orderStatusPillTextDark: { color: COLORS.TEXT_PRIMARY },
  orderStatusPillTextLight: { color: COLORS.TEXT_PRIMARY },
  orderCustomerLine: { color: THEME.text, fontSize: 16, fontFamily: FONT_SANS, lineHeight: 22 },
  orderCustomerLineCompact: { fontSize: 15, lineHeight: 20 },
  orderCustomerName: { color: THEME.text, fontSize: 16, fontWeight: "700", fontFamily: FONT_SANS },
  orderCustomerNameCompact: { fontSize: 15 },
  orderCustomerPhone: { color: THEME.mutedText, fontSize: 14, fontWeight: "500", fontFamily: FONT_SANS },
  orderDivider: { height: 1, backgroundColor: "rgba(151, 171, 199, 0.14)" },
  orderItemsList: { gap: 8 },
  orderItemsEmptyText: { color: THEME.mutedText, fontSize: 14, lineHeight: 20, fontFamily: FONT_SANS },
  orderItemRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  orderItemName: { flex: 1, color: THEME.text, fontSize: 14, lineHeight: 19, fontFamily: FONT_SANS },
  orderItemPrice: { color: THEME.text, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderTotalRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  orderTotalLabel: {
    color: THEME.mutedText,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 0.7,
    fontFamily: FONT_SANS,
  },
  orderTotalAmount: { color: THEME.accent, fontSize: 18, fontWeight: "800", fontFamily: FONT_SANS },
  orderCardActionStack: { gap: 8 },
  orderCardActionRow: { flexDirection: "row", gap: 8 },
  orderCardActionRowCompact: { gap: 8 },
  orderCardActionRowSecondary: { marginTop: 2 },
  orderCardActionButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  orderCardActionButtonFull: { flexBasis: "100%" },
  orderCardPrimaryAction: { backgroundColor: THEME.primary, borderWidth: 1, borderColor: THEME.primary },
  orderCardPrimaryActionText: { color: COLORS.SURFACE, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderCardSecondaryAction: {
    backgroundColor: THEME.primarySoft,
    borderWidth: 1,
    borderColor: THEME.accentSoft,
  },
  orderCardSecondaryActionText: { color: THEME.accent, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  printButton: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 14,
    paddingVertical: 0,
    paddingHorizontal: 14,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  printButtonText: { color: COLORS.TEXT_SECONDARY, fontSize: 13, fontWeight: "700", fontFamily: FONT_SANS },
  orderPreviewButton: {
    width: 44,
    flex: 0,
    flexBasis: 44,
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: 14,
    paddingHorizontal: 0,
    minHeight: 44,
  },
  orderPreviewButtonText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 18,
    textAlign: "center",
    lineHeight: 20,
  },
  orderDetailsToggle: {
    minHeight: 42,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    alignItems: "center",
    justifyContent: "center",
  },
  orderDetailsToggleText: { color: THEME.mutedText, fontSize: 13, fontWeight: "700", fontFamily: FONT_SANS },
  orderDetailsSection: {
    gap: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(151, 171, 199, 0.12)",
  },
  orderFieldGrid: { flexDirection: "row", gap: 10 },
  orderFieldGridStacked: { flexDirection: "column" },
  orderFieldColumn: { flex: 1, gap: 6 },
  orderFieldLabel: {
    color: THEME.mutedText,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  orderCompactInput: { minHeight: 44, paddingVertical: 10, fontSize: 14 },
  orderCompactNotesInput: { minHeight: 72, paddingVertical: 10, fontSize: 14, textAlignVertical: "top" },
  orderStatusToggleRow: { flexDirection: "row", gap: 8 },
  orderStatusToggle: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.chipBorder,
    backgroundColor: THEME.chip,
    alignItems: "center",
    justifyContent: "center",
  },
  orderStatusToggleActive: { borderColor: THEME.accent, backgroundColor: THEME.accent },
  orderStatusToggleText: { color: THEME.chipText, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderStatusToggleTextActive: { color: THEME.activeTextDark },
  orderEditActionRow: { flexDirection: "row", gap: 10 },
  orderEditorSaveButton: { backgroundColor: THEME.primary, borderWidth: 1, borderColor: THEME.primary },
  orderEditorSaveText: { color: COLORS.SURFACE, fontSize: 15, fontWeight: "700", fontFamily: FONT_SANS },
  orderEditorRemoveButton: {
    backgroundColor: COLORS.DANGER_TINT,
    borderWidth: 1,
    borderColor: COLORS.DANGER_SOFT,
  },
  orderEditorRemoveText: { color: COLORS.DANGER, fontSize: 15, fontWeight: "700", fontFamily: FONT_SANS },
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
    borderColor: COLORS.BORDER,
    backgroundColor: THEME.primarySoft,
    alignItems: "center",
  },
  orderCallChipText: { color: THEME.chipText, fontSize: 12, fontWeight: "700", fontFamily: FONT_SANS },
  thermalPreviewOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: COLORS.MODAL_OVERLAY,
  },
  thermalPreviewScreen: {
    flex: 1,
    backgroundColor: COLORS.PAPER_SURROUND,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
    paddingBottom: SAFE_AREA.bottom,
  },
  thermalPreviewBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  thermalPreviewContainer: {
    width: "100%",
    maxWidth: 380,
    maxHeight: "90%",
    overflow: "hidden",
    borderRadius: 16,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    ...CARD_SHADOW,
  },
  thermalPreviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    backgroundColor: COLORS.PAPER_SURROUND,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  thermalPreviewTitle: {
    flex: 1,
    color: COLORS.SURFACE,
    fontSize: 16,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  thermalPreviewHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  thermalPreviewPrintButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  thermalPreviewPrintButtonText: {
    color: COLORS.SURFACE_DARK,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  thermalPreviewCloseButton: {
    backgroundColor: "transparent",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  thermalPreviewCloseButtonText: {
    color: COLORS.TEXT_MUTED,
    fontSize: 14,
    fontFamily: FONT_SANS,
  },
  thermalPreviewPaperLabel: {
    color: COLORS.TEXT_MUTED,
    fontSize: 10,
    textAlign: "center",
    paddingVertical: 6,
    backgroundColor: COLORS.PAPER_SURROUND,
    fontFamily: FONT_SANS,
  },
  thermalPreviewScroll: {
    flex: 1,
    backgroundColor: COLORS.PAPER_SURROUND,
  },
  thermalPreviewScrollContent: {
    paddingVertical: 24,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  thermalReceiptPaper: {
    width: 220,
    backgroundColor: COLORS.PAPER,
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 8,
    ...PAPER_CARD_SHADOW,
    elevation: 10,
  },
  thermalReceiptRestaurantName: {
    color: COLORS.INK,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 1.5,
    marginBottom: 2,
    fontFamily: FONT_MONO,
  },
  thermalReceiptSubtitle: {
    color: COLORS.INK_MUTED,
    fontSize: 9,
    textAlign: "center",
    marginBottom: 6,
    fontFamily: FONT_MONO,
  },
  thermalReceiptDividerSolid: {
    color: COLORS.INK,
    fontSize: 8,
    textAlign: "center",
    marginBottom: 4,
    fontFamily: FONT_MONO,
  },
  thermalReceiptDividerDashed: {
    color: COLORS.INK,
    fontSize: 8,
    textAlign: "center",
    marginBottom: 4,
    fontFamily: FONT_MONO,
  },
  thermalReceiptOrderCode: {
    color: COLORS.INK,
    fontSize: 13,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 2,
    marginVertical: 4,
    fontFamily: FONT_MONO,
  },
  thermalReceiptStatus: {
    color: COLORS.INK,
    fontSize: 9,
    textAlign: "center",
    marginBottom: 4,
    fontFamily: FONT_MONO,
  },
  thermalReceiptMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
    marginVertical: 1,
  },
  thermalReceiptMetaLabel: {
    width: 52,
    color: COLORS.INK,
    fontSize: 9,
    fontFamily: FONT_MONO,
  },
  thermalReceiptMetaValue: {
    flex: 1,
    color: COLORS.INK,
    fontSize: 9,
    textAlign: "right",
    fontFamily: FONT_MONO,
  },
  thermalReceiptItemsHeader: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.INK,
    paddingBottom: 2,
    marginBottom: 2,
  },
  thermalReceiptItemsHeaderName: {
    flex: 1,
    color: COLORS.INK,
    fontSize: 8,
    fontWeight: "700",
    fontFamily: FONT_MONO,
  },
  thermalReceiptItemsHeaderQty: {
    width: 24,
    color: COLORS.INK,
    fontSize: 8,
    fontWeight: "700",
    textAlign: "center",
    fontFamily: FONT_MONO,
  },
  thermalReceiptItemsHeaderPrice: {
    width: 44,
    color: COLORS.INK,
    fontSize: 8,
    fontWeight: "700",
    textAlign: "right",
    fontFamily: FONT_MONO,
  },
  thermalReceiptItemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 1,
  },
  thermalReceiptItemName: {
    flex: 1,
    color: COLORS.INK,
    fontSize: 9,
    fontFamily: FONT_MONO,
    paddingRight: 6,
  },
  thermalReceiptItemQty: {
    width: 24,
    color: COLORS.INK,
    fontSize: 9,
    textAlign: "center",
    fontFamily: FONT_MONO,
  },
  thermalReceiptItemPrice: {
    width: 44,
    color: COLORS.INK,
    fontSize: 9,
    textAlign: "right",
    fontFamily: FONT_MONO,
  },
  thermalReceiptTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.INK,
  },
  thermalReceiptTotalLabel: {
    color: COLORS.INK,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: FONT_MONO,
  },
  thermalReceiptTotalAmount: {
    color: COLORS.INK,
    fontSize: 12,
    fontWeight: "700",
    fontFamily: FONT_MONO,
  },
  thermalReceiptFooterTitle: {
    color: COLORS.INK,
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 6,
    fontFamily: FONT_MONO,
  },
  thermalReceiptFooterText: {
    color: COLORS.INK_MUTED,
    fontSize: 8,
    textAlign: "center",
    marginTop: 2,
    fontFamily: FONT_MONO,
  },
  thermalReceiptTearRow: {
    width: 220,
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: COLORS.PAPER_SURROUND,
  },
  thermalReceiptTearTooth: {
    width: 0,
    height: 0,
    borderLeftWidth: 6,
    borderLeftColor: "transparent",
    borderRightWidth: 6,
    borderRightColor: "transparent",
    borderTopWidth: 10,
    borderTopColor: COLORS.PAPER,
  },
  thermalReceiptEmptyText: {
    color: COLORS.INK,
    fontSize: 9,
    textAlign: "center",
    fontFamily: FONT_MONO,
  },
  callReviewOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
    zIndex: 60,
    elevation: 60,
  },
  callReviewOverlayCompact: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 0,
    justifyContent: "flex-end",
    alignItems: "stretch",
  },
  callReviewBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(7, 14, 26, 0.78)",
  },
  callReviewModal: {
    width: "100%",
    alignSelf: "center",
    maxWidth: 500,
    backgroundColor: COLORS.SURFACE,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    ...CARD_SHADOW,
    overflow: "hidden",
  },
  callReviewModalWeb: { minWidth: 320 },
  callReviewModalCompact: {
    maxWidth: 500,
    alignSelf: "center",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    minWidth: 0,
  },
  callReviewScreen: {
    flex: 1,
    backgroundColor: COLORS.SURFACE,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
    paddingBottom: SAFE_AREA.bottom,
  },
  callReviewHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
  },
  callReviewHeaderContent: { flex: 1, minWidth: 0 },
  callReviewHeaderCompact: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 },
  callReviewHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    minWidth: 0,
  },
  callReviewHeaderRowCompact: { gap: 8 },
  callReviewHeaderMeta: { gap: 8, minWidth: 0 },
  callReviewTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 20,
    fontWeight: "700",
    fontFamily: FONT_SANS,
    flex: 1,
    minWidth: 0,
  },
  callReviewTitleCompact: { fontSize: 18, lineHeight: 22 },
  callReviewSubtitle: { color: COLORS.VOICE_COLOR, fontSize: 17, fontWeight: "700", fontFamily: FONT_SANS },
  callReviewSubtitleCompact: { fontSize: 16, lineHeight: 21 },
  callReviewStatusBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 20,
    minHeight: 24,
    justifyContent: "center",
  },
  callReviewStatusBadgeSuccess: { backgroundColor: COLORS.SUCCESS_TINT },
  callReviewStatusBadgePending: { backgroundColor: COLORS.WARNING_TINT },
  callReviewStatusBadgeDefault: { backgroundColor: COLORS.SURFACE_RAISED },
  callReviewStatusBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  callReviewStatusBadgeTextSuccess: { color: COLORS.SUCCESS },
  callReviewStatusBadgeTextPending: { color: COLORS.WARNING },
  callReviewStatusBadgeTextDefault: { color: COLORS.TEXT_MUTED },
  callReviewDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: COLORS.BORDER,
    marginHorizontal: 16,
  },
  callReviewAudioRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 4,
  },
  callReviewAudioButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.ACCENT,
    alignItems: "center",
    justifyContent: "center",
  },
  callReviewAudioButtonDisabled: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  callReviewAudioIconWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  callReviewAudioIconPlay: {
    paddingLeft: 2,
  },
  callReviewAudioIconStop: {
  },
  callReviewAudioIconDisabled: { opacity: 0.5 },
  callReviewAudioProgressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    marginHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.15)",
    overflow: "hidden",
  },
  callReviewAudioProgressFill: {
    height: "100%",
    width: 0,
    borderRadius: 2,
    backgroundColor: COLORS.ACCENT,
  },
  callReviewAudioDuration: { color: COLORS.TEXT_SECONDARY, fontSize: 12, fontFamily: FONT_MONO },
  callReviewCloseButton: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 16,
    minWidth: 70,
    alignSelf: "flex-start",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  callReviewCloseButtonCompact: { minWidth: 0, paddingVertical: 8, paddingHorizontal: 10 },
  callReviewCloseText: { color: COLORS.TEXT_PRIMARY, fontSize: 15, fontWeight: "600", fontFamily: FONT_SANS },
  callReviewCloseTextCompact: { fontSize: 14 },
  callReviewBodyScroll: { flex: 1, backgroundColor: COLORS.SURFACE },
  callReviewBodyScrollContent: { paddingBottom: 32 },
  callReviewSectionLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  callReviewTranscriptSectionHeader: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
    marginBottom: 8,
  },
  callReviewSectionLabelCompact: { marginLeft: 14, marginTop: 14, marginBottom: 6 },
  callReviewTranscriptBox: {
    flex: 1,
    minHeight: 0,
  },
  callReviewTranscriptBoxCompact: { flex: 1, minHeight: 0 },
  callReviewTranscriptScroll: { flex: 1, minHeight: 180 },
  callReviewTranscriptScrollCompact: { flex: 1 },
  callReviewTranscriptList: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24 },
  callReviewTranscriptListCompact: { paddingHorizontal: 14, paddingTop: 10, paddingBottom: 20 },
  callReviewTranscriptGroup: {
    width: "100%",
    minWidth: 0,
    marginBottom: 12,
  },
  callReviewTranscriptRowPadding: { paddingHorizontal: 20 },
  callReviewTranscriptAgentGroup: { alignSelf: "flex-start", maxWidth: "90%", minWidth: 0 },
  callReviewTranscriptUserGroup: { alignSelf: "flex-end", maxWidth: "85%", minWidth: 0, alignItems: "flex-end" },
  callReviewTranscriptNeutralGroup: { alignSelf: "stretch", minWidth: 0 },
  callReviewTranscriptSpeaker: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.8,
    fontFamily: FONT_SANS,
    textTransform: "uppercase",
  },
  transcriptSpeakerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  callReviewTranscriptSpeakerAgent: { color: COLORS.VOICE_COLOR, marginBottom: 3 },
  callReviewTranscriptSpeakerUser: { color: COLORS.TEXT_MUTED, marginTop: 3, textAlign: "right" },
  callReviewTranscriptSpeakerNeutral: { color: COLORS.TEXT_MUTED, marginBottom: 3 },
  callReviewTranscriptAgentBubble: {
    backgroundColor: COLORS.VOICE_TINT,
    borderRadius: 12,
    borderTopLeftRadius: 4,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.VOICE_COLOR,
  },
  callReviewTranscriptUserBubble: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 12,
    borderTopRightRadius: 4,
    padding: 10,
  },
  callReviewTranscriptNeutralBubble: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  callReviewTranscriptMessage: { color: COLORS.TEXT_PRIMARY, fontSize: 14, lineHeight: 20, fontFamily: FONT_SANS, flexShrink: 1 },
  callReviewTranscriptFallback: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    padding: 12,
  },
  callReviewTranscriptEmpty: {
    color: COLORS.TEXT_MUTED,
    fontSize: 14,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  callReviewTranscriptEmptyWrap: { alignItems: "center", paddingVertical: 40 },
  orderTranscriptText: { color: COLORS.TEXT_PRIMARY, fontSize: 14, lineHeight: 20, fontFamily: FONT_SANS },
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
    minHeight: 44,
    backgroundColor: THEME.cardAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  orderEditorToggleText: { color: THEME.accent, fontSize: 14, fontWeight: "700", fontFamily: FONT_SANS },
  orderRawEditorBox: {
    backgroundColor: THEME.cardAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: THEME.border,
    padding: 12,
    gap: 8,
  },
  orderEditorHint: { color: THEME.mutedText, fontSize: 12, lineHeight: 17, fontFamily: FONT_SANS },
  orderItemsInput: { minHeight: 110, textAlignVertical: "top", fontSize: 14 },
  orderItemPickerOverlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(15, 23, 42, 0.3)",
  },
  orderItemPickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  orderItemPickerSheet: {
    maxHeight: "92%",
    backgroundColor: COLORS.SURFACE,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 10,
    paddingBottom: (Platform.OS === "ios" ? 20 : 14) + SAFE_AREA.bottom,
    ...SHEET_CARD_SHADOW,
    elevation: 12,
  },
  orderItemPickerHandle: {
    alignSelf: "center",
    width: 48,
    height: 4,
    borderRadius: 999,
    backgroundColor: COLORS.BORDER,
    marginBottom: 10,
  },
  orderItemPickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
  },
  orderItemPickerTitle: {
    flex: 1,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 18,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  orderItemPickerHeaderActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  orderItemPickerSecondaryButton: {
    minHeight: 36,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemPickerSecondaryButtonText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  orderItemPickerPrimaryButton: {
    minHeight: 36,
    borderRadius: 8,
    backgroundColor: COLORS.ACCENT,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemPickerPrimaryButtonText: {
    color: COLORS.SURFACE,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerSearchInput: {
    minHeight: 42,
    borderRadius: 10,
    backgroundColor: COLORS.SURFACE_RAISED,
    marginHorizontal: 12,
    marginTop: 12,
    paddingHorizontal: 14,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  orderItemPickerScroll: { flexGrow: 0 },
  orderItemPickerList: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 8,
    gap: 8,
  },
  orderItemPickerListGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: 10,
  },
  orderItemPickerEmptyState: {
    borderRadius: 12,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 16,
    paddingVertical: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemPickerEmptyTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerEmptyText: {
    marginTop: 6,
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  orderItemPickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 12,
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  orderItemPickerRowGrid: {
    minHeight: 116,
    flexDirection: "column",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  orderItemPickerRowGridTwo: {
    width: "48.5%",
  },
  orderItemPickerRowGridThree: {
    width: "31.5%",
  },
  orderItemPickerRowGridFour: {
    width: "23.7%",
  },
  orderItemPickerRowText: { flex: 1, gap: 2 },
  orderItemPickerRowTextGrid: {
    flex: 0,
    minHeight: 62,
  },
  orderItemPickerRowTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  orderItemPickerRowMeta: {
    color: COLORS.TEXT_MUTED,
    fontSize: 11,
    fontFamily: FONT_SANS,
  },
  orderItemPickerStockMeta: {
    color: COLORS.SUCCESS,
    fontSize: 11,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerStockMetaWarning: {
    color: COLORS.DANGER,
  },
  orderItemPickerCustomizationMeta: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 11,
    lineHeight: 16,
    fontFamily: FONT_SANS,
  },
  orderItemPickerRowPrice: {
    color: COLORS.ACCENT,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerAddButton: {
    minHeight: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
    minWidth: 86,
    paddingHorizontal: 16,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-end",
  },
  orderItemPickerAddButtonText: {
    color: COLORS.ACCENT,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerCustomizeButton: {
    minWidth: 112,
  },
  orderItemPickerActionWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemPickerActionWrapGrid: {
    width: "100%",
    alignItems: "flex-end",
  },
  orderItemPickerQuantityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  orderItemPickerQuantityRowGrid: {
    alignSelf: "flex-end",
  },
  orderItemPickerQtyButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  orderItemPickerControlDisabled: {
    opacity: 0.45,
  },
  orderItemPickerQtyButtonAccent: { backgroundColor: COLORS.ACCENT_TINT },
  orderItemPickerQtyButtonDanger: { backgroundColor: COLORS.DANGER_TINT },
  orderItemPickerQtyButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 18,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderItemPickerQtyValue: {
    minWidth: 18,
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  orderItemPickerSelectedCount: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
    fontFamily: FONT_SANS,
  },
  orderItemPickerFooter: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: COLORS.SURFACE_DARK,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  orderItemPickerFooterText: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 13,
    fontFamily: FONT_SANS,
  },
  orderItemPickerFooterTotal: {
    color: COLORS.SURFACE,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  orderActionRow: { gap: SPACING.XS },
  orderActionRowWeb: { flexDirection: "row", alignItems: "center" },
  orderPrimaryActionWeb: { flexGrow: 0, minWidth: 240 },
  orderSecondaryActionMobile: { alignSelf: "stretch", justifyContent: "center" },
  errorText: { color: COLORS.DANGER, fontSize: 12, lineHeight: 17, fontFamily: FONT_SANS },
  settingsHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.LG,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top + SPACING.SM : SPACING.SM,
    paddingBottom: SPACING.SM,
    backgroundColor: COLORS.HEADER_BG,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  settingsBackButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingVertical: SPACING.XS,
    minWidth: 80,
    gap: SPACING.XXS,
  },
  settingsBackIconWrap: {
    width: 14,
    height: 14,
    position: "relative",
  },
  settingsBackIconStroke: {
    position: "absolute",
    left: 1,
    width: 10,
    height: 2.25,
    borderRadius: 999,
    backgroundColor: COLORS.HEADER_TEXT,
  },
  settingsBackIconStrokeUpper: {
    top: 3,
    transform: [{ rotate: "-45deg" }],
  },
  settingsBackIconStrokeLower: {
    top: 9,
    transform: [{ rotate: "45deg" }],
  },
  settingsBackText: {
    fontSize: TYPOGRAPHY.BODY + 1,
    lineHeight: 20,
    color: COLORS.HEADER_TEXT,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  settingsHeaderTitle: {
    flex: 1,
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "800",
    color: COLORS.HEADER_TEXT,
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  settingsHeaderActions: {
    minWidth: 110,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: SPACING.XS,
  },
  settingsHeaderGear: { color: COLORS.HEADER_TEXT, fontSize: 18, fontFamily: FONT_SANS },
  settingsHeaderSyncButton: {
    borderRadius: RADIUS.PILL,
    backgroundColor: COLORS.ACCENT,
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS,
  },
  settingsHeaderSyncButtonText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  settingsHeaderPrinterButton: {
    borderRadius: RADIUS.PILL,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  settingsHeaderPrinterButtonText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 13,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  settingsHeaderLogoutPlain: { paddingVertical: 6 },
  settingsHeaderLogoutPill: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: RADIUS.PILL,
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS,
  },
  settingsHeaderLogoutText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 14,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  settingsScreenSafe: { backgroundColor: COLORS.BACKGROUND },
  settingsScreenScroll: { backgroundColor: COLORS.BACKGROUND },
  lightAdminScreenSafe: { backgroundColor: COLORS.BACKGROUND },
  lightAdminScreenScroll: { backgroundColor: COLORS.BACKGROUND },
  lightAdminScreenContent: { backgroundColor: COLORS.BACKGROUND, paddingTop: SPACING.LG },
  lightAdminHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACING.LG,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top + SPACING.XS : SPACING.SM,
    paddingBottom: SPACING.SM,
    backgroundColor: COLORS.BACKGROUND,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
  },
  lightAdminBackButton: {
    flexDirection: "row",
    alignItems: "center",
    minWidth: 72,
    paddingVertical: SPACING.XS - 2,
  },
  lightAdminBackIcon: {
    fontSize: 22,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  lightAdminBackText: {
    fontSize: TYPOGRAPHY.BODY + 2,
    color: COLORS.TEXT_PRIMARY,
    marginLeft: 2,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  lightAdminHeaderTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: TYPOGRAPHY.TITLE,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  lightAdminDoneButton: {
    minWidth: 90,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: SPACING.XS - 2,
  },
  lightAdminDoneIcon: {
    fontSize: 20,
    color: COLORS.ACCENT,
    fontFamily: FONT_SANS,
  },
  lightAdminDoneText: {
    fontSize: TYPOGRAPHY.BODY,
    color: COLORS.ACCENT,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  lightAdminHeaderSpacer: { minWidth: 72 },
  settingsWideSection: {
    width: "100%",
  },
  settingsWideSectionLandscape: {
    width: "100%",
    alignSelf: "stretch",
  },
  settingsPanelsWrap: {
    width: "100%",
  },
  settingsPanelsWrapLandscape: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.MD,
    width: "100%",
    alignSelf: "stretch",
  },
  settingsPanelColumnLandscape: {
    flex: 1,
    minWidth: 0,
  },
  scannerCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    marginHorizontal: SPACING.MD,
    marginBottom: SPACING.MD,
    padding: SPACING.LG,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    ...SOFT_CARD_SHADOW,
    elevation: 2,
  },
  scannerCardLandscape: {
    marginHorizontal: 0,
    marginBottom: 0,
  },
  scannerCardTitle: {
    fontSize: TYPOGRAPHY.DISPLAY - 6,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    marginBottom: SPACING.MD,
    fontFamily: FONT_SANS,
  },
  scannerRestaurantSelector: {
    gap: SPACING.XS,
    paddingBottom: SPACING.SM,
  },
  scannerRestaurantChip: {
    borderRadius: RADIUS.PILL,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.XS + 1,
  },
  scannerRestaurantChipActive: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderColor: COLORS.ACCENT,
  },
  scannerRestaurantChipText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  scannerRestaurantChipTextActive: {
    color: COLORS.ACCENT,
  },
  scannerFieldShell: {
    position: "relative",
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.SM,
    paddingTop: SPACING.LG,
    paddingBottom: SPACING.SM,
    marginBottom: SPACING.SM,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  scannerFieldShellMultiline: {
    minHeight: 92,
  },
  scannerFieldLabel: {
    position: "absolute",
    top: SPACING.XS + 1,
    left: SPACING.SM,
    fontSize: TYPOGRAPHY.CAPTION,
    color: COLORS.TEXT_MUTED,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    fontFamily: FONT_SANS,
  },
  scannerFieldInput: {
    fontSize: TYPOGRAPHY.BODY + 1,
    color: COLORS.TEXT_PRIMARY,
    minHeight: 24,
    paddingTop: 0,
    paddingBottom: 0,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  scannerFieldInputMultiline: {
    minHeight: 58,
    textAlignVertical: "top",
  },
  scannerPrimaryButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: RADIUS.MD,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  scannerPrimaryWideButton: {
    flex: 1,
    backgroundColor: COLORS.ACCENT,
    borderRadius: RADIUS.MD,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  scannerPrimaryButtonText: {
    color: COLORS.HEADER_TEXT,
    fontSize: TYPOGRAPHY.BODY + 1,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  scannerDescription: {
    fontSize: TYPOGRAPHY.BODY,
    color: COLORS.TEXT_SECONDARY,
    lineHeight: 22,
    marginBottom: SPACING.MD,
    fontFamily: FONT_SANS,
  },
  scannerModeButton: {
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.LG,
    padding: SPACING.SM,
    marginBottom: SPACING.XS,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  scannerModeButtonActive: {
    backgroundColor: COLORS.ACCENT,
    borderColor: COLORS.ACCENT,
  },
  scannerModeButtonTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.BODY + 1,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  scannerModeButtonTitleActive: {
    color: COLORS.HEADER_TEXT,
  },
  scannerModeButtonSubtitle: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.LABEL,
    marginTop: SPACING.XXS,
    fontFamily: FONT_SANS,
  },
  scannerModeButtonSubtitleActive: {
    color: "rgba(255,255,255,0.82)",
  },
  scannerSecondaryModeRow: {
    flexDirection: "row",
    gap: SPACING.XS,
    marginBottom: SPACING.MD,
  },
  scannerCaptureRow: {
    flexDirection: "row",
    gap: SPACING.SM,
    marginBottom: SPACING.MD,
  },
  scannerCaptureButton: {
    flex: 1,
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: SPACING.XS,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  scannerCaptureButtonIcon: {
    fontSize: 16,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  scannerCaptureButtonText: {
    fontSize: TYPOGRAPHY.BODY,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  scannerPreviewImage: {
    width: "100%",
    height: 190,
    borderRadius: RADIUS.SM,
    marginBottom: SPACING.SM,
  },
  scannerNotesInput: {
    minHeight: 110,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.SM,
    paddingVertical: SPACING.SM,
    color: COLORS.TEXT_PRIMARY,
    backgroundColor: COLORS.SURFACE_RAISED,
    textAlignVertical: "top",
    marginBottom: SPACING.SM,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  scannerDraftActionRow: {
    flexDirection: "row",
    gap: SPACING.XS,
    marginTop: SPACING.XXS,
  },
  scannerDraftItemCard: {
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: RADIUS.SM,
    padding: SPACING.SM,
    gap: SPACING.XXS,
    marginTop: SPACING.XXS,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  scannerDraftItemLabel: {
    color: COLORS.ACCENT,
    fontSize: TYPOGRAPHY.LABEL,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: SPACING.XS,
    fontFamily: FONT_SANS,
  },
  scannerSecondaryActionButton: {
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.MD,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.SURFACE_RAISED,
    minHeight: 50,
  },
  scannerSecondaryActionText: {
    color: COLORS.TEXT_PRIMARY,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  voiceConsoleCard: {
    backgroundColor: "transparent",
    borderRadius: 0,
    marginHorizontal: 0,
    marginTop: SPACING.XXS,
    marginBottom: SPACING.SM,
    padding: 0,
  },
  voiceConsoleHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACING.SM,
  },
  voiceConsoleTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  voiceConsoleTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  voiceConsoleEmail: {
    fontSize: TYPOGRAPHY.BODY,
    color: COLORS.TEXT_SECONDARY,
    marginTop: SPACING.XXS,
    fontFamily: FONT_SANS,
  },
  voiceConsoleLogoutButton: {
    paddingHorizontal: 0,
    paddingVertical: 4,
  },
  voiceConsoleLogoutText: {
    color: COLORS.ACCENT,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  voiceModeSwitch: {
    flexDirection: "row",
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: RADIUS.LG,
    padding: SPACING.XXS,
    marginTop: SPACING.SM,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  voiceModeSwitchButton: {
    flex: 1,
    paddingVertical: SPACING.XS + 3,
    alignItems: "center",
    borderRadius: RADIUS.MD,
  },
  voiceModeSwitchButtonActive: {
    backgroundColor: COLORS.ACCENT,
  },
  voiceModeSwitchText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 15,
    fontWeight: "500",
    fontFamily: FONT_SANS,
  },
  voiceModeSwitchTextActive: {
    color: COLORS.HEADER_TEXT,
    fontWeight: "700",
  },
  voiceConfigCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    marginHorizontal: SPACING.MD,
    padding: SPACING.LG,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    ...SOFT_CARD_SHADOW,
    elevation: 2,
  },
  voiceConfigCardLandscape: {
    width: "100%",
    alignSelf: "stretch",
    marginHorizontal: 0,
  },
  voiceConfigContent: {
    width: "100%",
    gap: 0,
  },
  voiceConfigContentLandscape: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACING.LG,
  },
  voiceConfigMainColumn: {
    width: "100%",
  },
  voiceConfigMainColumnLandscape: {
    flex: 1,
    minWidth: 0,
  },
  voiceConfigSidebar: {
    width: "100%",
  },
  voiceConfigSidebarLandscape: {
    width: 320,
    minWidth: 280,
  },
  voiceConfigTitle: {
    fontSize: TYPOGRAPHY.DISPLAY - 6,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    marginBottom: SPACING.MD,
    fontFamily: FONT_SANS,
  },
  voiceConfigLabel: {
    fontSize: TYPOGRAPHY.BODY,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    marginBottom: SPACING.XS - 2,
    fontFamily: FONT_SANS,
  },
  voiceConfigInput: {
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    padding: SPACING.SM,
    fontSize: TYPOGRAPHY.BODY,
    color: COLORS.TEXT_PRIMARY,
    backgroundColor: COLORS.SURFACE_RAISED,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  voiceSavedKeyBox: {
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    padding: SPACING.SM,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  voiceSavedKeyText: {
    fontSize: TYPOGRAPHY.BODY,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_MONO,
  },
  voiceConfigActionStack: {
    gap: SPACING.XS,
    marginTop: SPACING.SM,
  },
  voiceConfigPrimaryButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: RADIUS.MD,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceConfigPrimaryButtonText: {
    color: COLORS.HEADER_TEXT,
    fontSize: 16,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  voiceConfigSecondaryButton: {
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: SPACING.SM,
    backgroundColor: COLORS.SURFACE_RAISED,
  },
  voiceConfigSecondaryButtonText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  voiceLinkedInfoBox: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: RADIUS.LG,
    padding: SPACING.SM,
    marginTop: SPACING.SM,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  voiceLinkedInfoBoxLandscape: {
    marginTop: 0,
  },
  voiceLinkedInfoLabel: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  voiceLinkedInfoValue: {
    fontSize: 13,
    color: COLORS.TEXT_SECONDARY,
    marginTop: 4,
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
  },
  adminIntroSection: { gap: SPACING.MD },
  adminSignedInRow: {
    paddingHorizontal: SPACING.MD,
    paddingVertical: SPACING.SM,
    gap: SPACING.XXS,
  },
  adminSignedInLabel: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: TYPOGRAPHY.BODY - 1,
    fontFamily: FONT_SANS,
  },
  adminSignedInValue: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.BODY,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  headerTextWrap: { flex: 1, gap: SPACING.XXS },
  settingsHeroCard: {
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.XL,
    paddingHorizontal: SPACING.LG,
    paddingVertical: SPACING.MD,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    ...METRIC_CARD_SHADOW,
    elevation: 3,
  },
  settingsHeroEyebrow: {
    color: COLORS.ACCENT,
    letterSpacing: 1.5,
  },
  settingsHeroTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: TYPOGRAPHY.DISPLAY - 2,
    fontWeight: "800",
  },
  settingsHeroSubtitle: {
    color: COLORS.TEXT_SECONDARY,
  },
  settingsLogoutButton: {
    backgroundColor: COLORS.SURFACE_RAISED,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    minWidth: 88,
  },
  settingsLogoutText: { color: COLORS.ACCENT, fontWeight: "700" },
  row: { flexDirection: "row", gap: SPACING.XS },
  parseModeRow: { flexDirection: "row", gap: SPACING.XS, flexWrap: "wrap" },
  parseModeTab: { flexGrow: 1, minWidth: 108 },
  rowBetween: { flexDirection: "row", gap: SPACING.XS, justifyContent: "space-between", alignItems: "center" },
  metricsRow: { flexDirection: "row", gap: SPACING.XS },
  metricCard: {
    flex: 1,
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    paddingVertical: SPACING.MD,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    alignItems: "center",
    ...METRIC_CARD_SHADOW,
    elevation: 2,
  },
  metricValue: { color: COLORS.ACCENT, fontSize: 24, fontWeight: "800", fontFamily: FONT_SANS },
  metricLabel: { color: THEME.mutedText, fontSize: 12, fontWeight: "600", fontFamily: FONT_SANS },
  settingsMetricsRow: { gap: SPACING.XS },
  settingsMetricCard: { backgroundColor: COLORS.SURFACE, paddingVertical: SPACING.MD },
  mainTabs: {
    flexDirection: "row",
    gap: 0,
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    padding: SPACING.XXS,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  mainTabButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: RADIUS.MD,
    alignItems: "center",
    justifyContent: "center",
  },
  mainTabButtonActive: { backgroundColor: COLORS.ACCENT_LIGHT, borderWidth: 1, borderColor: COLORS.ACCENT },
  mainTabText: { color: COLORS.TEXT_PRIMARY, fontWeight: "400", fontSize: 14, fontFamily: FONT_SANS },
  mainTabTextActive: { color: COLORS.ACCENT, fontWeight: "700", fontFamily: FONT_SANS },
  settingsTabs: {
    gap: 0,
    backgroundColor: COLORS.SURFACE,
    borderRadius: RADIUS.LG,
    padding: SPACING.XXS,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    marginBottom: SPACING.MD,
  },
  settingsTabButton: {
    minHeight: 48,
    borderRadius: RADIUS.MD,
    paddingVertical: 0,
    justifyContent: "center",
  },
  settingsTabButtonActive: { backgroundColor: COLORS.ACCENT_LIGHT, borderWidth: 1, borderColor: COLORS.ACCENT },
  settingsTabText: {
    color: COLORS.TEXT_MUTED,
    fontSize: 14,
    fontWeight: "400",
  },
  settingsTabTextActive: { color: COLORS.ACCENT, fontWeight: "700" },
  authSegmentedControl: {
    flexDirection: "row",
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: RADIUS.LG,
    padding: SPACING.XXS,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    marginBottom: SPACING.XL,
  },
  authSegmentTab: {
    flex: 1,
    paddingVertical: SPACING.XS + 3,
    alignItems: "center",
    borderRadius: RADIUS.MD,
    borderWidth: 1,
    borderColor: "transparent",
  },
  authSegmentTabActive: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderColor: COLORS.ACCENT,
  },
  authSegmentTabText: {
    fontSize: 15,
    fontWeight: "500",
    color: COLORS.TEXT_MUTED,
    fontFamily: FONT_SANS,
  },
  authSegmentTabTextActive: {
    color: COLORS.ACCENT,
    fontWeight: "700",
  },
  authInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
    borderRadius: RADIUS.MD,
    paddingHorizontal: SPACING.SM,
    marginBottom: SPACING.SM,
    backgroundColor: COLORS.SURFACE_RAISED,
    height: 56,
    overflow: "hidden",
  },
  authFieldFocused: {
    borderColor: COLORS.ACCENT,
  },
  authInputIcon: {
    fontSize: 16,
    marginRight: 10,
    color: COLORS.TEXT_MUTED,
    fontFamily: FONT_SANS,
  },
  authInputField: {
    minWidth: 0,
    height: "100%",
    fontSize: 15,
    color: COLORS.TEXT_PRIMARY,
    paddingVertical: 0,
    backgroundColor: "transparent",
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  authInputFieldFlex: {
    flex: 1,
  },
  authShowHideButton: {
    paddingLeft: 10,
  },
  authShowHideText: {
    fontSize: 13,
    fontWeight: "600",
    color: COLORS.ACCENT,
    fontFamily: FONT_SANS,
  },
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
  authGuidelinesCard: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
  },
  authGuidelinesTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    marginBottom: 10,
    fontFamily: FONT_SANS,
  },
  authGuidelineRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 6,
  },
  authGuidelineCheck: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: COLORS.BORDER,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  authGuidelineCheckMet: {
    backgroundColor: COLORS.ACCENT,
  },
  authGuidelineCheckText: {
    color: COLORS.SURFACE,
    fontSize: 10,
    fontFamily: FONT_SANS,
  },
  authGuidelineText: {
    fontSize: 13,
    color: COLORS.TEXT_SECONDARY,
    flex: 1,
    fontFamily: FONT_SANS,
  },
  authSubmitButton: {
    backgroundColor: COLORS.ACCENT,
    borderRadius: 10,
    height: 50,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  authSubmitButtonDisabled: {
    opacity: 0.6,
  },
  authSubmitButtonText: {
    color: COLORS.SURFACE,
    fontSize: 16,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  authForgotPasswordButton: {
    alignItems: "center",
    marginTop: 14,
  },
  authForgotPasswordText: {
    fontSize: 14,
    color: COLORS.ACCENT,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  authBackButton: {
    alignItems: "center",
    marginTop: 16,
  },
  authBackButtonText: {
    fontSize: 14,
    color: COLORS.ACCENT,
    fontWeight: "600",
    textDecorationLine: "underline",
    fontFamily: FONT_SANS,
  },
  voiceAgentSavedKeyCard: {
    backgroundColor: THEME.cardAlt,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: THEME.border,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  voiceAgentSavedKeyLabel: {
    color: THEME.mutedText,
    fontSize: 12,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  voiceAgentSavedKeyValue: {
    color: THEME.text,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_MONO,
  },
  voiceAgentSavedKeyActions: {
    gap: 10,
  },
  voiceAgentEditActions: {
    gap: 10,
  },
  multi: { minHeight: 70, textAlignVertical: "top" },
  multiLarge: { minHeight: 110, textAlignVertical: "top" },
  modeSwitch: {
    flexDirection: "row",
    backgroundColor: COLORS.SURFACE_RAISED,
    borderRadius: 18,
    padding: 5,
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.SURFACE_BORDER_SOFT,
  },
  modeSwitchButton: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: "center",
  },
  modeSwitchButtonActive: {
    backgroundColor: COLORS.ACCENT,
  },
  modeSwitchText: { color: COLORS.TEXT_SECONDARY, fontWeight: "500", fontSize: 15, fontFamily: FONT_SANS },
  modeSwitchTextActive: { color: COLORS.SURFACE, fontWeight: "700", fontFamily: FONT_SANS },
  primary: { backgroundColor: THEME.primary, borderRadius: 16, alignItems: "center", paddingVertical: 13 },
  primaryDisabled: { opacity: 0.6 },
  primaryWide: {
    flex: 1,
    backgroundColor: THEME.primary,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  primaryText: { color: COLORS.SURFACE, fontWeight: "800", letterSpacing: 0.2, fontFamily: FONT_SANS },
  secondary: {
    backgroundColor: THEME.primarySoft,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.accentSoft,
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  secondaryCompact: {
    backgroundColor: THEME.primarySoft,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: THEME.accentSoft,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    minWidth: 88,
  },
  secondaryText: { color: THEME.accent, fontWeight: "700", fontFamily: FONT_SANS },
  chip: {
    backgroundColor: THEME.chip,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: THEME.chipBorder,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  chipActive: { backgroundColor: THEME.primary, borderColor: THEME.primary },
  chipText: { color: THEME.chipText, fontWeight: "600", fontFamily: FONT_SANS },
  chipTextActive: { color: COLORS.SURFACE, fontFamily: FONT_SANS },
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
    backgroundColor: COLORS.SUCCESS_BG,
    borderColor: COLORS.SUCCESS,
  },
  noticeError: {
    backgroundColor: COLORS.DANGER_BG,
    borderColor: COLORS.DANGER,
  },
  noticeWarning: {
    backgroundColor: COLORS.WARNING_BG,
    borderColor: COLORS.WARNING,
  },
  noticeInfo: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderColor: COLORS.ACCENT,
  },
})

const editModalStyles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.BACKGROUND,
    paddingTop: Platform.OS === "android" ? SAFE_AREA.top : 0,
    paddingBottom: SAFE_AREA.bottom,
  },
  keyboardFill: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: COLORS.SURFACE,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.BORDER,
    gap: 12,
  },
  headerSideButton: {
    minWidth: 84,
  },
  noticeWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  cancelText: {
    fontSize: 16,
    color: COLORS.TEXT_SECONDARY,
    fontFamily: FONT_SANS,
  },
  saveText: {
    fontSize: 16,
    fontWeight: "700",
    color: COLORS.ACCENT,
    textAlign: "right",
    fontFamily: FONT_SANS,
  },
  formContent: {
    padding: 16,
    paddingBottom: 40,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.TEXT_SECONDARY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
    fontFamily: FONT_SANS,
  },
  sectionLabelInline: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.TEXT_SECONDARY,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  row: {
    flexDirection: "row",
  },
  rowStacked: {
    flexDirection: "column",
    gap: 12,
  },
  fieldColumn: {
    flex: 1,
  },
  fieldColumnLeft: {
    marginRight: 8,
  },
  fieldColumnRight: {
    marginLeft: 8,
  },
  fieldLabel: {
    fontSize: 12,
    color: COLORS.TEXT_MUTED,
    marginBottom: 4,
    fontFamily: FONT_SANS,
  },
  textInput: {
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
    ...WEB_TEXT_INPUT_RESET,
  },
  notesInput: {
    minHeight: 90,
    textAlignVertical: "top",
    paddingTop: 12,
  },
  fulfillmentSummaryCard: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  fulfillmentSummaryBadge: {
    alignSelf: "flex-start",
    minHeight: 32,
    borderRadius: 999,
    paddingHorizontal: 12,
    justifyContent: "center",
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderWidth: 1,
    borderColor: COLORS.ACCENT,
  },
  fulfillmentSummaryBadgeText: {
    color: COLORS.ACCENT,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.4,
    fontFamily: FONT_SANS,
  },
  deliveryGuidanceCard: {
    marginTop: 16,
    marginBottom: 4,
    borderRadius: 12,
    backgroundColor: COLORS.WARNING_BG,
    borderWidth: 1,
    borderColor: COLORS.WARNING,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  deliveryGuidanceTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 14,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  deliveryGuidanceText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_SANS,
  },
  deliveryReadOnlyField: {
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE_RAISED,
    paddingHorizontal: 14,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  deliveryReadOnlyFieldText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 15,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  statusRow: {
    flexDirection: "row",
    gap: 10,
  },
  statusButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.BORDER,
    alignItems: "center",
    backgroundColor: COLORS.SURFACE,
  },
  statusButtonActive: {
    backgroundColor: COLORS.ACCENT,
    borderColor: COLORS.ACCENT,
  },
  statusButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: COLORS.TEXT_SECONDARY,
    fontFamily: FONT_SANS,
  },
  statusButtonTextActive: {
    color: COLORS.SURFACE,
  },
  itemsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 20,
    marginBottom: 8,
  },
  addItemsButton: {
    backgroundColor: COLORS.ACCENT_LIGHT,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addItemsButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: COLORS.ACCENT,
    fontFamily: FONT_SANS,
  },
  itemsCard: {
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  emptyItemsText: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 12,
    fontFamily: FONT_SANS,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: 14,
    backgroundColor: COLORS.SURFACE,
    marginBottom: 10,
  },
  itemBody: {
    flex: 1,
    gap: 4,
  },
  itemName: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  itemMeta: {
    fontSize: 12,
    color: COLORS.TEXT_SECONDARY,
    fontFamily: FONT_SANS,
  },
  itemActions: {
    alignItems: "flex-end",
    gap: 8,
  },
  itemQuantityBadge: {
    minWidth: 64,
    borderRadius: 999,
    backgroundColor: COLORS.ACCENT_LIGHT,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
  },
  itemQuantityBadgeText: {
    fontSize: 12,
    fontWeight: "700",
    color: COLORS.ACCENT,
    fontFamily: FONT_SANS,
  },
  itemPrice: {
    fontSize: 15,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  itemRemoveButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.DANGER_BG,
    alignItems: "center",
    justifyContent: "center",
  },
  itemRemoveButtonText: {
    color: COLORS.DANGER,
    fontSize: 20,
    lineHeight: 20,
    fontFamily: FONT_SANS,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 2,
    borderTopColor: COLORS.TEXT_PRIMARY,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: "800",
    color: COLORS.TEXT_PRIMARY,
    fontFamily: FONT_SANS,
  },
  totalAmount: {
    fontSize: 16,
    fontWeight: "800",
    color: COLORS.ACCENT,
    fontFamily: FONT_SANS,
  },
  removeOrderButton: {
    marginTop: 18,
    minHeight: 48,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.DANGER,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLORS.DANGER_BG,
  },
  removeOrderButtonText: {
    fontSize: 14,
    fontWeight: "700",
    color: COLORS.DANGER,
    fontFamily: FONT_SANS,
  },
  customizationIntroCard: {
    backgroundColor: COLORS.SURFACE,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 16,
    gap: 4,
  },
  customizationItemTitle: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 20,
    fontWeight: "800",
    fontFamily: FONT_SANS,
  },
  customizationItemPrice: {
    color: COLORS.ACCENT,
    fontSize: 16,
    fontWeight: "700",
    fontFamily: FONT_SANS,
  },
  customizationItemHint: {
    color: COLORS.TEXT_SECONDARY,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 2,
    fontFamily: FONT_SANS,
  },
  customizationGroup: {
    marginTop: 20,
    gap: 10,
  },
  customizationGroupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  customizationRequiredBadge: {
    color: COLORS.WARNING,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontFamily: FONT_SANS,
  },
  customizationChoiceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  customizationChoiceChip: {
    minHeight: 40,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: COLORS.BORDER,
    backgroundColor: COLORS.SURFACE,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  customizationChoiceChipActive: {
    borderColor: COLORS.ACCENT,
    backgroundColor: COLORS.ACCENT_LIGHT,
  },
  customizationChoiceText: {
    color: COLORS.TEXT_PRIMARY,
    fontSize: 13,
    fontWeight: "600",
    fontFamily: FONT_SANS,
  },
  customizationChoiceTextActive: {
    color: COLORS.ACCENT,
  },
})
