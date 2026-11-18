/**
 * Retry Daemon for Story Aggregator
 * Retries ERROR items with retryCount < 3 every 15 minutes.
 * Spec: the Story Aggregator specification, section 4.2
 */

import { INBOX_CUTOFF_DATE } from "./stories-api"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DbInboxItem {
  findMany: (args: {
    where: { status: string; retryCount: { lt: number }; createdAt?: { gte: Date } }
    orderBy: { createdAt: "asc" }
  }) => Promise<InboxItemRecord[]>
  update: (args: {
    where: { id: string }
    data: Record<string, unknown>
  }) => Promise<unknown>
}

interface InboxItemRecord {
  id: string
  status: string
  retryCount: number
  createdAt: Date
  errorMessage: string | null
}

interface Db {
  inboxItem: DbInboxItem
}

type ProcessFn = (itemId: string) => Promise<void>

// ---------------------------------------------------------------------------
// getRetryableItems
// ---------------------------------------------------------------------------

/**
 * Query ERROR items with retryCount < 3, ordered by createdAt ASC (oldest first).
 */
export async function getRetryableItems(db: Db): Promise<InboxItemRecord[]> {
  return db.inboxItem.findMany({
    where: {
      status: "ERROR",
      retryCount: { lt: 3 },
      createdAt: { gte: INBOX_CUTOFF_DATE },
    },
    orderBy: { createdAt: "asc" },
  })
}

// ---------------------------------------------------------------------------
// retryItem
// ---------------------------------------------------------------------------

/**
 * Reset an item to PENDING, increment retryCount, and call processFn.
 * Returns true on success, false on failure (sets ERROR + errorMessage).
 */
export async function retryItem(
  itemId: string,
  processFn: ProcessFn,
  db: Db
): Promise<boolean> {
  // Reset to PENDING and increment retryCount
  await db.inboxItem.update({
    where: { id: itemId },
    data: {
      status: "PENDING",
    },
  })

  try {
    await processFn(itemId)
    return true
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error)

    await db.inboxItem.update({
      where: { id: itemId },
      data: {
        status: "ERROR",
        errorMessage,
      },
    })

    return false
  }
}

// ---------------------------------------------------------------------------
// RetryDaemon class
// ---------------------------------------------------------------------------

/**
 * Periodic retry daemon that processes ERROR items at a configurable interval.
 */
export class RetryDaemon {
  private readonly intervalMs: number
  private readonly processFn: ProcessFn
  private timerId: ReturnType<typeof setInterval> | null = null
  private _isRunning = false

  constructor(intervalMs: number, processFn: ProcessFn) {
    this.intervalMs = intervalMs
    this.processFn = processFn
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  start(db: Db): void {
    if (this._isRunning) return

    this._isRunning = true
    this.timerId = setInterval(() => {
      this.runOnce(db).catch((err) => {
        console.error("[RetryDaemon] Error during retry pass:", err)
      })
    }, this.intervalMs)
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId)
      this.timerId = null
    }
    this._isRunning = false
  }

  async runOnce(db: Db): Promise<void> {
    const items = await getRetryableItems(db)

    for (const item of items) {
      await retryItem(item.id, this.processFn, db)
    }
  }
}
