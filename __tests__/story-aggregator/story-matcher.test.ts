/**
 * Story Matcher tests — TDD RED phase
 *
 * These tests import from lib/story-aggregator/story-matcher.ts, which does NOT exist yet.
 * All tests are expected to FAIL until the implementation is written.
 *
 * Spec reference: the Story Aggregator specification section 4.3 (Story Matching)
 *
 * Exports under test:
 *   PreFilterCandidate interface
 *   computeSimilarityScore(newItem, candidate) => number (0-1)
 *   preFilterCandidates(newItem, stories, maxCandidates?) => PreFilterCandidate[]
 *   StoryMatcherDeps interface
 *   matchItem(itemId, userId, deps) => Promise<{ match: string | null, isNew: boolean, reasoning: string }>
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  computeSimilarityScore,
  preFilterCandidates,
  matchItem,
  matchContent,
  extractKeyEntities,
  extractVersionedEntities,
  type PreFilterCandidate,
  type StoryMatcherDeps,
  type MaterialCandidate,
} from "@/lib/story-aggregator/story-matcher"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "clx_user_001"
const ITEM_ID = "clx_inbox_001"
const STORY_ID_A = "clx_story_aaa"
const STORY_ID_B = "clx_story_bbb"

/** A typical new inbox item for matching */
const mockNewItem = {
  title: "Anthropic releases Claude 5 with new reasoning capabilities",
  content: "Anthropic announced the release of Claude 5, featuring enhanced reasoning.",
  extractedUrl: "https://anthropic.com/news/claude-5",
}

/** A candidate story that closely matches the new item (same event) */
const mockMatchingCandidate: PreFilterCandidate = {
  id: STORY_ID_A,
  title: "Anthropic Releases Claude 5",
  summary: "Anthropic unveiled Claude 5 with improved reasoning and multimodal capabilities.",
  sourceUrls: ["https://anthropic.com/blog/claude-5"],
  score: 0,
}

/** A candidate story that is unrelated to the new item */
const mockUnrelatedCandidate: PreFilterCandidate = {
  id: STORY_ID_B,
  title: "Dark mode typography trends in 2026",
  summary: "Designers are embracing dark themes with variable fonts for accessibility.",
  sourceUrls: ["https://typography.news/dark-mode-2026"],
  score: 0,
}

/** InboxItem as returned by db.inboxItem.findUnique */
const mockInboxItem = {
  id: ITEM_ID,
  userId: USER_ID,
  extractedTitle: "Anthropic releases Claude 5 with new reasoning capabilities",
  extractedContent: "Anthropic announced the release of Claude 5, featuring enhanced reasoning.",
  extractedUrl: "https://anthropic.com/news/claude-5",
  rawText: "Anthropic releases Claude 5",
}

/** Story as returned by db.story.findMany */
const mockStoryRecord = {
  id: STORY_ID_A,
  userId: USER_ID,
  title: "Anthropic Releases Claude 5",
  summary: "Anthropic unveiled Claude 5 with improved reasoning and multimodal capabilities.",
  sourceUrls: ["https://anthropic.com/blog/claude-5"],
  status: "DRAFT",
  createdAt: new Date("2026-02-10T10:00:00Z"),
}

const mockUnrelatedStoryRecord = {
  id: STORY_ID_B,
  userId: USER_ID,
  title: "Dark mode typography trends in 2026",
  summary: "Designers are embracing dark themes with variable fonts for accessibility.",
  sourceUrls: ["https://typography.news/dark-mode-2026"],
  status: "SENT_TO_NOTION",
  createdAt: new Date("2026-02-12T08:00:00Z"),
}

// ---------------------------------------------------------------------------
// Factory: build a fully-mocked StoryMatcherDeps object
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<StoryMatcherDeps> = {}): StoryMatcherDeps {
  return {
    db: {
      story: {
        findMany: vi.fn().mockResolvedValue([mockStoryRecord, mockUnrelatedStoryRecord]),
      },
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(mockInboxItem),
      },
    },
    matchWithAI: vi.fn().mockResolvedValue({
      match: STORY_ID_A,
      reasoning: "Both items refer to the same Anthropic Claude 5 release event.",
    }),
    ...overrides,
  }
}

// ===========================================================================
// 1. computeSimilarityScore — lightweight pre-filter scoring (spec 4.3)
// ===========================================================================

