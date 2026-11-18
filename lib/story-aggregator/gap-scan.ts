import type { TelegramMessage, GroupedMessage } from "./album-grouper"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GAP_SCAN_LIMIT = 100
export const GAP_SCAN_MAX_INGEST = 20
// Only ingest messages posted after this date (Unix seconds)
export const GAP_SCAN_CUTOFF_TS = Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 1000)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MediaResult {
  url: string | null
}

export interface GapScanDeps {
  getMessages: (limit: number) => Promise<TelegramMessage[]>
  findExistingExternalIds: (externalIds: string[]) => Promise<Set<string>>
  downloadMedia: (messages: TelegramMessage[], channelUsername: string) => Promise<MediaResult[]>
  resolveTelegramPostUrls: (messages: TelegramMessage[]) => Promise<(string | null)[]>
  ingestMessage: (grouped: GroupedMessage, userId: string, channelId: string) => Promise<string | null>
}

export interface GapScanResult {
  found: number
  ingested: number
  capped: boolean
}

// ---------------------------------------------------------------------------
// groupByAlbum — pure synchronous grouping
// ---------------------------------------------------------------------------

export function groupByAlbum(
  messages: TelegramMessage[],
  mediaResults: MediaResult[],
  telegramPostUrls: (string | null)[]
): GroupedMessage[] {
  if (messages.length === 0) return []

  // Track insertion order via ordered group keys
  const groupOrder: string[] = []
  const groupedMap = new Map<
    string,
    { messages: TelegramMessage[]; indices: number[] }
  >()

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    // Standalone messages use a unique key so they each get their own group
    const key = msg.groupedId !== null ? `group:${msg.groupedId}` : `standalone:${i}`

    if (!groupedMap.has(key)) {
      groupOrder.push(key)
      groupedMap.set(key, { messages: [], indices: [] })
    }
    const entry = groupedMap.get(key)!
    entry.messages.push(msg)
    entry.indices.push(i)
  }

  const result: GroupedMessage[] = []

  for (const key of groupOrder) {
    const entry = groupedMap.get(key)!
    const { messages: groupMsgs, indices } = entry

    const paired = groupMsgs.map((msg, i) => ({ msg, idx: indices[i] }))
    paired.sort((a, b) => a.msg.messageId - b.msg.messageId)
    const sorted = paired.map((p) => p.msg)
    const sortedIndices = paired.map((p) => p.idx)

    const primaryMessageId = sorted[0].messageId
    const messageIds = sorted.map((m) => m.messageId)
    const text = sorted.find((m) => m.text !== null)?.text ?? null
    const date = sorted[0].date
    const groupedId = sorted[0].groupedId

    // Collect media URLs for this group (using sortedIndices)
    const mediaUrls: string[] = []
    for (const idx of sortedIndices) {
      const url = mediaResults[idx]?.url
      if (url !== null && url !== undefined) {
        mediaUrls.push(url)
      }
    }

    // Telegram post URL: first non-null from sorted messages using sortedIndices
    let telegramPostUrl: string | null = null
    for (const idx of sortedIndices) {
      const url = telegramPostUrls[idx]
      if (url !== null && url !== undefined) {
        telegramPostUrl = url
        break
      }
    }

    result.push({
      messageIds,
      primaryMessageId,
      text,
      mediaUrls,
      groupedId,
      date,
      telegramPostUrl,
    })
  }

  return result
}

// ---------------------------------------------------------------------------
// runGapScan — main entry point
// ---------------------------------------------------------------------------

export async function runGapScan(
  channelId: string,
  channelUsername: string,
  userId: string,
  deps: GapScanDeps,
  state?: { isReconnecting: boolean; gramjsClient: unknown | null }
): Promise<GapScanResult> {
  // Early exit when reconnecting or client unavailable
  if (state?.isReconnecting || state?.gramjsClient === null) {
    return { found: 0, ingested: 0, capped: false }
  }

  try {
    const messages = await deps.getMessages(GAP_SCAN_LIMIT)

    if (messages.length === 0) {
      return { found: 0, ingested: 0, capped: false }
    }

    // Build external IDs for all fetched messages
    const externalIds = messages.map((m) => `${channelId}:${m.messageId}`)
    const existingSet = await deps.findExistingExternalIds(externalIds)

    // Filter to only missing messages that are newer than the cutoff date
    const missingMessages = messages.filter(
      (m) => !existingSet.has(`${channelId}:${m.messageId}`) && m.date >= GAP_SCAN_CUTOFF_TS
    )

    if (missingMessages.length === 0) {
      console.log("[GapScan] No gaps detected")
      return { found: 0, ingested: 0, capped: false }
    }

    console.log(`[GapScan] Found ${missingMessages.length} missing messages`)

    // Apply cap
    const capped = missingMessages.length > GAP_SCAN_MAX_INGEST
    if (capped) {
      console.log(`[GapScan] Capping ingestion at max limit of ${GAP_SCAN_MAX_INGEST} messages`)
    }
    const toIngest = capped ? missingMessages.slice(0, GAP_SCAN_MAX_INGEST) : missingMessages

    // Download media and resolve URLs only for missing messages
    const [mediaResults, telegramPostUrls] = await Promise.all([
      deps.downloadMedia(toIngest, channelUsername),
      deps.resolveTelegramPostUrls(toIngest),
    ])

    // Group by album
    const grouped = groupByAlbum(toIngest, mediaResults, telegramPostUrls)

    // Ingest each group
    let ingested = 0
    for (const group of grouped) {
      try {
        await deps.ingestMessage(group, userId, channelId)
        ingested++
      } catch (err: unknown) {
        // Unique constraint violation = dedup hit, not an error
        if (typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002") {
          // Silently skip — already ingested
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.warn(`[GapScan] Ingest failed for group ${group.primaryMessageId}: ${errMsg}`)
        }
      }
    }

    console.log(`[GapScan] Ingested ${ingested} items from ${missingMessages.length} found gaps`)

    return { found: missingMessages.length, ingested, capped }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[GapScan] Error during gap scan: ${message}`)
    return { found: 0, ingested: 0, capped: false }
  }
}
