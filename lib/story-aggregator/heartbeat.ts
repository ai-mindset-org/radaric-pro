/**
 * Heartbeat Monitor for Story Aggregator
 * Spec: the Story Aggregator specification, section 2.5 requirement 6
 *
 * - Daily summary via Telegram: "Processed X items, Y stories, Z errors"
 * - Immediate alert on critical errors (GramJS disconnect, DB unreachable)
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface HeartbeatStats {
  processedItems: number
  storiesCreated: number
  errorsCount: number
  pendingItems: number
}

export interface HeartbeatDeps {
  db: {
    inboxItem: {
      count: (args: { where: { status: string } }) => Promise<number>
    }
    story: {
      count: () => Promise<number>
    }
  }
  sendMessage: (message: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// getHeartbeatStats
// ---------------------------------------------------------------------------

/**
 * Query DB for current counts of processed items, stories, errors, and pending items.
 */
export async function getHeartbeatStats(
  db: HeartbeatDeps["db"]
): Promise<HeartbeatStats> {
  const [processedItems, storiesCreated, errorsCount, pendingItems] =
    await Promise.all([
      db.inboxItem.count({ where: { status: "PROCESSED" } }),
      db.story.count(),
      db.inboxItem.count({ where: { status: "ERROR" } }),
      db.inboxItem.count({ where: { status: "PENDING" } }),
    ])

  return { processedItems, storiesCreated, errorsCount, pendingItems }
}

// ---------------------------------------------------------------------------
// formatDailySummary
// ---------------------------------------------------------------------------

/**
 * Format a human-readable daily summary message for Telegram.
 */
export function formatDailySummary(stats: HeartbeatStats): string {
  const now = new Date()
  const timestamp = now.toISOString().replace("T", " ").slice(0, 16)

  return [
    `Story Aggregator — Daily Report`,
    `${timestamp}`,
    ``,
    `Processed items: ${stats.processedItems}`,
    `Stories created: ${stats.storiesCreated}`,
    `Errors: ${stats.errorsCount}`,
    `Pending: ${stats.pendingItems}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// formatErrorAlert
// ---------------------------------------------------------------------------

/**
 * Format an immediate critical error alert message for Telegram.
 */
export function formatErrorAlert(errorType: string, details: string): string {
  return [
    `ALERT: Critical Error`,
    ``,
    `Error: ${errorType}`,
    `Details: ${details}`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// HeartbeatMonitor class
// ---------------------------------------------------------------------------

/**
 * Periodic heartbeat monitor that sends daily summaries and immediate alerts.
 */
export class HeartbeatMonitor {
  private readonly intervalMs: number
  private readonly deps: HeartbeatDeps
  private timerId: ReturnType<typeof setInterval> | null = null
  private _isRunning = false

  constructor(intervalMs: number, deps: HeartbeatDeps) {
    this.intervalMs = intervalMs
    this.deps = deps
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  start(): void {
    if (this._isRunning) return

    this._isRunning = true
    this.timerId = setInterval(() => {
      this.sendDailySummary().catch((err) => {
        console.error("[HeartbeatMonitor] Error sending daily summary:", err)
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

  async sendDailySummary(): Promise<void> {
    const stats = await getHeartbeatStats(this.deps.db)
    const message = formatDailySummary(stats)
    await this.deps.sendMessage(message)
  }

  async sendAlert(errorType: string, details: string): Promise<void> {
    const message = formatErrorAlert(errorType, details)
    await this.deps.sendMessage(message)
  }
}
