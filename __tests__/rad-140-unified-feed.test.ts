/**
 * RAD-140: Unified Posts + Stories Feed
 *
 * Verifies the pure data-transformation layer that replaces the
 * `showStoriesOnly` toggle and the in-component `renderItems` useMemo.
 * All tests operate on plain data — no React rendering required.
 *
 * Criteria:
 *   AC-1: 2 materials sharing a storyId + 1 standalone → 2 RenderItems (1 story, 1 material)
 *   AC-2: buildRenderItems() sorts items by date descending
 *   AC-3: story group date = max(createdAt) of its constituent materials
 *   AC-4: buildRenderItems() has no showStoriesOnly param — always returns both types
 *   AC-5: INBOX filter includes materials with userStatus=SENT_TO_STORIES (they appear via story card)
 *   AC-6: INBOX filter returns only APPROVED + not DELETED + not ARCHIVED — regardless of story membership
 *   EC-1: all materials in one story → 1 story group, 0 standalone
 *   EC-2: no materials have stories → 0 story groups, all standalone
 *   EC-3: storyId set but story is null (data inconsistency) → treated as standalone
 */

import { describe, it, expect } from "vitest"
import { buildRenderItems, getFilterPredicate } from "@/lib/feed-utils"

// ---------------------------------------------------------------------------
// Type aliases (mirror what feed-utils.ts will export)
// ---------------------------------------------------------------------------

type FilterType = "ALL" | "INBOX" | "APPROVED" | "FILTERED" | "SENT_TO_NOTION" | "ARCHIVED"
type SourceTypeFilter = "ALL" | "RSS" | "TELEGRAM" | "TWITTER" | "EVENT_TRIGGER"

// ---------------------------------------------------------------------------
// Fixture factory
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
      type: overrides.sourceType ?? ("RSS" as const),
    },
    storyId: overrides.storyId !== undefined ? overrides.storyId : null,
    story: overrides.story !== undefined ? overrides.story : null,
  }
}

const STORY_FIXTURE = {
  id: "story-1",
  title: "Story Title",
  summary: "Story summary",
  rubrics: [],
  sourceUrls: [],
  status: "PUBLISHED",
  version: 1,
  createdAt: "2024-01-15T10:00:00.000Z",
  _count: { materials: 2, inboxItems: 0 },
}

// ---------------------------------------------------------------------------
// AC-1: 2 shared-story materials + 1 standalone → 2 render items
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — AC-1: basic grouping", () => {
  it("AC-1: 2 materials with same storyId + 1 standalone → returns 2 items (1 story group, 1 material)", () => {
    const mat1 = makeMaterial({ id: "m1", storyId: "story-1", story: STORY_FIXTURE })
    const mat2 = makeMaterial({ id: "m2", storyId: "story-1", story: STORY_FIXTURE })
    const mat3 = makeMaterial({ id: "m3", storyId: null, story: null })

    const result = buildRenderItems([mat1, mat2, mat3] as any, "ALL", "ALL")

    expect(result).toHaveLength(2)

    const storyItems = result.filter((r: any) => r.type === "story")
    const materialItems = result.filter((r: any) => r.type === "material")

    expect(storyItems).toHaveLength(1)
    expect(materialItems).toHaveLength(1)
    expect(storyItems[0].story.materials).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// AC-2: sorted by date descending
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — AC-2: date sorting", () => {
  it("AC-2: items are sorted by date descending — most recent first", () => {
    const older = makeMaterial({ id: "old", storyId: null, createdAt: "2024-01-10T00:00:00.000Z" })
    const newer = makeMaterial({ id: "new", storyId: null, createdAt: "2024-01-20T00:00:00.000Z" })
    const middle = makeMaterial({ id: "mid", storyId: null, createdAt: "2024-01-15T00:00:00.000Z" })

    const result = buildRenderItems([older, newer, middle] as any, "ALL", "ALL")

    expect(result).toHaveLength(3)
    // dates should be in descending order
    const dates = result.map((r: any) => r.date)
    expect(dates[0]).toBeGreaterThan(dates[1])
    expect(dates[1]).toBeGreaterThan(dates[2])
  })
})

// ---------------------------------------------------------------------------
// AC-3: story group date = max createdAt of its materials
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — AC-3: story group date is max of constituent materials", () => {
  it("AC-3: story group date equals the most recent material's createdAt timestamp", () => {
    const storyFixture = { ...STORY_FIXTURE, id: "story-ac3" }
    const earlierMat = makeMaterial({
      id: "s-early",
      storyId: "story-ac3",
      story: storyFixture,
      createdAt: "2024-01-10T00:00:00.000Z",
    })
    const laterMat = makeMaterial({
      id: "s-late",
      storyId: "story-ac3",
      story: storyFixture,
      createdAt: "2024-01-20T00:00:00.000Z",
    })

    const result = buildRenderItems([earlierMat, laterMat] as any, "ALL", "ALL")

    expect(result).toHaveLength(1)
    const storyItem = result[0] as any
    expect(storyItem.type).toBe("story")

    const expectedDate = new Date("2024-01-20T00:00:00.000Z").getTime()
    expect(storyItem.date).toBe(expectedDate)
  })
})

