// @ts-nocheck
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8"

const PROVIDER = "elevenlabs"
const AUDIO_BUCKET = "call-recordings"

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret",
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

function normalizePositiveInteger(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value))
  }
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed))
    }
  }
  return fallback
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
      return { error: uploadResult.error.message, path: null, sizeBytes: null }
    }

    return {
      path: storagePath,
      sizeBytes: audioBytes.byteLength,
      error: null,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to decode or upload full_audio.",
      path: null,
      sizeBytes: null,
    }
  }
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

function isMissingRecordingStorageColumnError(error: unknown): boolean {
  const message = normalizeString((error as { message?: string })?.message).toLowerCase()
  return (
    message.includes("recording_storage_bucket") ||
    message.includes("recording_storage_path") ||
    message.includes("recording_size_bytes")
  )
}

async function upsertConversationWebhook(params: {
  supabase: ReturnType<typeof createClient>
  row: Record<string, unknown>
}) {
  const withStorageColumns = await params.supabase
    .from("post_call_webhooks")
    .upsert(params.row, { onConflict: "dedupe_key" })
    .select("id, created_order_id")
    .single()

  if (!withStorageColumns.error || !isMissingRecordingStorageColumnError(withStorageColumns.error)) {
    return withStorageColumns
  }

  const fallbackRow = { ...params.row }
  delete fallbackRow.recording_storage_bucket
  delete fallbackRow.recording_storage_path
  delete fallbackRow.recording_size_bytes

  return await params.supabase
    .from("post_call_webhooks")
    .upsert(fallbackRow, { onConflict: "dedupe_key" })
    .select("id, created_order_id")
    .single()
}

