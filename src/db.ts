import type {
  MenuItemDraft,
  OrderCallReviewRecord,
  RestaurantOrderRecord,
  RestaurantRecord,
  VoiceAgentLinkRecord,
} from "./types"
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

function normalizeOrderTrackingErrorMessage(message: string): string {
  const normalized = message.toLowerCase()
  if (normalized.includes("all 999 active order ids")) {
    return "All live 3-digit order IDs are currently in use. Close a completed order, then try again."
  }
  return message
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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

  const { data, error } = await supabase
    .from("restaurants")
    .select("id, owner_user_id, name, phone, address, created_at, updated_at")
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  return (data || []) as RestaurantRecord[]
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

function normalizeOrderStatus(value: unknown): "pending" | "closed" {
  return value === "closed" ? "closed" : "pending"
}

function sanitizeOrderItems(items: RestaurantOrderRecord["items"]) {
  return (items || [])
    .map((item) => ({
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
    .select("id, restaurant_id, customer_name, customer_phone, short_order_code, order_code_date, status, notes, total_price, created_at, updated_at")
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
    throw new Error(normalizeOrderTrackingErrorMessage(orderError.message))
  }

  const orderRows = orders || []
  if (orderRows.length === 0) return []

  const orderIds = orderRows.map((order) => String(order.id))
  const { data: items, error: itemError } = await supabase
    .from("restaurant_order_items")
    .select("id, order_id, name, quantity, unit_price, created_at, updated_at")
    .in("order_id", orderIds)
    .order("created_at", { ascending: true })

  if (itemError) {
    if (isMissingTableError(itemError, "restaurant_order_items")) {
      throw new Error(missingTableMessage("restaurant_order_items"))
    }
    throw new Error(itemError.message)
  }

  const callReviewsByOrderId = new Map<string, OrderCallReviewRecord>()
  const { data: callReviewRows, error: callReviewError } = await supabase
    .from("post_call_webhooks")
    .select(
      "id, created_order_id, conversation_id, transcript_text, analysis_status, webhook_payload, created_at, updated_at",
    )
    .in("created_order_id", orderIds)
    .order("updated_at", { ascending: false })

  if (!callReviewError) {
    for (const row of callReviewRows || []) {
      const orderId = normalizeOptionalString(row.created_order_id)
      if (!orderId || callReviewsByOrderId.has(orderId)) {
        continue
      }

      callReviewsByOrderId.set(orderId, {
        id: String(row.id),
        conversationId: normalizeOptionalString(row.conversation_id),
        transcriptText: normalizeOptionalString(row.transcript_text),
        recordingUrl: extractRecordingUrlFromWebhookPayload(row.webhook_payload),
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
    shortOrderCode:
      order.short_order_code === null || order.short_order_code === undefined
        ? null
        : Number(order.short_order_code || 0),
    orderCodeDate: order.order_code_date === null ? null : String(order.order_code_date || ""),
    status: normalizeOrderStatus(order.status),
    notes: order.notes === null ? null : String(order.notes),
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
  status?: "pending" | "closed"
  notes?: string | null
  items: RestaurantOrderRecord["items"]
}) {
  assertSupabaseConfigured()

  const sanitizedItems = sanitizeOrderItems(input.items)
  const totalPrice = sanitizedItems.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)

  if (input.orderId) {
    const { error: updateError } = await supabase
      .from("restaurant_orders")
      .update({
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        status: input.status || "pending",
        notes: input.notes || null,
        total_price: totalPrice,
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
      const payload = sanitizedItems.map((item) => ({
        order_id: input.orderId,
        name: item.name,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        updated_at: nowIso(),
      }))

      const { error: insertItemsError } = await supabase.from("restaurant_order_items").insert(payload)
      if (insertItemsError) {
        if (isMissingTableError(insertItemsError, "restaurant_order_items")) {
          throw new Error(missingTableMessage("restaurant_order_items"))
        }
        throw new Error(normalizeOrderTrackingErrorMessage(insertItemsError.message))
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
      status: input.status || "pending",
      notes: input.notes || null,
      total_price: totalPrice,
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
    throw new Error(normalizeOrderTrackingErrorMessage(insertOrderError.message))
  }

  const orderId = requireData(insertedOrder, "Failed to create order").id as string
  if (sanitizedItems.length > 0) {
    const payload = sanitizedItems.map((item) => ({
      order_id: orderId,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unitPrice,
      updated_at: nowIso(),
    }))
    const { error: insertItemsError } = await supabase.from("restaurant_order_items").insert(payload)
    if (insertItemsError) {
      if (isMissingTableError(insertItemsError, "restaurant_order_items")) {
        throw new Error(missingTableMessage("restaurant_order_items"))
      }
      throw new Error(normalizeOrderTrackingErrorMessage(insertItemsError.message))
    }
  }

  return orderId
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
