/**
 * Telegram Message Deleter for Story Aggregator
 * Handles auto-deletion of Telegram inbox messages after successful Notion save.
 *
 * Safety invariant: NEVER delete a message unless Notion save is 100% confirmed.
 * A failed or partial pipeline must leave the message untouched.
 *
 * Exported functions (all with injectable deps for testability):
 *   shouldDeleteTelegramMessages(item) — pure guard function
 *   deleteTelegramMessages(messageIds, deps) — GramJS wrapper, never throws
 *   maybeDeleteTelegramMessage(itemId, deps) — full orchestration
 *   sweepUndeletedTelegramMessages(deps) — retry sweep for PROCESSED items
 *     whose post-save deletion failed (last 7 days, 20 per run)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboxItemForDeletion {
  id: string
  messageId: number
  externalId: string
  allMessageIds: number[]
  status: string
  telegramDeletedAt: Date | null
  storyId?: string | null
}

export interface DeleteDeps {
  db: {
    inboxItem: {
      findUnique: (args: { where: { id: string } }) => Promise<InboxItemForDeletion | null>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
  }
  gramjsClient: GramJSClient | null
  channelId: string
  autoDeleteEnabled: boolean
}

export interface SweepDeps {
  db: {
    inboxItem: {
      findMany: (args: {
        where: {
          userId: string
          externalId: { startsWith: string }
          messageId: { not: number }
          allMessageIds: { isEmpty: boolean }
          status: "PROCESSED"
          telegramDeletedAt: null
          story: { notionPageId: { not: null } }
          createdAt: { gte: Date }
        }
        take: number
        orderBy: { createdAt: "asc" }
      }) => Promise<InboxItemForDeletion[]>
      findUnique?: (args: { where: { id: string } }) => Promise<InboxItemForDeletion | null>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
  }
  gramjsClient: GramJSClient | null
  channelId: string
  userId: string
  autoDeleteEnabled: boolean
  now?: () => Date
  /** Checked before the query and before every item; true stops the sweep (client teardown). */
  shouldAbort?: () => boolean
}

export interface GramJSClient {
  getEntity: (id: bigint) => Promise<unknown>
  deleteMessages: (entity: unknown, ids: number[], options: { revoke: boolean }) => Promise<unknown>
}

// ---------------------------------------------------------------------------
// shouldDeleteTelegramMessages — pure guard
// ---------------------------------------------------------------------------

/**
 * Determine whether an item is eligible for Telegram message deletion.
 * Returns false for any condition that should prevent deletion.
 */
export function shouldDeleteTelegramMessages(item: InboxItemForDeletion): boolean {
  // Already deleted — idempotency guard
  if (item.telegramDeletedAt !== null) return false

  // Send to Stories items have messageId 0
  if (item.messageId === 0) return false

  // Web UI items have "material:" prefix
  if (item.externalId.startsWith("material:")) return false

  // Legacy items without backfill have empty allMessageIds
  if (item.allMessageIds.length === 0) return false

  return true
}

// ---------------------------------------------------------------------------
// deleteTelegramMessages — GramJS wrapper
// ---------------------------------------------------------------------------

const DELETE_BATCH_SIZE = 100

/**
 * Delete messages from a Telegram channel via GramJS.
 * Batches per 100 (Telegram API limit). Returns true on success, false on failure.
 * Never throws — all errors are caught and logged.
 */
