/**
 * TDD RED phase — evaluateMaterial N+1 fix (RAD-129)
 *
 * Feature: Refactor evaluateMaterial() to extract DB context fetching so that
 * evaluateMaterialsBatch() fetches context ONCE per batch instead of once per material.
 *
 * Criteria covered:
 *   AC-1: fetchEvaluationContext({sourceId, userId}) returns settings, source with feedbacks,
 *         userSettings, globalFeedbacks, and blacklist in a single call.
 *   AC-2: evaluateMaterialWithContext({material, context}) evaluates a material using
 *         pre-fetched context without any DB queries.
 *   AC-3: evaluateMaterialsBatch() calls fetchEvaluationContext() once, then calls
 *         evaluateMaterialWithContext() for each material.
 *   AC-4: evaluateMaterial() still works as a standalone convenience wrapper
 *         (fetches context + evaluates).
 *   AC-5: Blacklist check still happens per-material using the pre-fetched blacklist items.
 *   EC-1: Empty materials array passed to evaluateMaterialsBatch() returns empty array
 *         without any DB queries.
 *   EC-2: Context with no feedbacks (empty arrays) still produces valid evaluation prompt.
 *   ERR-1: If AI evaluation fails for one material in a batch, it throws for that material
 *          but doesn't affect the context (context is still valid for remaining materials).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  fetchEvaluationContext,
  evaluateMaterialWithContext,
  evaluateMaterialsBatch,
  evaluateMaterial,
  type EvaluationContext,
} from "@/lib/ai"

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by Vitest)
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn() },
    feed: { findUnique: vi.fn() },
    userSettings: { findUnique: vi.fn() },
    aIFeedback: { findMany: vi.fn() },
    blacklistItem: { findMany: vi.fn() },
  },
}))

vi.mock("ai", () => ({
  generateObject: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock declarations
// ---------------------------------------------------------------------------

import { db } from "@/lib/db"
import { generateObject } from "ai"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SOURCE_ID = "src_001"
const USER_ID = "user_001"

const mockSettings = {
  id: "settings_001",
  aiModel: "claude-sonnet-4-6",
  aiApiKey: "sk-test-key",
  aiTemperature: 0.3,
}

const mockSource = {
  id: SOURCE_ID,
  name: "TechSource",
  customPrompt: "Focus on TypeScript",
  likedCategories: ["Articles"],
  dislikedCategories: [],
  feedbacks: [],
}

const mockUserSettings = {
  userId: USER_ID,
  globalPrompt: "Only tech content",
}

const mockGlobalFeedbacks = [
  {
    id: "fb_001",
    isGlobal: true,
    userId: USER_ID,
    commentText: "Great deep-dive",
    feedbackType: "LIKE" as const,
    material: { title: "React 19", content: "Some content" },
  },
]

const mockBlacklist = [
  { id: "bl_001", userId: USER_ID, term: "spam", matchType: "CONTAINS" as const },
]

const mockMaterial = {
  title: "TypeScript 5.8 Features",
  content: "New type narrowing capabilities in TypeScript 5.8.",
  url: "https://devblogs.microsoft.com/typescript/ts-5-8",
}

const mockMaterial2 = {
  title: "React Server Components",
  content: "Deep dive into React Server Components.",
  url: "https://react.dev/blog/rsc",
}

const mockAIEvaluation = {
  relevant: true,
  confidence: 87,
  reasoning: "Strongly relevant to TypeScript development.",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupDefaultDbMocks() {
  vi.mocked(db.settings.findFirst).mockResolvedValue(mockSettings as never)
  vi.mocked(db.feed.findUnique).mockResolvedValue(mockSource as never)
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(mockUserSettings as never)
  vi.mocked(db.aIFeedback.findMany).mockResolvedValue(mockGlobalFeedbacks as never)
  vi.mocked(db.blacklistItem.findMany).mockResolvedValue(mockBlacklist as never)
  // Default mock returns single evaluation (for evaluateMaterialWithContext tests)
  // and batch format (for evaluateMaterialsBatch tests)
  vi.mocked(generateObject).mockImplementation(async (opts: { schema?: unknown; messages?: Array<{ content: string }> }) => {
    // Detect batch vs single by checking if schema expects evaluations array
    const schemaStr = JSON.stringify(opts.schema)
    if (schemaStr?.includes("evaluations")) {
      // Batch mode — infer count from numbered items in the user message
      const userMsg = opts.messages?.find((m: { content: string }) => m.content?.includes("MATERIALS TO EVALUATE"))
      const matches = userMsg?.content?.match(/\[\d+\]/g)
      const count = matches?.length || 3
      return { object: { evaluations: Array.from({ length: count }, () => mockAIEvaluation) } } as never
    }
    // Single mode
    return { object: mockAIEvaluation } as never
  })
}

// ---------------------------------------------------------------------------
// AC-1: fetchEvaluationContext returns all required fields
// ---------------------------------------------------------------------------

describe("fetchEvaluationContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-1: returns settings, source with feedbacks, userSettings, globalFeedbacks, and blacklist", async () => {
    const context = await fetchEvaluationContext({ sourceId: SOURCE_ID, userId: USER_ID })

    expect(context).toMatchObject({
      settings: expect.objectContaining({ id: mockSettings.id }),
      source: expect.objectContaining({ id: SOURCE_ID }),
      userSettings: expect.objectContaining({ userId: USER_ID }),
      globalFeedbacks: expect.arrayContaining([
        expect.objectContaining({ isGlobal: true }),
      ]),
      blacklist: expect.arrayContaining([
        expect.objectContaining({ term: "spam" }),
      ]),
    })
  })

  it("AC-1: global feedbacks query includes commented cross-source feedbacks via OR clause", async () => {
    await fetchEvaluationContext({ sourceId: SOURCE_ID, userId: USER_ID })

    expect(db.aIFeedback.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          OR: [
            { isGlobal: true },
            { isGlobal: false, commentText: { not: null }, sourceId: { not: SOURCE_ID } },
          ],
        },
      })
    )
  })

  it("AC-1: fetches source feedbacks as part of source (included relation)", async () => {
    const context = await fetchEvaluationContext({ sourceId: SOURCE_ID, userId: USER_ID })

    // Source must be fetched with feedbacks included
    expect(context.source).toHaveProperty("feedbacks")
    expect(Array.isArray(context.source?.feedbacks)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC-2: evaluateMaterialWithContext does not perform DB queries
// ---------------------------------------------------------------------------

describe("evaluateMaterialWithContext", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(generateObject).mockResolvedValue({ object: mockAIEvaluation } as never)
    // Intentionally do NOT set up DB mocks — if AC-2 is violated they'll return undefined
    // and the function will throw, which is how we detect DB calls
  })

  it("AC-2: evaluates material using pre-fetched context without DB queries", async () => {
    const context: EvaluationContext = {
      settings: mockSettings,
      source: mockSource,
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [],
    }

    const result = await evaluateMaterialWithContext({ material: mockMaterial, context })

    expect(result).toMatchObject({
      relevant: expect.any(Boolean),
      confidence: expect.any(Number),
      reasoning: expect.any(String),
    })

    // No DB should have been touched
    expect(db.settings.findFirst).not.toHaveBeenCalled()
    expect(db.feed.findUnique).not.toHaveBeenCalled()
    expect(db.userSettings.findUnique).not.toHaveBeenCalled()
    expect(db.aIFeedback.findMany).not.toHaveBeenCalled()
    expect(db.blacklistItem.findMany).not.toHaveBeenCalled()
  })

  it("EC-2: context with no feedbacks (empty arrays) still produces valid evaluation", async () => {
    const contextNoFeedbacks: EvaluationContext = {
      settings: mockSettings,
      source: { ...mockSource, feedbacks: [] },
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [],
    }

    const result = await evaluateMaterialWithContext({
      material: mockMaterial,
      context: contextNoFeedbacks,
    })

    expect(result).toMatchObject({
      relevant: expect.any(Boolean),
      confidence: expect.any(Number),
      reasoning: expect.any(String),
    })
  })
})

// ---------------------------------------------------------------------------
// AC-3: evaluateMaterialsBatch calls context fetch once for the whole batch
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — N+1 fix", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-3: fetches DB context once for a batch of 3 materials — not 3 times", async () => {
    const materials = [mockMaterial, mockMaterial2, { ...mockMaterial, title: "Third Article" }]

    await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    // DB settings.findFirst should be called ONCE (for context), not 3 times
    expect(db.settings.findFirst).toHaveBeenCalledTimes(1)
    // DB source.findUnique should be called ONCE, not 3 times
    expect(db.feed.findUnique).toHaveBeenCalledTimes(1)
    // DB blacklistItem.findMany should be called ONCE, not 3 times
    expect(db.blacklistItem.findMany).toHaveBeenCalledTimes(1)
    // DB aIFeedback.findMany should be called ONCE, not 3 times
    expect(db.aIFeedback.findMany).toHaveBeenCalledTimes(1)
  })

  it("AC-3: returns one evaluation result per material in the batch", async () => {
    const materials = [mockMaterial, mockMaterial2]

    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(results).toHaveLength(2)
    results.forEach((r) => {
      expect(r).toMatchObject({
        relevant: expect.any(Boolean),
        confidence: expect.any(Number),
        reasoning: expect.any(String),
      })
    })
  })

  it("EC-1: empty materials array returns empty array without any DB queries", async () => {
    const results = await evaluateMaterialsBatch({ materials: [], sourceId: SOURCE_ID, userId: USER_ID })

    expect(results).toEqual([])
    // No DB calls should be made for an empty batch
    expect(db.settings.findFirst).not.toHaveBeenCalled()
    expect(db.feed.findUnique).not.toHaveBeenCalled()
    expect(db.blacklistItem.findMany).not.toHaveBeenCalled()
    expect(db.aIFeedback.findMany).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC-4: evaluateMaterial still works as a convenience wrapper
// ---------------------------------------------------------------------------

describe("evaluateMaterial — standalone wrapper", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-4: still works as a convenience wrapper — fetches context and evaluates", async () => {
    const result = await evaluateMaterial({
      material: mockMaterial,
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })

    expect(result).toMatchObject({
      relevant: expect.any(Boolean),
      confidence: expect.any(Number),
      reasoning: expect.any(String),
    })

    // Must have fetched context (DB was called once)
    expect(db.settings.findFirst).toHaveBeenCalled()
    expect(db.feed.findUnique).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC-5: Blacklist check uses pre-fetched blacklist per material
// ---------------------------------------------------------------------------

describe("evaluateMaterialWithContext — blacklist check (AC-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(generateObject).mockResolvedValue({ object: mockAIEvaluation } as never)
  })

  it("AC-5: returns relevant:false with 100% confidence when material matches CONTAINS blacklist term", async () => {
    const context: EvaluationContext = {
      settings: mockSettings,
      source: mockSource,
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [{ id: "bl_001", userId: USER_ID, term: "spam", matchType: "CONTAINS" }],
    }

    const spamMaterial = {
      title: "Get rich quick spam scheme",
      content: "This is obvious spam content.",
      url: "https://spam.example.com",
    }

    const result = await evaluateMaterialWithContext({ material: spamMaterial, context })

    expect(result.relevant).toBe(false)
    expect(result.confidence).toBe(100)
    expect(result.reasoning).toContain("spam")
    // Blacklisted — AI should NOT be called
    expect(generateObject).not.toHaveBeenCalled()
  })

  it("AC-5: non-blacklisted material passes through to AI evaluation", async () => {
    const context: EvaluationContext = {
      settings: mockSettings,
      source: mockSource,
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [{ id: "bl_001", userId: USER_ID, term: "blocked-keyword", matchType: "CONTAINS" }],
    }

    const cleanMaterial = {
      title: "TypeScript Tips",
      content: "Useful TypeScript patterns.",
      url: "https://example.com/ts-tips",
    }

    const result = await evaluateMaterialWithContext({ material: cleanMaterial, context })

    // Clean material should go through to AI
    expect(generateObject).toHaveBeenCalled()
    expect(result).toMatchObject({ relevant: expect.any(Boolean) })
  })
})

// ---------------------------------------------------------------------------
// ERR-1: AI failure for one material in batch doesn't corrupt context
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — error handling (ERR-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("ERR-1: AI failure throws for that material; context was fetched only once (not per-material retry)", async () => {
    let aiCallCount = 0
    vi.mocked(generateObject).mockImplementation(async () => {
      aiCallCount++
      if (aiCallCount === 1) {
        throw new Error("AI rate limit exceeded")
      }
      return { object: mockAIEvaluation } as never
    })

    const materials = [mockMaterial, mockMaterial2]

    // Batch should throw (or reject) because first material's AI call fails
    await expect(
      evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })
    ).rejects.toThrow("AI rate limit exceeded")

    // Context was fetched only once regardless of the failure
    expect(db.settings.findFirst).toHaveBeenCalledTimes(1)
    expect(db.feed.findUnique).toHaveBeenCalledTimes(1)
    expect(db.blacklistItem.findMany).toHaveBeenCalledTimes(1)
  })
})
