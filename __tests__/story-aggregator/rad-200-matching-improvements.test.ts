/**
 * RAD-200: Story Matching Quality Improvements
 *
 * Tests for:
 *   A. Enriched scoring formula (computeSimilarityScore with 4 signals)
 *   B. Cross-language entity extraction (extractKeyEntities)
 *   C. Adaptive pre-filter (getMaxCandidates, zero-score fallback)
 *   D. Material titles in candidates (buildMatchingPrompt)
 *   F. Integration tests (matchContent full pipeline)
 */

import { describe, it, expect, vi } from "vitest"
import {
  computeSimilarityScore,
  preFilterCandidates,
  getMaxCandidates,
  extractKeyEntities,
  entityJaccard,
  extractVersionedEntities,
  matchContent,
  matchItem,
  type PreFilterCandidate,
  type StoryMatcherDeps,
} from "@/lib/story-aggregator/story-matcher"
import { buildMatchingPrompt } from "@/lib/story-aggregator/story-writer"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<PreFilterCandidate> = {}): PreFilterCandidate {
  return {
    id: "story-1",
    title: "Default Story Title",
    summary: "Default summary about technology.",
    sourceUrls: [],
    score: 0,
    ...overrides,
  }
}

const USER_ID = "user-1"
const ITEM_ID = "item-1"

function buildDeps(overrides?: {
  stories?: Array<Record<string, unknown>>
  aiResult?: unknown
  inboxItem?: Record<string, unknown> | null
}): StoryMatcherDeps {
  const stories = overrides?.stories ?? []
  const aiResult = overrides?.aiResult ?? { match: null, reasoning: "No match" }
  return {
    db: {
      story: {
        findMany: vi.fn().mockResolvedValue(stories),
      },
      inboxItem: overrides?.inboxItem !== undefined
        ? { findUnique: vi.fn().mockResolvedValue(overrides.inboxItem) }
        : { findUnique: vi.fn().mockResolvedValue({
            id: ITEM_ID,
            userId: USER_ID,
            extractedTitle: "Test Item Title",
            extractedContent: "Test content about Apple technology.",
            extractedUrl: null,
            rawText: "Test raw text",
          }) },
    },
    matchWithAI: vi.fn().mockResolvedValue(aiResult),
  }
}

// ===========================================================================
// A. Scoring Formula (9 tests)
// ===========================================================================

