import "react-native-url-polyfill/auto"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { createClient } from "@supabase/supabase-js"

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim()
const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || "").trim()

export function assertSupabaseConfigured() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase config missing. Set SUPABASE_URL and SUPABASE_ANON_KEY.")
  }
}

export const supabase = createClient(supabaseUrl || "https://example.supabase.co", supabaseAnonKey || "missing-key", {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
})
