/**
 * RAD-139: Status Model Verification
 *
 * Verifies the two-axis status model (aiEvaluation × userStatus):
 * implicit feedback fires correctly on user overrides, refilter scope is
 * correct, and filter logic is internally consistent.
 *
 * Criteria:
 *   AC-1: LIKE when FILTERED material sent to Notion
 *   AC-2: LIKE when FILTERED material sent to Stories
 *   AC-3: DISLIKE when APPROVED material deleted
 *   AC-4: null when hasExplicitFeedback=true
 *   AC-5: null for non-override transitions (APPROVED archived)
 *   AC-6: EXCLUDED_STATUSES contains exactly DELETED, ARCHIVED, SENT_TO_STORIES, SENT_TO_NOTION
 *   AC-7: refilterMaterials query uses userStatus: { notIn: EXCLUDED_STATUSES }
 *   EC-1: comment includes aiReasoning when available
 *   EC-2: comment excludes aiReasoning when null
 *   ERR-1: returns null (not throws) for unknown status values
 */

import { describe, it, expect, vi } from "vitest"
import { createImplicitFeedback } from "@/lib/implicit-feedback"
import {
  EXCLUDED_STATUSES,
  refilterMaterials,
  type RefilterDeps,
} from "@/lib/refilter-materials"

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeParams(
  overrides: Partial<Parameters<typeof createImplicitFeedback>[0]> = {}
) {
  return {
    materialId: "mat-rad139",
    sourceId: "src-rad139",
    userId: "user-rad139",
    aiEvaluation: "FILTERED" as const,
    aiConfidence: 80,
    aiReasoning: "Content does not match source criteria",
    newStatus: "SENT_TO_NOTION",
    hasExplicitFeedback: false,
    ...overrides,
  }
}

function buildRefilterDeps(overrides: Partial<RefilterDeps> = {}): RefilterDeps {
  return {
    db: {
      material: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    evaluateMaterial: vi.fn().mockResolvedValue({
      relevant: true,
      confidence: 88,
      reasoning: "Relevant.",
    }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createImplicitFeedback — happy path
// ---------------------------------------------------------------------------

describe("RAD-139 createImplicitFeedback — user overrides AI", () => {
  it("AC-1: returns LIKE when FILTERED material is approved by sending to Notion", () => {
    const result = createImplicitFeedback(
      makeParams({ aiEvaluation: "FILTERED", newStatus: "SENT_TO_NOTION" })
    )

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("LIKE")
    expect(result!.feedbackSource).toBe("implicit")
    expect(result!.isGlobal).toBe(false)
  })

  it("AC-2: returns LIKE when FILTERED material is approved by sending to Stories", () => {
    const result = createImplicitFeedback(
      makeParams({ aiEvaluation: "FILTERED", newStatus: "SENT_TO_STORIES" })
    )

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("LIKE")
  })

  it("AC-3: returns DISLIKE when APPROVED material is deleted — comment says 'deleted', not 'archived'", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "APPROVED",
        aiConfidence: 75,
        aiReasoning: "Good content",
        newStatus: "DELETED",
      })
    )

    expect(result).not.toBeNull()
    expect(result!.feedbackType).toBe("DISLIKE")
    // The comment must describe the actual action taken (deleted), not a generic "archived"
    expect(result!.commentText.toLowerCase()).toContain("deleted")
    expect(result!.commentText.toLowerCase()).not.toContain("archived")
  })

  it("AC-4: returns null when explicit feedback already exists (FILTERED → SENT_TO_NOTION)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "FILTERED",
        newStatus: "SENT_TO_NOTION",
        hasExplicitFeedback: true,
      })
    )

    expect(result).toBeNull()
  })

  it("AC-4: returns null when explicit feedback already exists (APPROVED → DELETED)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "APPROVED",
        newStatus: "DELETED",
        hasExplicitFeedback: true,
      })
    )

    expect(result).toBeNull()
  })

  it("AC-5: returns null when APPROVED material is archived — archiving is not disagreement with AI", () => {
    const result = createImplicitFeedback(
      makeParams({ aiEvaluation: "APPROVED", newStatus: "ARCHIVED" })
    )

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createImplicitFeedback — edge cases
// ---------------------------------------------------------------------------

describe("RAD-139 createImplicitFeedback — comment text edge cases", () => {
  it("EC-1: comment includes AI reasoning when aiReasoning is provided (LIKE path)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "FILTERED",
        newStatus: "SENT_TO_NOTION",
        aiReasoning: "Off-topic for this digest",
      })
    )

    expect(result).not.toBeNull()
    expect(result!.commentText).toContain("Off-topic for this digest")
    expect(result!.commentText).toContain("AI reasoning")
  })

  it("EC-1: comment includes AI reasoning when aiReasoning is provided (DISLIKE path)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "APPROVED",
        newStatus: "DELETED",
        aiReasoning: "Meets quality bar",
      })
    )

    expect(result).not.toBeNull()
    expect(result!.commentText).toContain("Meets quality bar")
    expect(result!.commentText).toContain("AI reasoning")
  })

  it("EC-2: comment does not include AI reasoning when aiReasoning is null (LIKE path)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "FILTERED",
        newStatus: "SENT_TO_NOTION",
        aiReasoning: null,
      })
    )

    expect(result).not.toBeNull()
    expect(result!.commentText).not.toContain("AI reasoning")
    expect(result!.commentText).not.toContain("null")
  })

  it("EC-2: comment does not include AI reasoning when aiReasoning is null (DISLIKE path)", () => {
    const result = createImplicitFeedback(
      makeParams({
        aiEvaluation: "APPROVED",
        newStatus: "DELETED",
        aiReasoning: null,
      })
    )

    expect(result).not.toBeNull()
    expect(result!.commentText).not.toContain("AI reasoning")
  })
})

