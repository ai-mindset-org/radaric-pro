/**
 * INBOX count consistency: serverCounts.filter.INBOX must match getFilterPredicate("INBOX").
 *
 * Bug: page.tsx computed inboxCount as "non-deleted, non-archived" WITHOUT
 * requiring aiEvaluation === "APPROVED". The client-side INBOX predicate and
 * the API /api/posts?filter=INBOX both require APPROVED. This mismatch caused
 * the INBOX badge to show an inflated count (including FILTERED materials),
 * making the Load More button disappear prematurely — the user sees "289" but
 * only 150 actual INBOX items exist, all fitting in 1-2 pages.
 *
 * These tests verify the contract between the count query and the filter predicate.
 */

import { describe, it, expect } from "vitest"
import { getFilterPredicate, type FeedMaterial } from "@/lib/feed-utils"

// ---------------------------------------------------------------------------
// Fixture factory (minimal)
// ---------------------------------------------------------------------------

function makeMaterial(overrides: {
  aiEvaluation?: FeedMaterial["aiEvaluation"]
  userStatus?: FeedMaterial["userStatus"]
} = {}): FeedMaterial {
  return {
    id: `m-${Math.random()}`,
    title: "Test",
    url: "https://example.com",
    content: "c",
    aiEvaluation: overrides.aiEvaluation ?? "APPROVED",
    aiConfidence: 90,
    aiReasoning: null,
    createdAt: "2024-01-15T10:00:00.000Z",
    publishedAt: null,
    userStatus: overrides.userStatus ?? "NEW",
    feed: { id: "src-1", name: "Test", type: "RSS" },
    storyId: null,
    story: null,
  }
}

// ---------------------------------------------------------------------------
// Simulates the server-side count logic from page.tsx
// ---------------------------------------------------------------------------

/**
 * Mimics the inboxCount WHERE clause from page.tsx.
 * If this function diverges from getFilterPredicate("INBOX"), the INBOX badge
 * will show the wrong number and Load More pagination will break.
 */
function serverInboxCountPredicate(m: { aiEvaluation: string; userStatus: string }): boolean {
  // This MUST match getFilterPredicate("INBOX") — requires aiEvaluation === "APPROVED"
  return (
    m.aiEvaluation === "APPROVED" &&
    m.userStatus !== "DELETED" &&
    m.userStatus !== "ARCHIVED"
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("INBOX count consistency with filter predicate", () => {
  const materials = [
    makeMaterial({ aiEvaluation: "APPROVED", userStatus: "NEW" }),
    makeMaterial({ aiEvaluation: "APPROVED", userStatus: "READ" }),
    makeMaterial({ aiEvaluation: "APPROVED", userStatus: "SENT_TO_STORIES" }),
    makeMaterial({ aiEvaluation: "FILTERED", userStatus: "NEW" }),
    makeMaterial({ aiEvaluation: "FILTERED", userStatus: "NEW" }),
    makeMaterial({ aiEvaluation: "APPROVED", userStatus: "DELETED" }),
    makeMaterial({ aiEvaluation: "APPROVED", userStatus: "ARCHIVED" }),
  ]

  it("server count predicate matches getFilterPredicate('INBOX') for every material", () => {
    const clientPredicate = getFilterPredicate("INBOX")

    for (const m of materials) {
      const clientResult = clientPredicate(m)
      const serverResult = serverInboxCountPredicate(m)
      expect(serverResult).toBe(clientResult)
    }
  })

  it("FILTERED materials are excluded from INBOX count", () => {
    const filtered = makeMaterial({ aiEvaluation: "FILTERED", userStatus: "NEW" })
    expect(serverInboxCountPredicate(filtered)).toBe(false)
    expect(getFilterPredicate("INBOX")(filtered)).toBe(false)
  })

  it("INBOX count equals APPROVED count for the same set of materials", () => {
    const clientInbox = getFilterPredicate("INBOX")
    const clientApproved = getFilterPredicate("APPROVED")

    const inboxCount = materials.filter(m => clientInbox(m)).length
    const approvedCount = materials.filter(m => clientApproved(m)).length
    const serverCount = materials.filter(m => serverInboxCountPredicate(m)).length

    // All three should agree
    expect(serverCount).toBe(inboxCount)
    expect(serverCount).toBe(approvedCount)
  })
})
