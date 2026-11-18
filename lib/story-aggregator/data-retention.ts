/**
 * Data Retention Policy for Story Aggregator
 * Per spec section 7 (Phase 4), line 748:
 *   - Clean extractedContent after 30 days for PROCESSED items
 *   - Archive items after 90 days for PROCESSED items
 *   - Never touch PENDING or ERROR items
 *   - Uses deps.now() for testable date calculations
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DataRetentionDeps {
  db: {
    inboxItem: {
      updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>
      count: (args: Record<string, unknown>) => Promise<number>
    }
  }
  now?: () => Date
}

export interface RetentionResult {
  contentCleaned: number
  itemsArchived: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// runRetention
// ---------------------------------------------------------------------------

/**
 * Run the full retention policy for a user:
 *   1. Clean extractedContent from PROCESSED items older than 30 days
 *   2. Archive PROCESSED items older than 90 days
 *
 * Both operations run in a single call. Uses deps.now() for date thresholds.
 * Returns { contentCleaned, itemsArchived }.
 */
export async function runRetention(
  userId: string,
  deps: DataRetentionDeps,
): Promise<RetentionResult> {
  const now = deps.now ? deps.now() : new Date()
  const thirtyDaysAgo = new Date(now.getTime() - THIRTY_DAYS_MS)
  const ninetyDaysAgo = new Date(now.getTime() - NINETY_DAYS_MS)

  // Content cleaning: set extractedContent to null for old PROCESSED items
  const cleanResult = await deps.db.inboxItem.updateMany({
    where: {
      userId,
      status: "PROCESSED",
      createdAt: { lt: thirtyDaysAgo },
    },
    data: {
      extractedContent: null,
    },
  })

  // Archiving: set status to ARCHIVED for very old PROCESSED items
  const archiveResult = await deps.db.inboxItem.updateMany({
    where: {
      userId,
      status: "PROCESSED",
      createdAt: { lt: ninetyDaysAgo },
    },
    data: {
      status: "ARCHIVED",
    },
  })

  return {
    contentCleaned: cleanResult.count,
    itemsArchived: archiveResult.count,
  }
}
