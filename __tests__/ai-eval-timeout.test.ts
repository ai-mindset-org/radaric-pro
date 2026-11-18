/**
 * RAD-232 — AI evaluation must not hang the parse stream.
 *
 * Root cause of the parse-stream freeze: generateObject() in evaluateMaterialsBatch()
 * was called with no abortSignal and no maxRetries, so a hung OpenRouter request
 * blocked the per-source task forever and Promise.allSettled never resolved.
 *
 * These tests pin the contract:
 *   T-1: generateObject is called with an AbortSignal (bounded wall-clock time).
 *   T-2: generateObject is called with an explicit finite maxRetries.
 *   T-3: AI_EVAL_TIMEOUT_MS is exported and is a sane positive bound.
 *   T-4: a hung/timed-out AI call rejects (does NOT hang) so the source fails fast.
 *   T-5: the PARENT budget is bounded, not just the leaf timeout.
 *   T-6: reasoning effort reaches OpenRouter models and never the Anthropic branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  evaluateMaterialsBatch,
  AI_EVAL_TIMEOUT_MS,
  AI_EVAL_MAX_RETRIES,
  AI_EVAL_CHUNK_BUDGET_MS,
  AI_EVAL_CHUNK_BUDGET_CEILING_MS,
} from "@/lib/ai"
import { DEFAULT_REASONING_EFFORT } from "@/lib/models/registry"

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

import { db } from "@/lib/db"
import { generateObject } from "ai"

const SOURCE_ID = "src_timeout_001"
const USER_ID = "user_timeout_001"

const mockSettings = {
  id: "settings_001",
  aiModel: "claude-sonnet-4-6",
  aiApiKey: "sk-test-key",
  aiTemperature: 0.3,
}

function makeMaterial(n: number) {
  return {
    title: `Article ${n}`,
    content: `Content of article ${n}.`,
    url: `https://example.com/article-${n}`,
  }
}

function setupDefaultDbMocks() {
  vi.mocked(db.settings.findFirst).mockResolvedValue(mockSettings as never)
  vi.mocked(db.feed.findUnique).mockResolvedValue({
    id: SOURCE_ID,
    name: "TimeoutSource",
    customPrompt: "",
    likedCategories: [],
    dislikedCategories: [],
    feedbacks: [],
  } as never)
  vi.mocked(db.userSettings.findUnique).mockResolvedValue({ userId: USER_ID, globalPrompt: "" } as never)
  vi.mocked(db.aIFeedback.findMany).mockResolvedValue([] as never)
  vi.mocked(db.blacklistItem.findMany).mockResolvedValue([] as never)
}

function setupOkAiMock(count: number) {
  vi.mocked(generateObject).mockResolvedValue({
    object: {
      evaluations: Array.from({ length: count }, (_, i) => ({
        relevant: true,
        confidence: 80,
        reasoning: `r${i}`,
      })),
    },
  } as never)
}

describe("AI eval timeout contract (RAD-232)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
  })

  it("T-1: passes an AbortSignal to generateObject so a hung request can't run forever", async () => {
    setupOkAiMock(2)
    await evaluateMaterialsBatch({
      materials: [makeMaterial(1), makeMaterial(2)],
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })

    const callArg = vi.mocked(generateObject).mock.calls[0]?.[0] as Record<string, unknown>
    expect(callArg?.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it("T-2: passes an explicit finite maxRetries to generateObject", async () => {
    setupOkAiMock(2)
    await evaluateMaterialsBatch({
      materials: [makeMaterial(1), makeMaterial(2)],
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })

    const callArg = vi.mocked(generateObject).mock.calls[0]?.[0] as Record<string, unknown>
    expect(typeof callArg?.maxRetries).toBe("number")
    expect(callArg?.maxRetries as number).toBeGreaterThanOrEqual(0)
    expect(callArg?.maxRetries as number).toBeLessThanOrEqual(3)
  })

  it("T-3: exports a sane positive AI_EVAL_TIMEOUT_MS bound", () => {
    expect(typeof AI_EVAL_TIMEOUT_MS).toBe("number")
    expect(AI_EVAL_TIMEOUT_MS).toBeGreaterThan(0)
    // Should be well under typical infra/socket limits but generous for a batch.
    expect(AI_EVAL_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })

  it("T-4: a timed-out AI call rejects (does not hang) so the source fails fast", async () => {
    vi.mocked(generateObject).mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })
    )

    await expect(
      evaluateMaterialsBatch({
        materials: [makeMaterial(1), makeMaterial(2)],
        sourceId: SOURCE_ID,
        userId: USER_ID,
      })
    ).rejects.toThrow(/timeout/i)
  })
})

// ---------------------------------------------------------------------------
// T-5: parent budget
//
// Raising the leaf timeout without bounding the parent is how RAD-232 happened.
// Chunks loop sequentially per source, so the per-source cost is this figure times
// the chunk count; past ~5 minutes a source-level parse stops looking hung and
// starts being hung.
// ---------------------------------------------------------------------------

describe("T-5: per-chunk worst case stays inside its ceiling", () => {
  it("AI_EVAL_CHUNK_BUDGET_MS is timeout x (retries + 1)", () => {
    expect(AI_EVAL_CHUNK_BUDGET_MS).toBe(AI_EVAL_TIMEOUT_MS * (AI_EVAL_MAX_RETRIES + 1))
  })

  it("stays under the ceiling", () => {
    expect(AI_EVAL_CHUNK_BUDGET_MS).toBeLessThanOrEqual(AI_EVAL_CHUNK_BUDGET_CEILING_MS)
  })
})

// ---------------------------------------------------------------------------
// T-6: reasoning effort
//
// The SDK key is camelCase `reasoningEffort` inside providerOptions.openai; the
// snake_case wire name is produced by the SDK and is DROPPED if passed in. And an
// `openai`-namespaced block must never reach createAnthropic.
// ---------------------------------------------------------------------------

describe("T-6: reasoning effort plumbing", () => {
  // createModelInstance is NOT mocked here — the point is to see what the real
  // construction path hands to generateObject, so it needs a credential to reach.
  const priorKey = process.env.OPENROUTER_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
    setupDefaultDbMocks()
    process.env.OPENROUTER_API_KEY = "fake-openrouter-key"
  })

  afterEach(() => {
    if (priorKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = priorKey
  })

  async function runWith(settings: Record<string, unknown>) {
    vi.mocked(db.settings.findFirst).mockResolvedValue(settings as never)
    setupOkAiMock(1)
    await evaluateMaterialsBatch({
      materials: [makeMaterial(1)],
      sourceId: SOURCE_ID,
      userId: USER_ID,
    })
    return vi.mocked(generateObject).mock.calls[0]?.[0] as Record<string, unknown>
  }

  it("thinks hard by default when filterReasoningEffort is unset", async () => {
    const call = await runWith({ ...mockSettings, aiModel: "google/gemini-3.8-flash" })
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: DEFAULT_REASONING_EFFORT } })
  })

  it("sends no effort to a model that does not take the parameter", async () => {
    // Claude Haiku 4.5 via OpenRouter advertises `reasoning` but not
    // `reasoning_effort`; the gate is the catalogue flag, not the slash.
    const call = await runWith({
      ...mockSettings,
      aiModel: "anthropic/claude-haiku-4.5",
      filterReasoningEffort: "high",
    })
    expect(call.providerOptions).toBeUndefined()
  })

  it("sends the effort under providerOptions.openai for an OpenRouter model", async () => {
    const call = await runWith({
      ...mockSettings,
      aiModel: "google/gemini-3.8-flash",
      filterReasoningEffort: "low",
    })
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "low" } })
  })

  it("does NOT send an openai block for a direct-Anthropic model", async () => {
    const call = await runWith({
      ...mockSettings,
      aiModel: "claude-sonnet-4-6",
      filterReasoningEffort: "low",
    })
    expect(call.providerOptions).toBeUndefined()
  })

  it("drops a value the provider would reject, falling back to the default", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const call = await runWith({
      ...mockSettings,
      aiModel: "google/gemini-3.8-flash",
      filterReasoningEffort: "turbo",
    })
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: DEFAULT_REASONING_EFFORT } })
  })

  it("treats an empty string as unset, the settings contract everywhere else", async () => {
    const call = await runWith({
      ...mockSettings,
      aiModel: "google/gemini-3.8-flash",
      filterReasoningEffort: "",
    })
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: DEFAULT_REASONING_EFFORT } })
  })

  it("lets an explicit choice override the default — including turning it off", async () => {
    const call = await runWith({
      ...mockSettings,
      aiModel: "google/gemini-3.8-flash",
      filterReasoningEffort: "none",
    })
    expect(call.providerOptions).toEqual({ openai: { reasoningEffort: "none" } })
  })
})
