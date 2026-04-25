// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-elevenlabs-webhook-token, elevenlabs-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function logWebhookEvent(stage: string, details: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      scope: "elevenlabs-post-call",
      stage,
      ...details,
    }),
  )
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseElevenLabsSignature(value: string) {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  let timestamp = ""
  let signature = ""

  for (const part of parts) {
    const [key, ...rest] = part.split("=")
    const parsedValue = rest.join("=").trim()
    if (key === "t") {
      timestamp = parsedValue
    } else if (key === "v0") {
      signature = parsedValue
    }
  }

  return timestamp && signature ? { timestamp, signature } : null
}

function bytesToHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}

async function verifyElevenLabsSignature(params: { payload: string; header: string; secret: string }) {
  const parsed = parseElevenLabsSignature(params.header)
  if (!parsed) {
    return false
  }

  const timestampNumber = Number(parsed.timestamp)
  if (!Number.isFinite(timestampNumber)) {
    return false
  }

  const currentTimeSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(currentTimeSeconds - timestampNumber) > 60 * 30) {
    return false
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(params.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${parsed.timestamp}.${params.payload}`))
  return bytesToHex(signed) === parsed.signature.toLowerCase()
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

function resolveWorkerSecret() {
  return normalizeString(Deno.env.get("WEBHOOK_WORKER_SECRET"))
}

function triggerWebhookWorker() {
  const functionsBaseUrl = resolveFunctionsBaseUrl()
  if (!functionsBaseUrl) {
    return
  }

  const workerUrl = `${functionsBaseUrl}/process-webhook-ingest-queue`
  const workerSecret = resolveWorkerSecret()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (workerSecret) {
    headers.authorization = `Bearer ${workerSecret}`
  }

  void fetch(workerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ limit: 1 }),
  }).catch((error) => {
    console.error("[elevenlabs-post-call] Failed to trigger queue worker:", error)
  })
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase service configuration is missing." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const rawBody = await request.text()
  if (!rawBody || !rawBody.trim()) {
    logWebhookEvent("ignored", { reason: "empty_body" })
    return jsonResponse(200, { ok: true, ignored: true, reason: "empty_body" })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    logWebhookEvent("ignored", { reason: "invalid_json", rawLength: rawBody.length })
    return jsonResponse(200, { ok: true, ignored: true, reason: "invalid_json" })
  }

  const payload = getObject(body.data) || body
  const conversationId = normalizeString(payload.conversation_id) || normalizeString(body.conversation_id)
  const incomingEventType = normalizeString(body.type) || normalizeString(payload.event_type) || "post_call"
  const incomingAgentId = normalizeString(payload.agent_id) || normalizeString(body.agent_id)
  const transcriptArrayCandidate = Array.isArray(payload.transcript)
    ? payload.transcript
    : Array.isArray(body.transcript)
      ? body.transcript
      : []

  logWebhookEvent("received", {
    eventType: incomingEventType,
    conversationId: conversationId || null,
    agentId: incomingAgentId || null,
    transcriptEntries: transcriptArrayCandidate.length,
    hasAnalysis: Boolean(getObject(payload.analysis) || getObject(body.analysis)),
    hasFullAudio: Boolean(normalizeString(payload.full_audio) || normalizeString(body.full_audio)),
    hasSignature: Boolean(
      normalizeString(request.headers.get("elevenlabs-signature")) ||
        normalizeString(request.headers.get("ElevenLabs-Signature")),
    ),
    hasToken: Boolean(
      normalizeString(request.headers.get("x-elevenlabs-webhook-token")) ||
        normalizeString(request.headers.get("authorization")),
    ),
  })

  if (!conversationId) {
    logWebhookEvent("ignored", {
      reason: "missing_conversation_id",
      eventType: incomingEventType,
      agentId: incomingAgentId || null,
    })
    return jsonResponse(200, { ok: true, ignored: true, reason: "missing_conversation_id" })
  }

  const expectedWebhookToken = normalizeString(Deno.env.get("ELEVENLABS_WEBHOOK_AUTH_TOKEN"))
  const incomingWebhookToken =
    normalizeString(request.headers.get("x-elevenlabs-webhook-token")) ||
    normalizeString(request.headers.get("authorization")).replace(/^bearer\s+/i, "")
  const incomingWebhookSignature =
    normalizeString(request.headers.get("elevenlabs-signature")) ||
    normalizeString(request.headers.get("ElevenLabs-Signature"))

  let linkedAgent: { restaurant_id?: string | null; post_call_webhook_secret?: string | null } | null = null
  if (incomingAgentId) {
    const { data: linkResult } = await supabase
      .from("voice_agent_links")
      .select("restaurant_id, post_call_webhook_secret")
      .eq("workspace_agent_id", incomingAgentId)
      .maybeSingle()

    linkedAgent = linkResult || null
  }

  let webhookAuthorized = false
  if (expectedWebhookToken && incomingWebhookToken && incomingWebhookToken === expectedWebhookToken) {
    webhookAuthorized = true
  }

  if (!webhookAuthorized && incomingWebhookSignature && normalizeString(linkedAgent?.post_call_webhook_secret)) {
    webhookAuthorized = await verifyElevenLabsSignature({
      payload: rawBody,
      header: incomingWebhookSignature,
      secret: normalizeString(linkedAgent?.post_call_webhook_secret),
    })
  }

  if (!webhookAuthorized && !expectedWebhookToken && !incomingWebhookSignature) {
    webhookAuthorized = true
  }

  if (!webhookAuthorized) {
    logWebhookEvent("rejected", {
      reason: "unauthorized",
      eventType: incomingEventType,
      conversationId,
      agentId: incomingAgentId || null,
      hasSignature: Boolean(incomingWebhookSignature),
      hasToken: Boolean(incomingWebhookToken),
      hasLinkedAgentSecret: Boolean(normalizeString(linkedAgent?.post_call_webhook_secret)),
    })
    return jsonResponse(401, { error: "Unauthorized webhook request." })
  }

  const idempotencyKey = `${conversationId}:${incomingEventType}`
  const queueResult = await supabase
    .from("webhook_ingest_queue")
    .upsert(
      {
        payload: body,
        source: PROVIDER,
        idempotency_key: idempotencyKey,
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    )
    .select("id, status")
    .maybeSingle()

  if (queueResult.error) {
    const message = normalizeString(queueResult.error.message)
    if (message.toLowerCase().includes("webhook_ingest_queue")) {
      return jsonResponse(500, {
        error: message || "Webhook ingest queue is missing.",
        remediation: "Run supabase/020_scalability_webhook_security.sql in Supabase SQL Editor, then retry.",
      })
    }

    logWebhookEvent("queue_failed", {
      eventType: incomingEventType,
      conversationId,
      agentId: incomingAgentId || null,
      error: message || "Unknown queue insert error",
    })
    return jsonResponse(500, { error: message || "Failed to queue webhook payload." })
  }

  logWebhookEvent("queued", {
    eventType: incomingEventType,
    conversationId,
    agentId: incomingAgentId || null,
    queueId: queueResult.data?.id || null,
    idempotencyKey,
  })

  triggerWebhookWorker()

  return jsonResponse(202, {
    ok: true,
    accepted: true,
    idempotency_key: idempotencyKey,
    queue_id: queueResult.data?.id || null,
    conversation_id: conversationId,
    event_type: incomingEventType,
  })
})