describe("computeSimilarityScore — lightweight similarity scoring (spec 4.3)", () => {
  it("returns a score between 0 and 1 for any two items", () => {
    // Arrange
    const newItem = {
      title: "Anthropic releases Claude 5",
      extractedUrl: "https://anthropic.com/news/claude-5",
    }

    // Act
    const score = computeSimilarityScore(newItem, mockMatchingCandidate)

    // Assert
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it("returns a higher score for items with high title word overlap than unrelated items", () => {
    // Arrange
    const newItem = {
      title: "Anthropic releases Claude 5 with new reasoning capabilities",
      extractedUrl: "https://anthropic.com/news/claude-5",
    }

    // Act: score against the matching candidate vs the unrelated one
    const highScore = computeSimilarityScore(newItem, mockMatchingCandidate)
    const lowScore = computeSimilarityScore(newItem, mockUnrelatedCandidate)

    // Assert: same-event story should score significantly higher
    expect(highScore).toBeGreaterThan(lowScore)
  })

  it("is case-insensitive when comparing titles", () => {
    // Arrange
    const newItemLower = {
      title: "anthropic releases claude 5",
      extractedUrl: null,
    }
    const newItemUpper = {
      title: "ANTHROPIC RELEASES CLAUDE 5",
      extractedUrl: null,
    }

    // Act
    const scoreLower = computeSimilarityScore(newItemLower, mockMatchingCandidate)
    const scoreUpper = computeSimilarityScore(newItemUpper, mockMatchingCandidate)

    // Assert: scores must be equal regardless of case
    expect(scoreLower).toBe(scoreUpper)
  })

  it("gives a bonus when a source URL domain matches a candidate's sourceUrls domain", () => {
    // Arrange: new item from anthropic.com — candidate also has anthropic.com
    const newItemSameDomain = {
      title: "Something about Anthropic",
      extractedUrl: "https://anthropic.com/blog/some-post",
    }
    const newItemDifferentDomain = {
      title: "Something about Anthropic",
      extractedUrl: "https://techcrunch.com/2026/anthropic-claude",
    }

    // Act
    const scoreSameDomain = computeSimilarityScore(newItemSameDomain, mockMatchingCandidate)
    const scoreDifferentDomain = computeSimilarityScore(
      newItemDifferentDomain,
      mockMatchingCandidate
    )

    // Assert: same domain should receive a bonus
    expect(scoreSameDomain).toBeGreaterThan(scoreDifferentDomain)
  })

  it("ignores common stop words (the, and, is, for, with) when computing word overlap", () => {
    // Arrange: two items that only share stop words — score should be low
    const newItem = {
      title: "the and is for with",
      extractedUrl: null,
    }
    const candidateOnlyStopWords: PreFilterCandidate = {
      id: "stop-word-story",
      title: "the and is for with",
      summary: "Generic filler text.",
      sourceUrls: [],
      score: 0,
    }
    const candidateWithRealWords: PreFilterCandidate = {
      id: "real-word-story",
      title: "the and is for with typography design",
      summary: "A story about design.",
      sourceUrls: [],
      score: 0,
    }

    // Act
    const scoreOnlyStopWords = computeSimilarityScore(newItem, candidateOnlyStopWords)
    const scoreWithRealWords = computeSimilarityScore(newItem, candidateWithRealWords)

    // Assert: only-stop-words overlap should yield a very low (ideally 0) meaningful overlap score
    expect(scoreOnlyStopWords).toBeLessThanOrEqual(scoreWithRealWords)
  })
})

// ===========================================================================
// 2. preFilterCandidates — top-N pre-filter (spec 4.3)
// ===========================================================================

describe("preFilterCandidates — top-N candidate selection (spec 4.3)", () => {
  it("returns the top maxCandidates stories sorted by score descending", () => {
    // Arrange
    const newItem = {
      title: "Anthropic releases Claude 5",
      extractedUrl: "https://anthropic.com/news/claude-5",
    }
    const stories: PreFilterCandidate[] = [
      { ...mockMatchingCandidate, score: 0 },
      { ...mockUnrelatedCandidate, score: 0 },
    ]

    // Act
    const result = preFilterCandidates(newItem, stories, 15)

    // Assert: result is sorted by score descending
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].score).toBeGreaterThanOrEqual(result[i + 1].score)
    }
  })

  it("returns at most maxCandidates items when more stories exist", () => {
    // Arrange: build 20 candidate stories
    const newItem = { title: "Any story title here", extractedUrl: null }
    const stories: PreFilterCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `story-${i}`,
      title: `Story number ${i} about random design topic`,
      summary: `Summary for story ${i}.`,
      sourceUrls: [],
      score: 0,
    }))

    // Act
    const result = preFilterCandidates(newItem, stories, 15)

    // Assert: capped at 15 (default per spec)
    expect(result.length).toBeLessThanOrEqual(15)
  })

  it("returns an empty array when given no stories", () => {
    // Arrange
    const newItem = { title: "Any story title here", extractedUrl: null }

    // Act
    const result = preFilterCandidates(newItem, [], 15)

    // Assert
    expect(result).toEqual([])
  })

  it("each returned candidate has a score property populated by computeSimilarityScore", () => {
    // Arrange
    const newItem = {
      title: "Anthropic releases Claude 5",
      extractedUrl: "https://anthropic.com/news/claude-5",
    }
    const stories: PreFilterCandidate[] = [
      { ...mockMatchingCandidate, score: 0 },
    ]

    // Act
    const result = preFilterCandidates(newItem, stories, 15)

    // Assert: score should be set (not still 0 from the input fixture)
    expect(result).toHaveLength(1)
    expect(typeof result[0].score).toBe("number")
    // The score computation must have run (score is between 0 and 1)
    expect(result[0].score).toBeGreaterThanOrEqual(0)
    expect(result[0].score).toBeLessThanOrEqual(1)
  })
})

// ===========================================================================
// 3. matchItem — full matching orchestration (spec 4.3)
// ===========================================================================

