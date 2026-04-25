import type {
  BillingConfig,
  CountryTaxRate,
  MenuItemDraft,
  OrderCallReviewRecord,
  RestaurantBillingConfig,
  RestaurantOrderRecord,
  RestaurantRecord,
  VoiceAgentLinkRecord,
} from "./types"
import { billingConfigToDraftBreakdown } from "./utils/billing"
import { assertSupabaseConfigured, supabase } from "./supabase"

function nowIso() {
  return new Date().toISOString()
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown error"
}

function requireData<T>(data: T | null, fallbackMessage: string): T {
  if (data === null || data === undefined) {
    throw new Error(fallbackMessage)
  }
  return data
}

type SupabaseQueryError = {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

function isMissingTableError(error: SupabaseQueryError | null | undefined, tableName: string): boolean {
  const code = String(error?.code || "")
  const haystack = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase()
  const table = tableName.toLowerCase()
  return (
    code === "PGRST205" ||
    haystack.includes(`public.${table}`) ||
    haystack.includes(`table '${table}'`) ||
    haystack.includes(`relation \"${table}\" does not exist`) ||
    haystack.includes(`relation \"public.${table}\" does not exist`) ||
    haystack.includes("schema cache")
  )
}

function isMissingColumnError(
  error: SupabaseQueryError | null | undefined,
  tableName: string,
  columnName: string,
): boolean {
  const code = String(error?.code || "")
  const haystack = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase()
  const table = tableName.toLowerCase()
  const column = columnName.toLowerCase()

  return (
    code === "PGRST204" ||
    haystack.includes(`${table}.${column}`) ||
    haystack.includes(`'${column}'`) ||
    haystack.includes(`"${column}"`) ||
    haystack.includes(`column ${column}`) ||
    haystack.includes(`column "${column}"`) ||
    haystack.includes(`column '${column}'`)
  )
}

function missingTableMessage(tableName: string): string {
  return `Supabase table '${tableName}' is missing. Run mobile-onboarding-rn/supabase/001_init_restaurant_onboarding.sql in Supabase SQL Editor, then refresh the app.`
}

function missingOrderTrackingMessage(): string {
  return "Supabase order tracking fields are missing. Run supabase/005_order_contact_and_short_code.sql, then supabase/006_active_pending_order_ids.sql in Supabase SQL Editor, then refresh the app."
}

function missingMenuOrderingMessage(): string {
  return "Supabase menu ordering fields are missing. Run supabase/007_menu_item_sort_order.sql in Supabase SQL Editor, then refresh the app."
}

function missingManualOrderStockMessage(): string {
  return "Manual POS stock sync is missing. Run supabase/010_manual_order_stock_atomic.sql and supabase/013_order_fulfillment_and_delivery_fields.sql in Supabase SQL Editor, then refresh the app."
}

function missingOrderFulfillmentMessage(): string {
  return "Order fulfilment fields are missing. Run supabase/013_order_fulfillment_and_delivery_fields.sql in Supabase SQL Editor, then refresh the app."
}

function missingOrderPaymentMessage(): string {
  return "Order payment fields are missing. Run supabase/014_order_payment_settlement.sql in Supabase SQL Editor, then refresh the app."
}

function missingBillingConfigMessage(): string {
  return "Billing configuration is missing. Run supabase/016_restaurant_billing_fields.sql, supabase/017_order_billing_fields.sql, and supabase/018_update_order_rpcs_billing.sql in Supabase SQL Editor, then refresh the app."
}

function normalizeOrderTrackingErrorMessage(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes("all 999 active order ids")) {
    return "All live 3-digit order IDs are currently in use. Close a completed order, then try again."
  }
  if (normalized.includes("short_order_code") && normalized.includes("already in use for an active order")) {
    return `${message}. Run supabase/015_harden_active_short_order_codes.sql in Supabase SQL Editor, then retry.`
  }
  return message
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeRequiredString(value: unknown, fallback = ""): string {
  return normalizeOptionalString(value) || fallback
}

function normalizePositiveNumber(value: unknown): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN

  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

function normalizeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .map((entry) => normalizePositiveNumber(entry))
    .filter((entry, index, values) => Number.isFinite(entry) && values.indexOf(entry) === index)
}

