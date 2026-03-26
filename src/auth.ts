import type { AppSession, SessionUser } from "./types"
import { assertSupabaseConfigured, supabase } from "./supabase"

function mapSessionUser(user: { id: string; email?: string | null }): SessionUser {
  return {
    id: user.id,
    email: String(user.email || ""),
  }
}

function normalizeAuthErrorMessage(error: { message?: string; status?: number } | null | undefined) {
  const message = String(error?.message || "").trim()
  const lowerMessage = message.toLowerCase()

  if (lowerMessage.includes("user already registered")) {
    return "That email is already in use. Try signing in instead."
  }

  if (lowerMessage.includes("password should be at least")) {
    return "Choose a password with at least 6 characters."
  }

  if (lowerMessage.includes("signups not allowed")) {
    return "New account creation is turned off right now."
  }

  if (lowerMessage.includes("unable to validate email address")) {
    return "Please check the email address and try again."
  }

  if (lowerMessage.includes("user not found")) {
    return "We couldn't find an account with that email."
  }

  if (lowerMessage.includes("email not confirmed")) {
    return "Please open the confirmation email we sent earlier, then sign in."
  }

  if (lowerMessage.includes("rate limit")) {
    return "You've tried that a few times already. Please wait a little, then try again."
  }

  if (lowerMessage.includes("invalid login credentials")) {
    return "That email or password doesn't look right. Please try again."
  }

  if (message.length > 0) {
    return message
  }

  return "We couldn't complete that right now. Please try again."
}

export async function registerWithEmail(email: string, password: string): Promise<SessionUser> {
  assertSupabaseConfigured()

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail || !password) {
    throw new Error("Email and password are required")
  }
  if (password.length < 6) {
    throw new Error("Password is too short. Use at least 6 characters.")
  }

  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
  })

  if (error) {
    if (String(error.message || "").toLowerCase().includes("user already registered")) {
      const existingLogin = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password,
      })

      if (!existingLogin.error && existingLogin.data.user) {
        return mapSessionUser(existingLogin.data.user)
      }
    }

    throw new Error(normalizeAuthErrorMessage(error))
  }

  if (data.session?.user) {
    return mapSessionUser(data.session.user)
  }

  // No active session after signup usually means email confirmation is required.
  throw new Error(`Confirmation email sent to ${normalizedEmail}. Please open it, then come back and sign in.`)
}

export async function loginWithEmail(email: string, password: string): Promise<SessionUser> {
  assertSupabaseConfigured()

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail || !password) {
    throw new Error("Email and password are required")
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizedEmail,
    password,
  })

  if (error || !data.user) {
    throw new Error(normalizeAuthErrorMessage(error) || "Invalid credentials")
  }

  return mapSessionUser(data.user)
}

export async function resetPasswordWithEmail(email: string): Promise<void> {
  assertSupabaseConfigured()

  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    throw new Error("Email is required for password reset.")
  }

  const { error } = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: process.env.EXPO_PUBLIC_PASSWORD_RESET_REDIRECT_URL || undefined,
  })

  if (error) {
    throw new Error(normalizeAuthErrorMessage(error) || "Could not send password reset email.")
  }
}

// Session is persisted by Supabase auth storage. Kept for API compatibility.
export async function saveSession(_session: AppSession) {
  return
}

export async function getSession(): Promise<AppSession | null> {
  assertSupabaseConfigured()

  const { data, error } = await supabase.auth.getSession()
  if (error) {
    throw new Error(error.message)
  }

  if (!data.session?.user) {
    return null
  }

  return {
    user: mapSessionUser(data.session.user),
  }
}

export async function clearSession() {
  assertSupabaseConfigured()
  const { error } = await supabase.auth.signOut()
  if (error) {
    throw new Error(error.message)
  }
}