describe("matchItem — full matching orchestration (spec 4.3)", () => {
  // Use non-versioned titles to bypass URL and entity shortcuts, forcing AI path
  const noVersionInboxItem = {
    ...mockInboxItem,
    extractedTitle: "New design system enforcement practices emerge",
    extractedContent: "Major companies are rethinking how they enforce design systems.",
    extractedUrl: "https://designnews.com/enforcement",
    rawText: "New design system enforcement practices emerge",
  }
  const noVersionStoryA = {
    ...mockStoryRecord,
    title: "Design system enforcement trends gaining traction",
    summary: "Companies push for stricter design system enforcement.",
    sourceUrls: ["https://uxinsight.com/enforcement-trends"],
  }

  it("happy path: fetches inbox item, fetches recent stories, calls AI, returns match result", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(noVersionInboxItem)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([noVersionStoryA, mockUnrelatedStoryRecord])

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: item was fetched
    expect(deps.db.inboxItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ITEM_ID } })
    )

    // Assert: recent stories were fetched for the same userId
    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      })
    )

    // Assert: AI was called and result reflects the match
    expect(deps.matchWithAI).toHaveBeenCalledOnce()
    expect(result.match).toBe(STORY_ID_A)
    expect(result.isNew).toBe(false)
    expect(typeof result.reasoning).toBe("string")
  })

  it("returns { match: null, isNew: true } without calling AI when no existing stories exist", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: AI must NOT be called — no candidates to evaluate
    expect(deps.matchWithAI).not.toHaveBeenCalled()
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
  })

  it("queries only stories from the last 30 days with DRAFT or SENT_TO_NOTION status (spec 4.3)", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: stories query must filter by status and date range
    const callArgs = (deps.db.story.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.where.status).toEqual(
      expect.objectContaining({ in: expect.arrayContaining(["DRAFT", "SENT_TO_NOTION"]) })
    )
    // createdAt must filter to the last 30 days
    expect(callArgs.where.createdAt).toBeDefined()
    expect(callArgs.where.createdAt.gte).toBeInstanceOf(Date)
  })

  it("returns { match: null, isNew: true, reasoning } when AI returns no match", async () => {
    // Arrange: use non-versioned fixtures to reach AI path
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(noVersionInboxItem)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([noVersionStoryA, mockUnrelatedStoryRecord])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: null,
      reasoning: "This is a completely new topic not covered by any existing story.",
    })

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
    expect(result.reasoning).toContain("new topic")
  })

  it("returns { match: null, isNew: true, reasoning: 'AI output invalid' } when AI returns unparseable output", async () => {
    // Arrange: use non-versioned fixtures to reach AI path
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(noVersionInboxItem)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([noVersionStoryA, mockUnrelatedStoryRecord])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      unexpectedField: "this is not valid matching output",
    })

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: graceful degradation — treat as new item
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
    expect(result.reasoning).toBe("AI output invalid")
  })

  it("pre-filters candidates using adaptive limits before calling AI", async () => {
    // Arrange: seed 60 stories — with >50 stories, adaptive limit is 15
    const deps = buildDeps()
    const manyStories = Array.from({ length: 60 }, (_, i) => ({
      id: `story-${i}`,
      userId: USER_ID,
      title: `Story ${i}: Design topic number ${i}`,
      summary: `Summary for story ${i} about design.`,
      sourceUrls: [`https://example.com/story-${i}`],
      status: "DRAFT",
      createdAt: new Date("2026-02-15T10:00:00Z"),
    }))
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(manyStories)

    // Act
    await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: with >50 stories, adaptive limit is 15
    expect(deps.matchWithAI).toHaveBeenCalledOnce()
    const [_systemPrompt, userContent] = (
      deps.matchWithAI as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string]
    const idMatches = (userContent.match(/story-\d+/g) ?? [])
    const uniqueIds = new Set(idMatches)
    expect(uniqueIds.size).toBeLessThanOrEqual(15)
  })
})

// ===========================================================================
// 4. computeSimilarityScore — Cyrillic / Russian text support (Bug #1)
// ===========================================================================

