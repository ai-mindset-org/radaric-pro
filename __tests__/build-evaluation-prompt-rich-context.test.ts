/**
 * buildEvaluationPrompt — Rich Feedback Context (RAD-109)
 *
 * RED phase tests: all tests MUST fail until the implementation is updated.
 *
 * Spec: FeedbackEntry gains optional `materialTitle` and `materialSnippet` fields.
 * When present, these fields enrich the <rule> tag with contextual material info.
 */

import { describe, it, expect } from "vitest"
import { buildEvaluationPrompt, type FeedbackEntry } from "@/lib/ai"

// ---------------------------------------------------------------------------
// Test helper — builds a minimal valid call, overrides applied on top
// ---------------------------------------------------------------------------
type RichFeedbackEntry = FeedbackEntry & {
  materialTitle?: string | null
  materialSnippet?: string | null
}

function buildPrompt(overrides: {
  globalFeedbacks?: RichFeedbackEntry[]
  sourceFeedbacks?: RichFeedbackEntry[]
  [key: string]: unknown
} = {}) {
  return buildEvaluationPrompt({
    material: { title: "Test Article", content: "Some content", url: "https://example.com/1" },
    globalPrompt: "Only tech content",
    sourcePrompt: "Focus on AI",
    globalFeedbacks: [],
    sourceFeedbacks: [],
    sourceName: "TechSource",
    likedCategories: [],
    dislikedCategories: [],
    ...overrides,
  } as Parameters<typeof buildEvaluationPrompt>[0])
}

