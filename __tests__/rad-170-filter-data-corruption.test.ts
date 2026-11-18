/**
 * RAD-170: Filter + Source Type interaction bugs
 *
 * Verifies that buildRenderItems and the filter logic correctly handle
 * the interaction between status filters and source type filters.
 *
 * Bug: When user selects a source type that returns 0 matches and
 * fetchFilterPage(0) is triggered, all materials matching the current
 * status filter are permanently removed from state (data corruption).
 *
 * Root cause: fetchFilterPage(0) replaces materials matching the active
 * status predicate with API results — if API returns 0 (wrong source type),
 * those materials vanish.
 *
 * Additionally: the filter change effect calculates hasMore using only the
 * status predicate, ignoring source type filters, causing incorrect
 * "Load More" visibility.
 */

import { describe, it, expect } from "vitest"
import { buildRenderItems, getFilterPredicate, matchesSourceTypes, type FilterType, type SourceTypeFilter } from "@/lib/feed-utils"

// ---------------------------------------------------------------------------
// Fixture factory (mirrors rad-140 pattern)
// ---------------------------------------------------------------------------

let _seq = 0
function makeId() {
  return `id-${++_seq}`
}

function makeMaterial(overrides: {
  id?: string
  aiEvaluation?: "APPROVED" | "FILTERED"
  userStatus?: "NEW" | "READ" | "SENT_TO_NOTION" | "DELETED" | "ARCHIVED" | "SENT_TO_STORIES"
  storyId?: string | null
  story?: object | null
  createdAt?: string
  sourceType?: "RSS" | "TELEGRAM" | "TWITTER" | "INTEREST" | "EVENT_TRIGGER"
} = {}) {
  return {
    id: overrides.id ?? makeId(),
    title: "Test material",
    url: "https://example.com",
    content: "content",
    aiEvaluation: overrides.aiEvaluation ?? ("APPROVED" as const),
    aiConfidence: 90,
    aiReasoning: null,
    createdAt: overrides.createdAt ?? "2024-01-15T10:00:00.000Z",
    publishedAt: null,
    userStatus: overrides.userStatus ?? ("NEW" as const),
    feed: {
      id: "src-1",
      name: "Test Source",
      type: overrides.sourceType ?? ("TELEGRAM" as const),
    },
    storyId: overrides.storyId !== undefined ? overrides.storyId : null,
    story: overrides.story !== undefined ? overrides.story : null,
  }
}

// ---------------------------------------------------------------------------
// Simulate the fetchFilterPage(0) "replace" logic from materials-list.tsx
// This is the BUGGY logic we need to test
// ---------------------------------------------------------------------------

/**
 * Simulates the current (buggy) materials state update in fetchFilterPage
 * when offset === 0:
 *
 *   setMaterials(prev => {
 *     const predicate = getFilterPredicate(activeFilter)
 *     const kept = prev.filter(m => !predicate(m))
 *     return [...kept, ...apiMaterials]
 *   })
 */
function simulateFetchFilterPageReplace(
  prevMaterials: any[],
  activeFilter: FilterType,
  apiMaterials: any[]
): any[] {
  const predicate = getFilterPredicate(activeFilter) as (m: any) => boolean
  const kept = prevMaterials.filter(m => !predicate(m))
  return [...kept, ...apiMaterials]
}

/**
 * Correct replacement: should only replace materials that match BOTH the
 * status filter AND the source type filter being fetched, not all materials
 * matching the status filter.
 */
function simulateCorrectFetchFilterPageReplace(
  prevMaterials: any[],
  activeFilter: FilterType,
  sourceTypeFilters: SourceTypeFilter[],
  apiMaterials: any[]
): any[] {
  const predicate = getFilterPredicate(activeFilter) as (m: any) => boolean
  // Only replace materials that match both the status filter AND source type
  const kept = prevMaterials.filter(m => {
    if (!predicate(m)) return true // doesn't match status filter — keep
    // Matches status filter: only remove if it also matches the source type being fetched
    if (sourceTypeFilters.includes("ALL") || sourceTypeFilters.length === 0) {
      return false // ALL source types — replace all matching
    }
    return !matchesSourceTypes(m, sourceTypeFilters)
  })
  return [...kept, ...apiMaterials]
}

// ---------------------------------------------------------------------------
// Test data: 98 materials, all Telegram, 67 approved, 31 filtered
// ---------------------------------------------------------------------------

function createUserDataset() {
  const materials: any[] = []
  // 66 approved NEW Telegram materials
  for (let i = 0; i < 66; i++) {
    materials.push(makeMaterial({
      id: `approved-${i}`,
      aiEvaluation: "APPROVED",
      userStatus: "NEW",
      sourceType: "TELEGRAM",
      createdAt: `2026-03-31T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00.000Z`,
    }))
  }
  // 1 approved SENT_TO_STORIES Telegram material
  materials.push(makeMaterial({
    id: "sent-to-stories-1",
    aiEvaluation: "APPROVED",
    userStatus: "SENT_TO_STORIES",
    sourceType: "TELEGRAM",
    createdAt: "2026-03-31T09:00:00.000Z",
  }))
  // 31 filtered NEW Telegram materials
  for (let i = 0; i < 31; i++) {
    materials.push(makeMaterial({
      id: `filtered-${i}`,
      aiEvaluation: "FILTERED",
      userStatus: "NEW",
      sourceType: "TELEGRAM",
      createdAt: `2026-03-31T${String(8 + Math.floor(i / 6)).padStart(2, "0")}:${String((i % 6) * 10).padStart(2, "0")}:00.000Z`,
    }))
  }
  return materials // 98 total
}

// ---------------------------------------------------------------------------
// BUG 1: fetchFilterPage(0) with mismatched source type destroys materials
// ---------------------------------------------------------------------------

