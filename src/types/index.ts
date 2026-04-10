export interface SessionUser {
  id: string
  email: string
}

export interface AppSession {
  user: SessionUser
}

export interface RestaurantRecord {
  id: string
  owner_user_id: string
  name: string
  phone: string | null
  address: string | null
  created_at: string
  updated_at: string
}

export interface MenuCustomizationDraft {
  id?: string
  label: string
  value?: string | null
  priceDelta: number
  isRequired: boolean
}

export interface MenuItemDraft {
  id?: string
  name: string
  description?: string | null
  category?: string | null
  basePrice: number
  stockQuantity: number
  customizations: MenuCustomizationDraft[]
}

export interface VoiceAgentLinkRecord {
  id: string
  restaurant_id: string
  workspace_base_url: string
  workspace_agent_id: string
  provider: string
  created_at: string
  updated_at: string
}

export interface RestaurantOrderItemRecord {
  id?: string
  order_id?: string
  menuItemId?: string | null
  name: string
  quantity: number
  unitPrice: number
  created_at?: string
  updated_at?: string
}

export interface OrderCallReviewRecord {
  id: string
  conversationId?: string | null
  transcriptText?: string | null
  recordingUrl?: string | null
  analysisStatus?: string | null
  created_at?: string
  updated_at?: string
}

export interface RestaurantOrderRecord {
  id?: string
  restaurant_id?: string
  customerName: string
  customerPhone?: string | null
  shortOrderCode?: number | null
  orderCodeDate?: string | null
  status: "pending" | "closed"
  notes?: string | null
  totalPrice: number
  items: RestaurantOrderItemRecord[]
  callReview?: OrderCallReviewRecord | null
  created_at?: string
  updated_at?: string
}

export type UiDraftItem = {
  name: string
  description: string
  category: string
  basePrice: string
  stockQuantity: string
  customizationText: string
}

export type UiOrderDraft = {
  id?: string
  customerName: string
  customerPhone: string
  shortOrderCode?: number | null
  orderCodeDate?: string | null
  createdAt?: string | null
  status: "pending" | "closed"
  notes: string
  itemsText: string
  callReview?: RestaurantOrderRecord["callReview"]
}

export type MainTab = "overview" | "menu" | "orders" | "voice"
export type AppMode = "admin" | "pos"
export type AuthMode = "login" | "register" | "reset"
export type ParseInsertMode = "replace" | "prepend" | "append"
export type OrderStatusFilter = "all" | "pending" | "complete"
export type NoticeKind = "info" | "success" | "error" | "warning"

export type AppNotice = {
  title: string
  message: string
  kind: NoticeKind
}

export type ReceiptLineItem = {
  name?: string | null
  item_name?: string | null
  quantity?: number | string | null
  qty?: number | string | null
  price?: number | string | null
  unit_price?: number | string | null
}

export type ReceiptOrder = {
  id?: string
  short_code?: string | number | null
  status?: string | null
  created_at?: string | null
  customer_name?: string | null
  contact_name?: string | null
  customer_phone?: string | null
  contact_phone?: string | null
  notes?: string | null
  special_instructions?: string | null
  total_amount?: number | string | null
  total?: number | string | null
  items?: ReceiptLineItem[]
  order_items?: ReceiptLineItem[]
}
