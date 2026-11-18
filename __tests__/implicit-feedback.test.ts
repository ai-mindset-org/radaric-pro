/**
 * createImplicitFeedback — TDD RED tests (RAD-110)
 *
 * Pure function that derives implicit feedback from user status overrides:
 * - FILTERED material sent to Notion/Stories → LIKE (user approved what AI filtered)
 * - APPROVED material archived/deleted → DISLIKE (user rejected what AI approved)
 * - Non-contradicting status changes → null
 * - Explicit feedback already present → null (never overwrite)
 */

import { describe, it, expect } from "vitest"
import { createImplicitFeedback } from "@/lib/implicit-feedback"

// ---------------------------------------------------------------------------
// Shared fixture factory
// ---------------------------------------------------------------------------
function makeParams(overrides: Partial<Parameters<typeof createImplicitFeedback>[0]> = {}) {
  return {
    materialId: "mat-1",
    sourceId: "src-1",
    userId: "user-1",
    aiEvaluation: "FILTERED" as const,
    aiConfidence: 85,
    aiReasoning: "Content does not match source criteria",
    newStatus: "SENT_TO_NOTION",
    hasExplicitFeedback: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC-1: FILTERED → SENT_TO_NOTION produces LIKE feedback
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — FILTERED material approved by user", () => {
  it("AC-1: returns LIKE feedback when FILTERED material is sent to Notion", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      aiConfidence: 85,
      aiReasoning: "Content does not match source criteria",
      newStatus: "SENT_TO_NOTION",
    }))

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("LIKE")
    expect(result!.feedbackSource).toBe("implicit")
    expect(result!.materialId).toBe("mat-1")
    expect(result!.sourceId).toBe("src-1")
    expect(result!.userId).toBe("user-1")
    expect(result!.isGlobal).toBe(false)
    expect(result!.commentText).toBe(
      "User approved AI-filtered material (confidence: 85%). AI reasoning: Content does not match source criteria"
    )
  })

  // AC-2: FILTERED → SENT_TO_STORIES produces LIKE feedback (same shape, different trigger)
  it("AC-2: returns LIKE feedback when FILTERED material is sent to Stories", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      aiConfidence: 72,
      aiReasoning: "Off-topic for this channel",
      newStatus: "SENT_TO_STORIES",
    }))

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("LIKE")
    expect(result!.feedbackSource).toBe("implicit")
    expect(result!.commentText).toBe(
      "User approved AI-filtered material (confidence: 72%). AI reasoning: Off-topic for this channel"
    )
  })
})

// ---------------------------------------------------------------------------
// AC-3 & AC-4: APPROVED material rejected by user
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — APPROVED material rejected by user", () => {
  it("AC-3: returns null when APPROVED material is archived (archive is normal workflow, not disagreement)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      aiConfidence: 91,
      aiReasoning: "High-quality content matching criteria",
      newStatus: "ARCHIVED",
    }))

    expect(result).toBeNull()
  })

  it("AC-4: returns DISLIKE feedback when APPROVED material is deleted", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      aiConfidence: 60,
      aiReasoning: "Meets minimum quality bar",
      newStatus: "DELETED",
    }))

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("DISLIKE")
    expect(result!.feedbackSource).toBe("implicit")
    expect(result!.commentText).toBe(
      "User deleted AI-approved material (confidence: 60%). AI reasoning: Meets minimum quality bar"
    )
  })
})

// ---------------------------------------------------------------------------
// AC-5: Non-contradicting status changes return null
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — non-contradicting status changes", () => {
  it("AC-5: returns null when APPROVED material is sent to Notion (no contradiction)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      newStatus: "SENT_TO_NOTION",
    }))

    expect(result).toBeNull()
  })

  it("AC-5: returns null when APPROVED material is sent to Stories (no contradiction)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      newStatus: "SENT_TO_STORIES",
    }))

    expect(result).toBeNull()
  })

  it("AC-5: returns null when FILTERED material is archived (no contradiction)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      newStatus: "ARCHIVED",
    }))

    expect(result).toBeNull()
  })

  it("AC-5: returns null when FILTERED material is deleted (no contradiction)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      newStatus: "DELETED",
    }))

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// EC-1: null aiReasoning omits the reasoning part from comment
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — null aiReasoning edge case", () => {
  it("EC-1: omits AI reasoning from LIKE comment when aiReasoning is null", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      aiConfidence: 78,
      aiReasoning: null,
      newStatus: "SENT_TO_NOTION",
    }))

    expect(result).not.toBeNull()
    expect(result!.commentText).toBe(
      "User approved AI-filtered material (confidence: 78%)"
    )
    expect(result!.commentText).not.toContain("AI reasoning")
  })

  it("EC-1: omits AI reasoning from DISLIKE comment when aiReasoning is null", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      aiConfidence: 55,
      aiReasoning: null,
      newStatus: "DELETED",
    }))

    expect(result).not.toBeNull()
    expect(result!.commentText).toBe(
      "User deleted AI-approved material (confidence: 55%)"
    )
    expect(result!.commentText).not.toContain("AI reasoning")
  })
})

// ---------------------------------------------------------------------------
// EC-2: Explicit feedback already present — never overwrite
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — explicit feedback guard", () => {
  it("EC-2: returns null when material already has explicit feedback from this user (FILTERED → SENT_TO_NOTION)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      newStatus: "SENT_TO_NOTION",
      hasExplicitFeedback: true,
    }))

    expect(result).toBeNull()
  })

  it("EC-2: returns null when material already has explicit feedback from this user (APPROVED → DELETED)", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      newStatus: "DELETED",
      hasExplicitFeedback: true,
    }))

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// ERR-1: Unrecognized newStatus returns null regardless of aiEvaluation
// ---------------------------------------------------------------------------
describe("createImplicitFeedback — unrecognized status", () => {
  it("ERR-1: returns null for unrecognized status 'READ' with FILTERED evaluation", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "FILTERED",
      newStatus: "READ",
    }))

    expect(result).toBeNull()
  })

  it("ERR-1: returns null for unrecognized status 'NEW' with APPROVED evaluation", () => {
    const result = createImplicitFeedback(makeParams({
      aiEvaluation: "APPROVED",
      newStatus: "NEW",
    }))

    expect(result).toBeNull()
  })
})