describe("computeSimilarityScore — Cyrillic / Russian text support (Bug #1)", () => {
  it("two Russian titles with overlapping words return a score > 0", () => {
    // "Интервью с Павлом Дуровым" vs "Беседа с Павлом Дуровым"
    // meaningful shared tokens: "павлом" and "дуровым"
    // Currently FAILS because tokenize() strips all Cyrillic via /[^a-z0-9\s]/g
    const newItem = {
      title: "Интервью с Павлом Дуровым",
      extractedUrl: null,
    }
    const candidate: PreFilterCandidate = {
      id: "ru-story-001",
      title: "Беседа с Павлом Дуровым",
      summary: "Расширенная беседа с основателем Telegram.",
      sourceUrls: [],
      score: 0,
    }

    const score = computeSimilarityScore(newItem, candidate)

    // Expect non-zero overlap on "Павлом" and "Дуровым"
    expect(score).toBeGreaterThan(0)
  })

  it("common Russian function words are treated as stop words and do not inflate scores", () => {
    // If only stop words overlap, score must stay at 0 (or equal to a zero-overlap pair)
    // Russian stop words: "с", "и", "в", "на", "о", "по", "из", "за", "как", "что", "это", "для"
    const stopWordOnlyItem = {
      title: "с и в на о по из за как что это для",
      extractedUrl: null,
    }
    const candidateStopWords: PreFilterCandidate = {
      id: "ru-stop-words-only",
      title: "с и в на о по из за как что это для",
      summary: "Только стоп-слова.",
      sourceUrls: [],
      score: 0,
    }
    const candidateWithMeaningfulWord: PreFilterCandidate = {
      id: "ru-meaningful",
      title: "с и в дизайн",
      summary: "Стоп-слова плюс значимое слово.",
      sourceUrls: [],
      score: 0,
    }

    const scoreStopOnly = computeSimilarityScore(stopWordOnlyItem, candidateStopWords)
    const scoreMeaningful = computeSimilarityScore(stopWordOnlyItem, candidateWithMeaningfulWord)

    // Stop-word-only pair should score no higher than a pair that adds a meaningful word
    // (ideally 0 — stop words are filtered out, so no meaningful intersection)
    expect(scoreStopOnly).toBeLessThanOrEqual(scoreMeaningful)
    expect(scoreStopOnly).toBe(0)
  })

  it("mixed Russian+English: Cyrillic shared word 'плагин' raises score vs a pair without it", () => {
    // "плагин Figma" vs "Новый плагин Figma" — share BOTH "figma" AND "плагин"
    // "инструмент Figma" vs "Новый плагин Figma" — share only "figma"
    // With Cyrillic support the first pair should score higher because "плагин" adds overlap.
    // Currently FAILS because tokenize() strips "плагин" in both titles to nothing,
    // making the two pairs identical (score depends only on "figma").
    const candidateMixed: PreFilterCandidate = {
      id: "mixed-story-001",
      title: "Новый плагин Figma",
      summary: "Обзор нового плагина для Figma.",
      sourceUrls: [],
      score: 0,
    }

    const itemWithCyrillicOverlap = {
      title: "плагин Figma для дизайнеров",   // shares "figma" + "плагин"
      extractedUrl: null,
    }
    const itemWithoutCyrillicOverlap = {
      title: "инструмент Figma для дизайнеров", // shares only "figma"
      extractedUrl: null,
    }

    const scoreWithOverlap = computeSimilarityScore(itemWithCyrillicOverlap, candidateMixed)
    const scoreWithout = computeSimilarityScore(itemWithoutCyrillicOverlap, candidateMixed)

    // The pair that shares both "figma" AND "плагин" must score strictly higher
    expect(scoreWithOverlap).toBeGreaterThan(scoreWithout)
  })
})

// ===========================================================================
// 5. matchItem — URL exact-match shortcut (most important dedup signal)
// ===========================================================================