// ---------------------------------------------------------------------------
// AC-1: Backward compatibility — existing callers without new fields still work
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — rich feedback context (RAD-109)", () => {
  it('AC-1: accepts FeedbackEntry without materialTitle/materialSnippet (backward compatible)', () => {
    const legacyFeedback: FeedbackEntry = { text: "Great analysis", type: "LIKE" }
    // Must not throw; legacy entries render exactly as before
    const result = buildPrompt({ globalFeedbacks: [legacyFeedback] })
    expect(result).toContain("Great analysis")
    expect(result).toContain('sentiment="LIKE"')
  })

  // -------------------------------------------------------------------------
  // AC-2: materialTitle renders Re: "{title}" before the comment text
  // -------------------------------------------------------------------------
  it('AC-2: renders Re: "{materialTitle}" before comment when materialTitle is present', () => {
    const feedback: RichFeedbackEntry = {
      text: "Loved the depth",
      type: "LIKE",
      materialTitle: "How LLMs Work",
    }
    const result = buildPrompt({ globalFeedbacks: [feedback] })
    // Rule must contain the Re: prefix followed by the comment
    expect(result).toContain('Re: "How LLMs Work"')
    expect(result).toContain("Loved the depth")
    // The Re: prefix must appear before the comment inside the same rule tag
    const ruleMatch = result.match(/<rule[^>]*>([^<]*)<\/rule>/)
    expect(ruleMatch).not.toBeNull()
    const ruleContent = ruleMatch![1]
    expect(ruleContent.indexOf('Re: "How LLMs Work"')).toBeLessThan(
      ruleContent.indexOf("Loved the depth")
    )
  })

  // -------------------------------------------------------------------------
  // AC-3: materialSnippet (up to 200 chars) in parentheses after title
  // -------------------------------------------------------------------------
  it('AC-3: renders snippet in parentheses after title when both materialTitle and materialSnippet are present', () => {
    const feedback: RichFeedbackEntry = {
      text: "Perfect match",
      type: "LIKE",
      materialTitle: "Deep Dive into RAG",
      materialSnippet: "Retrieval-Augmented Generation (RAG) is a technique that combines...",
    }
    const result = buildPrompt({ sourceFeedbacks: [feedback] })
    expect(result).toContain('Re: "Deep Dive into RAG" (Retrieval-Augmented Generation (RAG) is a technique that combines...)')
    expect(result).toContain("Perfect match")
  })

  // -------------------------------------------------------------------------
  // AC-4: No comment but has materialTitle — renders Approved/Rejected
  // -------------------------------------------------------------------------
  it('AC-4: renders Approved: "{title}" for LIKE with no comment but with materialTitle', () => {
    const feedback: RichFeedbackEntry = {
      text: null,
      type: "LIKE",
      materialTitle: "Rust is Amazing",
    }
    const result = buildPrompt({ sourceFeedbacks: [feedback] })
    expect(result).toContain('Approved: "Rust is Amazing"')
    expect(result).not.toContain("(reaction only, no comment)")
  })

  it('AC-4: renders Rejected: "{title}" for DISLIKE with no comment but with materialTitle', () => {
    const feedback: RichFeedbackEntry = {
      text: null,
      type: "DISLIKE",
      materialTitle: "Clickbait Article",
    }
    const result = buildPrompt({ globalFeedbacks: [feedback] })
    expect(result).toContain('Rejected: "Clickbait Article"')
    expect(result).not.toContain("(reaction only, no comment)")
  })

  // -------------------------------------------------------------------------
  // AC-5: Legacy — no comment, no materialTitle → (reaction only, no comment)
  // -------------------------------------------------------------------------
  it('AC-5: renders (reaction only, no comment) for entry with no comment and no materialTitle (legacy)', () => {
    const feedback: RichFeedbackEntry = { text: null, type: "DISLIKE" }
    const result = buildPrompt({ globalFeedbacks: [feedback] })
    expect(result).toContain("(reaction only, no comment)")
    expect(result).not.toContain("Rejected:")
    expect(result).not.toContain("Approved:")
  })

  // -------------------------------------------------------------------------
  // EC-1: materialTitle present but materialSnippet is null — title only, no parens
  // -------------------------------------------------------------------------
  it('EC-1: renders title only (no parenthetical) when materialSnippet is null', () => {
    const feedback: RichFeedbackEntry = {
      text: "Good one",
      type: "LIKE",
      materialTitle: "TypeScript Tips",
      materialSnippet: null,
    }
    const result = buildPrompt({ sourceFeedbacks: [feedback] })
    expect(result).toContain('Re: "TypeScript Tips"')
    // Must NOT have a trailing parenthetical snippet
    expect(result).not.toMatch(/Re: "TypeScript Tips" \(/)
    expect(result).toContain("Good one")
  })

  // -------------------------------------------------------------------------
  // EC-2: materialSnippet longer than 200 chars — truncated to 200 with "..."
  // -------------------------------------------------------------------------
  it('EC-2: truncates materialSnippet to 200 chars with "..." suffix when longer than 200', () => {
    const longSnippet = "A".repeat(250)
    const feedback: RichFeedbackEntry = {
      text: "Interesting",
      type: "LIKE",
      materialTitle: "Long Article",
      materialSnippet: longSnippet,
    }
    const result = buildPrompt({ globalFeedbacks: [feedback] })
    const expected200 = "A".repeat(200)
    expect(result).toContain(`Re: "Long Article" (${expected200}...)`)
    // Full 250-char snippet must not appear
    expect(result).not.toContain(longSnippet)
  })

  // -------------------------------------------------------------------------
  // ERR-1: Empty string materialTitle treated same as null (no Re: prefix)
  // -------------------------------------------------------------------------
  it('ERR-1: treats empty string materialTitle as null — no Re: prefix rendered', () => {
    const feedback: RichFeedbackEntry = {
      text: "Interesting read",
      type: "LIKE",
      materialTitle: "",
    }
    const result = buildPrompt({ sourceFeedbacks: [feedback] })
    // Empty materialTitle must not produce Re: ""
    expect(result).not.toContain('Re: ""')
    expect(result).not.toContain("Re: ")
    // Comment text still renders normally
    expect(result).toContain("Interesting read")
  })
})