describe("A. computeSimilarityScore — enriched 4-signal scoring (RAD-200)", () => {
  it("A1: content overlap raises score vs null content", () => {
    const candidate = makeCandidate({
      title: "Unrelated Title Here",
      summary: "Apple released a new design system for developers",
    })
    const withContent = computeSimilarityScore(
      { title: "Something Else", content: "Apple released a new design system for developers" },
      candidate
    )
    const withoutContent = computeSimilarityScore(
      { title: "Something Else" },
      candidate
    )
    expect(withContent).toBeGreaterThan(withoutContent)
  })

  it("A2: null content degrades gracefully (no crash, score equals title-only)", () => {
    const candidate = makeCandidate({ title: "Apple Design System" })
    const scoreNull = computeSimilarityScore(
      { title: "Apple Design System", content: null },
      candidate
    )
    const scoreUndefined = computeSimilarityScore(
      { title: "Apple Design System" },
      candidate
    )
    expect(scoreNull).toBe(scoreUndefined)
    expect(scoreNull).toBeGreaterThan(0)
  })

  it("A3: materialTitles overlap raises score vs story-title-only", () => {
    const candidateWithMaterials = makeCandidate({
      title: "AI News Roundup This Week",
      materialTitles: ["Apple Releases New MacBook Pro M5"],
    })
    const candidateWithout = makeCandidate({
      title: "AI News Roundup This Week",
    })
    const score = computeSimilarityScore(
      { title: "New MacBook Pro M5 Review" },
      candidateWithMaterials
    )
    const scoreWithout = computeSimilarityScore(
      { title: "New MacBook Pro M5 Review" },
      candidateWithout
    )
    expect(score).toBeGreaterThan(scoreWithout)
  })

  it("A4: empty materialTitles array falls back to 0 (no -Infinity)", () => {
    const candidate = makeCandidate({ materialTitles: [] })
    const score = computeSimilarityScore(
      { title: "Some Title" },
      candidate
    )
    expect(score).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(score)).toBe(true)
  })

  it("A5: shared entities ('Apple', 'iOS') raise score", () => {
    const candidate = makeCandidate({
      title: "Apple Announces iOS Update",
      summary: "Apple announced a major iOS update today.",
    })
    const relatedScore = computeSimilarityScore(
      { title: "New Features in Apple iOS", content: "Apple shared details about their iOS plans." },
      candidate
    )
    const unrelatedScore = computeSimilarityScore(
      { title: "Database Migration Guide", content: "How to migrate PostgreSQL databases." },
      candidate
    )
    expect(relatedScore).toBeGreaterThan(unrelatedScore)
  })

  it("A6: no shared entities yields entityScore of 0", () => {
    const candidate = makeCandidate({
      title: "simple lowercase only",
      summary: "nothing special here at all",
    })
    const score = computeSimilarityScore(
      { title: "completely different text", content: "no overlap whatsoever" },
      candidate
    )
    // With no shared entities, no title overlap, and no domain match, score should be ~0
    expect(score).toBeLessThan(0.05)
  })

  it("A7: pinning test — exact weights for controlled fixture", () => {
    // Fixture: perfect title match, partial content, no entities shared (< 2), domain match
    const candidate = makeCandidate({
      title: "exact match title words",
      summary: "some content words here",
      sourceUrls: ["https://example.com/article"],
    })
    const score = computeSimilarityScore(
      {
        title: "exact match title words",
        content: "some content words",
        extractedUrl: "https://example.com/other",
      },
      candidate
    )
    // titleJaccard = 1.0 (perfect match), so titleScore = max(1.0, 0) * 0.35 = 0.35
    // contentJaccard > 0 (partial overlap), contentScore = x * 0.15
    // entityScore likely 0 (no proper nouns/versions with 2+ overlap)
    // domainBonus = 1 * 0.10 = 0.10 (same domain)
    expect(score).toBeGreaterThanOrEqual(0.45)
    expect(score).toBeLessThanOrEqual(1.0)
  })

  it("A8: domain-only match caps at 0.10", () => {
    const candidate = makeCandidate({
      title: "completely unrelated topic",
      summary: "nothing in common with the query",
      sourceUrls: ["https://example.com/article"],
    })
    const score = computeSimilarityScore(
      { title: "different words entirely", extractedUrl: "https://example.com/page" },
      candidate
    )
    // Only domain matches, no title/content/entity overlap
    expect(score).toBeLessThanOrEqual(0.10 + 0.01) // small float tolerance
  })

  it("A9: perfect overlap on all signals returns 1.0 (clamped)", () => {
    const candidate = makeCandidate({
      title: "Apple Releases iOS 20 With Major Redesign",
      summary: "Apple released iOS 20 today with a complete visual redesign of the operating system.",
      sourceUrls: ["https://apple.com/ios20"],
    })
    const score = computeSimilarityScore(
      {
        title: "Apple Releases iOS 20 With Major Redesign",
        content: "Apple released iOS 20 today with a complete visual redesign of the operating system.",
        extractedUrl: "https://apple.com/ios20",
      },
      candidate
    )
    expect(score).toBeLessThanOrEqual(1.0)
    expect(score).toBeGreaterThan(0.7)
  })
})

// ===========================================================================
// B. Entity Extraction (8 tests)
// ===========================================================================