describe("matchItem — URL exact-match shortcut", () => {
  it("returns immediate match when extractedUrl matches a story's sourceUrls, without calling AI", async () => {
    // Arrange: inbox item has same URL as existing story
    const inboxItemWithSameUrl = {
      ...mockInboxItem,
      extractedUrl: "https://anthropic.com/blog/claude-5", // matches mockStoryRecord.sourceUrls[0]
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(inboxItemWithSameUrl)

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: matched by URL — AI must NOT be called
    expect(result.match).toBe(STORY_ID_A)
    expect(result.isNew).toBe(false)
    expect(result.reasoning).toContain("URL")
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("URL match is case-insensitive and ignores trailing slashes", async () => {
    const inboxItemWithVariantUrl = {
      ...mockInboxItem,
      extractedUrl: "https://Anthropic.com/blog/claude-5/", // trailing slash + uppercase
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(inboxItemWithVariantUrl)

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    expect(result.match).toBe(STORY_ID_A)
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("falls through to AI matching when URLs don't match", async () => {
    // Arrange: inbox item has a different URL and no versioned entity overlap with stories
    const inboxItemDifferentUrl = {
      ...mockInboxItem,
      extractedTitle: "New design system enforcement practices emerge",
      extractedUrl: "https://techcrunch.com/some-other-article",
      rawText: "New design system enforcement practices",
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(inboxItemDifferentUrl)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockStoryRecord, title: "Design enforcement trends", sourceUrls: ["https://other.com/article"] },
      mockUnrelatedStoryRecord,
    ])

    // Act
    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Assert: no URL match, no entity match → AI was called for semantic matching
    expect(deps.matchWithAI).toHaveBeenCalledOnce()
  })

  it("falls through to AI matching when extractedUrl is null", async () => {
    // Use non-versioned titles to ensure entity shortcut doesn't fire
    const inboxItemNoUrl = {
      ...mockInboxItem,
      extractedTitle: "New design system enforcement practices emerge",
      extractedUrl: null,
      rawText: "New design system enforcement practices",
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(inboxItemNoUrl)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...mockStoryRecord, title: "Design enforcement trends", sourceUrls: [] },
      mockUnrelatedStoryRecord,
    ])

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    expect(deps.matchWithAI).toHaveBeenCalledOnce()
  })
})

// ===========================================================================
// 6. extractVersionedEntities — product name + version extraction
// ===========================================================================

describe("extractVersionedEntities — product name + version extraction", () => {
  it("extracts 'gemini 3.1' from 'Gemini 3.1 Pro: A smarter model'", () => {
    const entities = extractVersionedEntities("Gemini 3.1 Pro: A smarter model")
    expect(entities).toContainEqual(expect.stringContaining("gemini 3.1"))
  })

  it("extracts 'seedance 2.0' from 'Seedance 2.0 — как получить доступ'", () => {
    const entities = extractVersionedEntities("Seedance 2.0 — как получить доступ")
    expect(entities).toContainEqual(expect.stringContaining("seedance 2.0"))
  })

  it("extracts 'claude 5' from 'Anthropic releases Claude 5 with reasoning'", () => {
    const entities = extractVersionedEntities("Anthropic releases Claude 5 with reasoning")
    expect(entities).toContainEqual(expect.stringContaining("claude 5"))
  })

  it("extracts 'react 19' from 'What is new in React 19'", () => {
    const entities = extractVersionedEntities("What is new in React 19")
    expect(entities).toContainEqual(expect.stringContaining("react 19"))
  })

  it("extracts entity with known qualifier: 'gemini 3.1 pro' (Pro is a product qualifier)", () => {
    const entities = extractVersionedEntities("Google released Gemini 3.1 Pro today")
    expect(entities).toContain("gemini 3.1 pro")
  })

  it("distinguishes 'gemini 3.1 pro' from 'gemini 3.1 flash' (different qualifiers)", () => {
    const proEntities = extractVersionedEntities("Gemini 3.1 Pro benchmark results")
    const flashEntities = extractVersionedEntities("Gemini 3.1 Flash is faster")
    // Both should have base entity, but with different qualifiers
    expect(proEntities).toContain("gemini 3.1 pro")
    expect(flashEntities).toContain("gemini 3.1 flash")
    // They should NOT share the qualified entity
    expect(proEntities).not.toContain("gemini 3.1 flash")
  })

  it("skips false positives like 'Figure 3', 'Step 2', 'Version 4'", () => {
    const entities = extractVersionedEntities("See Figure 3 and Step 2. Version 4 is coming.")
    // None of these should produce entities
    expect(entities).toEqual([])
  })

  it("returns empty array for text with no versioned products", () => {
    const entities = extractVersionedEntities("Dark mode typography trends in design")
    expect(entities).toEqual([])
  })

  it("handles multiple entities in one text", () => {
    const entities = extractVersionedEntities("Comparing Claude 5 vs GPT 5 performance")
    expect(entities.length).toBeGreaterThanOrEqual(2)
    expect(entities).toContainEqual(expect.stringContaining("claude 5"))
    expect(entities).toContainEqual(expect.stringContaining("gpt 5"))
  })

  it("is case-insensitive: 'GEMINI 3.1 PRO' produces same entity as 'Gemini 3.1 Pro'", () => {
    const upper = extractVersionedEntities("GEMINI 3.1 PRO released")
    const lower = extractVersionedEntities("gemini 3.1 pro released")
    expect(upper).toEqual(lower)
  })

  // RAD-322 — \b never fires before a Cyrillic word: Cyrillic letters are not
  // \w in JS, so a versioned Cyrillic product name was invisible.
  it("extracts 'ии 5' from 'ИИ 5 вышла' (Cyrillic name, \\b never fires)", () => {
    const entities = extractVersionedEntities("ИИ 5 вышла")
    expect(entities).toContain("ии 5")
  })

  it("extracts 'яндекс 2.0' from 'Яндекс 2.0'", () => {
    const entities = extractVersionedEntities("Яндекс 2.0")
    expect(entities).toContain("яндекс 2.0")
  })

  it("still extracts 'seedance 2.0' from a Latin name (regression)", () => {
    const entities = extractVersionedEntities("Seedance 2.0 — how to get access")
    expect(entities).toContain("seedance 2.0")
  })

  it("does not split a name when a Cyrillic letter directly precedes it (boundary must not fire mid-word)", () => {
    const entities = extractVersionedEntities("суперИИ 5 вышла")
    // The whole glued token is the name — "ии 5" alone would mean the
    // boundary incorrectly fired between "р" and "И".
    expect(entities).toContain("суперии 5")
    expect(entities).not.toContain("ии 5")
  })

  // Once Cyrillic names are visible, a preposition or a date word before a
  // number must not pass for a product: "в 2026 году" is in half of all
  // Russian posts and would make any two of them share a "versioned entity".
  it.each([
    ["В 2026 году вышло обновление"],
    ["До 5 раз быстрее"],
    ["на 20% выше"],
    ["около 100 тыс. пользователей"],
    ["релиз 14 января 2026"],
    ["Версия 2 уже доступна"],
  ])("finds no product in the Russian number phrase %j", (text) => {
    expect(extractVersionedEntities(text)).toEqual([])
  })

  it("finds no product in an English preposition before a year", () => {
    expect(extractVersionedEntities("Launched in 2025 to the public")).toEqual([])
  })
})

// ===========================================================================
// 7. matchItem — versioned entity signal (routes to the AI, no longer force-merges)
// ===========================================================================

describe("matchItem — versioned entity signal", () => {
  it("routes a shared-versioned-entity candidate to the AI (no force-merge) and returns the AI's match", async () => {
    // New item about "Seedance 2.0", existing story also about "Seedance 2.0".
    const deps = buildDeps({
      matchWithAI: vi.fn().mockResolvedValue({
        match: "story-seedance",
        reasoning: "Both cover the same Seedance 2.0 release",
      }),
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItem,
      extractedTitle: "Тесты Seedance 2.0: text-to-video генерация",
      extractedContent: "Разбираемся с Seedance 2.0",
      extractedUrl: null, // no URL → URL shortcut won't help
      rawText: "Тесты Seedance 2.0",
    })
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockStoryRecord,
        id: "story-seedance",
        title: "Seedance 2.0 — как получить доступ к новой SOTA-видеогенерации",
        summary: "Обзор Seedance 2.0",
        sourceUrls: ["https://t.me/channel/123"],
      },
      mockUnrelatedStoryRecord,
    ])

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // The entity is now a strong signal the AI decides on — not a silent force-merge.
    expect(deps.matchWithAI).toHaveBeenCalled()
    expect(result.match).toBe("story-seedance")
    expect(result.isNew).toBe(false)
  })

  it("guarantees the shared-entity candidate is included in the AI prompt, and the AI's verdict wins", async () => {
    // English post about "Gemini 3.1 Pro", Russian story about "Gemini 3.1 Pro".
    const deps = buildDeps({
      matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "different event" }),
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItem,
      extractedTitle: "Gemini 3.1 Pro: A smarter model for your most complex tasks",
      extractedContent: "Google released Gemini 3.1 Pro with enhanced capabilities",
      extractedUrl: null,
      rawText: null,
    })
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockStoryRecord,
        id: "story-gemini",
        title: "Gemini 3.1 Pro — обновленная модель от Google",
        summary: "Обзор Gemini 3.1 Pro от Google",
        sourceUrls: ["https://t.me/ainews/456"],
      },
      mockUnrelatedStoryRecord,
    ])

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(userContent).toContain("story-gemini")
    // The AI is free to reject the merge — precision over force-merge.
    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
  })

  it("does NOT flag an entity signal when entities differ by qualifier (Gemini 3.1 Pro vs Gemini 3.1 Flash)", async () => {
    const deps = buildDeps({
      matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "different qualifier" }),
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItem,
      extractedTitle: "Gemini 3.1 Flash benchmarks",
      extractedContent: "Testing Gemini 3.1 Flash performance",
      extractedUrl: null,
      rawText: "Gemini 3.1 Flash benchmarks",
    })
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockStoryRecord,
        id: "story-gemini-pro",
        title: "Gemini 3.1 Pro — обновленная модель",
        summary: "Обзор Gemini 3.1 Pro",
        sourceUrls: [],
      },
    ])

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // Different qualifiers mean different products → AI decides, and here rejects.
    expect(deps.matchWithAI).toHaveBeenCalled()
    expect(result.match).toBeNull()
  })

  it("falls through to AI when no versioned entities are found in the new item", async () => {
    const deps = buildDeps({
      matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "no match" }),
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItem,
      extractedTitle: "Interesting thoughts on typography and dark themes",
      extractedContent: "A deep dive into modern typography trends",
      extractedUrl: null,
      rawText: "Interesting thoughts on typography",
    })

    const result = await matchItem(ITEM_ID, USER_ID, deps)

    // No versioned entities → falls through to AI
    expect(deps.matchWithAI).toHaveBeenCalled()
  })
})