function isMissingFunctionError(error: SupabaseQueryError | null | undefined, functionName: string): boolean {
  const haystack = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`.toLowerCase()
  return haystack.includes(functionName.toLowerCase())
}

function extractRecordingUrlFromWebhookPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const root = payload as Record<string, unknown>
  const normalizedMetadata =
    root.normalized_metadata && typeof root.normalized_metadata === "object"
      ? (root.normalized_metadata as Record<string, unknown>)
      : null
  const nestedData = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null

  return (
    normalizeOptionalString(normalizedMetadata?.recording_url) ||
    normalizeOptionalString(normalizedMetadata?.audio_url) ||
    normalizeOptionalString(root.recording_url) ||
    normalizeOptionalString(root.audio_url) ||
    normalizeOptionalString(nestedData?.recording_url) ||
    normalizeOptionalString(nestedData?.audio_url)
  )
}

function extractRecordingStorageBucketFromWebhookPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const root = payload as Record<string, unknown>
  const normalizedMetadata =
    root.normalized_metadata && typeof root.normalized_metadata === "object"
      ? (root.normalized_metadata as Record<string, unknown>)
      : null

  return normalizeOptionalString(normalizedMetadata?.recording_storage_bucket)
}

function extractRecordingStoragePathFromWebhookPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const root = payload as Record<string, unknown>
  const normalizedMetadata =
    root.normalized_metadata && typeof root.normalized_metadata === "object"
      ? (root.normalized_metadata as Record<string, unknown>)
      : null

  return normalizeOptionalString(normalizedMetadata?.recording_storage_path)
}

function extractRecordingSizeBytesFromWebhookPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") {
    return null
  }

  const root = payload as Record<string, unknown>
  const normalizedMetadata =
    root.normalized_metadata && typeof root.normalized_metadata === "object"
      ? (root.normalized_metadata as Record<string, unknown>)
      : null

  const parsed = normalizePositiveNumber(normalizedMetadata?.recording_size_bytes)
  return parsed > 0 ? parsed : null
}

export async function initDatabase() {
  assertSupabaseConfigured()
  // Warm up auth session fetch so app fails fast with clear config/auth errors.
  const { error } = await supabase.auth.getSession()
  if (error) {
    throw new Error(error.message)
  }
}

export async function listRestaurants(ownerUserId: string): Promise<RestaurantRecord[]> {
  assertSupabaseConfigured()

  const restaurantsWithPaymentPin = await supabase
    .from("restaurants")
    .select("id, owner_user_id, name, phone, address, country_code, currency_code, payment_pin_hash, created_at, updated_at")
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false })

  let data = restaurantsWithPaymentPin.data as Record<string, unknown>[] | null
  let error = restaurantsWithPaymentPin.error

  if (error && isMissingColumnError(error, "restaurants", "payment_pin_hash")) {
    const fallbackResult = await supabase
      .from("restaurants")
      .select("id, owner_user_id, name, phone, address, country_code, currency_code, created_at, updated_at")
      .eq("owner_user_id", ownerUserId)
      .order("created_at", { ascending: false })

    data = fallbackResult.data as Record<string, unknown>[] | null
    error = fallbackResult.error
  }

  if (error) {
    throw new Error(error.message)
  }

  return (data || []).map((restaurant) => ({
    id: String(restaurant.id),
    owner_user_id: String(restaurant.owner_user_id),
    name: String(restaurant.name || ""),
    phone: normalizeOptionalString(restaurant.phone),
    address: normalizeOptionalString(restaurant.address),
    countryCode: normalizeRequiredString(restaurant.country_code, "GB"),
    currencyCode: normalizeRequiredString(restaurant.currency_code, "GBP"),
    hasPaymentPin: Boolean(normalizeOptionalString((restaurant as Record<string, unknown>).payment_pin_hash)),
    created_at: String(restaurant.created_at || ""),
    updated_at: String(restaurant.updated_at || ""),
  }))
}

export async function saveRestaurant(input: {
  ownerUserId: string
  restaurantId?: string
  name: string
  phone?: string | null
  address?: string | null
}) {
  assertSupabaseConfigured()

  if (input.restaurantId) {
    const { data, error } = await supabase
      .from("restaurants")
      .update({
        name: input.name,
        phone: input.phone || null,
        address: input.address || null,
        updated_at: nowIso(),
      })
      .eq("id", input.restaurantId)
      .eq("owner_user_id", input.ownerUserId)
      .select("id")
      .single()

    if (error) {
      throw new Error(error.message)
    }

    return requireData(data, "Restaurant not found").id as string
  }

  const { data, error } = await supabase
    .from("restaurants")
    .insert({
      owner_user_id: input.ownerUserId,
      name: input.name,
      phone: input.phone || null,
      address: input.address || null,
      updated_at: nowIso(),
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return requireData(data, "Failed to create restaurant").id as string
}

export async function saveRestaurantPaymentPin(input: { restaurantId: string; pin: string }) {
  assertSupabaseConfigured()

  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean
    restaurant_id?: string
    has_payment_pin?: boolean
    updated_at?: string
    error?: string
    remediation?: string
  }>("save-restaurant-payment-pin", {
    body: {
      restaurant_id: input.restaurantId,
      pin: input.pin,
    },
  })

  if (error) {
    throw new Error(error.message || "Failed to save the restaurant payment PIN.")
  }

  if (!data?.ok) {
    throw new Error(
      [data?.error || "Failed to save the restaurant payment PIN.", data?.remediation || ""].filter(Boolean).join(" "),
    )
  }

  return {
    restaurantId: normalizeOptionalString(data.restaurant_id) || input.restaurantId,
    hasPaymentPin: Boolean(data.has_payment_pin),
    updatedAt: normalizeOptionalString(data.updated_at),
  }
}

export async function insertMenuScan(input: {
  restaurantId: string
  imageUri?: string | null
  rawMenuText?: string | null
  extractedPayload: MenuItemDraft[]
}) {
  assertSupabaseConfigured()

  const { data, error } = await supabase
    .from("menu_scans")
    .insert({
      restaurant_id: input.restaurantId,
      image_uri: input.imageUri || null,
      raw_menu_text: input.rawMenuText || null,
      extracted_payload: input.extractedPayload,
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return requireData(data, "Failed to insert scan").id as string
}

export async function replaceRestaurantMenuItems(input: {
  restaurantId: string
  scanId?: string | null
  items: MenuItemDraft[]
}) {
  assertSupabaseConfigured()

  try {
    const { data: existingItems, error: existingItemsError } = await supabase
      .from("menu_items")
      .select("id")
      .eq("restaurant_id", input.restaurantId)

    if (existingItemsError) {
      throw new Error(existingItemsError.message)
    }

    const existingIds = (existingItems || []).map((item) => item.id as string)
    if (existingIds.length > 0) {
      const { error: customizationDeleteError } = await supabase
        .from("menu_item_customizations")
        .delete()
        .in("menu_item_id", existingIds)

      if (customizationDeleteError) {
        throw new Error(customizationDeleteError.message)
      }
    }

    const { error: itemsDeleteError } = await supabase
      .from("menu_items")
      .delete()
      .eq("restaurant_id", input.restaurantId)

    if (itemsDeleteError) {
      throw new Error(itemsDeleteError.message)
    }

    for (const [index, item] of input.items.entries()) {
      const { data: insertedItem, error: insertItemError } = await supabase
        .from("menu_items")
        .insert({
          restaurant_id: input.restaurantId,
          scan_id: input.scanId || null,
          name: item.name,
          description: item.description || null,
          category: item.category || null,
          base_price: Number(item.basePrice || 0),
          sort_order: index,
          stock_quantity: Math.max(0, Number(item.stockQuantity || 0)),
          is_available: Number(item.stockQuantity || 0) > 0,
          updated_at: nowIso(),
        })
        .select("id")
        .single()

      if (insertItemError) {
        if (isMissingColumnError(insertItemError, "menu_items", "sort_order")) {
          throw new Error(missingMenuOrderingMessage())
        }
        throw new Error(insertItemError.message)
      }

      const menuItemId = requireData(insertedItem, "Failed to insert menu item").id as string
      const customizations = item.customizations || []
      if (customizations.length > 0) {
        const payload = customizations.map((customization) => ({
          menu_item_id: menuItemId,
          label: customization.label,
          value: customization.value || null,
          price_delta: Number(customization.priceDelta || 0),
          is_required: Boolean(customization.isRequired),
          updated_at: nowIso(),
        }))

        const { error: customizationInsertError } = await supabase.from("menu_item_customizations").insert(payload)
        if (customizationInsertError) {
          throw new Error(customizationInsertError.message)
        }
      }
    }
  } catch (error) {
    throw new Error(getErrorMessage(error))
  }
}

export async function listRestaurantMenuItems(restaurantId: string): Promise<MenuItemDraft[]> {
  assertSupabaseConfigured()

  const { data: items, error: itemError } = await supabase
    .from("menu_items")
    .select("id, name, description, category, base_price, stock_quantity, is_available, sort_order")
    .eq("restaurant_id", restaurantId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })

  if (itemError) {
    if (isMissingColumnError(itemError, "menu_items", "sort_order")) {
      throw new Error(missingMenuOrderingMessage())
    }
    throw new Error(itemError.message)
  }

  const menuItems = items || []
  if (menuItems.length === 0) return []

  const menuItemIds = menuItems.map((item) => item.id as string)
  const { data: customizations, error: customizationError } = await supabase
    .from("menu_item_customizations")
    .select("id, menu_item_id, label, value, price_delta, is_required")
    .in("menu_item_id", menuItemIds)
    .order("created_at", { ascending: true })

  if (customizationError) {
    throw new Error(customizationError.message)
  }

  const groupedByMenuItem = new Map<string, MenuItemDraft["customizations"]>()
  for (const customization of customizations || []) {
    const menuItemId = String(customization.menu_item_id)
    const existing = groupedByMenuItem.get(menuItemId) || []
    existing.push({
      id: String(customization.id),
      label: String(customization.label || ""),
      value: customization.value === null ? null : String(customization.value),
      priceDelta: Number(customization.price_delta || 0),
      isRequired: Boolean(customization.is_required),
    })
    groupedByMenuItem.set(menuItemId, existing)
  }

  return menuItems.map((item) => ({
    id: String(item.id),
    name: String(item.name || ""),
    description: item.description === null ? null : String(item.description),
    category: item.category === null ? null : String(item.category),
    basePrice: Number(item.base_price || 0),
    stockQuantity: Math.max(0, Number(item.stock_quantity || 0)),
    customizations: groupedByMenuItem.get(String(item.id)) || [],
  }))
}

export async function getCountryTaxRates(countryCode?: string | null): Promise<CountryTaxRate[]> {
  assertSupabaseConfigured()

  let query = supabase
    .from("country_tax_rates")
    .select("id, country_code, tax_name, rate_percent, is_default, effective_from, notes")
    .order("is_default", { ascending: false })
    .order("rate_percent", { ascending: true })
    .order("effective_from", { ascending: false })

  const normalizedCountryCode = normalizeOptionalString(countryCode)?.toUpperCase() || null
  if (normalizedCountryCode) {
    query = query.eq("country_code", normalizedCountryCode)
  }

  const { data, error } = await query

  if (error) {
    if (isMissingTableError(error, "country_tax_rates")) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(error.message)
  }

  return (data || []).map((row) => ({
    id: String(row.id),
    countryCode: normalizeRequiredString(row.country_code, normalizedCountryCode || "GB"),
    taxName: normalizeRequiredString(row.tax_name, "VAT"),
    ratePercent: normalizePositiveNumber(row.rate_percent),
    isDefault: Boolean(row.is_default),
    effectiveFrom: normalizeRequiredString(row.effective_from, ""),
    notes: normalizeOptionalString(row.notes),
  }))
}

export async function getBillingConfig(restaurantId: string): Promise<BillingConfig> {
  assertSupabaseConfigured()

  const restaurantLookup = await supabase
    .from("restaurants")
    .select("id, country_code, currency_code")
    .eq("id", restaurantId)
    .single()

  if (restaurantLookup.error) {
    if (
      isMissingColumnError(restaurantLookup.error, "restaurants", "country_code") ||
      isMissingColumnError(restaurantLookup.error, "restaurants", "currency_code")
    ) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(restaurantLookup.error.message)
  }

  const countryCode = normalizeRequiredString(restaurantLookup.data.country_code, "GB")
  const currencyCode = normalizeRequiredString(restaurantLookup.data.currency_code, "GBP")
  const availableTaxRates = await getCountryTaxRates(countryCode)

  const configLookup = await supabase
    .from("restaurant_billing_config")
    .select(
      "id, restaurant_id, tax_rate_id, tax_rate_override, tax_inclusive, tax_label, service_fee_enabled, service_fee_type, service_fee_value, service_fee_label, tip_enabled, tip_suggestions, tip_label, updated_at",
    )
    .eq("restaurant_id", restaurantId)
    .maybeSingle()

  if (configLookup.error) {
    if (isMissingTableError(configLookup.error, "restaurant_billing_config")) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(configLookup.error.message)
  }

  const row = configLookup.data
  const selectedTaxRate =
    availableTaxRates.find((taxRate) => taxRate.id === normalizeOptionalString(row?.tax_rate_id)) ||
    availableTaxRates.find((taxRate) => taxRate.isDefault) ||
    availableTaxRates[0] ||
    null
  const taxLabel = normalizeOptionalString(row?.tax_label) || selectedTaxRate?.taxName || "VAT"
  const resolvedTaxRatePercent =
    normalizeOptionalString(String(row?.tax_rate_override ?? "")) !== null
      ? normalizePositiveNumber(row?.tax_rate_override)
      : selectedTaxRate?.ratePercent || 0

  return {
    id: normalizeOptionalString(row?.id) || undefined,
    restaurantId,
    countryCode,
    currencyCode,
    availableTaxRates,
    taxRateId: normalizeOptionalString(row?.tax_rate_id),
    taxRateOverride:
      normalizeOptionalString(String(row?.tax_rate_override ?? "")) !== null
        ? normalizePositiveNumber(row?.tax_rate_override)
        : null,
    resolvedTaxRatePercent,
    taxInclusive: Boolean(row?.tax_inclusive),
    taxLabel,
    serviceFeeEnabled: Boolean(row?.service_fee_enabled),
    serviceFeeType:
      row?.service_fee_type === "flat" || row?.service_fee_type === "percent" ? row.service_fee_type : null,
    serviceFeeValue: normalizePositiveNumber(row?.service_fee_value),
    serviceFeeLabel: normalizeOptionalString(row?.service_fee_label) || "Service Charge",
    tipEnabled: Boolean(row?.tip_enabled),
    tipSuggestions:
      normalizeNumberArray(row?.tip_suggestions).length > 0
        ? normalizeNumberArray(row?.tip_suggestions)
        : [10, 12.5, 15, 20],
    tipLabel: normalizeOptionalString(row?.tip_label) || "Gratuity",
    updatedAt: normalizeRequiredString(row?.updated_at, nowIso()),
  }
}

export async function saveBillingConfig(input: BillingConfig | RestaurantBillingConfig & {
  countryCode: string
  currencyCode: string
}): Promise<BillingConfig> {
  assertSupabaseConfigured()

  const normalizedCountryCode = normalizeRequiredString(input.countryCode, "GB").toUpperCase()
  const normalizedCurrencyCode = normalizeRequiredString(input.currencyCode, "GBP").toUpperCase()

  const restaurantUpdate = await supabase
    .from("restaurants")
    .update({
      country_code: normalizedCountryCode,
      currency_code: normalizedCurrencyCode,
      updated_at: nowIso(),
    })
    .eq("id", input.restaurantId)
    .select("id")
    .single()

  if (restaurantUpdate.error) {
    if (
      isMissingColumnError(restaurantUpdate.error, "restaurants", "country_code") ||
      isMissingColumnError(restaurantUpdate.error, "restaurants", "currency_code")
    ) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(restaurantUpdate.error.message)
  }

  const { error } = await supabase
    .from("restaurant_billing_config")
    .upsert(
      {
        restaurant_id: input.restaurantId,
        tax_rate_id: input.taxRateId || null,
        tax_rate_override:
          input.taxRateOverride === null || input.taxRateOverride === undefined ? null : normalizePositiveNumber(input.taxRateOverride),
        tax_inclusive: Boolean(input.taxInclusive),
        tax_label: normalizeRequiredString(input.taxLabel, "VAT"),
        service_fee_enabled: Boolean(input.serviceFeeEnabled),
        service_fee_type: input.serviceFeeEnabled ? input.serviceFeeType || null : null,
        service_fee_value: input.serviceFeeEnabled ? normalizePositiveNumber(input.serviceFeeValue) : 0,
        service_fee_label: normalizeRequiredString(input.serviceFeeLabel, "Service Charge"),
        tip_enabled: Boolean(input.tipEnabled),
        tip_suggestions: normalizeNumberArray(input.tipSuggestions).length > 0 ? normalizeNumberArray(input.tipSuggestions) : [10, 12.5, 15, 20],
        tip_label: normalizeRequiredString(input.tipLabel, "Gratuity"),
        updated_at: nowIso(),
      },
      { onConflict: "restaurant_id" },
    )

  if (error) {
    if (isMissingTableError(error, "restaurant_billing_config")) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(error.message)
  }

  return getBillingConfig(input.restaurantId)
}

function normalizeOrderStatus(value: unknown): "pending" | "closed" {
  return value === "closed" ? "closed" : "pending"
}

function normalizeFulfillmentType(value: unknown): "pickup" | "delivery" {
  return String(value || "").trim().toLowerCase() === "delivery" ? "delivery" : "pickup"
}

function normalizePaymentCollection(
  value: unknown,
  fulfillmentType: "pickup" | "delivery",
): "unpaid" | "cod" {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "cod" || normalized === "unpaid") {
    return normalized
  }
  return fulfillmentType === "delivery" ? "cod" : "unpaid"
}

function normalizePaymentStatus(value: unknown): "unpaid" | "paid" {
  return String(value || "").trim().toLowerCase() === "paid" ? "paid" : "unpaid"
}

function normalizePaymentMethod(value: unknown): "cash" | "card" | null {
  const normalized = String(value || "").trim().toLowerCase()
  if (normalized === "cash" || normalized === "card") {
    return normalized
  }
  return null
}

function sanitizeOrderItems(items: RestaurantOrderRecord["items"]) {
  return (items || [])
    .map((item) => ({
      menuItemId: normalizeOptionalString(item.menuItemId),
      name: String(item.name || "").trim(),
      quantity: Math.max(1, Number(item.quantity || 1)),
      unitPrice: Number(item.unitPrice || 0),
    }))
    .filter((item) => item.name.length > 0)
}

export async function listRestaurantOrders(restaurantId: string): Promise<RestaurantOrderRecord[]> {
  assertSupabaseConfigured()

  const { data: orders, error: orderError } = await supabase
    .from("restaurant_orders")
    .select(
      "id, restaurant_id, customer_name, customer_phone, fulfillment_type, delivery_postcode, delivery_address, payment_collection, payment_status, payment_method, card_transaction_id, short_order_code, order_code_date, status, notes, subtotal_amount, tax_amount, tax_rate_percent, tax_inclusive, tax_label, service_fee_amount, service_fee_label, tip_amount, tip_label, currency_code, total_price, created_at, updated_at",
    )
    .eq("restaurant_id", restaurantId)
    .order("created_at", { ascending: false })

  if (orderError) {
    if (isMissingTableError(orderError, "restaurant_orders")) {
      throw new Error(missingTableMessage("restaurant_orders"))
    }
    if (
      isMissingColumnError(orderError, "restaurant_orders", "customer_phone") ||
      isMissingColumnError(orderError, "restaurant_orders", "short_order_code") ||
      isMissingColumnError(orderError, "restaurant_orders", "order_code_date")
    ) {
      throw new Error(missingOrderTrackingMessage())
    }
    if (
      isMissingColumnError(orderError, "restaurant_orders", "fulfillment_type") ||
      isMissingColumnError(orderError, "restaurant_orders", "delivery_postcode") ||
      isMissingColumnError(orderError, "restaurant_orders", "delivery_address") ||
      isMissingColumnError(orderError, "restaurant_orders", "payment_collection")
    ) {
      throw new Error(missingOrderFulfillmentMessage())
    }
    if (
      isMissingColumnError(orderError, "restaurant_orders", "payment_status") ||
      isMissingColumnError(orderError, "restaurant_orders", "payment_method") ||
      isMissingColumnError(orderError, "restaurant_orders", "card_transaction_id")
    ) {
      throw new Error(missingOrderPaymentMessage())
    }
    if (
      isMissingColumnError(orderError, "restaurant_orders", "subtotal_amount") ||
      isMissingColumnError(orderError, "restaurant_orders", "tax_amount") ||
      isMissingColumnError(orderError, "restaurant_orders", "currency_code")
    ) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(normalizeOrderTrackingErrorMessage(orderError.message))
  }

  const orderRows = orders || []
  if (orderRows.length === 0) return []

  const orderIds = orderRows.map((order) => String(order.id))
  let items: Record<string, unknown>[] | null = null
  let itemError: SupabaseQueryError | null = null

  const itemResultWithMenuId = await supabase
    .from("restaurant_order_items")
    .select("id, order_id, menu_item_id, name, quantity, unit_price, created_at, updated_at")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true })

  if (itemResultWithMenuId.error && isMissingColumnError(itemResultWithMenuId.error, "restaurant_order_items", "menu_item_id")) {
    const fallbackItemResult = await supabase
      .from("restaurant_order_items")
      .select("id, order_id, name, quantity, unit_price, created_at, updated_at")
      .in("order_id", orderIds)
      .order("created_at", { ascending: true })

    items = (fallbackItemResult.data as Record<string, unknown>[] | null) || null
    itemError = fallbackItemResult.error
  } else {
    items = (itemResultWithMenuId.data as Record<string, unknown>[] | null) || null
    itemError = itemResultWithMenuId.error
  }

  if (itemError) {
    if (isMissingTableError(itemError, "restaurant_order_items")) {
      throw new Error(missingTableMessage("restaurant_order_items"))
    }
    throw new Error(itemError.message || "Failed to load restaurant order items.")
  }

  const callReviewsByOrderId = new Map<string, OrderCallReviewRecord>()
  const callReviewResultWithStorage = await supabase
    .from("post_call_webhooks")
    .select(
      "id, created_order_id, conversation_id, transcript_text, analysis_status, recording_storage_bucket, recording_storage_path, recording_size_bytes, webhook_payload, created_at, updated_at",
    )
    .in("created_order_id", orderIds)
    .order("updated_at", { ascending: false })

  let callReviewRows = callReviewResultWithStorage.data as Record<string, unknown>[] | null
  let callReviewError = callReviewResultWithStorage.error

  if (
    callReviewError &&
    (
      isMissingColumnError(callReviewError, "post_call_webhooks", "recording_storage_bucket") ||
      isMissingColumnError(callReviewError, "post_call_webhooks", "recording_storage_path") ||
      isMissingColumnError(callReviewError, "post_call_webhooks", "recording_size_bytes")
    )
  ) {
    const fallbackCallReviewResult = await supabase
      .from("post_call_webhooks")
      .select("id, created_order_id, conversation_id, transcript_text, analysis_status, webhook_payload, created_at, updated_at")
      .in("created_order_id", orderIds)
      .order("updated_at", { ascending: false })

    callReviewRows = fallbackCallReviewResult.data as Record<string, unknown>[] | null
    callReviewError = fallbackCallReviewResult.error
  }

  if (!callReviewError) {
    const signedRecordingUrls = new Map<string, string>()
    const storagePathsByBucket = new Map<string, string[]>()

    for (const row of callReviewRows || []) {
      const recordingStoragePath =
        normalizeOptionalString(row.recording_storage_path) || extractRecordingStoragePathFromWebhookPayload(row.webhook_payload)
      const recordingStorageBucket =
        normalizeOptionalString(row.recording_storage_bucket) ||
        extractRecordingStorageBucketFromWebhookPayload(row.webhook_payload) ||
        (recordingStoragePath ? "call-recordings" : null)

      if (!recordingStorageBucket || !recordingStoragePath) {
        continue
      }

      const existingPaths = storagePathsByBucket.get(recordingStorageBucket) || []
      if (!existingPaths.includes(recordingStoragePath)) {
        storagePathsByBucket.set(recordingStorageBucket, [...existingPaths, recordingStoragePath])
      }
    }

    for (const [bucket, paths] of storagePathsByBucket.entries()) {
      const signedUrlResult = await supabase.storage.from(bucket).createSignedUrls(paths, 60 * 30)
      if (signedUrlResult.error) {
        continue
      }

      for (const [index, path] of paths.entries()) {
        const signedUrl = normalizeOptionalString(signedUrlResult.data?.[index]?.signedUrl)
        if (signedUrl) {
          signedRecordingUrls.set(`${bucket}:${path}`, signedUrl)
        }
      }
    }

    for (const row of callReviewRows || []) {
      const orderId = normalizeOptionalString(row.created_order_id)
      if (!orderId || callReviewsByOrderId.has(orderId)) {
        continue
      }

      const recordingStoragePath =
        normalizeOptionalString(row.recording_storage_path) || extractRecordingStoragePathFromWebhookPayload(row.webhook_payload)
      const recordingStorageBucket =
        normalizeOptionalString(row.recording_storage_bucket) ||
        extractRecordingStorageBucketFromWebhookPayload(row.webhook_payload) ||
        (recordingStoragePath ? "call-recordings" : null)
      const signedRecordingUrl =
        recordingStorageBucket && recordingStoragePath
          ? signedRecordingUrls.get(`${recordingStorageBucket}:${recordingStoragePath}`) || null
          : null
      const recordingSizeBytes =
        normalizePositiveNumber(row.recording_size_bytes) || extractRecordingSizeBytesFromWebhookPayload(row.webhook_payload) || null

      callReviewsByOrderId.set(orderId, {
        id: String(row.id),
        conversationId: normalizeOptionalString(row.conversation_id),
        transcriptText: normalizeOptionalString(row.transcript_text),
        recordingUrl: signedRecordingUrl || extractRecordingUrlFromWebhookPayload(row.webhook_payload),
        recordingStorageBucket,
        recordingStoragePath,
        recordingSizeBytes,
        analysisStatus: normalizeOptionalString(row.analysis_status),
        created_at: normalizeOptionalString(row.created_at) || undefined,
        updated_at: normalizeOptionalString(row.updated_at) || undefined,
      })
    }
  }

  const groupedItems = new Map<string, RestaurantOrderRecord["items"]>()
  for (const item of items || []) {
    const orderId = String(item.order_id)
    const existing = groupedItems.get(orderId) || []
    existing.push({
      id: String(item.id),
      order_id: orderId,
      menuItemId: normalizeOptionalString(item.menu_item_id),
      name: String(item.name || ""),
      quantity: Number(item.quantity || 1),
      unitPrice: Number(item.unit_price || 0),
      created_at: String(item.created_at || ""),
      updated_at: String(item.updated_at || ""),
    })
    groupedItems.set(orderId, existing)
  }

  return orderRows.map((order) => ({
    id: String(order.id),
    restaurant_id: String(order.restaurant_id),
    customerName: String(order.customer_name || ""),
    customerPhone: order.customer_phone === null ? null : String(order.customer_phone || ""),
    fulfillmentType: normalizeFulfillmentType(order.fulfillment_type),
    deliveryPostcode: order.delivery_postcode === null ? null : String(order.delivery_postcode || ""),
    deliveryAddress: order.delivery_address === null ? null : String(order.delivery_address || ""),
    paymentCollection: normalizePaymentCollection(order.payment_collection, normalizeFulfillmentType(order.fulfillment_type)),
    paymentStatus: normalizePaymentStatus(order.payment_status),
    paymentMethod: normalizePaymentMethod(order.payment_method),
    cardTransactionId: order.card_transaction_id === null ? null : String(order.card_transaction_id || ""),
    shortOrderCode:
      order.short_order_code === null || order.short_order_code === undefined
        ? null
        : Number(order.short_order_code || 0),
    orderCodeDate: order.order_code_date === null ? null : String(order.order_code_date || ""),
    status: normalizeOrderStatus(order.status),
    notes: order.notes === null ? null : String(order.notes),
    subtotalAmount: normalizePositiveNumber(order.subtotal_amount),
    taxAmount: normalizePositiveNumber(order.tax_amount),
    taxRatePercent: normalizePositiveNumber(order.tax_rate_percent),
    taxInclusive: Boolean(order.tax_inclusive),
    taxLabel: normalizeRequiredString(order.tax_label, "VAT"),
    serviceFeeAmount: normalizePositiveNumber(order.service_fee_amount),
    serviceFeeLabel: normalizeRequiredString(order.service_fee_label, "Service Charge"),
    tipAmount: normalizePositiveNumber(order.tip_amount),
    tipLabel: normalizeRequiredString(order.tip_label, "Gratuity"),
    currencyCode: normalizeRequiredString(order.currency_code, "GBP"),
    totalPrice: Number(order.total_price || 0),
    items: groupedItems.get(String(order.id)) || [],
    callReview: callReviewsByOrderId.get(String(order.id)) || null,
    created_at: String(order.created_at || ""),
    updated_at: String(order.updated_at || ""),
  }))
}

export async function saveRestaurantOrder(input: {
  restaurantId: string
  orderId?: string
  customerName: string
  customerPhone: string
  fulfillmentType: "pickup" | "delivery"
  deliveryPostcode?: string | null
  deliveryAddress?: string | null
  paymentCollection?: "unpaid" | "cod" | null
  status?: "pending" | "closed"
  notes?: string | null
  items: RestaurantOrderRecord["items"]
}) {
  assertSupabaseConfigured()

  const sanitizedItems = sanitizeOrderItems(input.items)
  const subtotalAmount = sanitizedItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)
  const canUseAtomicStockSync = sanitizedItems.length > 0 && sanitizedItems.every((item) => Boolean(item.menuItemId))
  const fulfillmentType = normalizeFulfillmentType(input.fulfillmentType)
  const paymentCollection = normalizePaymentCollection(input.paymentCollection, fulfillmentType)
  const deliveryPostcode = fulfillmentType === "delivery" ? normalizeOptionalString(input.deliveryPostcode) : null
  const deliveryAddress = fulfillmentType === "delivery" ? normalizeOptionalString(input.deliveryAddress) : null

  if (canUseAtomicStockSync) {
    const { data, error } = await supabase.rpc("save_manual_order_atomic", {
      p_restaurant_id: input.restaurantId,
      p_order_id: input.orderId || null,
      p_customer_name: input.customerName,
      p_customer_phone: input.customerPhone,
      p_notes: input.notes || null,
      p_status: input.status || "pending",
      p_items: sanitizedItems.map((item) => ({
        item_id: item.menuItemId,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
      })),
      p_fulfillment_type: fulfillmentType,
      p_delivery_postcode: deliveryPostcode,
      p_delivery_address: deliveryAddress,
      p_payment_collection: paymentCollection,
    })

    if (error) {
      if (
        isMissingFunctionError(error, "save_manual_order_atomic") ||
        isMissingColumnError(error, "restaurant_order_items", "menu_item_id")
      ) {
        throw new Error(missingManualOrderStockMessage())
      }
      if (
        isMissingColumnError(error, "restaurant_orders", "fulfillment_type") ||
        isMissingColumnError(error, "restaurant_orders", "delivery_postcode") ||
        isMissingColumnError(error, "restaurant_orders", "delivery_address") ||
        isMissingColumnError(error, "restaurant_orders", "payment_collection")
      ) {
        throw new Error(missingOrderFulfillmentMessage())
      }
      if (
        isMissingColumnError(error, "restaurant_orders", "subtotal_amount") ||
        isMissingColumnError(error, "restaurant_orders", "tax_amount") ||
        isMissingColumnError(error, "restaurant_orders", "currency_code")
      ) {
        throw new Error(missingBillingConfigMessage())
      }
      throw new Error(normalizeOrderTrackingErrorMessage(error.message || "Failed to save order with stock sync"))
    }

    const resolvedRow = Array.isArray(data) ? data[0] : data
    const resolvedOrderId = normalizeOptionalString(resolvedRow?.order_id) || input.orderId || null
    if (!resolvedOrderId) {
      throw new Error("Failed to save the order with stock sync.")
    }

    return resolvedOrderId
  }

  const billingConfig = await getBillingConfig(input.restaurantId)
  let existingTipAmount = 0
  let existingTipLabel = billingConfig.tipLabel || "Gratuity"

  if (input.orderId) {
    const existingBillingLookup = await supabase
      .from("restaurant_orders")
      .select("tip_amount, tip_label")
      .eq("id", input.orderId)
      .eq("restaurant_id", input.restaurantId)
      .maybeSingle()

    if (existingBillingLookup.error) {
      if (
        isMissingColumnError(existingBillingLookup.error, "restaurant_orders", "tip_amount") ||
        isMissingColumnError(existingBillingLookup.error, "restaurant_orders", "tip_label")
      ) {
        throw new Error(missingBillingConfigMessage())
      }
      throw new Error(existingBillingLookup.error.message)
    }

    existingTipAmount = normalizePositiveNumber(existingBillingLookup.data?.tip_amount)
    existingTipLabel = normalizeOptionalString(existingBillingLookup.data?.tip_label) || existingTipLabel
  }

  const billingBreakdown = billingConfigToDraftBreakdown(billingConfig, subtotalAmount, existingTipAmount)

  if (input.orderId) {
    const { error: updateError } = await supabase
      .from("restaurant_orders")
      .update({
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        fulfillment_type: fulfillmentType,
        delivery_postcode: deliveryPostcode,
        delivery_address: deliveryAddress,
        payment_collection: paymentCollection,
        status: input.status || "pending",
        notes: input.notes || null,
        subtotal_amount: billingBreakdown.subtotalAmount,
        tax_amount: billingBreakdown.taxAmount,
        tax_rate_percent: billingBreakdown.taxRatePercent,
        tax_inclusive: billingBreakdown.taxInclusive,
        tax_label: billingBreakdown.taxLabel,
        service_fee_amount: billingBreakdown.serviceFeeAmount,
        service_fee_label: billingBreakdown.serviceFeeLabel,
        tip_amount: billingBreakdown.tipAmount,
        tip_label: existingTipLabel,
        currency_code: billingBreakdown.currencyCode,
        total_price: billingBreakdown.totalAmount,
        updated_at: nowIso(),
      })
      .eq("id", input.orderId)
      .eq("restaurant_id", input.restaurantId)

    if (updateError) {
      if (isMissingTableError(updateError, "restaurant_orders")) {
        throw new Error(missingTableMessage("restaurant_orders"))
      }
      if (isMissingColumnError(updateError, "restaurant_orders", "customer_phone")) {
        throw new Error(missingOrderTrackingMessage())
      }
      if (
        isMissingColumnError(updateError, "restaurant_orders", "fulfillment_type") ||
        isMissingColumnError(updateError, "restaurant_orders", "delivery_postcode") ||
        isMissingColumnError(updateError, "restaurant_orders", "delivery_address") ||
        isMissingColumnError(updateError, "restaurant_orders", "payment_collection")
      ) {
        throw new Error(missingOrderFulfillmentMessage())
      }
      if (
        isMissingColumnError(updateError, "restaurant_orders", "subtotal_amount") ||
        isMissingColumnError(updateError, "restaurant_orders", "tax_amount") ||
        isMissingColumnError(updateError, "restaurant_orders", "currency_code")
      ) {
        throw new Error(missingBillingConfigMessage())
      }
      throw new Error(normalizeOrderTrackingErrorMessage(updateError.message))
    }

    const { error: deleteItemsError } = await supabase.from("restaurant_order_items").delete().eq("order_id", input.orderId)
    if (deleteItemsError) {
      if (isMissingTableError(deleteItemsError, "restaurant_order_items")) {
        throw new Error(missingTableMessage("restaurant_order_items"))
      }
      throw new Error(deleteItemsError.message)
    }

    if (sanitizedItems.length > 0) {
      const payloadWithMenuItemId = sanitizedItems.map((item) => ({
        order_id: input.orderId,
        menu_item_id: item.menuItemId || null,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        updated_at: nowIso(),
      }))

      let insertItemsError: SupabaseQueryError | null = null
      const insertItemsResult = await supabase.from("restaurant_order_items").insert(payloadWithMenuItemId)
      insertItemsError = insertItemsResult.error

      if (insertItemsError && isMissingColumnError(insertItemsError, "restaurant_order_items", "menu_item_id")) {
        const fallbackPayload = sanitizedItems.map((item) => ({
          order_id: input.orderId,
          name: item.name,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          updated_at: nowIso(),
        }))
        const fallbackInsertResult = await supabase.from("restaurant_order_items").insert(fallbackPayload)
        insertItemsError = fallbackInsertResult.error
      }

      if (insertItemsError) {
        if (isMissingTableError(insertItemsError, "restaurant_order_items")) {
          throw new Error(missingTableMessage("restaurant_order_items"))
        }
        throw new Error(normalizeOrderTrackingErrorMessage(insertItemsError.message || "Failed to save order items."))
      }
    }

    return input.orderId
  }

  const { data: insertedOrder, error: insertOrderError } = await supabase
    .from("restaurant_orders")
    .insert({
      restaurant_id: input.restaurantId,
      customer_name: input.customerName,
      customer_phone: input.customerPhone,
      fulfillment_type: fulfillmentType,
      delivery_postcode: deliveryPostcode,
      delivery_address: deliveryAddress,
      payment_collection: paymentCollection,
      status: input.status || "pending",
      notes: input.notes || null,
      subtotal_amount: billingBreakdown.subtotalAmount,
      tax_amount: billingBreakdown.taxAmount,
      tax_rate_percent: billingBreakdown.taxRatePercent,
      tax_inclusive: billingBreakdown.taxInclusive,
      tax_label: billingBreakdown.taxLabel,
      service_fee_amount: billingBreakdown.serviceFeeAmount,
      service_fee_label: billingBreakdown.serviceFeeLabel,
      tip_amount: billingBreakdown.tipAmount,
      tip_label: existingTipLabel,
      currency_code: billingBreakdown.currencyCode,
      total_price: billingBreakdown.totalAmount,
      updated_at: nowIso(),
    })
    .select("id")
    .single()

  if (insertOrderError) {
    if (isMissingTableError(insertOrderError, "restaurant_orders")) {
      throw new Error(missingTableMessage("restaurant_orders"))
    }
    if (isMissingColumnError(insertOrderError, "restaurant_orders", "customer_phone")) {
      throw new Error(missingOrderTrackingMessage())
    }
    if (
      isMissingColumnError(insertOrderError, "restaurant_orders", "fulfillment_type") ||
      isMissingColumnError(insertOrderError, "restaurant_orders", "delivery_postcode") ||
      isMissingColumnError(insertOrderError, "restaurant_orders", "delivery_address") ||
      isMissingColumnError(insertOrderError, "restaurant_orders", "payment_collection")
    ) {
      throw new Error(missingOrderFulfillmentMessage())
    }
    if (
      isMissingColumnError(insertOrderError, "restaurant_orders", "subtotal_amount") ||
      isMissingColumnError(insertOrderError, "restaurant_orders", "tax_amount") ||
      isMissingColumnError(insertOrderError, "restaurant_orders", "currency_code")
    ) {
      throw new Error(missingBillingConfigMessage())
    }
    throw new Error(normalizeOrderTrackingErrorMessage(insertOrderError.message))
  }

  const orderId = requireData(insertedOrder, "Failed to create order").id as string
  if (sanitizedItems.length > 0) {
    const payloadWithMenuItemId = sanitizedItems.map((item) => ({
      order_id: orderId,
      menu_item_id: item.menuItemId || null,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      updated_at: nowIso(),
    }))
    let insertItemsError: SupabaseQueryError | null = null
    const insertItemsResult = await supabase.from("restaurant_order_items").insert(payloadWithMenuItemId)
    insertItemsError = insertItemsResult.error

    if (insertItemsError && isMissingColumnError(insertItemsError, "restaurant_order_items", "menu_item_id")) {
      const fallbackPayload = sanitizedItems.map((item) => ({
        order_id: orderId,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        updated_at: nowIso(),
      }))
      const fallbackInsertResult = await supabase.from("restaurant_order_items").insert(fallbackPayload)
      insertItemsError = fallbackInsertResult.error
    }

    if (insertItemsError) {
      if (isMissingTableError(insertItemsError, "restaurant_order_items")) {
        throw new Error(missingTableMessage("restaurant_order_items"))
      }
      throw new Error(normalizeOrderTrackingErrorMessage(insertItemsError.message || "Failed to save order items."))
    }
  }

  return orderId
}

export async function updateRestaurantOrderPayment(input: {
  restaurantId: string
  orderId: string
  pin: string
  paymentStatus: "unpaid" | "paid"
  paymentMethod?: "cash" | "card" | null
  cardTransactionId?: string | null
  tipAmount?: number | null
}) {
  assertSupabaseConfigured()

  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean
    order_id?: string
    payment_status?: string | null
    payment_method?: string | null
    card_transaction_id?: string | null
    tip_amount?: number | null
    error?: string
    remediation?: string
  }>("update-order-payment-status", {
    body: {
      restaurant_id: input.restaurantId,
      order_id: input.orderId,
      pin: input.pin,
      payment_status: input.paymentStatus,
      payment_method: input.paymentStatus === "paid" ? input.paymentMethod || null : null,
      card_transaction_id: input.paymentStatus === "paid" ? input.cardTransactionId || null : null,
      tip_amount: input.paymentStatus === "paid" ? normalizePositiveNumber(input.tipAmount) : 0,
    },
  })

  if (error) {
    throw new Error(error.message || "Failed to update order payment.")
  }

  if (!data?.ok) {
    throw new Error(
      [data?.error || "Failed to update order payment.", data?.remediation || ""].filter(Boolean).join(" "),
    )
  }

  return {
    orderId: normalizeOptionalString(data.order_id) || input.orderId,
    paymentStatus: normalizePaymentStatus(data.payment_status || input.paymentStatus),
    paymentMethod: normalizePaymentMethod(data.payment_method),
    cardTransactionId: normalizeOptionalString(data.card_transaction_id),
    tipAmount: normalizePositiveNumber(data.tip_amount),
  }
}

export async function deleteRestaurantOrder(input: { restaurantId: string; orderId: string }) {
  assertSupabaseConfigured()

  const { error: deleteItemsError } = await supabase
    .from("restaurant_order_items")
    .delete()
    .eq("order_id", input.orderId)

  if (deleteItemsError) {
    if (isMissingTableError(deleteItemsError, "restaurant_order_items")) {
      throw new Error(missingTableMessage("restaurant_order_items"))
    }
    throw new Error(deleteItemsError.message)
  }

  const { error: deleteOrderError } = await supabase
    .from("restaurant_orders")
    .delete()
    .eq("id", input.orderId)
    .eq("restaurant_id", input.restaurantId)

  if (deleteOrderError) {
    if (isMissingTableError(deleteOrderError, "restaurant_orders")) {
      throw new Error(missingTableMessage("restaurant_orders"))
    }
    throw new Error(deleteOrderError.message)
  }
}

export async function saveVoiceAgentLink(input: {
  restaurantId: string
  workspaceBaseUrl: string
  workspaceAgentId: string
  provider?: string
}) {
  assertSupabaseConfigured()

  const { data, error } = await supabase
    .from("voice_agent_links")
    .upsert(
      {
        restaurant_id: input.restaurantId,
        workspace_base_url: input.workspaceBaseUrl,
        workspace_agent_id: input.workspaceAgentId,
        provider: input.provider || "elevenlabs",
        updated_at: nowIso(),
      },
      { onConflict: "restaurant_id" },
    )
    .select("id")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return requireData(data, "Failed to save voice agent link").id as string
}

export async function getVoiceAgentLink(restaurantId: string): Promise<VoiceAgentLinkRecord | null> {
  assertSupabaseConfigured()

  const { data, error } = await supabase
    .from("voice_agent_links")
    .select("id, restaurant_id, workspace_base_url, workspace_agent_id, provider, created_at, updated_at")
    .eq("restaurant_id", restaurantId)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }

  return (data as VoiceAgentLinkRecord | null) || null
}
