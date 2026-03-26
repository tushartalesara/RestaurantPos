// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"
const AUDIO_BUCKET = "call-recordings"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-elevenlabs-webhook-token",
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

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
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
    return jsonResponse(200, { ok: true, ignored: true, reason: "empty_body" })
  }

  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonResponse(200, { ok: true, ignored: true, reason: "invalid_json" })
  }

  const payload = getObject(body.data) || body
  const conversationId = normalizeString(payload.conversation_id) || normalizeString(body.conversation_id)

  if (!conversationId) {
    return jsonResponse(200, { ok: true, ignored: true, reason: "missing_conversation_id" })
  }

  const { data: existing, error: existingError } = await supabase
    .from("post_call_webhooks")
    .select("*")
    .eq("provider", PROVIDER)
    .eq("conversation_id", conversationId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existingError) {
    return jsonResponse(500, { error: existingError.message })
  }

  const agentId =
    normalizeString(payload.agent_id) || normalizeString(body.agent_id) || normalizeString(existing?.agent_id)

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

  const payloadNormalizedMetadata = getObject(payload.normalized_metadata)
  const bodyNormalizedMetadata = getObject(body.normalized_metadata)
  const existingPayload = getObject(existing?.webhook_payload) || {}
  const existingNormalizedMetadata = getObject(existingPayload.normalized_metadata)
  const nestedPayloadData = getObject(payload.data)

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

  if (!restaurantId && agentId) {
    const { data: linkResult } = await supabase
      .from("voice_agent_links")
      .select("restaurant_id")
      .eq("workspace_agent_id", agentId)
      .maybeSingle()

    restaurantId = normalizeString(linkResult?.restaurant_id)
  }

  if (!restaurantId) {
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
  const finalTranscriptText = incomingTranscriptText || normalizeString(existing?.transcript_text) || null
  const finalRecordingUrl =
    uploadedAudio?.publicUrl ||
    incomingRecordingUrl ||
    extractRecordingUrl(existingPayload, existingNormalizedMetadata, getObject(existingPayload.data)) ||
    null
  const finalDuration = incomingDuration ?? existingNormalizedMetadata?.call_duration_secs ?? null
  const finalCreatedOrderId = normalizeString(existing?.created_order_id) || normalizeString(linkedOrder?.id) || null

  const mergedWebhookPayload = {
    ...existingPayload,
    ...body,
    normalized_metadata: {
      ...(existingNormalizedMetadata || {}),
      recording_url: finalRecordingUrl,
      recording_storage_bucket: uploadedAudio?.path ? AUDIO_BUCKET : existingNormalizedMetadata?.recording_storage_bucket || null,
      recording_storage_path: uploadedAudio?.path || normalizeString(existingNormalizedMetadata?.recording_storage_path) || null,
      recording_size_bytes:
        uploadedAudio?.sizeBytes ??
        (typeof existingNormalizedMetadata?.recording_size_bytes === "number"
          ? existingNormalizedMetadata.recording_size_bytes
          : null),
      audio_upload_error: uploadedAudio?.error || null,
      call_duration_secs: finalDuration,
      event_id: eventId,
      event_type: eventType,
      merged_at: new Date().toISOString(),
    },
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
        analysis: existing?.analysis || null,
        analysis_status: existing?.analysis_status || "processing",
        analysis_error: existing?.analysis_error || null,
        extracted_order: existing?.extracted_order || null,
        created_order_id: finalCreatedOrderId,
      },
      { onConflict: "dedupe_key" },
    )
    .select("id, created_order_id")
    .single()

  if (saveError) {
    return jsonResponse(500, { error: saveError.message })
  }

  return jsonResponse(200, {
    ok: true,
    deduplicated: Boolean(existing),
    webhookId: saveResult.id,
    linkedOrderId: saveResult.created_order_id || finalCreatedOrderId,
    restaurantId,
    conversationId,
    agentId: agentId || null,
    eventType,
  })
})
