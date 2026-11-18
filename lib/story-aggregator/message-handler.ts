/**
 * Message Handler for Story Aggregator
 * Converts raw Telegram messages into InboxItems and triggers the pipeline.
 * Pure functions with dependency injection for testability.
 *
 * Exported functions:
 *   parseMessageToInboxData(msg, channelId, userId) — extract fields from a raw TG message
 *   ingestMessage(msg, channelId, userId, deps) — create InboxItem in DB, trigger pipeline
 *   catchUpMessages(channelId, userId, lastMessageId, deps) — catch-up on startup
 *
 * Spec: the Story Aggregator specification, sections 4.1, 2.5
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawTelegramMessage {
  id: number
  message: string
  entities?: Array<{
    className: string
    offset: number
    length: number
    url?: string
  }>
  media: {
    photoUrl?: string
    webpageUrl?: string
  } | null
  groupedId: string | null
  fwdFrom: {
    fromId?: { channelId?: string }
    channelName?: string
  } | null
  peerId: { channelId?: string } | null
  date: number
}

export interface InboxItemCreateData {
  userId: string
  externalId: string
  messageId: number
  rawText: string
  extractedUrl: string | null
  mediaUrls: string[]
  sourceChannel: string | null
  forwardedFromId: string | null
  status: string
}

export interface MessageHandlerDeps {
  db: {
    inboxItem: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>
      findFirst: (args: { where: Record<string, unknown> }) => Promise<{ id: string } | null>
    }
    userSettings: {
      findUnique: (args: { where: { userId: string } }) => Promise<Record<string, unknown> | null>
      update: (args: { where: { userId: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
  }
  processItem: (itemId: string) => Promise<unknown>
  getChannelMessages: (channelId: string, afterId: number, limit: number) => Promise<RawTelegramMessage[]>
}

interface IngestResult {
  id: string
  duplicate: boolean
}

interface CatchUpResult {
  processed: number
  errors: number
}

// ---------------------------------------------------------------------------
// URL extraction helpers
// ---------------------------------------------------------------------------

const URL_REGEX = /https?:\/\/[^\s)>\]"']+/

function extractUrlFromText(text: string): string | null {
  const match = text.match(URL_REGEX)
  return match ? match[0] : null
}

function extractUrlFromEntities(
  message: string,
  entities?: RawTelegramMessage["entities"]
): string | null {
  if (!entities || entities.length === 0) return null

  for (const entity of entities) {
    if (entity.className === "MessageEntityTextUrl" && entity.url) {
      return entity.url
    }
    if (entity.className === "MessageEntityUrl") {
      return message.slice(entity.offset, entity.offset + entity.length)
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// parseMessageToInboxData
// ---------------------------------------------------------------------------

/**
 * Extract InboxItem fields from a raw Telegram message.
 * Pure function — no side effects.
 */
export function parseMessageToInboxData(
  msg: RawTelegramMessage,
  channelId: string,
  userId: string
): InboxItemCreateData {
  const externalId = `${channelId}:${msg.id}`

  // Extract URL: try entities first, then media webpage, then text regex
  const extractedUrl =
    extractUrlFromEntities(msg.message, msg.entities) ??
    msg.media?.webpageUrl ??
    extractUrlFromText(msg.message) ??
    null

  // Extract media URLs
  const mediaUrls: string[] = []
  if (msg.media?.photoUrl) {
    mediaUrls.push(msg.media.photoUrl)
  }

  // Extract forwarded info
  const sourceChannel = msg.fwdFrom?.channelName ?? null
  const forwardedFromId = msg.fwdFrom?.fromId?.channelId ?? null

  return {
    userId,
    externalId,
    messageId: msg.id,
    rawText: msg.message,
    extractedUrl,
    mediaUrls,
    sourceChannel,
    forwardedFromId,
    status: "PENDING",
  }
}

// ---------------------------------------------------------------------------
// ingestMessage
// ---------------------------------------------------------------------------

/**
 * Create an InboxItem in the database from a raw TG message.
 * Checks for duplicates (same externalId). If duplicate, returns existing ID.
 * Otherwise creates new item, updates lastMessageId, and triggers pipeline.
 */
export async function ingestMessage(
  msg: RawTelegramMessage,
  channelId: string,
  userId: string,
  deps: MessageHandlerDeps
): Promise<IngestResult> {
  const data = parseMessageToInboxData(msg, channelId, userId)

  // Check for duplicate
  const existing = await deps.db.inboxItem.findFirst({
    where: { externalId: data.externalId },
  })

  if (existing) {
    return { id: existing.id, duplicate: true }
  }

  // Create new item
  const created = await deps.db.inboxItem.create({ data: data as unknown as Record<string, unknown> })

  // Update last message ID
  await deps.db.userSettings.update({
    where: { userId },
    data: { storyLastMessageId: msg.id },
  })

  // Trigger pipeline
  await deps.processItem(created.id)

  return { id: created.id, duplicate: false }
}

// ---------------------------------------------------------------------------
// catchUpMessages
// ---------------------------------------------------------------------------

const CATCH_UP_LIMIT = 200

/**
 * Fetch messages from the channel after lastMessageId and process each.
 * Continues processing even if individual messages fail.
 * Updates lastMessageId to the highest successfully processed message ID.
 */
export async function catchUpMessages(
  channelId: string,
  userId: string,
  lastMessageId: number,
  deps: MessageHandlerDeps
): Promise<CatchUpResult> {
  const messages = await deps.getChannelMessages(channelId, lastMessageId, CATCH_UP_LIMIT)

  if (messages.length === 0) {
    return { processed: 0, errors: 0 }
  }

  let processed = 0
  let errors = 0
  let maxMessageId = lastMessageId

  for (const msg of messages) {
    try {
      const data = parseMessageToInboxData(msg, channelId, userId)

      // Check for duplicate
      const existing = await deps.db.inboxItem.findFirst({
        where: { externalId: data.externalId },
      })

      if (!existing) {
        const created = await deps.db.inboxItem.create({ data: data as unknown as Record<string, unknown> })
        await deps.processItem(created.id)
      }

      processed++

      if (msg.id > maxMessageId) {
        maxMessageId = msg.id
      }
    } catch {
      errors++
    }
  }

  // Update lastMessageId to the highest seen
  if (maxMessageId > lastMessageId) {
    await deps.db.userSettings.update({
      where: { userId },
      data: { storyLastMessageId: maxMessageId },
    })
  }

  return { processed, errors }
}
