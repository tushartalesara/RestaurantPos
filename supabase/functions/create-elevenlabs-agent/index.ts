// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"
const ELEVENLABS_API_ORIGIN = "https://api.elevenlabs.io"
const ELEVENLABS_API_BASE_URL = `${ELEVENLABS_API_ORIGIN}/v1`

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const TOOL_NAMES = {
  getMenuItems: "mobile_onboarding_get_menu_items",
  getItemCustomizations: "mobile_onboarding_get_item_customizations",
  checkItemStock: "mobile_onboarding_check_item_stock",
  lookupUkPostcodeAddresses: "mobile_onboarding_lookup_uk_postcode_addresses",
  placeOrderAtomic: "mobile_onboarding_place_order_atomic",
} as const

type WorkspaceToolRecord = {
  id?: string
  tool_id?: string
  tool_config?: {
    name?: string
  }
}

function jsonResponse(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  })
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function resolveFunctionsBaseUrl(): string {
  const configured =
    normalizeString(Deno.env.get("MOBILE_ONBOARDING_SUPABASE_FUNCTIONS_BASE_URL")) ||
    normalizeString(Deno.env.get("SUPABASE_FUNCTIONS_BASE_URL"))

  if (configured) {
    return configured.replace(/\/+$/, "")
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  if (!supabaseUrl) {
    return ""
  }

  return `${supabaseUrl.replace(/\/+$/, "")}/functions/v1`
}

function resolveToolSecret(): string {
  return (
    normalizeString(Deno.env.get("MOBILE_ONBOARDING_ELEVENLABS_TOOL_SECRET")) ||
    normalizeString(Deno.env.get("ELEVENLABS_TOOL_SECRET"))
  )
}

function resolvePostCallWebhookUrl(): string {
  const functionsBaseUrl = resolveFunctionsBaseUrl()
  return functionsBaseUrl ? `${functionsBaseUrl}/elevenlabs-post-call` : ""
}

function buildRestaurantPrompt(params: { agentName: string; address?: string; phone?: string }) {
  const businessFacts = [
    `Restaurant name: ${params.agentName}.`,
    params.address ? `Address: ${params.address}.` : null,
    params.phone ? `Phone: ${params.phone}.` : null,
  ]
    .filter(Boolean)
    .join(" ")

  return [
    `You are the restaurant voice ordering assistant for ${params.agentName}.`,
    businessFacts,
    `Take accurate orders, check stock, collect required customizations, and place the final order using tools.`,
    `Never invent menu items, availability, prices, or options.`,
    ``,
    `TOOLS YOU MUST USE`,
    `1) ${TOOL_NAMES.getMenuItems}`,
    `2) ${TOOL_NAMES.getItemCustomizations}`,
    `3) ${TOOL_NAMES.checkItemStock}`,
    `4) ${TOOL_NAMES.lookupUkPostcodeAddresses}`,
    `5) ${TOOL_NAMES.placeOrderAtomic}`,
    ``,
    `CORE RULES`,
    `- Always pass agent_id as {{system__agent_id}} in tool calls.`,
    `- Always pass conversation_id as {{system__conversation_id}} when available.`,
    `- Collect customer_name and customer_phone before placing an order.`,
    `- Determine whether the order is pickup or delivery before placing it.`,
    `- For delivery, ask for the postcode first, then call ${TOOL_NAMES.lookupUkPostcodeAddresses}.`,
    `- For delivery, read back a short numbered list of returned addresses and let the caller pick one exact address before placing the order.`,
    `- Never ask the caller to dictate the full delivery address before you have done the postcode lookup.`,
    `- Pickup orders must be sent as fulfillment_type=pickup and payment_collection=unpaid.`,
    `- Delivery orders must be sent as fulfillment_type=delivery and payment_collection=cod.`,
    `- Never place an order without explicit customer confirmation.`,
    `- Never claim the order is placed unless ${TOOL_NAMES.placeOrderAtomic} succeeds.`,
    `- Speak naturally and keep replies concise.`,
    `- Present the menu by category first instead of reading a long flat list.`,
    `- Treat menu descriptions as included contents, not optional customizations.`,
    `- Use customizations only for selectable choices returned by tools.`,
    ``,
    `ORDER FLOW`,
    `- Greet the caller, ask whether the order is for pickup or delivery, then ask what they would like to order.`,
    `- If they ask about the menu, call ${TOOL_NAMES.getMenuItems} and summarize categories plus a few examples.`,
    `- For each requested item, call ${TOOL_NAMES.checkItemStock} first.`,
    `- If an exact item is resolved, call ${TOOL_NAMES.getItemCustomizations} before final confirmation.`,
    `- For delivery, collect the postcode, call ${TOOL_NAMES.lookupUkPostcodeAddresses}, and let the caller choose one returned address.`,
    `- If the postcode lookup returns no results, ask for a different postcode or offer pickup instead.`,
    `- Summarize the cart, fulfilment type, payment collection, and delivery address when relevant, then ask if you should place the order now.`,
    `- On yes, call ${TOOL_NAMES.placeOrderAtomic} with customer details, fulfillment_type, payment_collection, notes if any, and the final items.`,
    `- Share the 3-digit order code and total price after a successful order.`,
  ].join("\n")
}

function buildRestaurantFirstMessage(agentName: string) {
  return `Hello! Welcome to ${agentName}. How can I help you today? Would you like to place an order?`
}

function buildRestaurantToolConfigs(params: { functionsBaseUrl: string; toolSecret: string }) {
  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (params.toolSecret) {
    requestHeaders["x-tool-secret"] = params.toolSecret
  }

  return [
    {
      type: "webhook",
      name: TOOL_NAMES.getMenuItems,
      description:
        "List available menu items for the restaurant linked to the provided agent_id. Use this to describe categories and narrow menu choices.",
      response_timeout_secs: 20,
      disable_interruptions: false,
      force_pre_tool_speech: false,
      api_schema: {
        url: `${params.functionsBaseUrl}/get-menu-items`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string", description: "Use {{system__agent_id}}." },
            conversation_id: { type: "string", description: "Use {{system__conversation_id}} when available." },
            query: { type: "string", description: "Optional item name or keyword from the caller." },
            category: { type: "string", description: "Optional category filter such as burgers, wraps, or drinks." },
            limit: { type: "number", description: "Maximum number of menu items to return." },
            include_unavailable: {
              type: "boolean",
              description: "Set true only if the caller explicitly wants unavailable items included.",
            },
          },
        },
      },
    },
    {
      type: "webhook",
      name: TOOL_NAMES.getItemCustomizations,
      description:
        "Get customization options for a specific menu item. Prefer item_id when available. Always send agent_id.",
      response_timeout_secs: 20,
      disable_interruptions: false,
      force_pre_tool_speech: false,
      api_schema: {
        url: `${params.functionsBaseUrl}/get-item-customizations`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string", description: "Use {{system__agent_id}}." },
            conversation_id: { type: "string", description: "Use {{system__conversation_id}} when available." },
            item_id: { type: "string", description: "Preferred exact menu item id returned by another tool." },
            item_name: { type: "string", description: "Exact item name if item_id is not available." },
          },
        },
      },
    },
    {
      type: "webhook",
      name: TOOL_NAMES.checkItemStock,
      description:
        "Check whether the requested item and quantity can be fulfilled. Always send agent_id and requested_qty.",
      response_timeout_secs: 20,
      disable_interruptions: false,
      force_pre_tool_speech: false,
      api_schema: {
        url: `${params.functionsBaseUrl}/check-item-stock`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: ["agent_id"],
          properties: {
            agent_id: { type: "string", description: "Use {{system__agent_id}}." },
            conversation_id: { type: "string", description: "Use {{system__conversation_id}} when available." },
            item_id: { type: "string", description: "Preferred exact menu item id when available." },
            item_name: { type: "string", description: "Exact item name when item_id is not available yet." },
            requested_qty: { type: "number", description: "How many units the caller wants." },
          },
        },
      },
    },
    {
      type: "webhook",
      name: TOOL_NAMES.lookupUkPostcodeAddresses,
      description:
        "Look up delivery addresses for a UK postcode. Always send agent_id and the caller's postcode before asking them to choose one exact address.",
      response_timeout_secs: 20,
      disable_interruptions: false,
      force_pre_tool_speech: false,
      api_schema: {
        url: `${params.functionsBaseUrl}/lookup-uk-postcode-addresses`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: ["agent_id", "postcode"],
          properties: {
            agent_id: { type: "string", description: "Use {{system__agent_id}}." },
            conversation_id: { type: "string", description: "Use {{system__conversation_id}} when available." },
            postcode: { type: "string", description: "The UK delivery postcode provided by the caller." },
          },
        },
      },
    },
    {
      type: "webhook",
      name: TOOL_NAMES.placeOrderAtomic,
      description:
        "Place the final restaurant order transactionally after the caller confirms it. Always send agent_id, conversation_id, customer_name, customer_phone, fulfillment_type, payment_collection, and items.",
      response_timeout_secs: 20,
      disable_interruptions: false,
      force_pre_tool_speech: false,
      api_schema: {
        url: `${params.functionsBaseUrl}/place-order-atomic`,
        method: "POST",
        request_headers: requestHeaders,
        request_body_schema: {
          type: "object",
          required: [
            "agent_id",
            "conversation_id",
            "customer_name",
            "customer_phone",
            "fulfillment_type",
            "payment_collection",
            "items",
          ],
          properties: {
            agent_id: { type: "string", description: "Use {{system__agent_id}}." },
            conversation_id: { type: "string", description: "Use {{system__conversation_id}}." },
            customer_name: { type: "string", description: "Customer name for the order." },
            customer_phone: { type: "string", description: "Customer phone number for order tracking." },
            fulfillment_type: {
              type: "string",
              description: "Use pickup for collection orders or delivery for address orders.",
              enum: ["pickup", "delivery"],
            },
            delivery_postcode: {
              type: "string",
              description: "Required when fulfillment_type is delivery. Use the selected UK delivery postcode.",
            },
            delivery_address: {
              type: "string",
              description: "Required when fulfillment_type is delivery. Use the exact address chosen from the postcode lookup results.",
            },
            payment_collection: {
              type: "string",
              description: "Use unpaid for pickup orders and cod for delivery orders.",
              enum: ["unpaid", "cod"],
            },
            status: {
              type: "string",
              description: "Use pending unless there is a special reason to close the order immediately.",
              enum: ["pending", "closed"],
            },
            notes: { type: "string", description: "Any special instructions or free-text notes." },
            items: {
              type: "array",
              description: "Final confirmed order lines.",
              items: {
                type: "object",
                required: ["item_id", "quantity"],
                properties: {
                  item_id: { type: "string", description: "Exact menu item id from earlier tool results." },
                  quantity: { type: "number", description: "Confirmed quantity for this item." },
                  name: { type: "string", description: "Optional display name for the item." },
                  unit_price: { type: "number", description: "Optional unit price override. Usually omit." },
                },
              },
            },
          },
        },
      },
    },
  ]
}

