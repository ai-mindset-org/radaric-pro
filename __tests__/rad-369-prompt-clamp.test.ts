// @vitest-environment node

/**
 * RAD-369 — the prompt caps also hold at READ time.
 *
 * A `globalPrompt` or feed `customPrompt` stored over the cap before the
 * write-time guard existed still sits in the row at full length, and every
 * filter call renders it into the system prompt. `buildPromptPreamble` is the
 * one place all the evaluation builders meet, so the clamp lives there; this
 * test pins the 8000-character bound through the public builder.
 */

import { describe, it, expect } from "vitest"
import { buildEvaluationPrompt } from "@/lib/ai"
import { USER_PROMPT_MAX } from "@/lib/validations/prompt-limits"

const STORED_OVER_CAP = 20000

function build(globalPrompt: string, sourcePrompt: string) {
  return buildEvaluationPrompt({
    material: { title: "A post", content: "Some content", url: "https://example.com/1" },
    globalPrompt,
    sourcePrompt,
    globalFeedbacks: [],
    sourceFeedbacks: [],
    sourceName: "A source",
    likedCategories: [],
    dislikedCategories: [],
  })
}

describe("buildPromptPreamble — stored prompts are clamped at read time", () => {
  it("a 20000-char globalPrompt reaches the prompt as 8000 chars", () => {
    const prompt = build("g".repeat(STORED_OVER_CAP), "")

    expect(prompt).toContain("g".repeat(USER_PROMPT_MAX))
    expect(prompt).not.toContain("g".repeat(USER_PROMPT_MAX + 1))
  })

  it("a 20000-char customPrompt reaches the prompt as 8000 chars", () => {
    const prompt = build("", "s".repeat(STORED_OVER_CAP))

    expect(prompt).toContain("s".repeat(USER_PROMPT_MAX))
    expect(prompt).not.toContain("s".repeat(USER_PROMPT_MAX + 1))
  })

  it("leaves a prompt under the cap intact", () => {
    const prompt = build("Short global criteria", "Short source criteria")

    expect(prompt).toContain("Short global criteria")
    expect(prompt).toContain("Short source criteria")
  })
})