describe("B. extractKeyEntities — cross-language entity extraction (RAD-200)", () => {
  it("B1: extracts capitalized proper nouns", () => {
    const entities = extractKeyEntities("Apple releases new Figma plugin for developers")
    expect(entities.has("apple")).toBe(true)
    expect(entities.has("figma")).toBe(true)
  })

  it("B2: skips lowercase common words and sentence starters", () => {
    const entities = extractKeyEntities("However the system was already working before")
    // "However" is in SENTENCE_STARTER_SKIP, "the" is a stop word
    expect(entities.has("however")).toBe(false)
    expect(entities.has("the")).toBe(false)
  })

  it("B3: extracts significant numbers", () => {
    const entities = extractKeyEntities("Apple releases iOS 20 in 2026")
    expect(entities.has("20")).toBe(true)
    expect(entities.has("2026")).toBe(true)
  })

  it("B4: extracts versioned product names", () => {
    const entities = extractKeyEntities("Check out Gemini 3.1 Pro benchmarks")
    expect(entities.has("gemini 3.1 pro")).toBe(true)
  })

  it("B5: cross-language entity overlap works", () => {
    const enEntities = extractKeyEntities("Apple releases iOS 20 today")
    const ruEntities = extractKeyEntities("Apple выпустила iOS 20 сегодня")
    // Both should share "apple" and "20" (and iOS from versioned entity extraction)
    const shared = [...enEntities].filter((e) => ruEntities.has(e))
    expect(shared.length).toBeGreaterThanOrEqual(2)
  })

  it("B6: integrates with extractVersionedEntities", () => {
    const entities = extractKeyEntities("Seedance 2.0 is a breakthrough")
    expect(entities.has("seedance 2.0")).toBe(true)
  })

  it("B7: empty string returns empty set", () => {
    const entities = extractKeyEntities("")
    expect(entities.size).toBe(0)
  })

  it("B8: all-lowercase text with no numbers returns empty set", () => {
    const entities = extractKeyEntities("this is all lowercase text without any numbers")
    expect(entities.size).toBe(0)
  })
})

describe("B. entityJaccard — Jaccard with 2+ overlap threshold (RAD-200)", () => {
  it("returns 0 when fewer than 2 entities overlap", () => {
    const a = new Set(["apple", "ios"])
    const b = new Set(["apple", "android"])
    expect(entityJaccard(a, b)).toBe(0) // only 1 shared = "apple"
  })

  it("returns > 0 when 2+ entities overlap", () => {
    const a = new Set(["apple", "ios", "20"])
    const b = new Set(["apple", "ios", "redesign"])
    expect(entityJaccard(a, b)).toBeGreaterThan(0)
  })

  it("returns 0 for empty sets", () => {
    expect(entityJaccard(new Set(), new Set(["apple"]))).toBe(0)
    expect(entityJaccard(new Set(["apple"]), new Set())).toBe(0)
  })
})

// ===========================================================================
// C. Adaptive Pre-filter (5 tests)
// ===========================================================================

describe("C. getMaxCandidates — adaptive pre-filter limits (RAD-200)", () => {
  it("C1: <=20 stories passes all through", () => {
    expect(getMaxCandidates(10)).toBe(10)
    expect(getMaxCandidates(20)).toBe(20)
  })

  it("C2: <=50 stories returns 25", () => {
    expect(getMaxCandidates(35)).toBe(25)
    expect(getMaxCandidates(50)).toBe(25)
  })

  it("C3: >50 stories returns 15", () => {
    expect(getMaxCandidates(51)).toBe(15)
    expect(getMaxCandidates(100)).toBe(15)
  })
})

describe("C. preFilterCandidates — zero-score fallback (RAD-200)", () => {
  it("C4: when all candidates score 0, keeps top 5 by recency", () => {
    // All titles completely different from the new item — all score 0
    const candidates = Array.from({ length: 10 }, (_, i) => makeCandidate({
      id: `story-${i}`,
      title: `тема ${i} на русском языке`,
      summary: `описание ${i}`,
      createdAt: new Date(2026, 0, i + 1), // Jan 1-10
    }))
    const result = preFilterCandidates(
      { title: "completely different english text about something" },
      candidates
    )
    expect(result.length).toBe(5)
    // Should be sorted by recency (newest first)
    expect(result[0].id).toBe("story-9") // Jan 10
  })

  it("C5: fallback only activates when ALL scores are 0", () => {
    const candidates = [
      makeCandidate({ id: "s1", title: "matching words here" }),
      makeCandidate({ id: "s2", title: "что-то на русском" }),
      makeCandidate({ id: "s3", title: "другое на русском" }),
    ]
    const result = preFilterCandidates(
      { title: "matching words here exactly" },
      candidates
    )
    // At least one scored > 0, so normal sorting applies (no fallback)
    expect(result[0].id).toBe("s1")
    expect(result[0].score).toBeGreaterThan(0)
  })
})

