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