// ---------------------------------------------------------------------------
// createImplicitFeedback — error cases
// ---------------------------------------------------------------------------

describe("RAD-139 createImplicitFeedback — unknown status values", () => {
  it("ERR-1: returns null (does not throw) for unknown status 'SPAM' with FILTERED evaluation", () => {
    expect(() => {
      const result = createImplicitFeedback(
        makeParams({ aiEvaluation: "FILTERED", newStatus: "SPAM" })
      )
      expect(result).toBeNull()
    }).not.toThrow()
  })

  it("ERR-1: returns null (does not throw) for unknown status 'PENDING' with APPROVED evaluation", () => {
    expect(() => {
      const result = createImplicitFeedback(
        makeParams({ aiEvaluation: "APPROVED", newStatus: "PENDING" })
      )
      expect(result).toBeNull()
    }).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// EXCLUDED_STATUSES — exact membership
// ---------------------------------------------------------------------------

describe("RAD-139 EXCLUDED_STATUSES — refilter scope", () => {
  it("AC-6: EXCLUDED_STATUSES contains exactly DELETED, ARCHIVED, SENT_TO_STORIES, SENT_TO_NOTION", () => {
    const expected = new Set(["DELETED", "ARCHIVED", "SENT_TO_STORIES", "SENT_TO_NOTION"])
    const actual = new Set([...EXCLUDED_STATUSES])

    // Every expected status must be present
    for (const s of expected) {
      expect(actual).toContain(s)
    }
    // No extra statuses beyond the expected four
    expect(actual.size).toBe(4)
  })

  it("AC-6: EXCLUDED_STATUSES does NOT include NEW or READ — those must be re-evaluated", () => {
    const excluded = [...EXCLUDED_STATUSES]

    expect(excluded).not.toContain("NEW")
    expect(excluded).not.toContain("READ")
  })
})

// ---------------------------------------------------------------------------
// refilterMaterials — query shape
// ---------------------------------------------------------------------------

describe("RAD-139 refilterMaterials — query uses EXCLUDED_STATUSES for notIn", () => {
  it("AC-7: findMany is called with userStatus.notIn referencing all four excluded statuses", async () => {
    const deps = buildRefilterDeps()

    await refilterMaterials("user-rad139", deps)

    const findManyCall = (
      deps.db.material.findMany as ReturnType<typeof vi.fn>
    ).mock.calls[0][0]

    const notIn: string[] = findManyCall?.where?.userStatus?.notIn ?? []

    expect(notIn).toContain("DELETED")
    expect(notIn).toContain("ARCHIVED")
    expect(notIn).toContain("SENT_TO_STORIES")
    expect(notIn).toContain("SENT_TO_NOTION")
  })

  it("AC-7: query notIn list has exactly 4 entries — no extra statuses excluded", async () => {
    const deps = buildRefilterDeps()

    await refilterMaterials("user-rad139", deps)

    const findManyCall = (
      deps.db.material.findMany as ReturnType<typeof vi.fn>
    ).mock.calls[0][0]

    const notIn: string[] = findManyCall?.where?.userStatus?.notIn ?? []

    expect(notIn).toHaveLength(4)
  })
})
