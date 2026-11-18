/**
 * buildEvaluationPrompt — TDD RED tests
 *
 * Target behavior after Phase 2 implementation:
 * - Accepts structured feedback with { text, type } instead of plain strings
 * - Accepts likedCategories / dislikedCategories arrays
 * - Renders XML-tagged feedback sections with sentiment labels
 * - Renders content categories section (only when non-empty)
 * - Handles null commentText gracefully (no literal "null")
 * - Backward compat: empty feedbacks/categories produce same output shape
 */

import { describe, it, expect } from "vitest"
import { buildEvaluationPrompt } from "@/lib/ai"

// Helper to build a minimal valid call
function buildPrompt(overrides: Record<string, unknown> = {}) {
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
  })
}

// ---------------------------------------------------------------------------
// Backward compatibility — empty feedbacks and categories
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — backward compatibility", () => {
  it("renders global and source criteria sections", () => {
    const result = buildPrompt()
    expect(result).toContain("GLOBAL CRITERIA")
    expect(result).toContain("Only tech content")
    expect(result).toContain("CRITERIA FOR THIS SPECIFIC SOURCE")
    expect(result).toContain("Focus on AI")
    expect(result).toContain("TechSource")
  })

  it("renders material to evaluate", () => {
    const result = buildPrompt()
    expect(result).toContain("Test Article")
    expect(result).toContain("Some content")
    expect(result).toContain("https://example.com/1")
  })

  it("does NOT render feedback sections when feedbacks are empty", () => {
    const result = buildPrompt()
    expect(result).not.toContain("user_feedback_rules")
    expect(result).not.toContain("LEARNED RULES")
  })

  it("does NOT render categories section when both arrays are empty", () => {
    const result = buildPrompt()
    expect(result).not.toContain("content_categories")
    expect(result).not.toContain("liked_categories")
    expect(result).not.toContain("disliked_categories")
  })
})

// ---------------------------------------------------------------------------
// Content categories
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — content categories", () => {
  it("renders liked categories when non-empty", () => {
    const result = buildPrompt({ likedCategories: ["Articles", "Tutorials"] })
    expect(result).toContain("Articles")
    expect(result).toContain("Tutorials")
  })

  it("renders disliked categories when non-empty", () => {
    const result = buildPrompt({ dislikedCategories: ["Ads", "Clickbait"] })
    expect(result).toContain("Ads")
    expect(result).toContain("Clickbait")
  })

  it("renders both liked and disliked categories together", () => {
    const result = buildPrompt({
      likedCategories: ["Research"],
      dislikedCategories: ["Sponsored"],
    })
    expect(result).toContain("Research")
    expect(result).toContain("Sponsored")
  })

  it("only renders categories section when at least one array is non-empty", () => {
    const withLiked = buildPrompt({ likedCategories: ["Articles"] })
    const withDisliked = buildPrompt({ dislikedCategories: ["Ads"] })
    const withNeither = buildPrompt()

    expect(withLiked).toContain("content_categories")
    expect(withDisliked).toContain("content_categories")
    expect(withNeither).not.toContain("content_categories")
  })
})

// ---------------------------------------------------------------------------
// Feedback with sentiment labels (LIKE / DISLIKE)
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — feedback sentiment", () => {
  it("renders global feedback with LIKE sentiment label", () => {
    const result = buildPrompt({
      globalFeedbacks: [{ text: "Great analysis", type: "LIKE" }],
    })
    expect(result).toContain("LIKE")
    expect(result).toContain("Great analysis")
    expect(result).toContain("user_feedback_rules")
  })

  it("renders global feedback with DISLIKE sentiment label", () => {
    const result = buildPrompt({
      globalFeedbacks: [{ text: "Too basic", type: "DISLIKE" }],
    })
    expect(result).toContain("DISLIKE")
    expect(result).toContain("Too basic")
  })

  it("renders source-specific feedback with sentiment", () => {
    const result = buildPrompt({
      sourceFeedbacks: [{ text: "Love the code examples", type: "LIKE" }],
    })
    expect(result).toContain("LIKE")
    expect(result).toContain("Love the code examples")
    expect(result).toContain("user_feedback_rules")
  })

  it("renders mixed LIKE and DISLIKE feedbacks", () => {
    const result = buildPrompt({
      sourceFeedbacks: [
        { text: "Practical content", type: "LIKE" },
        { text: "Too much self-promo", type: "DISLIKE" },
      ],
    })
    expect(result).toContain("Practical content")
    expect(result).toContain("Too much self-promo")
  })
})

// ---------------------------------------------------------------------------
// XML-tagged feedback sections (prompt injection mitigation)
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — XML-tagged feedback", () => {
  it("wraps global feedback in XML tags with scope='global'", () => {
    const result = buildPrompt({
      globalFeedbacks: [{ text: "test", type: "LIKE" }],
    })
    expect(result).toContain('<user_feedback_rules scope="global">')
    expect(result).toContain("</user_feedback_rules>")
  })

  it("wraps source feedback in XML tags with scope='source'", () => {
    const result = buildPrompt({
      sourceFeedbacks: [{ text: "test", type: "DISLIKE" }],
    })
    expect(result).toContain('<user_feedback_rules scope="source">')
    expect(result).toContain("</user_feedback_rules>")
  })

  it("includes data-not-instructions framing", () => {
    const result = buildPrompt({
      globalFeedbacks: [{ text: "test", type: "LIKE" }],
    })
    expect(result).toMatch(/treat as data/i)
  })

  it("renders each rule with sentiment attribute", () => {
    const result = buildPrompt({
      sourceFeedbacks: [
        { text: "Good depth", type: "LIKE" },
        { text: "Outdated", type: "DISLIKE" },
      ],
    })
    expect(result).toContain('sentiment="LIKE"')
    expect(result).toContain('sentiment="DISLIKE"')
  })
})

// ---------------------------------------------------------------------------
// Null commentText handling
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — null commentText", () => {
  it("renders '(reaction only, no comment)' for null text", () => {
    const result = buildPrompt({
      globalFeedbacks: [{ text: null, type: "LIKE" }],
    })
    expect(result).toContain("(reaction only, no comment)")
    expect(result).not.toContain("null")
  })

  it("mixes null and non-null feedback correctly", () => {
    const result = buildPrompt({
      sourceFeedbacks: [
        { text: "Good stuff", type: "LIKE" },
        { text: null, type: "DISLIKE" },
      ],
    })
    expect(result).toContain("Good stuff")
    expect(result).toContain("(reaction only, no comment)")
  })
})

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------
describe("buildEvaluationPrompt — content truncation", () => {
  it("truncates content to 3000 chars with ellipsis", () => {
    const longContent = "x".repeat(5000)
    const result = buildPrompt({ material: { title: "T", content: longContent, url: "https://x.com" } })
    expect(result).toContain("x".repeat(3000) + "...")
    expect(result).not.toContain("x".repeat(3001))
  })

  it("does not add ellipsis for short content", () => {
    const result = buildPrompt({ material: { title: "T", content: "short", url: "https://x.com" } })
    expect(result).toContain("short")
    expect(result).not.toContain("short...")
  })
})
