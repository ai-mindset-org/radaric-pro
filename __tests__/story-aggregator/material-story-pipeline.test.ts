/**
 * Phase 3 — Material Story Pipeline
 * TDD RED phase: all tests are expected to FAIL until implementation is written.
 *
 * Spec: RAD-120 Phase 3
 *
 * Criteria covered:
 *   AC-1: processApprovedMaterials() fetches materials by IDs with source relation,
 *         filters to only APPROVED materials owned by the user (via source.userId)
 *   AC-2: Materials that already have a storyId are skipped (idempotency)
 *   AC-3: For each material, calls matchContent() with correct field mapping
 *         (title→title, content→content, url→url, rawText→null)
 *   AC-4: When match found → sets storyId + userStatus="SENT_TO_STORIES" + storyMatchedAt,
 *         then calls updateExistingStory() to regenerate
 *   AC-5: When no match → creates new story via AI, links material with storyId,
 *         sets userStatus="SENT_TO_STORIES" and storyMatchedAt
 *   AC-6: Returns summary { storiesCreated, storiesUpdated, materialsProcessed, materialsSkipped }
 *   EC-1: Empty materialIds array → returns all-zeros summary, no DB calls
 *   EC-2: All materials already have storyId → returns materialsSkipped: N, storiesCreated: 0
 *   EC-3: Material with FILTERED status (not APPROVED) → skipped even if ID is in the list
 *   ERR-1: AI failure for one material continues processing remaining; failed material
 *          not linked to any story; result includes errors count
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  processApprovedMaterials,
  type MaterialPipelineDeps,
} from "@/lib/story-aggregator/material-story-pipeline"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "clx_user_001"
const MATERIAL_ID_1 = "mat_001"
const MATERIAL_ID_2 = "mat_002"
const MATERIAL_ID_3 = "mat_003"
const STORY_ID_EXISTING = "story_existing_001"
const STORY_ID_NEW = "story_new_001"

const mockApprovedMaterial = {
  id: MATERIAL_ID_1,
  title: "React 19 Released",
  content: "React 19 brings major improvements to the rendering pipeline.",
  url: "https://react.dev/blog/2024/12/05/react-19",
  rawText: null,
  aiEvaluation: "APPROVED",
  userStatus: "NEW",
  storyId: null,
  storyMatchedAt: null,
  feed: {
    userId: USER_ID,
    name: "React Blog",
    type: "RSS",
  },
}

const mockApprovedMaterial2 = {
  id: MATERIAL_ID_2,
  title: "TypeScript 5.8 Features",
  content: "TypeScript 5.8 introduces new type narrowing capabilities.",
  url: "https://devblogs.microsoft.com/typescript/announcing-typescript-5-8",
  rawText: null,
  aiEvaluation: "APPROVED",
  userStatus: "NEW",
  storyId: null,
  storyMatchedAt: null,
  feed: {
    userId: USER_ID,
    name: "TypeScript Blog",
    type: "RSS",
  },
}

const mockMaterialAlreadyLinked = {
  id: MATERIAL_ID_3,
  title: "Already Processed Article",
  content: "This was already processed before.",
  url: "https://example.com/already-processed",
  rawText: null,
  aiEvaluation: "APPROVED",
  userStatus: "SENT_TO_STORIES",
  storyId: STORY_ID_EXISTING,
  storyMatchedAt: new Date("2026-03-01T10:00:00Z"),
  feed: {
    userId: USER_ID,
    name: "Example",
    type: "RSS",
  },
}

const mockAIStoryOutput = {
  languageFlag: "GB",
  title: "React 19 Released",
  rubrics: ["Новые технологии"],
  authorLevel: "expert",
  materialType: "news",
  materialCharacter: "useful",
  summary: "React 19 is out with major improvements.",
  body: "The React team has released version 19 with significant changes to the rendering pipeline.",
  keyPoints: ["New rendering engine", "Improved performance"],
  sourceUrls: ["https://react.dev/blog/2024/12/05/react-19"],
}

// ---------------------------------------------------------------------------
// Dep factory
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<MaterialPipelineDeps> = {}): MaterialPipelineDeps {
  const storyCreate = vi.fn().mockResolvedValue({ id: STORY_ID_NEW })
  const materialUpdateMany = vi.fn().mockResolvedValue({ count: 1 })

  const db: MaterialPipelineDeps["db"] = {
    material: {
      findMany: vi.fn().mockResolvedValue([mockApprovedMaterial]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: materialUpdateMany,
    },
    story: {
      create: storyCreate,
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
    // Run the callback against the same story.create / material.updateMany mocks.
    $transaction: vi.fn(async (fn) =>
      fn({ story: { create: storyCreate }, material: { updateMany: materialUpdateMany } })
    ),
  }

  return {
    db,
    matchContent: vi
      .fn()
      .mockResolvedValue({ match: null, matchType: null, isNew: true, reasoning: "No match" }),
    generateStory: vi.fn().mockResolvedValue(mockAIStoryOutput),
    matchWithAI: vi.fn().mockResolvedValue({ match: null, reasoning: "No match" }),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processApprovedMaterials", () => {
  it("AC-1: fetches materials by IDs with source relation and filters to only APPROVED materials owned by the user", async () => {
    const deps = buildDeps()
    const materialOtherUser = {
      ...mockApprovedMaterial,
      id: "mat_other",
      feed: { userId: "other_user_id" },
    }
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockApprovedMaterial,
      materialOtherUser,
    ])

    const result = await processApprovedMaterials([MATERIAL_ID_1, "mat_other"], USER_ID, deps)

    // findMany should have been called with the given IDs
    expect(deps.db.material.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: [MATERIAL_ID_1, "mat_other"] },
        }),
      })
    )

    // Only the user's material should have been processed (1 processed, 1 skipped due to wrong user)
    expect(result.materialsProcessed).toBe(1)
  })

  it("AC-2: skips materials that already have a storyId (idempotency)", async () => {
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockMaterialAlreadyLinked,
    ])

    const result = await processApprovedMaterials([MATERIAL_ID_3], USER_ID, deps)

    expect(result.materialsSkipped).toBe(1)
    expect(result.materialsProcessed).toBe(0)
    expect(result.storiesCreated).toBe(0)
    expect(result.storiesUpdated).toBe(0)
    // matchContent should never be called for already-linked materials
    expect(deps.matchContent).not.toHaveBeenCalled()
  })

  it("AC-3: calls matchContent() with correct field mapping + candidate pool + requireSignal", async () => {
    const deps = buildDeps()

    await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    expect(deps.matchContent).toHaveBeenCalledWith(
      {
        title: mockApprovedMaterial.title,
        content: mockApprovedMaterial.content,
        url: mockApprovedMaterial.url,
        rawText: null,
      },
      USER_ID,
      expect.anything(),
      expect.objectContaining({
        candidateMaterials: expect.any(Array),
        requireSignal: true,
      })
    )
  })

  it("AC-4: when match found → updates material with storyId, userStatus=SENT_TO_STORIES, storyMatchedAt, then calls updateExistingStory", async () => {
    const deps = buildDeps({
      matchContent: vi.fn().mockResolvedValue({
        match: STORY_ID_EXISTING,
        matchType: "story",
        isNew: false,
        reasoning: "URL match",
      }),
    })
    // Provide story record for updateExistingStory to fetch
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: STORY_ID_EXISTING,
      userId: USER_ID,
      title: "Existing Story",
      languageFlag: "GB",
      summary: "Summary",
      body: "Body",
      keyPoints: [],
      sourceUrls: [],
      rubrics: [],
      archiveLinks: null,
      notionPageId: null,
      notionUrl: null,
      status: "DRAFT",
      version: 1,
      inboxItems: [],
      materials: [mockApprovedMaterial],
    })

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    // material.update must set storyId and SENT_TO_STORIES
    expect(deps.db.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID_1 },
        data: expect.objectContaining({
          storyId: STORY_ID_EXISTING,
          storyMatchedAt: expect.any(Date),
        }),
      })
    )

    expect(result.storiesUpdated).toBe(1)
    expect(result.storiesCreated).toBe(0)
  })

  it("AC-5 (new default): no match → leaves the post standalone, NO story created", async () => {
    const deps = buildDeps({
      matchContent: vi
        .fn()
        .mockResolvedValue({ match: null, matchType: null, isNew: true, reasoning: "No match" }),
    })

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    // No summarization for a lone post: no AI story generation, no story row, no link.
    expect(deps.generateStory).not.toHaveBeenCalled()
    expect(deps.db.story.create).not.toHaveBeenCalled()
    expect(deps.db.material.update).not.toHaveBeenCalled()

    expect(result.storiesCreated).toBe(0)
    expect(result.storiesUpdated).toBe(0)
    expect(result.materialsProcessed).toBe(1)
  })

  it("allowSingletonStory: explicit manual path still creates a single-material story on no match", async () => {
    const deps = buildDeps({
      matchContent: vi
        .fn()
        .mockResolvedValue({ match: null, matchType: null, isNew: true, reasoning: "No match" }),
    })

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps, {
      allowSingletonStory: true,
    })

    expect(deps.generateStory).toHaveBeenCalled()
    expect(deps.db.story.create).toHaveBeenCalled()
    // Singleton link goes through the guarded transaction (updateMany, storyId:null).
    expect(deps.db.$transaction).toHaveBeenCalled()
    expect(deps.db.material.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATERIAL_ID_1, storyId: null },
        data: expect.objectContaining({ storyId: STORY_ID_NEW, storyMatchedAt: expect.any(Date) }),
      })
    )
    expect(result.storiesCreated).toBe(1)
  })

  it("pairs two standalone posts (SSE one-at-a-time shape) into ONE story linking both", async () => {
    // Mimics the real Group Stories button: processApprovedMaterials([A]) with a
    // persisted standalone B that A matches living in the DB candidate pool.
    const deps = buildDeps({
      matchContent: vi.fn().mockResolvedValue({
        match: MATERIAL_ID_2,
        matchType: "material",
        isNew: false,
        reasoning: "Same topic as the standalone partner",
      }),
    })
    // 1st findMany = by-id (just A); 2nd findMany = candidate pool (A + persisted B)
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([mockApprovedMaterial])
      .mockResolvedValueOnce([mockApprovedMaterial, mockApprovedMaterial2])

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    // Exactly one story, created atomically, with BOTH materials claimed (storyId:null guard).
    expect(deps.db.story.create).toHaveBeenCalledTimes(1)
    expect(deps.db.$transaction).toHaveBeenCalledTimes(1)
    const claimedIds = (deps.db.material.updateMany as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0]?.where?.id
    )
    expect(claimedIds).toEqual(expect.arrayContaining([MATERIAL_ID_1, MATERIAL_ID_2]))
    // Each claim is guarded on storyId:null so a concurrent run can't double-link.
    for (const call of (deps.db.material.updateMany as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]?.where?.storyId).toBeNull()
    }
    expect(result.storiesCreated).toBe(1)
  })

  it("pairing partial failure (2nd link throws) does not leave a 1-material story", async () => {
    const deps = buildDeps({
      matchContent: vi.fn().mockResolvedValue({
        match: MATERIAL_ID_2,
        matchType: "material",
        isNew: false,
        reasoning: "match",
      }),
    })
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([mockApprovedMaterial])
      .mockResolvedValueOnce([mockApprovedMaterial, mockApprovedMaterial2])
    // The transaction throws partway → the whole pairing (story.create + links) rolls back.
    ;(deps.db.$transaction as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Material mat_002 already linked to a story")
    )

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    // No story counted, the failure is captured, and no plain material.update sneaks a link in.
    expect(result.storiesCreated).toBe(0)
    expect((result as { errors?: number }).errors).toBeGreaterThanOrEqual(1)
    expect(deps.db.material.update).not.toHaveBeenCalled()
  })

  it("AC-6: returns summary with storiesCreated, storiesUpdated, materialsProcessed, materialsSkipped", async () => {
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockApprovedMaterial,
      mockMaterialAlreadyLinked,
    ])

    const result = await processApprovedMaterials(
      [MATERIAL_ID_1, MATERIAL_ID_3],
      USER_ID,
      deps
    )

    expect(result).toMatchObject({
      storiesCreated: expect.any(Number),
      storiesUpdated: expect.any(Number),
      materialsProcessed: expect.any(Number),
      materialsSkipped: expect.any(Number),
    })
    // Totals must be consistent
    expect(result.materialsProcessed + result.materialsSkipped).toBeGreaterThanOrEqual(1)
  })

  it("EC-1: empty materialIds array → returns all-zeros summary with no DB calls", async () => {
    const deps = buildDeps()

    const result = await processApprovedMaterials([], USER_ID, deps)

    expect(result).toEqual({
      storiesCreated: 0,
      storiesUpdated: 0,
      materialsProcessed: 0,
      materialsSkipped: 0,
    })
    expect(deps.db.material.findMany).not.toHaveBeenCalled()
  })

  it("EC-2: all materials already have storyId → returns materialsSkipped equal to count, storiesCreated: 0, storiesUpdated: 0", async () => {
    const alreadyLinked1 = { ...mockApprovedMaterial, id: "mat_a", storyId: "story_a" }
    const alreadyLinked2 = { ...mockApprovedMaterial, id: "mat_b", storyId: "story_b" }
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      alreadyLinked1,
      alreadyLinked2,
    ])

    const result = await processApprovedMaterials(["mat_a", "mat_b"], USER_ID, deps)

    expect(result.materialsSkipped).toBe(2)
    expect(result.storiesCreated).toBe(0)
    expect(result.storiesUpdated).toBe(0)
    expect(deps.matchContent).not.toHaveBeenCalled()
  })

  it("EC-3: material with FILTERED status (not APPROVED) is skipped even if its ID is in the list", async () => {
    const filteredMaterial = {
      ...mockApprovedMaterial,
      id: "mat_filtered",
      aiEvaluation: "FILTERED",
    }
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([filteredMaterial])

    const result = await processApprovedMaterials(["mat_filtered"], USER_ID, deps)

    expect(result.materialsSkipped).toBe(1)
    expect(result.materialsProcessed).toBe(0)
    expect(deps.matchContent).not.toHaveBeenCalled()
  })

  it("ERR-1: AI failure for one material continues processing remaining; failed material not linked; result includes errors field", async () => {
    // Use the singleton (manual) path so each material independently calls generateStory.
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      mockApprovedMaterial,
      mockApprovedMaterial2,
    ])
    // First call throws, second call succeeds
    ;(deps.generateStory as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("AI timeout"))
      .mockResolvedValueOnce(mockAIStoryOutput)

    const result = await processApprovedMaterials(
      [MATERIAL_ID_1, MATERIAL_ID_2],
      USER_ID,
      deps,
      { allowSingletonStory: true }
    )

    // Second material should still be processed
    expect(result.storiesCreated).toBe(1)
    // Failed material should not have been linked (singleton links via updateMany)
    const linkCalls = (deps.db.material.updateMany as ReturnType<typeof vi.fn>).mock.calls
    const linkedIds = linkCalls
      .filter((call) => call[0]?.data?.storyId !== undefined)
      .map((call) => call[0]?.where?.id)
    expect(linkedIds).not.toContain(MATERIAL_ID_1)
    expect(linkedIds).toContain(MATERIAL_ID_2)

    // Result includes errors count
    expect((result as { errors?: number }).errors).toBeGreaterThanOrEqual(1)
  })

  it("triangle: three mutually-related standalone posts in one batch → exactly one story, no fragmentation", async () => {
    const matA = { ...mockApprovedMaterial, id: "tri_a" }
    const matB = { ...mockApprovedMaterial, id: "tri_b" }
    const matC = { ...mockApprovedMaterial, id: "tri_c" }
    const deps = buildDeps()
    // by-id batch = all three; pool = all three (every later call returns the same set).
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([matA, matB, matC])
    // A pairs with B (first standalone partner); after that B and C are claimed/handled.
    ;(deps.matchContent as ReturnType<typeof vi.fn>).mockImplementation(
      async (_content, _userId, _mdeps, opts) => {
        const partnerId = opts?.candidateMaterials?.[0]?.id
        return partnerId
          ? { match: partnerId, matchType: "material", isNew: false, reasoning: "related" }
          : { match: null, matchType: null, isNew: true, reasoning: "no candidates" }
      }
    )

    const result = await processApprovedMaterials(["tri_a", "tri_b", "tri_c"], USER_ID, deps)

    // A+B form one story; B is then skipped (linkedThisRun); C has no remaining partner → standalone.
    expect(result.storiesCreated).toBe(1)
    expect(deps.db.story.create).toHaveBeenCalledTimes(1)
  })

  it("re-run on a lone post with no candidate → no new story and no AI call (idempotency/cost)", async () => {
    // requireSignal path: matchContent returns no match without invoking generateStory.
    const deps = buildDeps({
      matchContent: vi
        .fn()
        .mockResolvedValue({ match: null, matchType: null, isNew: true, reasoning: "no signal" }),
    })
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([mockApprovedMaterial])
      .mockResolvedValueOnce([mockApprovedMaterial]) // pool = only itself

    const result = await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    expect(result.storiesCreated).toBe(0)
    expect(deps.generateStory).not.toHaveBeenCalled()
    expect(deps.db.story.create).not.toHaveBeenCalled()
  })

  it("skips a DELETED material even if its id is passed in (eligible filter)", async () => {
    const deleted = { ...mockApprovedMaterial, id: "mat_del", userStatus: "DELETED" }
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([deleted])

    const result = await processApprovedMaterials(["mat_del"], USER_ID, deps)

    expect(result.materialsSkipped).toBe(1)
    expect(result.materialsProcessed).toBe(0)
    expect(deps.matchContent).not.toHaveBeenCalled()
  })

  it("candidate-pool query excludes hidden feeds + DELETED/ARCHIVED and is bounded", async () => {
    const deps = buildDeps()
    ;(deps.db.material.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([mockApprovedMaterial]) // by-id
      .mockResolvedValueOnce([]) // pool

    await processApprovedMaterials([MATERIAL_ID_1], USER_ID, deps)

    const poolArgs = (deps.db.material.findMany as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(poolArgs.where.feed).toEqual({ userId: USER_ID, hidden: false })
    expect(poolArgs.where.aiEvaluation).toBe("APPROVED")
    expect(poolArgs.where.storyId).toBeNull()
    expect(poolArgs.where.userStatus).toEqual({ notIn: ["DELETED", "ARCHIVED"] })
    expect(poolArgs.take).toBeGreaterThan(0)
  })
})
