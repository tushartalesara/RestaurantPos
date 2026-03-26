function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

const DEFAULT_AGENT_CREATE_PATH = "/api/customer/agent"
const CONFIGURED_AGENT_CREATE_PATH = String(process.env.EXPO_PUBLIC_IBARA_AGENT_CREATE_PATH || "").trim()

async function parseJson(response: Response) {
  return response.json().catch(() => ({} as Record<string, any>))
}

function resolveAgentCreateUrl(baseUrl: string): string {
  if (!CONFIGURED_AGENT_CREATE_PATH) {
    return `${normalizeBaseUrl(baseUrl)}${DEFAULT_AGENT_CREATE_PATH}`
  }
  if (/^https?:\/\//i.test(CONFIGURED_AGENT_CREATE_PATH)) {
    return CONFIGURED_AGENT_CREATE_PATH
  }
  const path = CONFIGURED_AGENT_CREATE_PATH.startsWith("/")
    ? CONFIGURED_AGENT_CREATE_PATH
    : `/${CONFIGURED_AGENT_CREATE_PATH}`
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

export async function loginToIbaraWorkspace(input: { baseUrl: string; email: string; password: string }) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const response = await fetch(`${baseUrl}/api/mobile/auth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email.trim(),
      password: input.password,
    }),
  })

  const payload = await parseJson(response)
  if (!response.ok || !payload?.token) {
    throw new Error(payload?.error || "Failed to authenticate with ibara workspace")
  }

  return {
    baseUrl,
    token: String(payload.token),
  }
}

export async function createRestaurantVoiceAgent(input: {
  baseUrl: string
  token: string
  restaurantName: string
  phone?: string | null
  address?: string | null
}) {
  const response = await fetch(resolveAgentCreateUrl(input.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "mobile_onboarding",
      industry: "restaurant",
      useCase: "general_inquiry",
      agentName: input.restaurantName,
      phone: input.phone || null,
      address: input.address || null,
    }),
  })

  const payload = await parseJson(response)
  if (!response.ok) {
    throw new Error(payload?.error || "Failed to create voice agent in workspace")
  }

  const agentId = String(payload?.agent?.agent_id || payload?.agent_id || "").trim()
  if (!agentId) {
    throw new Error("Workspace did not return an agent_id")
  }

  return {
    agentId,
    raw: payload,
  }
}
