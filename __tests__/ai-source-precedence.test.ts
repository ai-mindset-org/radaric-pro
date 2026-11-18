/**
 * Source-criteria precedence / hard-veto regression tests.
 *
 * Bug: the global prompt ("approve outstanding packaging / design projects")
 * silently overrode narrow per-source exclusions ("only roundups, no individual
 * cases"), so individual cases kept landing in Approved. The fix makes a source
 * prompt's exclusions a HARD VETO over the global criteria, and reframes the task
 * as a priority-ordered decision instead of a flat 5-question checklist.
 *
 * These tests pin that wording so the precedence semantics can't silently regress.
 */

import { describe, it, expect } from "vitest"
import {
  buildEvaluationPrompt,
  buildBatchEvaluationPrompt,
  EVALUATION_PRIORITY_RULES,
  type EvaluationContext,
} from "@/lib/ai"

function buildPrompt(overrides: Record<string, unknown> = {}) {
  return buildEvaluationPrompt({
    material: { title: "Test Article", content: "Some content", url: "https://example.com/1" },
    globalPrompt: "Approve outstanding design projects, including packaging",
    sourcePrompt: "Only roundups. Individual cases — no.",
    globalFeedbacks: [],
    sourceFeedbacks: [],
    sourceName: "TheDieline",
    likedCategories: [],
    dislikedCategories: [],
    ...overrides,
  })
}

describe("source-criteria precedence — hard veto over global criteria", () => {
  it("adds a PRECEDENCE block declaring source criteria override the global ones", () => {
    const result = buildPrompt()
    expect(result).toContain("PRECEDENCE")
    expect(result).toContain("OVERRIDE the global criteria")
    expect(result).toContain("HARD FILTER")
    // The veto must be explicit: a violation forces relevant=false.
    expect(result).toContain("relevant=false")
  })

  it("does NOT add the PRECEDENCE block when the source has no custom prompt", () => {
    const result = buildPrompt({ sourcePrompt: "" })
    expect(result).not.toContain("PRECEDENCE")
    expect(result).not.toContain("OVERRIDE the global criteria")
  })

  it("treats a whitespace-only source prompt as absent (no veto block)", () => {
    const result = buildPrompt({ sourcePrompt: "   \n  " })
    expect(result).not.toContain("PRECEDENCE")
  })

  it("keeps the legacy section headers so the rest of the prompt is intact", () => {
    const result = buildPrompt()
    expect(result).toContain("GLOBAL CRITERIA")
    expect(result).toContain("CRITERIA FOR THIS SPECIFIC SOURCE")
  })
})

describe("priority-ordered task instructions", () => {
  it("uses a priority order, not the old flat 5-question checklist", () => {
    const result = buildPrompt()
    expect(result).toContain(EVALUATION_PRIORITY_RULES)
    expect(result).toContain("PRIORITY ORDER")
    expect(result).toContain("SOURCE-SPECIFIC criteria decide first")
    // The old wording framed everything as co-equal — make sure it's gone.
    expect(result).not.toContain("based on ALL the criteria above. Consider:")
  })

  it("requires the model to state whether source criteria were satisfied or violated", () => {
    expect(EVALUATION_PRIORITY_RULES).toContain("SATISFIED or VIOLATED")
  })
})

// ---------------------------------------------------------------------------
// Batch path — the high-volume runtime path (parse-stream / parse). It shares
// buildPromptPreamble + EVALUATION_PRIORITY_RULES, so the precedence semantics
// must hold here too, not just on the single-eval helper.
// ---------------------------------------------------------------------------
function batchContext(customPrompt: string | null): EvaluationContext {
  return {
    settings: { id: "s1", aiModel: "claude-sonnet-4-6", aiApiKey: "k", aiTemperature: 0.3 },
    source: {
      id: "src1",
      name: "TheDieline",
      customPrompt,
      likedCategories: [],
      dislikedCategories: [],
      feedbacks: [],
    },
    userSettings: {
      userId: "u1",
      globalPrompt: "Approve outstanding design projects, including packaging",
      globalLikedCategories: [],
      globalDislikedCategories: [],
    },
    globalFeedbacks: [],
    blacklist: [],
  }
}

describe("batch path — precedence parity with single-eval", () => {
  const materials = [{ title: "T", content: "C", url: "https://example.com/1" }]

  it("emits the PRECEDENCE veto + priority rules when the source has a custom prompt", () => {
    const prompt = buildBatchEvaluationPrompt({
      materials,
      context: batchContext("Only roundups. Individual cases — no."),
    })
    expect(prompt).toContain("PRECEDENCE")
    expect(prompt).toContain("OVERRIDE the global criteria")
    expect(prompt).toContain("relevant=false")
    expect(prompt).toContain(EVALUATION_PRIORITY_RULES)
  })

  it("omits the PRECEDENCE block when the source has no custom prompt", () => {
    const prompt = buildBatchEvaluationPrompt({ materials, context: batchContext(null) })
    expect(prompt).not.toContain("PRECEDENCE")
    // ...but still uses the priority-ordered task text, never the old checklist.
    expect(prompt).toContain(EVALUATION_PRIORITY_RULES)
    expect(prompt).not.toContain("based on ALL the criteria")
  })
})
