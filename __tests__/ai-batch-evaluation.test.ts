/**
 * TDD RED phase — Batch AI Evaluation: 25 items per call (RAD-128)
 *
 * Feature: Modify evaluateMaterialsBatch() to send multiple materials in a single
 * AI prompt instead of one-per-call. New function buildBatchEvaluationPrompt() and
 * new constant BATCH_EVAL_SIZE (25) are introduced.
 *
 * Criteria covered:
 *   AC-1: buildBatchEvaluationPrompt() accepts array of materials and returns a prompt
 *         containing all materials in a numbered list with [1], [2], etc. prefixes
 *   AC-2: evaluateMaterialsBatch() with 3 non-blacklisted materials makes exactly 1
 *         generateObject call (not 3)
 *   AC-3: evaluateMaterialsBatch() returns one AIEvaluation per input material, in
 *         the same order as the input array
 *   AC-4: Blacklisted materials get {relevant: false, confidence: 100} without being
 *         included in the AI batch prompt
 *   AC-5: Mixed batch (blacklisted + non-blacklisted) preserves input order with
 *         blacklist results and AI results interleaved correctly
 *   EC-1: Batch larger than 25 materials splits into multiple AI calls (30 → 2 calls)
 *   EC-2: All materials blacklisted → 0 AI calls, all results are blacklist rejections
 *   ERR-1: If AI call fails, evaluateMaterialsBatch() throws (no silent partial results)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  evaluateMaterialsBatch,
  buildBatchEvaluationPrompt,
  BATCH_EVAL_SIZE,
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

const SOURCE_ID = "src_batch_001"
const USER_ID = "user_batch_001"

const mockSettings = {
  id: "settings_001",
  aiModel: "claude-sonnet-4-6",
  aiApiKey: "sk-test-key",
  aiTemperature: 0.3,
}

const mockSource = {
  id: SOURCE_ID,
  name: "TechBatchSource",
  customPrompt: "Focus on TypeScript",
  likedCategories: ["Articles"],
  dislikedCategories: [],
  feedbacks: [],
}

const mockUserSettings = {
  userId: USER_ID,
  globalPrompt: "Only tech content",
}

function makeMaterial(n: number) {
  return {
    title: `Article ${n}`,
    content: `Content of article ${n} about technology.`,
    url: `https://example.com/article-${n}`,
  }
}

function makeAIEvaluation(n: number) {
  return {
    relevant: true,
    confidence: 80 + n,
    reasoning: `Article ${n} is relevant.`,
  }
}

function setupDefaultDbMocks() {
  vi.mocked(db.settings.findFirst).mockResolvedValue(mockSettings as never)
  vi.mocked(db.feed.findUnique).mockResolvedValue(mockSource as never)
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(mockUserSettings as never)
  vi.mocked(db.aIFeedback.findMany).mockResolvedValue([] as never)
  vi.mocked(db.blacklistItem.findMany).mockResolvedValue([] as never)
}

/**
 * Sets up generateObject to return an array-based batch response.
 * The mock returns `evaluations` matching the given count.
 */
function setupBatchAiMock(evaluationsPerCall: number[]) {
  let callIndex = 0
  vi.mocked(generateObject).mockImplementation(async () => {
    const count = evaluationsPerCall[callIndex++] ?? evaluationsPerCall[evaluationsPerCall.length - 1]
    return {
      object: {
        evaluations: Array.from({ length: count }, (_, i) => makeAIEvaluation(i + 1)),
      },
    } as never
  })
}

// ---------------------------------------------------------------------------
// AC-1: buildBatchEvaluationPrompt includes numbered materials
// ---------------------------------------------------------------------------