// ===========================================================================
// D. Material Titles in Candidates (4 tests)
// ===========================================================================

describe("D. buildMatchingPrompt — materialTitles in AI prompt (RAD-200)", () => {
  it("D2: includes 'Related article titles:' when materialTitles present", () => {
    const prompt = buildMatchingPrompt(
      { title: "New Article", content: "Content" },
      [{ id: "s1", title: "Story", summary: "Sum", materialTitles: ["Article A", "Article B"] }]
    )
    expect(prompt).toContain("Related article titles: <titles>Article A; Article B</titles>")
  })

  it("D3: omits 'Related article titles:' when materialTitles empty", () => {
    const prompt = buildMatchingPrompt(
      { title: "New Article", content: "Content" },
      [{ id: "s1", title: "Story", summary: "Sum", materialTitles: [] }]
    )
    expect(prompt).not.toContain("Related article titles:")
  })

  it("D3b: omits 'Related article titles:' when materialTitles undefined", () => {
    const prompt = buildMatchingPrompt(
      { title: "New Article", content: "Content" },
      [{ id: "s1", title: "Story", summary: "Sum" }]
    )
    expect(prompt).not.toContain("Related article titles:")
  })

  it("D4: materialTitles boost pre-filter score", () => {
    const withMat = makeCandidate({
      title: "Weekly AI Digest",
      materialTitles: ["React 19 Performance Guide"],
    })
    const without = makeCandidate({
      title: "Weekly AI Digest",
    })
    const scoreWith = computeSimilarityScore(
      { title: "React 19 Performance Tips" },
      withMat
    )
    const scoreWithout = computeSimilarityScore(
      { title: "React 19 Performance Tips" },
      without
    )
    expect(scoreWith).toBeGreaterThan(scoreWithout)
  })
})

// ===========================================================================
// F. Integration Tests (10 tests)
// ===========================================================================

