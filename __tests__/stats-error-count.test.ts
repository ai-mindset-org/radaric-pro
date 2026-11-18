/**
 * Stats API — Error Count Badge
 *
 * Tests for GET /api/stats route (app/api/stats/route.ts).
 * The route currently does NOT return `sources.errorCount` — all tests must FAIL.
 *
 * Spec coverage:
 *   AC-5: sources.errorCount is the count of sources with status "ERROR" for the current user
 *   AC-8: When errorCount is 0, the field is still present (not undefined) so the client can suppress the badge
 *   EC-3: Stats API returns errorCount: 0 when no sources are in ERROR state (not undefined)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock @/lib/db (Prisma client)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    material: {
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    feed: {
      count: vi.fn(),
    },
  },
}))

// ---------------------------------------------------------------------------
// Mock @/lib/auth-utils
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/stats/route"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_USER_ID = "user-abc-123"

/**
 * Configure mocks for a successful authenticated request.
 * Accepts optional override for `sourceErrorCount` to test various scenarios.
 */
function setupAuthAndDb({
  sourceErrorCount = 0,
  totalSources = 5,
  activeSources = 4,
}: {
  sourceErrorCount?: number
  totalSources?: number
  activeSources?: number
} = {}) {
  vi.mocked(requireAuth).mockResolvedValue({ userId: MOCK_USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)

  // material.count — called multiple times for each material status bucket
  vi.mocked(db.material.count).mockResolvedValue(0)

  // material.groupBy — per-source inbox counts (empty for these error-count tests)
  vi.mocked(db.material.groupBy).mockResolvedValue([] as never)

  // source.count — called for total, active, and now errorCount
  vi.mocked(db.feed.count).mockImplementation(async (args: any) => {
    if (args?.where?.status === "ERROR") return sourceErrorCount
    if (args?.where?.isActive === true) return activeSources
    return totalSources
  })
}

// ---------------------------------------------------------------------------
// AC-5: sources.errorCount is present in the response
// ---------------------------------------------------------------------------

describe("GET /api/stats — AC-5: response includes sources.errorCount", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("AC-5: response body contains sources.errorCount as a number", async () => {
    setupAuthAndDb({ sourceErrorCount: 3 })

    const response = await GET()
    const body = await response.json()

    expect(body.feeds).toBeDefined()
    expect(typeof body.feeds.errorCount).toBe("number")
  })

  it("AC-5: sources.errorCount equals the count of ERROR-status sources for the user", async () => {
    setupAuthAndDb({ sourceErrorCount: 3, totalSources: 10, activeSources: 7 })

    const response = await GET()
    const body = await response.json()

    expect(body.feeds.errorCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// EC-3 + AC-8: errorCount is 0 (not undefined) when no sources are in ERROR
// ---------------------------------------------------------------------------

describe("GET /api/stats — EC-3 + AC-8: errorCount is 0 when no sources have ERROR status", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("EC-3: sources.errorCount is exactly 0 when no ERROR sources exist", async () => {
    setupAuthAndDb({ sourceErrorCount: 0 })

    const response = await GET()
    const body = await response.json()

    expect(body.feeds.errorCount).toBe(0)
  })

  it("AC-8: sources.errorCount is 0 (not undefined) so client can conditionally hide badge", async () => {
    setupAuthAndDb({ sourceErrorCount: 0 })

    const response = await GET()
    const body = await response.json()

    // Must be 0, not undefined — the field must always be present
    expect(body.feeds.errorCount).not.toBeUndefined()
    expect(body.feeds.errorCount).toBe(0)
  })
})