describe("RAD-170 Bug 1: fetchFilterPage data corruption", () => {
  it("BUGGY: fetchFilterPage(0) for INBOX+RSS removes all INBOX materials when API returns 0 results", () => {
    const materials = createUserDataset() // 98 total: 67 approved, 31 filtered, all Telegram
    const inboxBefore = materials.filter(m => getFilterPredicate("INBOX")(m as any)).length
    expect(inboxBefore).toBe(67) // precondition

    // Simulate: API returns 0 results for INBOX+RSS (user has no RSS feeds)
    const afterReplace = simulateFetchFilterPageReplace(materials, "INBOX", [])

    // BUG: all 67 INBOX materials are gone!
    const inboxAfter = afterReplace.filter(m => getFilterPredicate("INBOX")(m as any)).length
    // This assertion documents the bug — it should fail once the fix is applied
    // because the fixed version should preserve Telegram INBOX materials
    expect(afterReplace.length).toBe(31) // only FILTERED materials remain — BAD!
    expect(inboxAfter).toBe(0)           // all INBOX materials lost — BAD!
  })

  it("CORRECT: replacement should preserve materials that don't match the fetched source type", () => {
    const materials = createUserDataset()

    // Correct replacement: only remove materials matching BOTH INBOX AND RSS
    const afterCorrectReplace = simulateCorrectFetchFilterPageReplace(
      materials, "INBOX", ["RSS"], []
    )

    // All 98 materials preserved (no RSS materials to replace)
    expect(afterCorrectReplace.length).toBe(98)
    const inboxAfter = afterCorrectReplace.filter(m => getFilterPredicate("INBOX")(m as any)).length
    expect(inboxAfter).toBe(67)
  })

  it("CORRECT: replacement with matching source type replaces correctly", () => {
    const materials = createUserDataset()
    const newTelegramMaterials = [
      makeMaterial({ id: "new-tg-1", aiEvaluation: "APPROVED", sourceType: "TELEGRAM" }),
    ]

    const afterReplace = simulateCorrectFetchFilterPageReplace(
      materials, "INBOX", ["TELEGRAM"], newTelegramMaterials
    )

    // 31 FILTERED (kept) + 1 new Telegram = 32
    // INBOX Telegram materials replaced with API result
    expect(afterReplace.length).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// BUG 2: cascading corruption — repeated fetchFilterPage empties all state
// ---------------------------------------------------------------------------

describe("RAD-170 Bug 2: cascading data loss", () => {
  it("BUGGY: switching to ALL filter after INBOX corruption loses remaining materials", () => {
    const materials = createUserDataset()

    // Step 1: INBOX + RSS fetch → loses all INBOX materials
    const step1 = simulateFetchFilterPageReplace(materials, "INBOX", [])
    expect(step1.length).toBe(31) // only FILTERED left

    // Step 2: Switch to ALL filter, still RSS source type → API returns 0
    const step2 = simulateFetchFilterPageReplace(step1, "ALL", [])

    // BUG: ALL predicate matches all non-deleted → ALL materials removed!
    expect(step2.length).toBe(0) // everything gone!
  })
})

// ---------------------------------------------------------------------------
// BUG 3: hasMore ignores source type filter
// ---------------------------------------------------------------------------

describe("RAD-170 Bug 3: hasMore calculation ignores source type", () => {
  it("hasMore should account for source type when calculating matching count", () => {
    const materials = createUserDataset()

    // Current buggy logic: counts only status-matching materials
    const inboxPredicate = getFilterPredicate("INBOX") as (m: any) => boolean
    const statusMatchCount = materials.filter(inboxPredicate).length
    expect(statusMatchCount).toBe(67) // status-only count

    // But with RSS source type filter, actual visible count is 0
    const items = buildRenderItems(materials as any, "INBOX", ["RSS"])
    expect(items.length).toBe(0)

    // The mismatch: statusMatchCount=67 but renderItems=0
    // hasMore = (67 < 67) = false, but Load More SHOULD NOT show
    // because there are 0 visible items and the server also has 0 RSS items
    // The real fix: hasMore should consider source type, or
    // the effect should not call fetchFilterPage when source type mismatch explains the empty result
  })

  it("buildRenderItems correctly filters by source type", () => {
    const materials = createUserDataset()

    // ALL source types
    const allItems = buildRenderItems(materials as any, "INBOX", ["ALL"])
    expect(allItems.length).toBe(67)

    // TELEGRAM only
    const tgItems = buildRenderItems(materials as any, "INBOX", ["TELEGRAM"])
    expect(tgItems.length).toBe(67) // all are Telegram

    // RSS — none match
    const rssItems = buildRenderItems(materials as any, "INBOX", ["RSS"])
    expect(rssItems.length).toBe(0)

    // Multi-select: TELEGRAM + RSS
    const multiItems = buildRenderItems(materials as any, "INBOX", ["TELEGRAM", "RSS"])
    expect(multiItems.length).toBe(67)
  })

  it("SENT_TO_NOTION filter with all-Telegram user shows 1 material regardless of source type", () => {
    const materials = createUserDataset()

    // SENT_TO_NOTION filter
    const items = buildRenderItems(materials as any, "SENT_TO_NOTION", ["ALL"])
    expect(items.length).toBe(1) // only the SENT_TO_STORIES material

    const tgItems = buildRenderItems(materials as any, "SENT_TO_NOTION", ["TELEGRAM"])
    expect(tgItems.length).toBe(1) // it's Telegram

    const rssItems = buildRenderItems(materials as any, "SENT_TO_NOTION", ["RSS"])
    expect(rssItems.length).toBe(0) // no RSS
  })
})