// ===========================================================================
// matchContent — unified story + standalone-material matching
// ===========================================================================

describe("matchContent — story + standalone-material candidates", () => {
  // A new post that shares title-token signal with a candidate material but has
  // NO versioned entity and NO shared URL → must reach the AI matcher.
  const newPost = {
    title: "OpenAI launches new image model for designers",
    content: "OpenAI announced a new image generation model aimed at designers.",
    url: "https://openai.com/news/image-model",
    rawText: null,
  }
  const relatedMaterial: MaterialCandidate = {
    id: "mat_partner_001",
    title: "OpenAI unveils image generation model",
    content: "The new OpenAI image model is now available for designers and creators.",
    url: "https://verge.com/openai-image-model",
  }
  const unrelatedMaterial: MaterialCandidate = {
    id: "mat_unrelated_001",
    title: "Quarterly municipal water bond financing report",
    content: "City council reviewed the quarterly bond financing for water infrastructure.",
    url: "https://gov.example/water-bonds",
  }

  function storiesOnlyDeps(stories: unknown[] = []): StoryMatcherDeps {
    return {
      db: { story: { findMany: vi.fn().mockResolvedValue(stories) } },
      matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "no match" }),
    } as unknown as StoryMatcherDeps
  }

  it("returns matchType 'material' when the AI matches a standalone candidate material", async () => {
    const deps = storiesOnlyDeps([])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: relatedMaterial.id,
      reasoning: "Same OpenAI image-model announcement",
    })

    const result = await matchContent(newPost, USER_ID, deps, {
      candidateMaterials: [relatedMaterial, unrelatedMaterial],
    })

    expect(result.match).toBe(relatedMaterial.id)
    expect(result.matchType).toBe("material")
    expect(deps.matchWithAI).toHaveBeenCalled()
  })

  it("returns matchType 'story' when the AI matches an existing story", async () => {
    const deps = storiesOnlyDeps([mockStoryRecord])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: STORY_ID_A,
      reasoning: "Same Claude 5 release",
    })

    const result = await matchContent(
      { title: "Anthropic ships Claude 5", content: "Claude 5 is here.", url: "https://x.com/c5", rawText: null },
      USER_ID,
      deps,
      { candidateMaterials: [relatedMaterial] }
    )

    expect(result.match).toBe(STORY_ID_A)
    expect(result.matchType).toBe("story")
  })

  it("URL-exact shortcut matches a candidate material without calling the AI", async () => {
    const deps = storiesOnlyDeps([])
    const sameUrlMaterial: MaterialCandidate = {
      id: "mat_sameurl_001",
      title: "Different headline, same link",
      content: "...",
      url: "https://openai.com/news/image-model/", // trailing slash → normalizes equal
    }

    const result = await matchContent(newPost, USER_ID, deps, {
      candidateMaterials: [sameUrlMaterial],
    })

    expect(result.match).toBe(sameUrlMaterial.id)
    expect(result.matchType).toBe("material")
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("routes a shared-versioned-entity candidate material to the AI (no force-merge), and returns the AI's match", async () => {
    const deps = storiesOnlyDeps([])
    const versionedMaterial: MaterialCandidate = {
      id: "mat_gemini_001",
      title: "Gemini 3.1 Pro benchmarks impress",
      content: "Google's Gemini 3.1 Pro tops the charts.",
      url: "https://blog.google/gemini-31-pro",
    }
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: versionedMaterial.id,
      reasoning: "Both cover the Gemini 3.1 Pro release",
    })

    const result = await matchContent(
      { title: "Обзор Gemini 3.1 Pro", content: "Новая модель Gemini 3.1 Pro.", url: "https://ru.example/g31", rawText: null },
      USER_ID,
      deps,
      { candidateMaterials: [versionedMaterial] }
    )

    // The entity is a signal the AI decides on — the candidate must reach the AI...
    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(userContent).toContain("mat_gemini_001")
    // ...and the AI's match is returned as a material pairing.
    expect(result.match).toBe(versionedMaterial.id)
    expect(result.matchType).toBe("material")
  })

  it("requireSignal skips the AI call when no candidate shares signal", async () => {
    const deps = storiesOnlyDeps([])

    const result = await matchContent(newPost, USER_ID, deps, {
      candidateMaterials: [unrelatedMaterial],
      requireSignal: true,
    })

    expect(result.match).toBeNull()
    expect(result.matchType).toBeNull()
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("rescues a story whose shared entity appears only in the material BODY (RAD-308)", async () => {
    // The materials pipeline calls matchContent with rawText: null, so the
    // versioned-entity signal must fall back to `content`. A Telegram post's
    // title is just its first line — the model name almost always sits in the
    // body. Production case (2026-09-08): two stories about the same
    // Navier-Stokes announcement that never merged, because the story was
    // truncated by the adaptive pre-filter and the entity rescue never fired.
    const story = {
      ...mockStoryRecord,
      id: "story-navier",
      title: "Решение проблемы Навье-Стокса с помощью ИИ",
      summary: "OpenAI опубликовали доказательство",
      sourceUrls: ["https://x.com/openai/1"],
      materials: [
        { title: "We're sharing a solution to the Navier-Stokes problem, produced by a model far more capable than GPT-6 Astra." },
      ],
    }
    // Enough near-duplicate noise to fill every adaptive top-N slot, so the
    // story can only reach the AI via the entity rescue.
    const noise: MaterialCandidate[] = Array.from({ length: 60 }, (_, i) => ({
      id: `mat_noise_${i}`,
      title: "OpenAI выложили решение задачи тысячелетия",
      content: "Подробности по ссылке.",
      url: `https://t.me/noise/${i}`,
    }))
    const deps = storiesOnlyDeps([story])

    await matchContent(
      {
        title: "OpenAI выложили решение задачи тысячелетия",
        content: "Модель называется GPT-6 Astra, и она решила задачу тысячелетия.",
        url: "https://t.me/data_secrets/9869",
        rawText: null, // exactly what material-story-pipeline passes
      },
      USER_ID,
      deps,
      { candidateMaterials: noise, requireSignal: true }
    )

    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(userContent).toContain("story-navier")
  })

  it("returns no match when there are neither stories nor candidate materials", async () => {
    const deps = storiesOnlyDeps([])

    const result = await matchContent(newPost, USER_ID, deps, { candidateMaterials: [] })

    expect(result.match).toBeNull()
    expect(result.matchType).toBeNull()
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })

  it("treats an AI-returned unknown id as no match", async () => {
    const deps = storiesOnlyDeps([])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: "id_we_never_offered",
      reasoning: "hallucinated",
    })

    const result = await matchContent(newPost, USER_ID, deps, {
      candidateMaterials: [relatedMaterial],
    })

    expect(result.match).toBeNull()
    expect(result.matchType).toBeNull()
  })
})

