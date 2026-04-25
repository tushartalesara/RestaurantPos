import AsyncStorage from "@react-native-async-storage/async-storage"
import * as FileSystem from "expo-file-system/legacy"
import * as Crypto from "expo-crypto"
import type { BillingConfig, MenuItemDraft, RestaurantOrderRecord, RestaurantRecord, VoiceAgentLinkRecord } from "../types"

const RESTAURANTS_CACHE_KEY = "offline-cache:restaurants"
const RESTAURANT_SNAPSHOT_KEY_PREFIX = "offline-cache:restaurant:"
const AUDIO_INDEX_KEY = "offline-cache:audio-index"
const AUDIO_CACHE_FILE_LIMIT = 6
const AUDIO_CACHE_DIRECTORY =
  (FileSystem.documentDirectory || FileSystem.cacheDirectory || "").replace(/\/?$/, "/") + "offline-call-review/"

type AudioCacheIndexEntry = {
  cacheKey: string
  sourceUrl: string
  fileUri: string
  updatedAt: string
}

export type RestaurantOfflineSnapshot = {
  restaurantId: string
  savedAt: string
  menuItems: MenuItemDraft[]
  orders: RestaurantOrderRecord[]
  voiceAgentLink: VoiceAgentLinkRecord | null
  billingConfig: BillingConfig | null
}

function getRestaurantSnapshotKey(restaurantId: string) {
  return `${RESTAURANT_SNAPSHOT_KEY_PREFIX}${restaurantId}`
}

function normalizeErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

async function readJsonValue<T>(storageKey: string): Promise<T | null> {
  try {
    const rawValue = await AsyncStorage.getItem(storageKey)
    if (!rawValue) {
      return null
    }
    return JSON.parse(rawValue) as T
  } catch {
    return null
  }
}

async function writeJsonValue(storageKey: string, value: unknown) {
  await AsyncStorage.setItem(storageKey, JSON.stringify(value))
}

async function loadAudioCacheIndex(): Promise<AudioCacheIndexEntry[]> {
  const rawEntries = ((await readJsonValue<Record<string, unknown>[]>(AUDIO_INDEX_KEY)) || []).map((entry) => ({
    cacheKey:
      typeof entry.cacheKey === "string"
        ? entry.cacheKey
        : typeof entry.url === "string"
          ? entry.url
          : "",
    sourceUrl:
      typeof entry.sourceUrl === "string"
        ? entry.sourceUrl
        : typeof entry.url === "string"
          ? entry.url
          : "",
    fileUri: typeof entry.fileUri === "string" ? entry.fileUri : "",
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
  }))

  return rawEntries.filter((entry) => entry.cacheKey.trim().length > 0 && entry.fileUri.trim().length > 0)
}

async function saveAudioCacheIndex(entries: AudioCacheIndexEntry[]) {
  await writeJsonValue(AUDIO_INDEX_KEY, entries)
}

async function ensureAudioCacheDirectory() {
  if (!AUDIO_CACHE_DIRECTORY) {
    throw new Error("Local file storage is not available on this device.")
  }

  const existing = await FileSystem.getInfoAsync(AUDIO_CACHE_DIRECTORY)
  if (!existing.exists) {
    await FileSystem.makeDirectoryAsync(AUDIO_CACHE_DIRECTORY, { intermediates: true })
  }
}

function guessAudioExtension(recordingUrl: string) {
  const sanitizedUrl = recordingUrl.split("?")[0].toLowerCase()
  if (sanitizedUrl.endsWith(".wav")) return ".wav"
  if (sanitizedUrl.endsWith(".webm")) return ".webm"
  if (sanitizedUrl.endsWith(".m4a")) return ".m4a"
  if (sanitizedUrl.endsWith(".aac")) return ".aac"
  return ".mp3"
}

async function pruneAudioCache(indexEntries: AudioCacheIndexEntry[]) {
  const sortedEntries = [...indexEntries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  const entriesToKeep = sortedEntries.slice(0, AUDIO_CACHE_FILE_LIMIT)
  const entriesToRemove = sortedEntries.slice(AUDIO_CACHE_FILE_LIMIT)

  for (const entry of entriesToRemove) {
    try {
      await FileSystem.deleteAsync(entry.fileUri, { idempotent: true })
    } catch {}
  }

  await saveAudioCacheIndex(entriesToKeep)
}

export async function loadCachedRestaurants(): Promise<RestaurantRecord[]> {
  return (await readJsonValue<RestaurantRecord[]>(RESTAURANTS_CACHE_KEY)) || []
}

export async function saveCachedRestaurants(restaurants: RestaurantRecord[]) {
  await writeJsonValue(RESTAURANTS_CACHE_KEY, restaurants)
}

export async function loadCachedRestaurantSnapshot(restaurantId: string): Promise<RestaurantOfflineSnapshot | null> {
  return await readJsonValue<RestaurantOfflineSnapshot>(getRestaurantSnapshotKey(restaurantId))
}

export async function saveCachedRestaurantSnapshot(snapshot: RestaurantOfflineSnapshot) {
  await writeJsonValue(getRestaurantSnapshotKey(snapshot.restaurantId), snapshot)
}

export async function getCachedRecordingUri(recordingKey: string): Promise<string | null> {
  const normalizedKey = recordingKey.trim()
  if (!normalizedKey) {
    return null
  }

  const indexEntries = await loadAudioCacheIndex()
  const existingEntry = indexEntries.find((entry) => entry.cacheKey === normalizedKey)
  if (!existingEntry) {
    return null
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(existingEntry.fileUri)
    if (!fileInfo.exists) {
      await saveAudioCacheIndex(indexEntries.filter((entry) => entry.cacheKey !== normalizedKey))
      return null
    }
  } catch {
    return null
  }

  const touchedEntries = indexEntries.map((entry) =>
    entry.cacheKey === normalizedKey ? { ...entry, updatedAt: new Date().toISOString() } : entry,
  )
  await saveAudioCacheIndex(touchedEntries)

  return existingEntry.fileUri
}

export async function cacheRecordingAudio(recordingUrl: string, recordingKey?: string): Promise<string | null> {
  const normalizedUrl = recordingUrl.trim()
  const normalizedKey = (recordingKey || recordingUrl).trim()
  if (!normalizedUrl || !normalizedKey) {
    return null
  }

  const existingUri = await getCachedRecordingUri(normalizedKey)
  if (existingUri) {
    return existingUri
  }

  await ensureAudioCacheDirectory()

  const hashedName = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalizedUrl)
  const destinationUri = `${AUDIO_CACHE_DIRECTORY}${hashedName}${guessAudioExtension(normalizedUrl)}`

  try {
    const result = await FileSystem.downloadAsync(normalizedUrl, destinationUri)
    const nextEntry: AudioCacheIndexEntry = {
      cacheKey: normalizedKey,
      sourceUrl: normalizedUrl,
      fileUri: result.uri,
      updatedAt: new Date().toISOString(),
    }
    const existingEntries = await loadAudioCacheIndex()
    const dedupedEntries = [nextEntry, ...existingEntries.filter((entry) => entry.cacheKey !== normalizedKey)]
    await pruneAudioCache(dedupedEntries)
    return result.uri
  } catch (error) {
    try {
      await FileSystem.deleteAsync(destinationUri, { idempotent: true })
    } catch {}
    console.error("Failed to cache call recording:", normalizeErrorMessage(error, "Unknown audio cache error"))
    return null
  }
}