async function elevenLabsRequest<T>(apiKey: string, endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${ELEVENLABS_API_BASE_URL}${endpoint}`, {
    ...init,
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`ElevenLabs API error (${response.status}) ${endpoint}: ${errorText}`)
  }

  if (response.status === 204) {
    return null as T
  }

  return (await response.json()) as T
}

async function ensureRestaurantTools(apiKey: string) {
  const functionsBaseUrl = resolveFunctionsBaseUrl()
  if (!functionsBaseUrl) {
    throw new Error("Supabase Functions base URL is not configured")
  }

  const toolConfigs = buildRestaurantToolConfigs({
    functionsBaseUrl,
    toolSecret: resolveToolSecret(),
  })

  const listResult = await elevenLabsRequest<{ tools?: WorkspaceToolRecord[] } | WorkspaceToolRecord[]>(
    apiKey,
    "/convai/tools",
    { method: "GET" },
  )

  const existingTools = Array.isArray(listResult) ? listResult : listResult.tools || []
  const existingByName = new Map<string, WorkspaceToolRecord>()

  for (const tool of existingTools) {
    const toolName = normalizeString(tool.tool_config?.name)
    if (toolName) {
      existingByName.set(toolName, tool)
    }
  }

  const toolIds: string[] = []
  for (const toolConfig of toolConfigs) {
    const existing = existingByName.get(toolConfig.name)
    const existingToolId = normalizeString(existing?.id) || normalizeString(existing?.tool_id)
    const endpoint = existingToolId ? `/convai/tools/${existingToolId}` : "/convai/tools"
    const method = existingToolId ? "PATCH" : "POST"
    const result = await elevenLabsRequest<WorkspaceToolRecord>(apiKey, endpoint, {
      method,
      body: JSON.stringify({ tool_config: toolConfig }),
    })

    const resolvedToolId = normalizeString(result?.id) || normalizeString(result?.tool_id)
    if (!resolvedToolId) {
      throw new Error(`Tool provisioning failed for ${toolConfig.name}`)
    }

    toolIds.push(resolvedToolId)
  }

  return toolIds
}

async function attachToolsToAgent(params: {
  apiKey: string
  agentId: string
  systemPrompt: string
  firstMessage: string
  toolIds: string[]
}) {
  const currentAgent = await elevenLabsRequest<Record<string, any>>(params.apiKey, `/convai/agents/${params.agentId}`, {
    method: "GET",
  })

  const updatePayload: Record<string, any> = {
    name: currentAgent.name,
    conversation_config: currentAgent.conversation_config || {},
  }

  if (!updatePayload.conversation_config.agent) {
    updatePayload.conversation_config.agent = {}
  }
  if (!updatePayload.conversation_config.agent.prompt) {
    updatePayload.conversation_config.agent.prompt = {}
  }

  updatePayload.conversation_config.agent.first_message = params.firstMessage
  updatePayload.conversation_config.agent.prompt.prompt = params.systemPrompt
  updatePayload.conversation_config.agent.prompt.tool_ids = params.toolIds

  await elevenLabsRequest(params.apiKey, `/convai/agents/${params.agentId}`, {
    method: "PATCH",
    body: JSON.stringify(updatePayload),
  })
}

async function createPostCallWebhook(apiKey: string) {
  const webhookUrl = resolvePostCallWebhookUrl()
  if (!webhookUrl) {
    throw new Error("Post-call webhook URL could not be resolved")
  }

  const result = await elevenLabsRequest<{ webhook_id?: string; webhook_secret?: string | null }>(
    apiKey,
    "/workspace/webhooks",
    {
      method: "POST",
      body: JSON.stringify({
        settings: {
          auth_type: "hmac",
          name: "Restaurant POS Post Call",
          webhook_url: webhookUrl,
        },
      }),
    },
  )

  const webhookId = normalizeString(result?.webhook_id)
  const webhookSecret = normalizeString(result?.webhook_secret)

  if (!webhookId || !webhookSecret) {
    throw new Error("ElevenLabs did not return a post-call webhook ID and secret")
  }

  return {
    webhookId,
    webhookSecret,
  }
}

async function configurePostCallWebhook(params: { apiKey: string; webhookId: string }) {
  const desiredPayload = {
    webhooks: {
      post_call_webhook_id: params.webhookId,
      events: ["transcript", "call_initiation_failure"],
      send_audio: true,
    },
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await elevenLabsRequest<Record<string, any>>(params.apiKey, "/convai/settings", {
      method: "PATCH",
      body: JSON.stringify(desiredPayload),
    })

    const currentSettings = await elevenLabsRequest<Record<string, any>>(params.apiKey, "/convai/settings", {
      method: "GET",
    })

    const configuredWebhookId = normalizeString(currentSettings?.webhooks?.post_call_webhook_id)
    const sendAudioEnabled = currentSettings?.webhooks?.send_audio === true

    if (configuredWebhookId === params.webhookId && sendAudioEnabled) {
      return
    }
  }

  throw new Error("ElevenLabs post-call webhook was not configured with audio delivery enabled.")
}

async function resolveUserId(request: Request, supabaseUrl: string, supabaseAnonKey: string) {
  const authHeader =
    normalizeString(request.headers.get("Authorization")) || normalizeString(request.headers.get("authorization"))
  if (!authHeader) {
    return ""
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  })

  const authResult = await authClient.auth.getUser()
  if (authResult.error) {
    throw new Error(authResult.error.message)
  }

  return normalizeString(authResult.data.user?.id)
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseAnonKey = normalizeString(Deno.env.get("SUPABASE_ANON_KEY"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase function environment is incomplete." })
  }

  let userId = ""
  try {
    userId = await resolveUserId(request, supabaseUrl, supabaseAnonKey)
  } catch (error) {
    return jsonResponse(401, { error: error instanceof Error ? error.message : "Unauthorized." })
  }

  if (!userId) {
    return jsonResponse(401, { error: "Unauthorized." })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse(400, { error: "Body must be a JSON object." })
  }

  const bodyObj = body as Record<string, unknown>
  const restaurantId = normalizeString(bodyObj.restaurant_id)
  const apiKey = normalizeString(bodyObj.api_key)

  if (!restaurantId) {
    return jsonResponse(400, { error: "restaurant_id is required." })
  }
  if (!apiKey) {
    return jsonResponse(400, { error: "ElevenLabs API key is required." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const restaurantResult = await supabase
    .from("restaurants")
    .select("id, name, phone, address")
    .eq("id", restaurantId)
    .eq("owner_user_id", userId)
    .maybeSingle()

  if (restaurantResult.error) {
    return jsonResponse(500, { error: restaurantResult.error.message })
  }

  if (!restaurantResult.data) {
    return jsonResponse(404, { error: "Restaurant not found." })
  }

  const restaurant = restaurantResult.data
  const systemPrompt = buildRestaurantPrompt({
    agentName: restaurant.name,
    address: normalizeString(restaurant.address),
    phone: normalizeString(restaurant.phone),
  })
  const firstMessage = buildRestaurantFirstMessage(restaurant.name)

  let toolIds: string[] = []
  try {
    toolIds = await ensureRestaurantTools(apiKey)
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Failed to provision ElevenLabs restaurant tools.",
    })
  }

  let postCallWebhookId = ""
  let postCallWebhookSecret = ""
  try {
    const createdWebhook = await createPostCallWebhook(apiKey)
    postCallWebhookId = createdWebhook.webhookId
    postCallWebhookSecret = createdWebhook.webhookSecret
    await configurePostCallWebhook({
      apiKey,
      webhookId: postCallWebhookId,
    })
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Failed to configure ElevenLabs post-call webhook.",
    })
  }

  let createdAgent: Record<string, any> | null = null
  try {
    createdAgent = await elevenLabsRequest<Record<string, any>>(apiKey, "/convai/agents/create", {
      method: "POST",
      body: JSON.stringify({
        name: restaurant.name,
        conversation_config: {
          agent: {
            language: "en",
            first_message: firstMessage,
            prompt: {
              prompt: systemPrompt,
            },
          },
        },
      }),
    })
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Failed to create voice agent in ElevenLabs.",
    })
  }

  const agentId =
    normalizeString(createdAgent?.agent_id) ||
    normalizeString(createdAgent?.agent?.agent_id) ||
    normalizeString(createdAgent?.id)

  if (!agentId) {
    return jsonResponse(502, { error: "ElevenLabs did not return an agent_id." })
  }

  try {
    await attachToolsToAgent({
      apiKey,
      agentId,
      systemPrompt,
      firstMessage,
      toolIds,
    })
  } catch (error) {
    return jsonResponse(502, {
      error: error instanceof Error ? error.message : "Agent was created but restaurant tools could not be attached.",
      agent_id: agentId,
    })
  }

  const linkResult = await supabase
    .from("voice_agent_links")
    .upsert(
      {
        restaurant_id: restaurantId,
        workspace_base_url: ELEVENLABS_API_ORIGIN,
        workspace_agent_id: agentId,
        post_call_webhook_id: postCallWebhookId,
        post_call_webhook_secret: postCallWebhookSecret,
        provider: PROVIDER,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "restaurant_id" },
    )
    .select("id")
    .single()

  if (linkResult.error) {
    return jsonResponse(500, {
      error: linkResult.error.message,
      agent_id: agentId,
    })
  }

  return jsonResponse(200, {
    ok: true,
    provider: PROVIDER,
    restaurant_id: restaurantId,
    agent_id: agentId,
    post_call_webhook_id: postCallWebhookId,
    tool_ids: toolIds,
    link_id: linkResult.data?.id || null,
  })
})