describe("buildBatchEvaluationPrompt", () => {
  it("AC-1: includes all materials in a numbered list with [1], [2], etc. prefixes", () => {
    const context: EvaluationContext = {
      settings: mockSettings,
      source: mockSource,
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [],
    }

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]
    const prompt = buildBatchEvaluationPrompt({ materials, context })

    expect(prompt).toContain("[1]")
    expect(prompt).toContain("[2]")
    expect(prompt).toContain("[3]")
    expect(prompt).toContain("Article 1")
    expect(prompt).toContain("Article 2")
    expect(prompt).toContain("Article 3")
  })

  it("AC-1: numbered list does not contain [4] when only 3 materials provided", () => {
    const context: EvaluationContext = {
      settings: mockSettings,
      source: mockSource,
      userSettings: mockUserSettings,
      globalFeedbacks: [],
      blacklist: [],
    }

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]
    const prompt = buildBatchEvaluationPrompt({ materials, context })

    expect(prompt).not.toContain("[4]")
  })
})

// ---------------------------------------------------------------------------
// AC-2: 3 non-blacklisted materials → exactly 1 generateObject call
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — single AI call for 3 materials (AC-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-2: with 3 non-blacklisted materials makes exactly 1 generateObject call (not 3)", async () => {
    setupBatchAiMock([3])

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]
    await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(generateObject).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// AC-3: Returns one evaluation per input material, in same order
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — result order matches input (AC-3)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-3: returns one AIEvaluation per input material", async () => {
    setupBatchAiMock([3])

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]
    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(results).toHaveLength(3)
    results.forEach((r) => {
      expect(r).toMatchObject({
        relevant: expect.any(Boolean),
        confidence: expect.any(Number),
        reasoning: expect.any(String),
      })
    })
  })

  it("AC-3: results are returned in the same order as the input array", async () => {
    // Return distinct evaluations so order can be verified
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        evaluations: [
          { relevant: true, confidence: 91, reasoning: "First" },
          { relevant: false, confidence: 72, reasoning: "Second" },
          { relevant: true, confidence: 55, reasoning: "Third" },
        ],
      },
    } as never)

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]
    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(results[0].reasoning).toBe("First")
    expect(results[1].reasoning).toBe("Second")
    expect(results[2].reasoning).toBe("Third")
  })
})

// ---------------------------------------------------------------------------
// AC-4: Blacklisted materials skip AI and get {relevant: false, confidence: 100}
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — blacklisted materials skip AI (AC-4)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-4: blacklisted material returns {relevant: false, confidence: 100} without AI call", async () => {
    vi.mocked(db.blacklistItem.findMany).mockResolvedValue([
      { id: "bl_001", userId: USER_ID, term: "spam", matchType: "CONTAINS" },
    ] as never)

    // Only 1 non-blacklisted material should reach the AI
    setupBatchAiMock([1])

    const spamMaterial = {
      title: "This is spam content",
      content: "Obvious spam article here.",
      url: "https://spam.example.com",
    }
    const cleanMaterial = makeMaterial(1)

    const results = await evaluateMaterialsBatch({
      materials: [spamMaterial, cleanMaterial],
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })

    expect(results[0].relevant).toBe(false)
    expect(results[0].confidence).toBe(100)
  })

  it("AC-4: blacklisted material is NOT included in the AI batch prompt", async () => {
    vi.mocked(db.blacklistItem.findMany).mockResolvedValue([
      { id: "bl_001", userId: USER_ID, term: "blockedword", matchType: "CONTAINS" },
    ] as never)

    setupBatchAiMock([1])

    const blacklistedMaterial = {
      title: "Contains blockedword in title",
      content: "Some content here.",
      url: "https://example.com/blocked",
    }
    const cleanMaterial = makeMaterial(99)

    await evaluateMaterialsBatch({
      materials: [blacklistedMaterial, cleanMaterial],
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })

    // The prompt passed to generateObject should NOT contain the blacklisted material's title
    const callArg = vi.mocked(generateObject).mock.calls[0]?.[0]
    expect(callArg?.prompt ?? callArg?.messages).not.toContain("Contains blockedword in title")
  })
})

