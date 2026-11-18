/**
 * TDD RED phase — refilter-materials
 *
 * Feature: "Run AI Rules" — re-evaluate all non-archived materials using current AI filtering rules.
 *
 * Criteria covered:
 *   AC-1: refilterMaterials() fetches all eligible materials (excludes DELETED, ARCHIVED,
 *         SENT_TO_STORIES, SENT_TO_NOTION) belonging to the user via source.userId,
 *         and returns a result object with all expected counters.
 *   AC-2: For each fetched material, calls deps.evaluateMaterial() with { title, content, url },
 *         sourceId, and userId.
 *   AC-3: When new evaluation differs from existing aiEvaluation, updates aiEvaluation,
 *         aiConfidence, aiReasoning and increments the appropriate flip counter.
 *   AC-4: When new evaluation matches existing aiEvaluation, updates only aiConfidence and
 *         aiReasoning and increments unchanged.
 *   AC-5: Materials with userStatus SENT_TO_STORIES or SENT_TO_NOTION are excluded from query.
 *   EC-1: No eligible materials found → returns all-zero result, no evaluateMaterial calls.
 *   EC-2: Material was APPROVED, re-evaluation says FILTERED → aiEvaluation set to FILTERED,
 *         flippedToFiltered incremented by 1.
 *   ERR-1: evaluateMaterial throws for one material → processing continues; failed material not
 *          updated; errors count incremented.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  refilterMaterials,
  type RefilterDeps,
} from "@/lib/refilter-materials"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "clx_user_001"
const SOURCE_ID_1 = "src_001"
const SOURCE_ID_2 = "src_002"
const MATERIAL_ID_1 = "mat_001"
const MATERIAL_ID_2 = "mat_002"
const MATERIAL_ID_3 = "mat_003"

const mockApprovedMaterial = {
  id: MATERIAL_ID_1,
  title: "React 19 Released",
  content: "React 19 brings major improvements to the rendering pipeline.",
  url: "https://react.dev/blog/2024/12/05/react-19",
  sourceId: SOURCE_ID_1,
  aiEvaluation: "APPROVED",
  aiConfidence: 85,
  aiReasoning: "Highly relevant to frontend development.",
  feed: { userId: USER_ID },
}

const mockFilteredMaterial = {
  id: MATERIAL_ID_2,
  title: "Off-topic Article",
  content: "Something unrelated to the user interests.",
  url: "https://example.com/off-topic",
  sourceId: SOURCE_ID_2,
  aiEvaluation: "FILTERED",
  aiConfidence: 70,
  aiReasoning: "Does not match any criteria.",
  feed: { userId: USER_ID },
}

const mockApprovedMaterial2 = {
  id: MATERIAL_ID_3,
  title: "TypeScript 5.8 Features",
  content: "TypeScript 5.8 introduces new type narrowing capabilities.",
  url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8",
  sourceId: SOURCE_ID_1,
  aiEvaluation: "APPROVED",
  aiConfidence: 90,
  aiReasoning: "Strongly relevant.",
  feed: { userId: USER_ID },
}

// ---------------------------------------------------------------------------
// Dep factory
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<RefilterDeps> = {}): RefilterDeps {
  return {
    db: {
      material: {
        findMany: vi.fn().mockResolvedValue([mockApprovedMaterial]),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    evaluateMaterial: vi.fn().mockResolvedValue({
      relevant: true,
      confidence: 88,
      reasoning: "Still relevant.",
    }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refilterMaterials", () => {
  it("AC-1: fetches non-archived materials owned by the user and returns result with all expected counters", async () => {
    const deps = buildDeps()

    const result = await refilterMaterials(USER_ID, deps)

    // Query must exclude DELETED, ARCHIVED, SENT_TO_STORIES, SENT_TO_NOTION
    expect(deps.db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          feed: expect.objectContaining({ userId: USER_ID }),
          userStatus: expect.objectContaining({
            notIn: expect.arrayContaining([
              "DELETED",
              "ARCHIVED",
              "SENT_TO_STORIES",
              "SENT_TO_NOTION",
            ]),
          }),
        }),
      })
    )

    // Result must have all expected keys
    expect(result).toMatchObject({
      total: expect.any(Number),
      evaluated: expect.any(Number),
      flippedToApproved: expect.any(Number),
      flippedToFiltered: expect.any(Number),
      unchanged: expect.any(Number),
      errors: expect.any(Number),
    })
  })

  it("AC-2: calls evaluateMaterial() with { title, content, url }, sourceId, and userId for each material", async () => {
    const deps = buildDeps()

    await refilterMaterials(USER_ID, deps)

    expect(deps.evaluateMaterial).toHaveBeenCalledWith({
      material: {
        title: mockApprovedMaterial.title,
        content: mockApprovedMaterial.content,
        url: mockApprovedMaterial.url,
      },
      sourceId: mockApprovedMaterial.sourceId,
      userId: USER_ID,
    })
  })

  it("AC-3: when evaluation differs, updates aiEvaluation + aiConfidence + aiReasoning and increments flip counter", async () => {
    // Material is currently APPROVED; evaluation returns FILTERED (relevant: false)
    const deps = buildDeps({
      evaluateMaterial: vi.fn().mockResolvedValue({
        relevant: false,
        confidence: 92,
        reasoning: "No longer relevant after rule update.",
      }),
    })

    const result = await refilterMaterials(USER_ID, deps)

    expect(deps.db.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID_1 },
        data: expect.objectContaining({
          aiEvaluation: "FILTERED",
          aiConfidence: 92,
          aiReasoning: "No longer relevant after rule update.",
        }),
      })
    )
    // Flip counter must have been incremented (flippedToFiltered since APPROVED→FILTERED)
    expect(result.flippedToFiltered).toBe(1)
    expect(result.flippedToApproved).toBe(0)
  })

  it("AC-4: when evaluation matches existing verdict, updates only aiConfidence + aiReasoning and increments unchanged", async () => {
    // Material is APPROVED; evaluation returns relevant: true (still APPROVED)
    const deps = buildDeps({
      evaluateMaterial: vi.fn().mockResolvedValue({
        relevant: true,
        confidence: 95,
        reasoning: "Updated reasoning, same verdict.",
      }),
    })

    const result = await refilterMaterials(USER_ID, deps)

    expect(deps.db.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID_1 },
        data: expect.objectContaining({
          aiConfidence: 95,
          aiReasoning: "Updated reasoning, same verdict.",
        }),
      })
    )
    // aiEvaluation must NOT change — should not be present in update data
    const updateCall = (deps.db.material.update as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(updateCall[0].data).not.toHaveProperty("aiEvaluation")

    expect(result.unchanged).toBe(1)
    expect(result.flippedToApproved).toBe(0)
    expect(result.flippedToFiltered).toBe(0)
  })

  it("AC-5: excludes SENT_TO_STORIES and SENT_TO_NOTION from the query (preserves user overrides)", async () => {
    const deps = buildDeps()

    await refilterMaterials(USER_ID, deps)

    const findManyCall = (deps.db.material.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const notIn: string[] = findManyCall?.where?.userStatus?.notIn ?? []

    expect(notIn).toContain("SENT_TO_STORIES")
    expect(notIn).toContain("SENT_TO_NOTION")
  })

  it("EC-1: no eligible materials found → returns all-zero result with no evaluateMaterial calls", async () => {
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await refilterMaterials(USER_ID, deps)

    expect(result).toEqual({
      total: 0,
      evaluated: 0,
      flippedToApproved: 0,
      flippedToFiltered: 0,
      unchanged: 0,
      errors: 0,
    })
    expect(deps.evaluateMaterial).not.toHaveBeenCalled()
  })

  it("EC-2: material was APPROVED, re-evaluation says FILTERED → aiEvaluation updated to FILTERED, flippedToFiltered incremented", async () => {
    const deps = buildDeps({
      evaluateMaterial: vi.fn().mockResolvedValue({
        relevant: false,
        confidence: 80,
        reasoning: "Criteria changed, now irrelevant.",
      }),
    })
    // Approved material returned by query
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockApprovedMaterial,
    ])

    const result = await refilterMaterials(USER_ID, deps)

    expect(deps.db.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID_1 },
        data: expect.objectContaining({
          aiEvaluation: "FILTERED",
        }),
      })
    )
    expect(result.flippedToFiltered).toBe(1)
    expect(result.flippedToApproved).toBe(0)
    expect(result.unchanged).toBe(0)
  })

  it("ERR-1: evaluateMaterial throws for one material → processing continues, failed material not updated, errors incremented", async () => {
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockApprovedMaterial,
      mockApprovedMaterial2,
    ])
    // First call throws, second succeeds
    ;(deps.evaluateMaterial as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("AI timeout"))
      .mockResolvedValueOnce({
        relevant: true,
        confidence: 91,
        reasoning: "Still relevant.",
      })

    const result = await refilterMaterials(USER_ID, deps)

    // errors must be incremented for the failed material
    expect(result.errors).toBe(1)

    // Failed material must not have been updated
    const updateCalls = (deps.db.material.update as ReturnType<typeof vi.fn>).mock.calls
    const updatedIds = updateCalls.map((call) => call[0]?.where?.id)
    expect(updatedIds).not.toContain(MATERIAL_ID_1)

    // Second material must still have been processed
    expect(updatedIds).toContain(MATERIAL_ID_3)
    expect(result.evaluated).toBeGreaterThanOrEqual(1)
  })
})