async function processQueuedPayload(params: {
  supabase: ReturnType<typeof createClient>
  queueId: string
  body: Record<string, unknown>
}) {
  const body = params.body
  const payload = getObject(body.data) || body
  const conversationId = normalizeString(payload.conversation_id) || normalizeString(body.conversation_id)
  const incomingEventType = normalizeString(body.type) || normalizeString(payload.event_type) || "post_call"

  if (!conversationId) {
    return {
      ok: true,
      ignored: true,
      reason: "missing_conversation_id",
      eventType: incomingEventType,
    }
  }

  const existing = await loadLatestConversationWebhook({
    supabase: params.supabase,
    provider: PROVIDER,
    conversationId,
  })

  const agentId =
    normalizeString(payload.agent_id) || normalizeString(body.agent_id) || normalizeString(existing?.agent_id)

  let linkedAgent: { restaurant_id?: string | null } | null = null
  if (agentId) {
    const { data: linkResult } = await params.supabase
      .from("voice_agent_links")
      .select("restaurant_id")
      .eq("workspace_agent_id", agentId)
      .maybeSingle()

    linkedAgent = linkResult || null
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

  const { data: linkedOrder } = await params.supabase
    .from("restaurant_orders")
    .select("id, restaurant_id")
    .eq("source_provider", PROVIDER)
    .eq("source_conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  let restaurantId =
    normalizeString(existing?.restaurant_id) || normalizeString(linkedOrder?.restaurant_id) || normalizeString(linkedAgent?.restaurant_id)

  if (!restaurantId) {
    return {
      ok: true,
      ignored: true,
      reason: agentId ? "agent_not_linked" : "missing_agent_id",
      agentId: agentId || null,
      conversationId,
      eventType,
    }
  }

  const uploadedAudio =
    fullAudioBase64.length > 0
      ? await uploadConversationAudio({
          supabase: params.supabase,
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
      supabase: params.supabase,
      provider: PROVIDER,
      conversationId,
    })
  } catch (error) {
    console.error("[process-webhook-ingest-queue] Failed to reload latest row:", error)
  }

  const latestPayload = getObject(latestExisting?.webhook_payload) || {}
  const latestNormalizedMetadata = getObject(latestPayload.normalized_metadata)
  const latestPayloadData = getObject(latestPayload.data)
  const finalTranscriptText = incomingTranscriptText || normalizeString(latestExisting?.transcript_text) || null
  const finalAnalysis = incomingAnalysis || getObject(latestExisting?.analysis) || null
  const finalAnalysisStatus = incomingAnalysis ? "completed" : normalizeString(latestExisting?.analysis_status) || "processing"
  const finalRecordingUrl =
    incomingRecordingUrl ||
    extractRecordingUrl(latestPayload, latestNormalizedMetadata, latestPayloadData) ||
    null
  const finalDuration = incomingDuration ?? latestNormalizedMetadata?.call_duration_secs ?? null
  const finalCreatedOrderId = normalizeString(latestExisting?.created_order_id) || normalizeString(linkedOrder?.id) || null
  const mergedWebhookPayload = mergeObjects(latestPayload, body)
  const mergedWebhookPayloadData = mergeObjects(latestPayloadData, incomingBodyData)
  const mergedWebhookNormalizedMetadata = mergeObjects(latestNormalizedMetadata, bodyNormalizedMetadata)
  const recordingStorageBucket = uploadedAudio?.path
    ? AUDIO_BUCKET
    : normalizeString(latestExisting?.recording_storage_bucket) ||
      normalizeString(latestNormalizedMetadata?.recording_storage_bucket) ||
      null
  const recordingStoragePath = uploadedAudio?.path
    ? uploadedAudio.path
    : normalizeString(latestExisting?.recording_storage_path) ||
      normalizeString(latestNormalizedMetadata?.recording_storage_path) ||
      null
  const existingRecordingSizeBytes = normalizePositiveInteger(latestExisting?.recording_size_bytes, 0)
  const metadataRecordingSizeBytes = normalizePositiveInteger(latestNormalizedMetadata?.recording_size_bytes, 0)
  const recordingSizeBytes = uploadedAudio?.sizeBytes ?? (existingRecordingSizeBytes || metadataRecordingSizeBytes || 0)

  mergedWebhookPayload.data = mergedWebhookPayloadData
  mergedWebhookPayload.normalized_metadata = {
    ...mergedWebhookNormalizedMetadata,
    recording_url: finalRecordingUrl,
    recording_storage_bucket: recordingStorageBucket,
    recording_storage_path: recordingStoragePath,
    recording_size_bytes: recordingSizeBytes > 0 ? recordingSizeBytes : null,
    audio_upload_error: uploadedAudio?.error || null,
    call_duration_secs: finalDuration,
    event_id: eventId,
    event_type: eventType,
    merged_at: new Date().toISOString(),
    queue_id: params.queueId,
  }

  const saveResult = await upsertConversationWebhook({
    supabase: params.supabase,
    row: {
      provider: PROVIDER,
      dedupe_key: dedupeKey,
      event_id: eventId,
      event_type: eventType,
      conversation_id: conversationId,
      agent_id: agentId || null,
      restaurant_id: restaurantId,
      webhook_payload: mergedWebhookPayload,
      transcript_text: finalTranscriptText,
      analysis: finalAnalysis,
      analysis_status: finalAnalysisStatus,
      analysis_error: latestExisting?.analysis_error || null,
      extracted_order: latestExisting?.extracted_order || null,
      created_order_id: finalCreatedOrderId,
      recording_storage_bucket: recordingStorageBucket,
      recording_storage_path: recordingStoragePath,
      recording_size_bytes: recordingSizeBytes > 0 ? recordingSizeBytes : null,
    },
  })

  if (saveResult.error) {
    throw new Error(saveResult.error.message)
  }

  return {
    ok: true,
    ignored: false,
    webhookId: saveResult.data?.id || null,
    linkedOrderId: saveResult.data?.created_order_id || finalCreatedOrderId,
    restaurantId,
    conversationId,
    agentId: agentId || null,
    eventType,
  }
}

function isWorkerAuthorized(request: Request) {
  const expectedSecret = normalizeString(Deno.env.get("WEBHOOK_WORKER_SECRET"))
  if (!expectedSecret) {
    return true
  }

  const providedSecret =
    normalizeString(request.headers.get("x-worker-secret")) ||
    normalizeString(request.headers.get("authorization")).replace(/^bearer\s+/i, "")

  return Boolean(providedSecret) && providedSecret === expectedSecret
}

serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed. Use POST." })
  }

  if (!isWorkerAuthorized(request)) {
    return jsonResponse(401, { error: "Unauthorized worker request." })
  }

  const supabaseUrl = normalizeString(Deno.env.get("SUPABASE_URL"))
  const supabaseServiceRoleKey = normalizeString(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return jsonResponse(500, { error: "Supabase service configuration is missing." })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const body = await request.json().catch(() => ({}))
  const bodyObj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const batchLimit = Math.min(Math.max(normalizePositiveInteger(bodyObj.limit, 10), 1), 25)

  const pendingRowsResult = await supabase
    .from("webhook_ingest_queue")
    .select("id, payload, attempt_count, idempotency_key, received_at")
    .eq("status", "pending")
    .order("received_at", { ascending: true })
    .limit(batchLimit)

  if (pendingRowsResult.error) {
    return jsonResponse(500, { error: pendingRowsResult.error.message })
  }

  const pendingRows = pendingRowsResult.data || []
  if (pendingRows.length === 0) {
    return jsonResponse(200, { ok: true, claimed: 0, processed: 0, failed: 0, ignored: 0 })
  }

  let claimedCount = 0
  let processedCount = 0
  let failedCount = 0
  let ignoredCount = 0
  const failures: Array<Record<string, unknown>> = []

  for (const row of pendingRows) {
    const attemptCount = normalizePositiveInteger(row.attempt_count, 0) + 1
    const claimedRowResult = await supabase
      .from("webhook_ingest_queue")
      .update({
        status: "processing",
        last_attempt_at: new Date().toISOString(),
        attempt_count: attemptCount,
        error_message: null,
      })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id, payload, attempt_count, idempotency_key")
      .maybeSingle()

    if (claimedRowResult.error) {
      failedCount += 1
      failures.push({
        queue_id: row.id,
        error: claimedRowResult.error.message,
      })
      continue
    }

    if (!claimedRowResult.data?.id) {
      continue
    }

    claimedCount += 1

    try {
      const payload = getObject(claimedRowResult.data.payload)
      if (!payload) {
        throw new Error("Queue payload is missing or invalid.")
      }

      const processed = await processQueuedPayload({
        supabase,
        queueId: String(claimedRowResult.data.id),
        body: payload,
      })

      await supabase
        .from("webhook_ingest_queue")
        .update({
          status: "done",
          processed_at: new Date().toISOString(),
          error_message: processed.ignored ? normalizeString(processed.reason) || null : null,
        })
        .eq("id", claimedRowResult.data.id)

      processedCount += 1
      if (processed.ignored) {
        ignoredCount += 1
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown webhook processing error."
      const shouldRetry = attemptCount < 3

      await supabase
        .from("webhook_ingest_queue")
        .update({
          status: shouldRetry ? "pending" : "failed",
          error_message: errorMessage,
          processed_at: shouldRetry ? null : new Date().toISOString(),
        })
        .eq("id", claimedRowResult.data.id)

      failedCount += 1
      failures.push({
        queue_id: claimedRowResult.data.id,
        retrying: shouldRetry,
        error: errorMessage,
      })
    }
  }

  return jsonResponse(200, {
    ok: true,
    claimed: claimedCount,
    processed: processedCount,
    failed: failedCount,
    ignored: ignoredCount,
    failures,
  })
})
