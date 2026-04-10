import { assertSupabaseConfigured, supabase } from "./supabase"

export const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io"

type CreateRestaurantVoiceAgentInput = {
  restaurantId: string
  apiKey: string
}

type CreateRestaurantVoiceAgentResponse = {
  agent_id?: string
  agent?: {
    agent_id?: string
  }
  error?: string
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export async function createRestaurantVoiceAgent(input: CreateRestaurantVoiceAgentInput) {
  assertSupabaseConfigured()

  const restaurantId = normalizeString(input.restaurantId)
  const apiKey = normalizeString(input.apiKey)

  if (!restaurantId) {
    throw new Error("restaurant_id is required")
  }
  if (!apiKey) {
    throw new Error("ElevenLabs API key is required")
  }

  const { data, error } = await supabase.functions.invoke<CreateRestaurantVoiceAgentResponse>("create-elevenlabs-agent", {
    body: {
      restaurant_id: restaurantId,
      api_key: apiKey,
    },
  })

  if (error) {
    throw new Error(error.message || "Failed to create voice agent in ElevenLabs")
  }

  const payload = data || {}
  const agentId = normalizeString(payload.agent_id) || normalizeString(payload.agent?.agent_id)

  if (!agentId) {
    throw new Error(payload.error || "ElevenLabs did not return an agent_id")
  }

  return {
    agentId,
    raw: payload,
  }
}
