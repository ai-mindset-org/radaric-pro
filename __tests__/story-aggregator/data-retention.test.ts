/**
 * Data Retention Policy — spec section 7 (Phase 4), line 748
 *
 * Interface under test (lib/story-aggregator/data-retention.ts — does NOT exist yet):
 *
 *   export interface DataRetentionDeps {
 *     db: {
 *       inboxItem: {
 *         updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>
 *         count:      (args: Record<string, unknown>) => Promise<number>
 *       }
 *     }
 *     now?: () => Date  // defaults to () => new Date()
 *   }
 *
 *   export interface RetentionResult {
 *     contentCleaned: number
 *     itemsArchived:  number
 *   }
 *
 *   export async function runRetention(
 *     userId: string,
 *     deps:   DataRetentionDeps,
 *   ): Promise<RetentionResult>
 *
 * Per spec:
 *   - Clean extractedContent (set to null) for PROCESSED items older than 30 days.
 *   - Archive items (set status to ARCHIVED) for PROCESSED items older than 90 days.
 *   - Never touch PENDING or ERROR items.
 *   - Return { contentCleaned, itemsArchived }.
 *   - Use deps.now() for all date calculations (testability).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  runRetention,
  type DataRetentionDeps,
  type RetentionResult,
} from "@/lib/story-aggregator/data-retention"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const USER_ID = "user-test-123"

/** Pinned "now" used across all tests: 2026-02-19T00:00:00Z */
const FIXED_NOW = new Date("2026-02-19T00:00:00Z")

/**
 * 30 days before FIXED_NOW — the threshold date for content cleaning.
 * Items created before this date should have extractedContent cleared.
 */
const THIRTY_DAYS_AGO = new Date("2026-01-20T00:00:00Z")

/**
 * 90 days before FIXED_NOW — the threshold date for archiving.
 * Items created before this date should be set to ARCHIVED.
 */
const NINETY_DAYS_AGO = new Date("2025-11-21T00:00:00Z")

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a DataRetentionDeps object with vi.fn() stubs.
 *
 * cleanCount  — count returned by the first updateMany call (content cleaning)
 * archiveCount — count returned by the second updateMany call (archiving)
 */