// ===========================================================================
// RAD-309 / RAD-316 — key-entity signal across scripts and candidate side
// ===========================================================================

describe("RAD-309 — extractKeyEntities across scripts", () => {
  it("extracts Cyrillic proper nouns and skips Russian sentence starters", () => {
    const entities = extractKeyEntities(
      "Яндекс представил нейросеть. Однако рынок ждал большего. Компания обещает запуск."
    )
    expect(entities.has("яндекс")).toBe(true)
    expect(entities.has("однако")).toBe(false)
    expect(entities.has("компания")).toBe(false)
  })

  it("extracts acronym and mixed-case brands the old Latin regex missed", () => {
    const entities = extractKeyEntities("OpenAI ships GPT-5 and SOTA video models")
    expect(entities.has("openai")).toBe(true)
    expect(entities.has("gpt")).toBe(true)
    expect(entities.has("sota")).toBe(true)
    expect(entities.has("gpt 5")).toBe(true) // versioned product, unchanged path
  })

  it("extracts Cyrillic acronyms and inner-capital names", () => {
    const entities = extractKeyEntities("ИИ и США лидируют. СберБанк запустил сервис.")
    expect(entities.has("ии")).toBe(true)
    expect(entities.has("сша")).toBe(true)
    expect(entities.has("сбербанк")).toBe(true)
  })

  it("extracts lowercase-initial inner-capital brands (iOS, iPhone)", () => {
    const entities = extractKeyEntities("iPad and iPhone apps ship with iOS every year")
    expect(entities.has("ipad")).toBe(true)
    expect(entities.has("iphone")).toBe(true)
    expect(entities.has("ios")).toBe(true)
  })

  it("does not turn long all-caps prose into entities", () => {
    expect(extractKeyEntities("RELEASES EVERYTHING").size).toBe(0)
  })

  it("skips generic abbreviations so two unrelated AI posts share no entity", () => {
    expect(extractKeyEntities("AI is great IMO").size).toBe(0)
    expect(extractKeyEntities("NEW: TOP AI tools").size).toBe(0)
  })

  it("keeps all-lowercase text entity-free (regression)", () => {
    expect(extractKeyEntities("this is all lowercase text without any numbers").size).toBe(0)
  })
})