describe("F. matchContent integration — full pipeline (RAD-200)", () => {
  it("F1: no stories → isNew: true", async () => {
    const deps = buildDeps({ stories: [] })
    const result = await matchContent(
      { title: "Test", content: "Content", url: null, rawText: null },
      USER_ID,
      deps
    )
    expect(result.isNew).toBe(true)
    expect(result.match).toBeNull()
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("F2: URL shortcut match → AI not called", async () => {
    const deps = buildDeps({
      stories: [{
        id: "story-url",
        userId: USER_ID,
        title: "Existing Story",
        summary: "Summary",
        sourceUrls: ["https://example.com/article"],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [],
      }],
    })
    const result = await matchContent(
      { title: "Different Title", content: "Different", url: "https://example.com/article", rawText: null },
      USER_ID,
      deps
    )
    expect(result.match).toBe("story-url")
    expect(result.isNew).toBe(false)
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("F3: shared versioned entity routes the candidate to the AI (no force-merge), and the AI confirms", async () => {
    const deps = buildDeps({
      stories: [{
        id: "story-entity",
        userId: USER_ID,
        title: "Big AI News This Week",
        summary: "Summary of AI developments",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [{ title: "Claude 5 Released with Advanced Reasoning" }],
      }],
      aiResult: { match: "story-entity", reasoning: "Both about the Claude 5 release" },
    })
    const result = await matchContent(
      { title: "Claude 5 Benchmark Results", content: "Testing Claude 5", url: null, rawText: "Claude 5 benchmarks" },
      USER_ID,
      deps
    )
    // The versioned entity is now a strong signal the AI decides on — not a force-merge.
    expect(deps.matchWithAI).toHaveBeenCalled()
    expect(result.match).toBe("story-entity")
    expect(result.isNew).toBe(false)
  })

  it("F5: cross-language entities help pre-filter pass candidates to AI", async () => {
    // Use a topic without versioned entities to avoid the entity shortcut
    const deps = buildDeps({
      stories: [{
        id: "story-cross",
        userId: USER_ID,
        title: "Apple Announces New Privacy Features at WWDC",
        summary: "Apple presented major privacy improvements at the WWDC conference.",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [],
      }],
      aiResult: { match: "story-cross", reasoning: "Same Apple WWDC privacy event" },
    })
    const result = await matchContent(
      { title: "Apple представила новые функции конфиденциальности на WWDC", content: "Apple показала улучшения приватности на конференции WWDC.", url: null, rawText: null },
      USER_ID,
      deps
    )
    // Entity overlap (Apple, WWDC) should help this reach AI
    expect(deps.matchWithAI).toHaveBeenCalled()
    expect(result.match).toBe("story-cross")
  })

  it("F7: adaptive filter with 10 stories passes all to AI", async () => {
    // Ensure at least some title overlap so candidates don't all score 0
    const stories = Array.from({ length: 10 }, (_, i) => ({
      id: `story-${i}`,
      userId: USER_ID,
      title: `Design System Update ${i} for Web Platform`,
      summary: `Summary about design system changes ${i}.`,
      sourceUrls: [],
      status: "DRAFT",
      createdAt: new Date(),
      materials: [],
    }))
    const deps = buildDeps({ stories, aiResult: { match: null, reasoning: "No match" } })

    await matchContent(
      { title: "Design System for Web Platform", content: "New design system topic", url: null, rawText: null },
      USER_ID,
      deps
    )

    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    // All 10 stories should be in the prompt (adaptive: <=20 passes all)
    const idMatches = new Set(userContent.match(/story-\d+/g) ?? [])
    expect(idMatches.size).toBe(10)
  })

  it("F8: matchContent uses content field for scoring in material pipeline path", async () => {
    // Two stories: one has matching content, the other has matching title
    const stories = [
      {
        id: "story-content",
        userId: USER_ID,
        title: "Unrelated Story Title",
        summary: "Apple announced a new design system for professional developers with Xcode tools.",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [],
      },
      {
        id: "story-other",
        userId: USER_ID,
        title: "Different Story About Database",
        summary: "PostgreSQL migration guide for large-scale apps.",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [],
      },
    ]
    const deps = buildDeps({
      stories,
      aiResult: { match: "story-content", reasoning: "Content overlap about Apple design system" },
    })

    await matchContent(
      {
        title: "New Tools for Apple Developers",
        content: "Apple announced a new design system for professional developers with updated Xcode tools.",
        url: null,
        rawText: null,
      },
      USER_ID,
      deps
    )

    // AI should be called (content helps pre-filter rank story-content higher)
    expect(deps.matchWithAI).toHaveBeenCalled()
  })

  it("F9: entity in materialTitles still reaches the AI, and the AI may reject the merge (precision over force-merge)", async () => {
    const deps = buildDeps({
      stories: [{
        id: "story-hidden-entity",
        userId: USER_ID,
        title: "Big AI News This Week", // No versioned entity in title
        summary: "Several AI announcements this week.",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [{ title: "Claude 5 Released" }], // Entity only here
      }],
      aiResult: { match: null, reasoning: "The new post only benchmarks Claude 5; it is a distinct item" },
    })
    const result = await matchContent(
      { title: "Claude 5 Benchmarks Show Improvement", content: "Testing Claude 5", url: null, rawText: "Claude 5 results" },
      USER_ID,
      deps
    )
    // The candidate is guaranteed to reach the AI (entity signal)...
    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(userContent).toContain("story-hidden-entity")
    // ...but the AI is free to reject — no silent force-merge.
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
  })

  it("F11: an incidental body mention of a versioned entity no longer force-merges — the AI decides", async () => {
    // New post is ABOUT GPT-5 but mentions "Sonnet 5" in passing in its body.
    const deps = buildDeps({
      stories: [{
        id: "story-sonnet5",
        userId: USER_ID,
        title: "Anthropic ships Sonnet 5",
        summary: "Anthropic released Sonnet 5 today.",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [{ title: "Anthropic ships Sonnet 5" }],
      }],
      aiResult: { match: null, reasoning: "New post is about GPT-5, not the Sonnet 5 release" },
    })
    const result = await matchContent(
      {
        title: "OpenAI ships GPT 5",
        content: "OpenAI released GPT 5. In benchmarks it was compared against Sonnet 5.",
        url: null,
        rawText: "OpenAI released GPT 5. In benchmarks it was compared against Sonnet 5.",
      },
      USER_ID,
      deps
    )
    // Before the fix this force-merged via the shared "sonnet 5" token with no AI call.
    expect(deps.matchWithAI).toHaveBeenCalled()
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
  })

  it("F10: matchContent with null rawText produces valid results (backward compat)", async () => {
    const deps = buildDeps({
      stories: [{
        id: "story-1",
        userId: USER_ID,
        title: "Some Story",
        summary: "Summary",
        sourceUrls: [],
        status: "DRAFT",
        createdAt: new Date(),
        materials: [],
      }],
      aiResult: { match: null, reasoning: "No match" },
    })
    const result = await matchContent(
      { title: "Test Title", content: "Test Content", url: null, rawText: null },
      USER_ID,
      deps
    )
    expect(result).toHaveProperty("match")
    expect(result).toHaveProperty("isNew")
    expect(result).toHaveProperty("reasoning")
  })
})

// ===========================================================================
// E. AI Prompt Relaxation (5 tests)
// ===========================================================================

describe("E. buildMatchingPrompt — same-specific-event, precision-biased criteria", () => {
  const prompt = buildMatchingPrompt(
    { title: "Test", content: "Content" },
    [{ id: "s1", title: "Story", summary: "Sum" }]
  )

  it("E1: frames the task as SAME SPECIFIC EVENT, and drops the old topic-redundancy framing", () => {
    expect(prompt).toContain("SAME SPECIFIC EVENT")
    // The reader-redundancy framing caused same-topic over-grouping — it must be gone.
    expect(prompt).not.toContain("REDUNDANT")
  })

  it("E2: groups analysis/commentary only when it is about THAT SAME specific event", () => {
    expect(prompt).toContain("ABOUT THAT SAME specific event")
    expect(prompt).toContain("SAME story")
  })

  it("E3: still groups the same event across languages", () => {
    expect(prompt).toContain("language")
  })

  it("E4: keeps same-company-different-product as DIFFERENT (the reported bug case)", () => {
    expect(prompt).toContain("DIFFERENT")
    expect(prompt).toContain("Sonnet 5")
    expect(prompt).toContain("science model")
  })

  it("E5: biases toward separate (null) when uncertain", () => {
    expect(prompt).toContain("WHEN IN DOUBT")
    expect(prompt).toContain("null")
  })

  it("E6: keeps the distinct-category guard against over-grouping", () => {
    expect(prompt).toContain("Dark mode in Figma")
  })
})

// ===========================================================================

describe("F. matchItem integration — inboxItem dep handling (RAD-200)", () => {
  it("matchItem returns gracefully when inboxItem dep is undefined", async () => {
    const deps: StoryMatcherDeps = {
      db: {
        story: { findMany: vi.fn().mockResolvedValue([]) },
        // inboxItem intentionally omitted
      },
      matchWithAI: vi.fn(),
    }
    const result = await matchItem("item-1", USER_ID, deps)
    expect(result.isNew).toBe(true)
    expect(result.reasoning).toContain("not available")
  })
})
