// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"
const AUDIO_BUCKET = "call-recordings"

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

function mergeObjects(
  base: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...(base || {}) }

  for (const [key, value] of Object.entries(incoming || {})) {
    const currentValue = getObject(result[key])
    const nextValue = getObject(value)

    if (currentValue && nextValue) {
      result[key] = mergeObjects(currentValue, nextValue)
      continue
    }

    result[key] = value
  }

  return result
}

function extractRecordingUrl(...sources: Array<Record<string, unknown> | null>) {
  for (const source of sources) {
    const candidate = normalizeString(source?.recording_url) || normalizeString(source?.audio_url)
    if (candidate) {
      return candidate
    }
  }
  return null
}

function decodeBase64ToBytes(value: string) {
  const normalized = value.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, "").replace(/\s+/g, "")
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

async function uploadConversationAudio(params: {
  supabase: ReturnType<typeof createClient>
  restaurantId: string
  conversationId: string
  fullAudioBase64: string
}) {
  try {
    const audioBytes = decodeBase64ToBytes(params.fullAudioBase64)
    const storagePath = `${params.restaurantId}/${params.conversationId}.mp3`
    const uploadResult = await params.supabase.storage.from(AUDIO_BUCKET).upload(storagePath, audioBytes, {
      upsert: true,
      contentType: "audio/mpeg",
      cacheControl: "3600",
    })

    if (uploadResult.error) {
      return { error: uploadResult.error.message }
    }

    const publicUrlResult = params.supabase.storage.from(AUDIO_BUCKET).getPublicUrl(storagePath)
    return {
      path: storagePath,
      publicUrl: publicUrlResult.data.publicUrl,
      sizeBytes: audioBytes.byteLength,
      error: null,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to decode or upload full_audio.",
    }
  }
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

async function loadLatestConversationWebhook(params: {
  supabase: ReturnType<typeof createClient>
  provider: string
  conversationId: string
}) {
  const { data, error } = await params.supabase
    .from("post_call_webhooks")
    .select("*")
    .eq("provider", params.provider)
    .eq("conversation_id", params.conversationId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(error.message)
  }

  return data || null
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || ""
  const supabaseServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""

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

  let existing: Record<string, unknown> | null = null
  try {
    existing = await loadLatestConversationWebhook({
      supabase,
      provider: PROVIDER,
      conversationId,
    })
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to load existing webhook row." })
  }

  const agentId =
    normalizeString(payload.agent_id) || normalizeString(body.agent_id) || normalizeString(existing?.agent_id)

  const expectedWebhookToken = normalizeString(Deno.env.get("ELEVENLABS_WEBHOOK_AUTH_TOKEN"))
  const incomingWebhookToken =
    normalizeString(request.headers.get("x-elevenlabs-webhook-token")) ||
    normalizeString(request.headers.get("authorization")).replace(/^bearer\s+/i, "")
  const incomingWebhookSignature =
    normalizeString(request.headers.get("elevenlabs-signature")) ||
    normalizeString(request.headers.get("ElevenLabs-Signature"))

  let linkedAgent: { restaurant_id?: string | null; post_call_webhook_secret?: string | null } | null = null
  if (agentId) {
    const { data: linkResult } = await supabase
      .from("voice_agent_links")
      .select("restaurant_id, post_call_webhook_secret")
      .eq("workspace_agent_id", agentId)
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
      agentId: incomingAgentId || agentId || null,
      hasSignature: Boolean(incomingWebhookSignature),
      hasToken: Boolean(incomingWebhookToken),
      hasLinkedAgentSecret: Boolean(normalizeString(linkedAgent?.post_call_webhook_secret)),
    })
    return jsonResponse(401, { error: "Unauthorized webhook request." })
  }

  const eventId =
    normalizeString(body.event_id) ||
    normalizeString(payload.event_id) ||
    normalizeString(existing?.event_id) ||
    `evt_${crypto.randomUUID()}`
  const eventType =
    normalizeString(body.type) || normalizeString(payload.event_type) || normalizeString(existing?.event_type) || "post_call"

  let incomingTranscriptText = ""
  const transcriptArray = Array.isArray(payload.transcript)
    ? payload.transcript
    : Array.isArray(body.transcript)
      ? body.transcript
      : []

  if (transcriptArray.length > 0) {
    incomingTranscriptText = transcriptArray
      .map((item) => {
        const transcriptRow = getObject(item)
        const role = normalizeString(transcriptRow?.role) || "speaker"
        const message = normalizeString(transcriptRow?.message) || normalizeString(transcriptRow?.text)
        return message ? `${role}: ${message}` : ""
      })
      .filter(Boolean)
      .join("\n")
  }

  logWebhookEvent("parsed", {
    eventType,
    conversationId,
    agentId: agentId || null,
    transcriptEntries: transcriptArray.length,
    transcriptChars: incomingTranscriptText.length,
    hasAnalysis: Boolean(getObject(payload.analysis) || getObject(body.analysis)),
  })

  const payloadNormalizedMetadata = getObject(payload.normalized_metadata)
  const bodyNormalizedMetadata = getObject(body.normalized_metadata)
  const nestedPayloadData = getObject(payload.data)
  const incomingBodyData = getObject(body.data)
  const incomingAnalysis = getObject(payload.analysis) || getObject(body.analysis)

  const incomingRecordingUrl =
    extractRecordingUrl(payload, body, payloadNormalizedMetadata, bodyNormalizedMetadata, nestedPayloadData) || null
  const incomingDuration =
    payload.call_duration_secs ??
    body.call_duration_secs ??
    payloadNormalizedMetadata?.call_duration_secs ??
    bodyNormalizedMetadata?.call_duration_secs ??
    null

  const fullAudioBase64 = normalizeString(payload.full_audio) || normalizeString(body.full_audio)

  if ("full_audio" in payload) {
    delete payload.full_audio
  }
  if ("full_audio" in body) {
    delete body.full_audio
  }

  const { data: linkedOrder } = await supabase
    .from("restaurant_orders")
    .select("id, restaurant_id")
    .eq("source_provider", PROVIDER)
    .eq("source_conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let restaurantId =
    normalizeString(existing?.restaurant_id) || normalizeString(linkedOrder?.restaurant_id) || ""

  if (!restaurantId) {
    restaurantId = normalizeString(linkedAgent?.restaurant_id)
  }

  if (!restaurantId) {
    logWebhookEvent("ignored", {
      reason: agentId ? "agent_not_linked" : "missing_agent_id",
      eventType,
      conversationId,
      agentId: agentId || null,
    })
    return jsonResponse(200, {
      ok: true,
      ignored: true,
      reason: agentId ? "agent_not_linked" : "missing_agent_id",
      agentId: agentId || null,
      conversationId,
    })
  }
  const uploadedAudio =
    fullAudioBase64.length > 0
      ? await uploadConversationAudio({
          supabase,
          restaurantId,
          conversationId,
          fullAudioBase64,
        })
      : null

  const dedupeKey =
    normalizeString(existing?.dedupe_key) || `${PROVIDER}:conversation:${conversationId}`

  let latestExisting: Record<string, unknown> | null = existing
  try {
    latestExisting = await loadLatestConversationWebhook({
      supabase,
      provider: PROVIDER,
      conversationId,
    })
  } catch (error) {
    logWebhookEvent("latest_row_reload_failed", {
      eventType,
      conversationId,
      agentId: agentId || null,
      error: error instanceof Error ? error.message : "unknown_error",
    })
  }

  const latestPayload = getObject(latestExisting?.webhook_payload) || {}
  const latestNormalizedMetadata = getObject(latestPayload.normalized_metadata)
  const latestPayloadData = getObject(latestPayload.data)
  const finalTranscriptText = incomingTranscriptText || normalizeString(latestExisting?.transcript_text) || null
  const finalAnalysis = incomingAnalysis || getObject(latestExisting?.analysis) || null
  const finalAnalysisStatus = incomingAnalysis ? "completed" : normalizeString(latestExisting?.analysis_status) || "processing"
  const finalRecordingUrl =
    uploadedAudio?.publicUrl ||
    incomingRecordingUrl ||
    extractRecordingUrl(latestPayload, latestNormalizedMetadata, getObject(latestPayload.data)) ||
    null
  const finalDuration = incomingDuration ?? latestNormalizedMetadata?.call_duration_secs ?? null
  const finalCreatedOrderId = normalizeString(latestExisting?.created_order_id) || normalizeString(linkedOrder?.id) || null
  const mergedWebhookPayload = mergeObjects(latestPayload, body)
  const mergedWebhookPayloadData = mergeObjects(latestPayloadData, incomingBodyData)
  const mergedWebhookNormalizedMetadata = mergeObjects(latestNormalizedMetadata, bodyNormalizedMetadata)

  logWebhookEvent("save_attempt", {
    eventType,
    conversationId,
    agentId: agentId || null,
    restaurantId,
    dedupeKey,
    hadExistingRow: Boolean(latestExisting),
    transcriptChars: finalTranscriptText?.length || 0,
    hasAnalysis: Boolean(finalAnalysis),
    hasRecordingUrl: Boolean(finalRecordingUrl),
    createdOrderId: finalCreatedOrderId || null,
  })

  mergedWebhookPayload.data = mergedWebhookPayloadData
  mergedWebhookPayload.normalized_metadata = {
      ...mergedWebhookNormalizedMetadata,
      recording_url: finalRecordingUrl,
      recording_storage_bucket: uploadedAudio?.path ? AUDIO_BUCKET : latestNormalizedMetadata?.recording_storage_bucket || null,
      recording_storage_path: uploadedAudio?.path || normalizeString(latestNormalizedMetadata?.recording_storage_path) || null,
      recording_size_bytes:
        uploadedAudio?.sizeBytes ??
        (typeof latestNormalizedMetadata?.recording_size_bytes === "number"
          ? latestNormalizedMetadata.recording_size_bytes
          : null),
      audio_upload_error: uploadedAudio?.error || null,
      call_duration_secs: finalDuration,
      event_id: eventId,
      event_type: eventType,
      merged_at: new Date().toISOString(),
  }

  const { data: saveResult, error: saveError } = await supabase
    .from("post_call_webhooks")
    .upsert(
      {
        provider: PROVIDER,
        dedupe_key: dedupeKey,
        event_id: eventId,
        event_type: eventType,
        conversation_id: conversationId,
        agent_id: agentId,
        restaurant_id: restaurantId,
        webhook_payload: mergedWebhookPayload,
        transcript_text: finalTranscriptText,
        analysis: finalAnalysis,
        analysis_status: finalAnalysisStatus,
        analysis_error: latestExisting?.analysis_error || null,
        extracted_order: latestExisting?.extracted_order || null,
        created_order_id: finalCreatedOrderId,
      },
      { onConflict: "dedupe_key" },
    )
    .select("id, created_order_id")
    .single()

  if (saveError) {
    logWebhookEvent("save_failed", {
      eventType,
      conversationId,
      agentId: agentId || null,
      restaurantId,
      error: saveError.message,
    })
    return jsonResponse(500, { error: saveError.message })
  }

  logWebhookEvent("save_success", {
    eventType,
    conversationId,
    agentId: agentId || null,
    restaurantId,
    webhookId: saveResult.id,
    deduplicated: Boolean(existing),
    linkedOrderId: saveResult.created_order_id || finalCreatedOrderId || null,
    transcriptChars: finalTranscriptText?.length || 0,
    hasAnalysis: Boolean(finalAnalysis),
    hasRecordingUrl: Boolean(finalRecordingUrl),
  })

  return jsonResponse(200, {
    ok: true,
    deduplicated: Boolean(latestExisting),
    webhookId: saveResult.id,
    linkedOrderId: saveResult.created_order_id || finalCreatedOrderId,
    restaurantId,
    conversationId,
    agentId: agentId || null,
    eventType,
  })
})