describe("RAD-316 — candidate entities come from material titles", () => {
  const entityOnlyItem = {
    title: "Анонс нового видеогенератора",
    content: "OpenAI unveils Sora, its new video model.",
  }
  const storyNoTitles: PreFilterCandidate = {
    id: "story-entity-1",
    title: "Новости индустрии",
    summary: "Дайджест главного за неделю",
    sourceUrls: [],
    score: 0,
  }

  it("scores 0 when no candidate text shares anything, > 0 once material titles are read", () => {
    const storyWithTitles: PreFilterCandidate = {
      ...storyNoTitles,
      materialTitles: ["OpenAI unveils Sora video generator"],
    }

    expect(computeSimilarityScore(entityOnlyItem, storyNoTitles)).toBe(0)
    expect(computeSimilarityScore(entityOnlyItem, storyWithTitles)).toBeGreaterThan(0)
  })

  it("does not dilute a material-rich story below its title+summary-only score", () => {
    // Same shared entities either way; the extra material titles only grow the
    // Jaccard union, so a single joined candidate text would LOWER the score of
    // exactly the stories material titles are meant to help.
    const item = {
      title: "OpenAI Sora review",
      content: "OpenAI's Sora model generates video.",
    }
    const base: PreFilterCandidate = {
      id: "story-dilution-1",
      title: "OpenAI releases Sora",
      summary: "OpenAI video model",
      sourceUrls: [],
      score: 0,
    }
    const withTitles: PreFilterCandidate = {
      ...base,
      materialTitles: [
        "OpenAI introduces Sora model",
        "Google Veo benchmark comparison",
        "Meta Movie Gen announced",
        "Runway Gen-4 update",
      ],
    }

    expect(computeSimilarityScore(item, withTitles)).toBeGreaterThanOrEqual(
      computeSimilarityScore(item, base)
    )
  })

  it("rescues the story to the AI judge via the key-entity signal alone", async () => {
    const story = {
      ...mockStoryRecord,
      id: "story-openai-sora",
      title: "Новости индустрии",
      summary: "Дайджест главного за неделю",
      sourceUrls: ["https://t.me/tech/1"],
      materials: [{ title: "OpenAI unveils Sora video generator" }],
    }
    const deps = buildDeps({})
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([story])
    ;(deps.matchWithAI as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: null,
      reasoning: "different event",
    })

    const result = await matchContent(
      {
        title: "Анонс нового видеогенератора",
        content: "OpenAI unveils Sora, its new video model.",
        url: "https://example.com/sora", // different domain → no domain bonus
        rawText: null,
      },
      USER_ID,
      deps,
      { requireSignal: true }
    )

    expect(deps.matchWithAI).toHaveBeenCalled()
    const [, userContent] = (deps.matchWithAI as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string]
    expect(userContent).toContain("story-openai-sora")
    expect(result.isNew).toBe(true)
  })
})