// ---------------------------------------------------------------------------
// AC-5: Mixed batch preserves input order
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — mixed batch order preservation (AC-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("AC-5: mixed batch preserves input order with blacklist and AI results interleaved", async () => {
    vi.mocked(db.blacklistItem.findMany).mockResolvedValue([
      { id: "bl_001", userId: USER_ID, term: "spamword", matchType: "CONTAINS" },
    ] as never)

    // Materials: [clean, blacklisted, clean] — AI should evaluate 2 materials
    vi.mocked(generateObject).mockResolvedValueOnce({
      object: {
        evaluations: [
          { relevant: true, confidence: 88, reasoning: "First clean" },
          { relevant: false, confidence: 60, reasoning: "Third clean" },
        ],
      },
    } as never)

    const materials = [
      makeMaterial(1),
      { title: "Contains spamword", content: "Spam.", url: "https://spam.com" },
      makeMaterial(3),
    ]

    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(results).toHaveLength(3)
    // Index 0: AI result for material 1
    expect(results[0].reasoning).toBe("First clean")
    // Index 1: blacklist result
    expect(results[1].relevant).toBe(false)
    expect(results[1].confidence).toBe(100)
    // Index 2: AI result for material 3
    expect(results[2].reasoning).toBe("Third clean")
  })
})

// ---------------------------------------------------------------------------
// EC-1: Batch of 30 → 3 AI calls (10 + 10 + 10)
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — batch splitting (EC-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("EC-1: 30 materials splits into 3 AI calls (10 + 10 + 10), not 30", async () => {
    setupBatchAiMock([10, 10, 10])

    const materials = Array.from({ length: 30 }, (_, i) => makeMaterial(i + 1))
    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(generateObject).toHaveBeenCalledTimes(3)
    expect(results).toHaveLength(30)
  })

  it("EC-1: BATCH_EVAL_SIZE constant is exported and equals 10", () => {
    expect(BATCH_EVAL_SIZE).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// EC-2: All materials blacklisted → 0 AI calls
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — all blacklisted (EC-2)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("EC-2: all materials blacklisted → 0 AI calls, all results are blacklist rejections", async () => {
    vi.mocked(db.blacklistItem.findMany).mockResolvedValue([
      { id: "bl_001", userId: USER_ID, term: "blocked", matchType: "CONTAINS" },
    ] as never)

    const materials = [
      { title: "blocked article one", content: "Content.", url: "https://a.com" },
      { title: "also blocked two", content: "blocked word here.", url: "https://b.com" },
    ]

    const results = await evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })

    expect(generateObject).not.toHaveBeenCalled()
    expect(results).toHaveLength(2)
    results.forEach((r) => {
      expect(r.relevant).toBe(false)
      expect(r.confidence).toBe(100)
    })
  })
})

// ---------------------------------------------------------------------------
// ERR-1: AI failure → throws, no silent partial results
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — AI failure throws (ERR-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("ERR-1: if AI call fails, evaluateMaterialsBatch() throws and does not return partial results", async () => {
    vi.mocked(generateObject).mockRejectedValueOnce(new Error("AI service unavailable"))

    const materials = [makeMaterial(1), makeMaterial(2), makeMaterial(3)]

    await expect(
      evaluateMaterialsBatch({ materials, sourceId: SOURCE_ID, userId: USER_ID })
    ).rejects.toThrow("AI service unavailable")
  })
})

// ---------------------------------------------------------------------------
// RAD-397: `criteria` runs the clean tracked-question context
// ---------------------------------------------------------------------------

describe("evaluateMaterialsBatch — tracked-question clean context (RAD-397)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("judges by the query alone: no source customPrompt, no global prompt", async () => {
    setupBatchAiMock([1])

    const QUERY = "What key research has Anthropic published?"
    await evaluateMaterialsBatch({
      materials: [makeMaterial(1)],
      sourceId: SOURCE_ID,
      userId: USER_ID,
      criteria: QUERY,
    })

    const call = vi.mocked(generateObject).mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const systemPrompt = call.messages[0].content

    // The question is the sole criterion...
    expect(systemPrompt).toContain(QUERY)
    // ...and the feed/global curation criteria are suppressed. The mock
    // source carries customPrompt "Focus on TypeScript" and the global prompt
    // is "Only tech content" — neither may leak into a tracked-question eval.
    expect(systemPrompt).not.toContain("Focus on TypeScript")
    expect(systemPrompt).not.toContain("Only tech content")
    // The clean context never reads the feed at all.
    expect(db.feed.findUnique).not.toHaveBeenCalled()
  })
})
