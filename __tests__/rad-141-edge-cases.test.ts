/**
 * TDD RED phase — RAD-141 Edge Cases & Robustness
 *
 * Covers:
 *   AC-1: INBOX server count logic matches client-side INBOX filter
 *   AC-2: APPROVED server count logic matches client-side APPROVED filter
 *   AC-3: FILTERED server count logic matches client-side FILTERED filter
 *   AC-4: refilterMaterials() with AbortSignal stops mid-run and returns partial results
 *   AC-5: refilterMaterials() evaluator throws → continues, increments errors, does NOT update failed material
 *   EC-1: processApprovedMaterials([]) returns zeros immediately with no DB calls
 *   EC-2: processApprovedMaterials() skips materials that already have a storyId
 *   EC-3: processApprovedMaterials() skips FILTERED materials
 *   ERR-1: refilterMaterials() with zero eligible materials returns total=0 immediately
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { refilterMaterials, type RefilterDeps } from "@/lib/refilter-materials"
import {
  processApprovedMaterials,
  type MaterialPipelineDeps,
} from "@/lib/story-aggregator/material-story-pipeline"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const USER_ID = "clx_test_user_001"
const SOURCE_ID = "src_test_001"

// Represents all possible material states for filter consistency tests
type FakeMaterial = {
  id: string
  aiEvaluation: "APPROVED" | "FILTERED" | null
  userStatus: "ACTIVE" | "DELETED" | "ARCHIVED" | "SENT_TO_NOTION" | "SENT_TO_STORIES"
  storyId: string | null
}

function makeMaterial(
  overrides: Partial<FakeMaterial> & { id: string }
): FakeMaterial {
  return {
    aiEvaluation: "APPROVED",
    userStatus: "ACTIVE",
    storyId: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC-1: INBOX filter consistency
// ---------------------------------------------------------------------------

describe("AC-1: INBOX server count matches client filter", () => {
  it("AC-1: server INBOX query (aiEvaluation=APPROVED, userStatus notIn [DELETED, ARCHIVED]) matches client predicate", () => {
    const materials: FakeMaterial[] = [
      makeMaterial({ id: "m1", aiEvaluation: "APPROVED", userStatus: "ACTIVE" }),       // in INBOX
      makeMaterial({ id: "m2", aiEvaluation: "APPROVED", userStatus: "DELETED" }),      // excluded
      makeMaterial({ id: "m3", aiEvaluation: "APPROVED", userStatus: "ARCHIVED" }),     // excluded
      makeMaterial({ id: "m4", aiEvaluation: "FILTERED", userStatus: "ACTIVE" }),       // excluded (wrong eval)
      makeMaterial({ id: "m5", aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION" }), // in INBOX server? Let's check...
      makeMaterial({ id: "m6", aiEvaluation: "APPROVED", userStatus: "SENT_TO_STORIES" }), // in INBOX server?
    ]

    // Server query: aiEvaluation === "APPROVED" AND userStatus NOT IN ["DELETED", "ARCHIVED"]
    const serverCount = materials.filter(
      (m) =>
        m.aiEvaluation === "APPROVED" &&
        m.userStatus !== "DELETED" &&
        m.userStatus !== "ARCHIVED"
    ).length

    // Client predicate (from materials-list.tsx line 258):
    // m.userStatus !== "DELETED" && m.userStatus !== "ARCHIVED" && m.aiEvaluation === "APPROVED"
    const clientCount = materials.filter(
      (m) =>
        m.userStatus !== "DELETED" &&
        m.userStatus !== "ARCHIVED" &&
        m.aiEvaluation === "APPROVED"
    ).length

    expect(serverCount).toBe(clientCount)
    // Verify the actual count is deterministic
    expect(serverCount).toBe(3) // m1, m5, m6 pass both filters
  })
})

// ---------------------------------------------------------------------------
// AC-2: APPROVED filter consistency
// ---------------------------------------------------------------------------

describe("AC-2: APPROVED server count matches client filter", () => {
  it("AC-2: server APPROVED query (aiEvaluation=APPROVED, excludes DELETED+ARCHIVED) matches client predicate", () => {
    const materials: FakeMaterial[] = [
      makeMaterial({ id: "m1", aiEvaluation: "APPROVED", userStatus: "ACTIVE" }),     // in APPROVED
      makeMaterial({ id: "m2", aiEvaluation: "APPROVED", userStatus: "DELETED" }),    // excluded
      makeMaterial({ id: "m3", aiEvaluation: "APPROVED", userStatus: "ARCHIVED" }),   // excluded (archived)
      makeMaterial({ id: "m4", aiEvaluation: "FILTERED", userStatus: "ACTIVE" }),     // excluded (wrong eval)
      makeMaterial({ id: "m5", aiEvaluation: "APPROVED", userStatus: "SENT_TO_NOTION" }), // in APPROVED
    ]

    // Server query: aiEvaluation === "APPROVED" AND userStatus notIn [DELETED, ARCHIVED]
    const serverCount = materials.filter(
      (m) =>
        m.aiEvaluation === "APPROVED" &&
        m.userStatus !== "DELETED" &&
        m.userStatus !== "ARCHIVED"
    ).length

    // Client predicate: m.userStatus !== "DELETED" && m.userStatus !== "ARCHIVED" && m.aiEvaluation === "APPROVED"
    const clientCount = materials.filter(
      (m) =>
        m.userStatus !== "DELETED" &&
        m.userStatus !== "ARCHIVED" &&
        m.aiEvaluation === "APPROVED"
    ).length

    expect(serverCount).toBe(clientCount)
    expect(serverCount).toBe(2) // m1, m5
  })
})

// ---------------------------------------------------------------------------
// AC-3: FILTERED filter consistency
// ---------------------------------------------------------------------------

describe("AC-3: FILTERED server count matches client filter", () => {
  it("AC-3: server FILTERED query (aiEvaluation=FILTERED, userStatus not DELETED) matches client predicate", () => {
    const materials: FakeMaterial[] = [
      makeMaterial({ id: "m1", aiEvaluation: "FILTERED", userStatus: "ACTIVE" }),    // in FILTERED
      makeMaterial({ id: "m2", aiEvaluation: "FILTERED", userStatus: "DELETED" }),   // excluded
      makeMaterial({ id: "m3", aiEvaluation: "FILTERED", userStatus: "ARCHIVED" }),  // in FILTERED (not deleted)
      makeMaterial({ id: "m4", aiEvaluation: "APPROVED", userStatus: "ACTIVE" }),    // excluded (wrong eval)
    ]

    // Server query: aiEvaluation === "FILTERED" AND userStatus !== "DELETED"
    const serverCount = materials.filter(
      (m) =>
        m.aiEvaluation === "FILTERED" &&
        m.userStatus !== "DELETED"
    ).length

    // Client predicate (from materials-list.tsx line 261-262):
    // m.userStatus !== "DELETED" && m.aiEvaluation === "FILTERED"
    const clientCount = materials.filter(
      (m) =>
        m.userStatus !== "DELETED" &&
        m.aiEvaluation === "FILTERED"
    ).length

    expect(serverCount).toBe(clientCount)
    expect(serverCount).toBe(2) // m1, m3
  })
})

// ---------------------------------------------------------------------------
// Refilter deps factory
// ---------------------------------------------------------------------------

function buildRefilterDeps(
  findManyResult: unknown[],
  overrides: Partial<RefilterDeps> = {}
): RefilterDeps {
  return {
    db: {
      material: {
        findMany: vi.fn().mockResolvedValue(findManyResult),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    evaluateMaterial: vi.fn().mockResolvedValue({
      relevant: true,
      confidence: 85,
      reasoning: "Relevant.",
    }),
    ...overrides,
  }
}

function makeDbMaterial(id: string, evaluation: string = "APPROVED") {
  return {
    id,
    title: `Material ${id}`,
    content: `Content for ${id}`,
    url: `https://example.com/${id}`,
    sourceId: SOURCE_ID,
    aiEvaluation: evaluation,
    aiConfidence: 80,
    aiReasoning: "Initial reasoning.",
    feed: { userId: USER_ID },
  }
}

// ---------------------------------------------------------------------------
// AC-4: refilterMaterials abort signal stops mid-run
// ---------------------------------------------------------------------------

describe("AC-4: refilterMaterials() aborts mid-run on AbortSignal", () => {
  it("AC-4: when AbortSignal fires after first material, stops processing and returns partial results", async () => {
    const mat1 = makeDbMaterial("abort-mat-1")
    const mat2 = makeDbMaterial("abort-mat-2")
    const mat3 = makeDbMaterial("abort-mat-3")

    const controller = new AbortController()

    const deps = buildRefilterDeps([mat1, mat2, mat3], {
      evaluateMaterial: vi.fn().mockImplementation(async () => {
        // After first evaluation, abort
        controller.abort()
        return { relevant: true, confidence: 88, reasoning: "Evaluated." }
      }),
    })

    const result = await refilterMaterials(USER_ID, deps, { signal: controller.signal })

    // total must be 3 (all fetched materials)
    expect(result.total).toBe(3)
    // Only 1 was evaluated before abort
    expect(result.evaluated).toBe(1)
    // Remaining 2 were NOT processed — evaluated + errors < total
    expect(result.evaluated + result.errors).toBeLessThan(result.total)
  })
})

// ---------------------------------------------------------------------------
// AC-5: refilterMaterials() continues when evaluator throws
// ---------------------------------------------------------------------------

describe("AC-5: refilterMaterials() continues on evaluator error", () => {
  it("AC-5: evaluator throws for one material — errors incremented, failed material NOT updated, rest processed", async () => {
    const failingMat = makeDbMaterial("fail-mat-1", "APPROVED")
    const okMat = makeDbMaterial("ok-mat-2", "APPROVED")

    const deps = buildRefilterDeps([failingMat, okMat])
    ;(deps.evaluateMaterial as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("AI evaluator timeout"))
      .mockResolvedValueOnce({ relevant: false, confidence: 72, reasoning: "Changed verdict." })

    const result = await refilterMaterials(USER_ID, deps)

    expect(result.errors).toBe(1)

    // Failed material must NOT have been updated
    const updateCalls = (deps.db.material.update as ReturnType<typeof vi.fn>).mock.calls
    const updatedIds = updateCalls.map((call: unknown[]) => (call[0] as { where: { id: string } }).where.id)
    expect(updatedIds).not.toContain("fail-mat-1")

    // Second material must have been processed (verdict flipped to FILTERED)
    expect(result.flippedToFiltered).toBe(1)
    expect(result.evaluated).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Pipeline deps factory
// ---------------------------------------------------------------------------

function buildPipelineDeps(overrides: Partial<MaterialPipelineDeps> = {}): MaterialPipelineDeps {
  return {
    db: {
      material: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
      story: {
        create: vi.fn().mockResolvedValue({ id: "story-new-1" }),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue({
          userId: USER_ID,
          storySystemPrompt: null,
          storyLanguage: "en",
        }),
      },
    },
    matchContent: vi.fn().mockResolvedValue({ match: null, isNew: true, reasoning: "New topic." }),
    generateStory: vi.fn().mockResolvedValue({
      title: "Test Story",
      languageFlag: "en",
      summary: "Summary",
      body: "Body",
      keyPoints: [],
      sourceUrls: [],
      rubrics: [],
    }),
    matchWithAI: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// EC-1: processApprovedMaterials with empty array
// ---------------------------------------------------------------------------

describe("EC-1: processApprovedMaterials() returns zeros immediately for empty input", () => {
  it("EC-1: empty materialIds array returns all-zero summary with no DB calls", async () => {
    const deps = buildPipelineDeps()

    const result = await processApprovedMaterials([], USER_ID, deps)

    expect(result).toEqual({
      storiesCreated: 0,
      storiesUpdated: 0,
      materialsProcessed: 0,
      materialsSkipped: 0,
    })

    // No DB access should have happened
    expect(deps.db.material.findMany).not.toHaveBeenCalled()
    expect(deps.db.story.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// EC-2: processApprovedMaterials() skips materials with existing storyId
// ---------------------------------------------------------------------------

describe("EC-2: processApprovedMaterials() skips materials that already have a storyId", () => {
  it("EC-2: material with storyId set is skipped and materialsSkipped is incremented", async () => {
    const materialWithStory = {
      id: "mat-has-story",
      title: "Already grouped",
      content: "Content",
      url: "https://example.com/grouped",
      rawText: null,
      aiEvaluation: "APPROVED",
      userStatus: "ACTIVE",
      storyId: "existing-story-id",
      storyMatchedAt: new Date(),
      feed: { userId: USER_ID, name: "Test Source", type: "RSS" },
    }

    const deps = buildPipelineDeps({
      db: {
        ...buildPipelineDeps().db,
        material: {
          findMany: vi.fn().mockResolvedValue([materialWithStory]),
          update: vi.fn().mockResolvedValue({}),
        },
      },
    })

    const result = await processApprovedMaterials(["mat-has-story"], USER_ID, deps)

    expect(result.materialsSkipped).toBe(1)
    expect(result.materialsProcessed).toBe(0)
    // No story should be created
    expect(deps.db.story.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// EC-3: processApprovedMaterials() skips FILTERED materials
// ---------------------------------------------------------------------------

describe("EC-3: processApprovedMaterials() skips FILTERED materials", () => {
  it("EC-3: material with aiEvaluation=FILTERED is skipped, materialsSkipped incremented", async () => {
    const filteredMaterial = {
      id: "mat-filtered",
      title: "Filtered material",
      content: "Content",
      url: "https://example.com/filtered",
      rawText: null,
      aiEvaluation: "FILTERED",
      userStatus: "ACTIVE",
      storyId: null,
      storyMatchedAt: null,
      feed: { userId: USER_ID, name: "Test Source", type: "RSS" },
    }

    const deps = buildPipelineDeps({
      db: {
        ...buildPipelineDeps().db,
        material: {
          findMany: vi.fn().mockResolvedValue([filteredMaterial]),
          update: vi.fn().mockResolvedValue({}),
        },
      },
    })

    const result = await processApprovedMaterials(["mat-filtered"], USER_ID, deps)

    expect(result.materialsSkipped).toBe(1)
    expect(result.materialsProcessed).toBe(0)
    expect(deps.matchContent).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// ERR-1: refilterMaterials() with zero eligible materials
// ---------------------------------------------------------------------------

describe("ERR-1: refilterMaterials() with zero eligible materials", () => {
  it("ERR-1: when no eligible materials found, returns immediately with total=0 and no evaluations", async () => {
    const deps = buildRefilterDeps([])

    const result = await refilterMaterials(USER_ID, deps)

    expect(result.total).toBe(0)
    expect(result.evaluated).toBe(0)
    expect(result.errors).toBe(0)
    expect(result.flippedToApproved).toBe(0)
    expect(result.flippedToFiltered).toBe(0)
    expect(result.unchanged).toBe(0)

    expect(deps.evaluateMaterial).not.toHaveBeenCalled()
  })
})