export async function deleteTelegramMessages(
  messageIds: number[],
  deps: { gramjsClient: GramJSClient; channelId: string }
): Promise<boolean> {
  if (messageIds.length === 0) return true

  if (messageIds.length > 1000) {
    console.warn(`[TelegramDeleter] Suspiciously large messageIds array (${messageIds.length}), skipping`)
    return false
  }

  try {
    const entity = await deps.gramjsClient.getEntity(BigInt(deps.channelId))

    for (let i = 0; i < messageIds.length; i += DELETE_BATCH_SIZE) {
      const batch = messageIds.slice(i, i + DELETE_BATCH_SIZE)
      await deps.gramjsClient.deleteMessages(entity, batch, { revoke: true })
    }

    console.log(`[TelegramDeleter] Deleted ${messageIds.length} message(s) from channel ${deps.channelId}`)
    return true
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`[TelegramDeleter] Failed to delete messages: ${msg}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// maybeDeleteTelegramMessage — full orchestration
// ---------------------------------------------------------------------------

/**
 * Attempt to delete the Telegram source message(s) for a processed inbox item.
 * Only deletes when ALL conditions are met:
 * - autoDeleteEnabled is true
 * - gramjsClient is available
 * - channelId is non-empty
 * - item status is PROCESSED
 * - shouldDeleteTelegramMessages guards pass
 *
 * On success: sets telegramDeletedAt timestamp.
 * On failure: logs warning, does NOT change item status.
 * Never throws.
 */
export async function maybeDeleteTelegramMessage(
  itemId: string,
  deps: DeleteDeps
): Promise<void> {
  try {
    // Guard: feature toggle
    if (!deps.autoDeleteEnabled) return

    // Guard: GramJS client available
    if (!deps.gramjsClient) {
      console.warn("[TelegramDeleter] GramJS client not available, skipping deletion")
      return
    }

    // Guard: channel ID present
    if (!deps.channelId) return

    // Fetch fresh item state
    const item = await deps.db.inboxItem.findUnique({ where: { id: itemId } })
    if (!item) return

    // Guard: only delete PROCESSED items
    if (item.status !== "PROCESSED") return

    // Guard: pure function checks
    if (!shouldDeleteTelegramMessages(item)) return

    // Attempt deletion
    const deleted = await deleteTelegramMessages(item.allMessageIds, {
      gramjsClient: deps.gramjsClient,
      channelId: deps.channelId,
    })

    // Only set audit timestamp on confirmed deletion
    if (deleted) {
      await deps.db.inboxItem.update({
        where: { id: itemId },
        data: { telegramDeletedAt: new Date() },
      })
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`[TelegramDeleter] Error in maybeDeleteTelegramMessage for ${itemId}: ${msg}`)
  }
}

// ---------------------------------------------------------------------------
// sweepUndeletedTelegramMessages — retry sweep
// ---------------------------------------------------------------------------

const SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_BATCH_SIZE = 20

/**
 * Re-attempt deletion for PROCESSED items with a confirmed Notion save whose
 * single post-save deletion attempt failed (telegramDeletedAt still null).
 * Bounded to items created in the last 7 days, 20 per run, oldest first, and
 * to items whose externalId belongs to the configured channel.
 * When findUnique is provided, each item is re-read right before deletion and
 * skipped if it changed since the batch was read.
 * Returns the number of items deleted. Never throws.
 */
export async function sweepUndeletedTelegramMessages(deps: SweepDeps): Promise<number> {
  if (!deps.autoDeleteEnabled) return 0
  if (!deps.gramjsClient) return 0
  if (!deps.channelId) return 0

  const gramjsClient = deps.gramjsClient
  const now = deps.now ? deps.now() : new Date()
  const channelPrefix = `${deps.channelId}:`

  if (deps.shouldAbort?.()) return 0

  let items: InboxItemForDeletion[]
  try {
    items = await deps.db.inboxItem.findMany({
      where: {
        userId: deps.userId,
        externalId: { startsWith: channelPrefix },
        messageId: { not: 0 },
        allMessageIds: { isEmpty: false },
        status: "PROCESSED",
        telegramDeletedAt: null,
        story: { notionPageId: { not: null } },
        createdAt: { gte: new Date(now.getTime() - SWEEP_WINDOW_MS) },
      },
      take: SWEEP_BATCH_SIZE,
      orderBy: { createdAt: "asc" },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn(`[TelegramDeleter] Sweep query failed: ${msg}`)
    return 0
  }

  let deletedCount = 0
  for (const item of items) {
    if (deps.shouldAbort?.()) break
    if (!item.externalId.startsWith(channelPrefix)) continue
    if (!shouldDeleteTelegramMessages(item)) continue

    let messageIds = item.allMessageIds
    if (deps.db.inboxItem.findUnique) {
      let fresh: InboxItemForDeletion | null
      try {
        fresh = await deps.db.inboxItem.findUnique({ where: { id: item.id } })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.warn(`[TelegramDeleter] Sweep: re-read failed for ${item.id}, skipping: ${msg}`)
        continue
      }
      if (!fresh) continue
      if (fresh.status !== "PROCESSED") continue
      if (!shouldDeleteTelegramMessages(fresh)) continue
      if (fresh.storyId == null) continue
      if (item.storyId !== undefined && fresh.storyId !== item.storyId) continue
      messageIds = fresh.allMessageIds
    }

    const deleted = await deleteTelegramMessages(messageIds, {
      gramjsClient,
      channelId: deps.channelId,
    })
    if (!deleted) continue

    try {
      await deps.db.inboxItem.update({
        where: { id: item.id },
        data: { telegramDeletedAt: new Date() },
      })
      deletedCount++
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[TelegramDeleter] Sweep: deleted messages for ${item.id} but failed to stamp telegramDeletedAt: ${msg}`)
    }
  }

  if (deletedCount > 0) {
    console.log(`[TelegramDeleter] Sweep: deleted ${deletedCount} leftover item(s)`)
  }
  return deletedCount
}