function buildDeps(
  cleanCount = 0,
  archiveCount = 0,
  nowFn: () => Date = () => FIXED_NOW,
): DataRetentionDeps {
  return {
    db: {
      inboxItem: {
        updateMany: vi
          .fn()
          .mockResolvedValueOnce({ count: cleanCount })
          .mockResolvedValueOnce({ count: archiveCount }),
        count: vi.fn().mockResolvedValue(0),
      },
    },
    now: nowFn,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. Content cleaning — clears extractedContent after 30 days
// ---------------------------------------------------------------------------

describe("runRetention — content cleaning (30-day threshold)", () => {
  it("cleans extractedContent from PROCESSED items older than 30 days", async () => {
    // Arrange
    const deps = buildDeps(3, 0)

    // Act
    const result = await runRetention(USER_ID, deps)

    // Assert — updateMany must have been called at least once
    expect(deps.db.inboxItem.updateMany).toHaveBeenCalled()

    // Find the call that sets extractedContent to null
    const cleanCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.extractedContent === null,
    )
    expect(cleanCall).toBeDefined()

    const args = cleanCall![0]
    // Must scope to the correct user
    expect(args.where.userId).toBe(USER_ID)
    // Must only target PROCESSED items
    expect(args.where.status).toBe("PROCESSED")
    // The createdAt filter must use the 30-day boundary
    expect(args.where.createdAt.lt).toEqual(THIRTY_DAYS_AGO)
  })

  it("does not clean extractedContent from items newer than 30 days", async () => {
    // Arrange — updateMany returns 0 because DB filters out recent items
    const deps = buildDeps(0, 0)

    // Act
    await runRetention(USER_ID, deps)

    // Assert — the lt boundary for content cleaning must be exactly 30 days ago,
    // so items newer than that threshold are NOT touched by the query.
    const cleanCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.extractedContent === null,
    )
    expect(cleanCall).toBeDefined()
    const args = cleanCall![0]
    // The boundary must be exactly THIRTY_DAYS_AGO — not earlier (which would miss recent items)
    expect(args.where.createdAt.lt).toEqual(THIRTY_DAYS_AGO)
  })

  it("does not clean extractedContent from PENDING or ERROR items", async () => {
    // Arrange
    const deps = buildDeps(0, 0)

    // Act
    await runRetention(USER_ID, deps)

    // Assert — the content-cleaning updateMany must filter by status === 'PROCESSED'
    const cleanCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.extractedContent === null,
    )
    expect(cleanCall).toBeDefined()

    const whereStatus = cleanCall![0].where.status
    // Must target PROCESSED only — must NOT include PENDING or ERROR
    expect(whereStatus).toBe("PROCESSED")
    expect(whereStatus).not.toBe("PENDING")
    expect(whereStatus).not.toBe("ERROR")
    // Guard against an inclusive filter that happens to include PROCESSED alongside others
    if (typeof whereStatus === "object" && whereStatus !== null) {
      expect((whereStatus as { in?: string[] }).in).not.toEqual(
        expect.arrayContaining(["PENDING", "ERROR"]),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Archiving — sets status to ARCHIVED after 90 days
// ---------------------------------------------------------------------------

describe("runRetention — archiving (90-day threshold)", () => {
  it("archives PROCESSED items older than 90 days", async () => {
    // Arrange
    const deps = buildDeps(0, 2)

    // Act
    await runRetention(USER_ID, deps)

    // Assert — find the updateMany call that sets status to ARCHIVED
    const archiveCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.status === "ARCHIVED",
    )
    expect(archiveCall).toBeDefined()

    const args = archiveCall![0]
    expect(args.where.userId).toBe(USER_ID)
    expect(args.where.status).toBe("PROCESSED")
    expect(args.where.createdAt.lt).toEqual(NINETY_DAYS_AGO)
  })

  it("does not archive items newer than 90 days", async () => {
    // Arrange
    const deps = buildDeps(0, 0)

    // Act
    await runRetention(USER_ID, deps)

    // Assert — the archive call's lt boundary must be exactly 90 days ago,
    // so items newer than that are not included.
    const archiveCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.status === "ARCHIVED",
    )
    expect(archiveCall).toBeDefined()
    expect(archiveCall![0].where.createdAt.lt).toEqual(NINETY_DAYS_AGO)
  })

  it("does not archive PENDING or ERROR items even if older than 90 days", async () => {
    // Arrange
    const deps = buildDeps(0, 0)

    // Act
    await runRetention(USER_ID, deps)

    // Assert
    const archiveCall = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.data?.status === "ARCHIVED",
    )
    expect(archiveCall).toBeDefined()

    const whereStatus = archiveCall![0].where.status
    expect(whereStatus).toBe("PROCESSED")
    expect(whereStatus).not.toBe("PENDING")
    expect(whereStatus).not.toBe("ERROR")
    if (typeof whereStatus === "object" && whereStatus !== null) {
      expect((whereStatus as { in?: string[] }).in).not.toEqual(
        expect.arrayContaining(["PENDING", "ERROR"]),
      )
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Return value — correct counts
// ---------------------------------------------------------------------------

describe("runRetention — return value", () => {
  it("returns correct counts for both operations", async () => {
    // Arrange — content cleaning touches 5 items; archiving touches 2
    const deps = buildDeps(5, 2)

    // Act
    const result: RetentionResult = await runRetention(USER_ID, deps)

    // Assert
    expect(result).toEqual({ contentCleaned: 5, itemsArchived: 2 })
  })

  it("handles zero items gracefully and returns { contentCleaned: 0, itemsArchived: 0 }", async () => {
    // Arrange
    const deps = buildDeps(0, 0)

    // Act
    const result = await runRetention(USER_ID, deps)

    // Assert — must not throw and must return zeroed result
    expect(result).toEqual({ contentCleaned: 0, itemsArchived: 0 })
  })
})

// ---------------------------------------------------------------------------
// 4. Date injection — deps.now() controls all threshold calculations
// ---------------------------------------------------------------------------

describe("runRetention — deps.now() date injection", () => {
  it("uses injected now() for all date threshold calculations", async () => {
    // Arrange — use a different fixed point in time: 2026-06-15
    const customNow = new Date("2026-06-15T00:00:00Z")
    const expectedThirtyDaysAgo = new Date("2026-05-16T00:00:00Z")
    const expectedNinetyDaysAgo  = new Date("2026-03-17T00:00:00Z")

    const deps: DataRetentionDeps = {
      db: {
        inboxItem: {
          updateMany: vi
            .fn()
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 }),
          count: vi.fn().mockResolvedValue(0),
        },
      },
      now: () => customNow,
    }

    // Act
    await runRetention(USER_ID, deps)

    const calls = (deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>).mock.calls

    // Find the content-cleaning call and the archive call
    const cleanCall   = calls.find((c) => c[0]?.data?.extractedContent === null)
    const archiveCall = calls.find((c) => c[0]?.data?.status === "ARCHIVED")

    expect(cleanCall).toBeDefined()
    expect(archiveCall).toBeDefined()

    // Thresholds must be derived from the injected now(), not the wall clock
    expect(cleanCall![0].where.createdAt.lt).toEqual(expectedThirtyDaysAgo)
    expect(archiveCall![0].where.createdAt.lt).toEqual(expectedNinetyDaysAgo)
  })
})

// ---------------------------------------------------------------------------
// 5. Parallelism — both operations run concurrently
// ---------------------------------------------------------------------------

describe("runRetention — parallel execution", () => {
  it("performs content cleaning and archiving in parallel (both updateMany called per invocation)", async () => {
    // Arrange
    const callOrder: string[] = []

    const updateMany = vi.fn().mockImplementation(async (args: Record<string, unknown>) => {
      const data = args.data as Record<string, unknown>
      if (data.extractedContent === null) {
        callOrder.push("clean")
      } else if (data.status === "ARCHIVED") {
        callOrder.push("archive")
      }
      return { count: 1 }
    })

    const deps: DataRetentionDeps = {
      db: {
        inboxItem: {
          updateMany,
          count: vi.fn().mockResolvedValue(0),
        },
      },
      now: () => FIXED_NOW,
    }

    // Act
    await runRetention(USER_ID, deps)

    // Assert — both operations must have been invoked in a single call to runRetention
    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(callOrder).toContain("clean")
    expect(callOrder).toContain("archive")
  })
})