// ---------------------------------------------------------------------------
// AC-4: function accepts no showStoriesOnly parameter
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — AC-4: no showStoriesOnly parameter", () => {
  it("AC-4: buildRenderItems signature takes (materials, filter, sourceTypeFilter) — no showStoriesOnly argument", () => {
    // The function should only accept 3 arguments. We verify by calling it with
    // only 3 args and confirming it returns both story and standalone items.
    const storyMat = makeMaterial({ id: "sm", storyId: "story-ac4", story: { ...STORY_FIXTURE, id: "story-ac4" } })
    const standaloneMat = makeMaterial({ id: "sa", storyId: null })

    // Call with exactly 3 args — if the function required a 4th arg, TypeScript
    // would complain at build time; at runtime both types appear in the output
    const result = buildRenderItems([storyMat, standaloneMat] as any, "ALL", "ALL")

    const types = result.map((r: any) => r.type)
    expect(types).toContain("story")
    expect(types).toContain("material")
  })
})

// ---------------------------------------------------------------------------
// AC-5 / AC-6: filter predicate correctness for INBOX
// ---------------------------------------------------------------------------

describe("RAD-140 getFilterPredicate — AC-5 & AC-6: INBOX filter", () => {
  it("AC-5: INBOX filter includes materials with userStatus=SENT_TO_STORIES when aiEvaluation=APPROVED", () => {
    // SENT_TO_STORIES materials still appear in their story card; the filter
    // must not exclude them from the pool that feeds buildRenderItems
    const sentToStories = makeMaterial({
      aiEvaluation: "APPROVED",
      userStatus: "SENT_TO_STORIES",
      storyId: "story-inbox",
      story: { ...STORY_FIXTURE, id: "story-inbox" },
    })

    const predicate = getFilterPredicate("INBOX")
    expect(predicate(sentToStories as any)).toBe(true)
  })

  it("AC-6: INBOX filter returns only APPROVED + not DELETED + not ARCHIVED — excludes FILTERED regardless of story membership", () => {
    const approvedStandalone = makeMaterial({ aiEvaluation: "APPROVED", userStatus: "NEW" })
    const approvedInStory = makeMaterial({
      aiEvaluation: "APPROVED",
      userStatus: "NEW",
      storyId: "story-x",
      story: { ...STORY_FIXTURE, id: "story-x" },
    })
    const filteredInStory = makeMaterial({
      aiEvaluation: "FILTERED",
      userStatus: "NEW",
      storyId: "story-x",
      story: { ...STORY_FIXTURE, id: "story-x" },
    })
    const deleted = makeMaterial({ aiEvaluation: "APPROVED", userStatus: "DELETED" })
    const archived = makeMaterial({ aiEvaluation: "APPROVED", userStatus: "ARCHIVED" })

    const predicate = getFilterPredicate("INBOX")

    expect(predicate(approvedStandalone as any)).toBe(true)
    expect(predicate(approvedInStory as any)).toBe(true)
    expect(predicate(filteredInStory as any)).toBe(false)
    expect(predicate(deleted as any)).toBe(false)
    expect(predicate(archived as any)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// EC-1: all materials in one story → 1 story group, 0 standalone
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — EC-1: all materials in one story", () => {
  it("EC-1: when all materials share a storyId, returns exactly 1 story group and 0 standalone items", () => {
    const story = { ...STORY_FIXTURE, id: "story-ec1" }
    const m1 = makeMaterial({ id: "ec1-a", storyId: "story-ec1", story })
    const m2 = makeMaterial({ id: "ec1-b", storyId: "story-ec1", story })
    const m3 = makeMaterial({ id: "ec1-c", storyId: "story-ec1", story })

    const result = buildRenderItems([m1, m2, m3] as any, "ALL", "ALL")

    expect(result).toHaveLength(1)
    expect(result[0].type).toBe("story")
    const storyItem = result[0] as any
    expect(storyItem.story.materials).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// EC-2: no materials have stories → 0 story groups, all standalone
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — EC-2: no stories present", () => {
  it("EC-2: when no materials have a storyId, returns 0 story groups and all items as standalone materials", () => {
    const m1 = makeMaterial({ id: "ec2-a", storyId: null })
    const m2 = makeMaterial({ id: "ec2-b", storyId: null })

    const result = buildRenderItems([m1, m2] as any, "ALL", "ALL")

    expect(result).toHaveLength(2)
    result.forEach((r: any) => expect(r.type).toBe("material"))
  })
})

// ---------------------------------------------------------------------------
// EC-3: storyId set but story is null → treated as standalone
// ---------------------------------------------------------------------------

describe("RAD-140 buildRenderItems — EC-3: storyId without story object", () => {
  it("EC-3: material with storyId set but story=null is treated as a standalone item, not a story group", () => {
    const inconsistent = makeMaterial({
      id: "ec3-a",
      storyId: "story-missing",
      story: null,
    })
    const normal = makeMaterial({ id: "ec3-b", storyId: null })

    const result = buildRenderItems([inconsistent, normal] as any, "ALL", "ALL")

    expect(result).toHaveLength(2)
    // Neither item should be a story group — both are standalone materials
    result.forEach((r: any) => expect(r.type).toBe("material"))
  })
})
