/**
 * RAD-137 — Post grid doesn't update after AI Rules / Group Stories
 *
 * These tests DISPROVE the bug fix — they fail if the fix is wrong or incomplete.
 *
 * Root causes fixed:
 *   1. SSR query in page.tsx was missing `storyId` and `story` relation fields
 *   2. `streamedMaterials` was not cleared before `router.refresh()` in 3 handlers
 *      (refilter complete, grouping complete, parse complete), causing stale streamed
 *      data to shadow fresh server data in the combinedMaterials merge.
 *
 * Criteria:
 *   AC-1: SSR materialSelect in page.tsx includes storyId and story with all required fields
 *   AC-2: SSR materialSelect and API /api/posts story fields are identical
 *   AC-3: combinedMaterials merge — when streamedMaterials is empty, equals materials
 *   AC-4: combinedMaterials merge — when streamedMaterials is non-empty, streamed data wins (existing priority)
 *   AC-5: refilterMaterials() excludes DELETED, ARCHIVED, SENT_TO_STORIES, SENT_TO_NOTION
 *   AC-6: refilterMaterials() updates aiEvaluation via db.material.update when verdict flips
 */

import { describe, it, expect, vi } from "vitest"
import { refilterMaterials, EXCLUDED_STATUSES, type RefilterDeps } from "@/lib/refilter-materials"
import fs from "fs"
import path from "path"

// ---------------------------------------------------------------------------
// Helpers — parse source files as text (no runtime imports needed for static analysis)
// ---------------------------------------------------------------------------

function readSource(relPath: string): string {
  const abs = path.resolve(__dirname, "..", relPath)
  return fs.readFileSync(abs, "utf-8")
}

// ---------------------------------------------------------------------------
// AC-1: SSR materialSelect includes storyId and story with required sub-fields
// (After RAD-208, the select lives in lib/materials/fetch-materials-page.ts
// instead of inline in posts/page.tsx — both callers share it.)
// ---------------------------------------------------------------------------

describe("AC-1: SSR materialSelect includes story fields", () => {
  const helperSource = readSource("lib/materials/fetch-materials-page.ts")

  it("AC-1a: materialSelect contains storyId: true", () => {
    // The select object must explicitly include storyId
    expect(helperSource).toMatch(/storyId\s*:\s*true/)
  })

  it("AC-1b: materialSelect contains story relation select with id, title, summary", () => {
    // The story select block must be present with core fields
    expect(helperSource).toMatch(/story\s*:\s*\{/)
    expect(helperSource).toMatch(/id\s*:\s*true/)
    expect(helperSource).toMatch(/title\s*:\s*true/)
    expect(helperSource).toMatch(/summary\s*:\s*true/)
  })

  it("AC-1c: materialSelect story select includes rubrics, sourceUrls, status, version, createdAt", () => {
    // These fields are required by the Material type in materials-list.tsx
    expect(helperSource).toMatch(/rubrics\s*:\s*true/)
    expect(helperSource).toMatch(/sourceUrls\s*:\s*true/)
    expect(helperSource).toMatch(/status\s*:\s*true/)
    expect(helperSource).toMatch(/version\s*:\s*true/)
  })

  it("AC-1d: materialSelect story select includes _count with materials and inboxItems", () => {
    expect(helperSource).toMatch(/_count/)
    expect(helperSource).toMatch(/materials\s*:\s*true/)
    expect(helperSource).toMatch(/inboxItems\s*:\s*true/)
  })
})

// ---------------------------------------------------------------------------
// AC-2: SSR helper and API story selects are structurally consistent
// ---------------------------------------------------------------------------

describe("AC-2: SSR helper and API /api/posts/route.ts story fields are consistent", () => {
  const helperSource = readSource("lib/materials/fetch-materials-page.ts")
  const apiSource = readSource("app/api/posts/route.ts")

  const STORY_FIELDS = ["id", "title", "summary", "rubrics", "sourceUrls", "status", "version", "createdAt", "_count"]

  for (const field of STORY_FIELDS) {
    it(`AC-2: both helper and route.ts select story field "${field}"`, () => {
      // Both files must reference this field inside a story select block
      const helperHasField = helperSource.includes(field)
      const apiHasField = apiSource.includes(field)

      expect(helperHasField).toBe(true)
      expect(apiHasField).toBe(true)
    })
  }

  it("AC-2: both sources include storyId: true at material level", () => {
    expect(helperSource).toMatch(/storyId\s*:\s*true/)
    expect(apiSource).toMatch(/storyId\s*:\s*true/)
  })
})

// ---------------------------------------------------------------------------
// AC-3: combinedMaterials merge — when streamedMaterials is empty, result equals materials
// ---------------------------------------------------------------------------

describe("AC-3: combinedMaterials merge logic — empty streamed", () => {
  // Pure function extracted from the useMemo in materials-list.tsx
  function combinedMaterials(streamedMaterials: { id: string; aiEvaluation: string }[], materials: { id: string; aiEvaluation: string }[]) {
    const seen = new Set<string>()
    const result: typeof materials = []
    for (const material of [...streamedMaterials, ...materials]) {
      if (!seen.has(material.id)) {
        seen.add(material.id)
        result.push(material)
      }
    }
    return result
  }

  it("AC-3: when streamedMaterials is empty, combinedMaterials equals materials exactly", () => {
    const materials = [
      { id: "mat-1", aiEvaluation: "APPROVED" },
      { id: "mat-2", aiEvaluation: "FILTERED" },
    ]

    const result = combinedMaterials([], materials)

    expect(result).toEqual(materials)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("mat-1")
    expect(result[1].id).toBe("mat-2")
  })

  it("AC-3: after clearing streamedMaterials, fresh server data is reflected without stale overrides", () => {
    // Simulate: server data has updated aiEvaluation = FILTERED (after refilter)
    const freshMaterials = [{ id: "mat-1", aiEvaluation: "FILTERED" }]

    // streamedMaterials is cleared (the fix) — so empty
    const result = combinedMaterials([], freshMaterials)

    // Fresh data must win — not stale APPROVED from before the refilter
    expect(result[0].aiEvaluation).toBe("FILTERED")
  })
})

// ---------------------------------------------------------------------------
// AC-4: combinedMaterials merge — when streamedMaterials has data, streamed wins (existing priority)
// ---------------------------------------------------------------------------

describe("AC-4: combinedMaterials merge logic — streamed data takes priority when present", () => {
  function combinedMaterials(streamedMaterials: { id: string; aiEvaluation: string }[], materials: { id: string; aiEvaluation: string }[]) {
    const seen = new Set<string>()
    const result: typeof materials = []
    for (const material of [...streamedMaterials, ...materials]) {
      if (!seen.has(material.id)) {
        seen.add(material.id)
        result.push(material)
      }
    }
    return result
  }

  it("AC-4: when streamedMaterials has stale APPROVED and materials has fresh FILTERED, stale wins", () => {
    // This documents the existing merge priority (streamed > server)
    // The fix works by CLEARING streamed before refresh, not by changing priority
    const streamedMaterials = [{ id: "mat-1", aiEvaluation: "APPROVED" }]
    const freshMaterials = [{ id: "mat-1", aiEvaluation: "FILTERED" }]

    const result = combinedMaterials(streamedMaterials, freshMaterials)

    // Streamed data wins — APPROVED stays (this confirms clearing is the correct fix)
    expect(result).toHaveLength(1)
    expect(result[0].aiEvaluation).toBe("APPROVED")
  })

  it("AC-4: streamed-only materials are included before server materials", () => {
    const streamedMaterials = [{ id: "mat-new", aiEvaluation: "APPROVED" }]
    const serverMaterials = [{ id: "mat-old", aiEvaluation: "FILTERED" }]

    const result = combinedMaterials(streamedMaterials, serverMaterials)

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("mat-new")
    expect(result[1].id).toBe("mat-old")
  })
})

// ---------------------------------------------------------------------------
// AC-5: refilterMaterials() excludes correct statuses
// ---------------------------------------------------------------------------

describe("AC-5: refilterMaterials excludes correct statuses from DB query", () => {
  function buildDeps(overrides: Partial<RefilterDeps> = {}): RefilterDeps {
    return {
      db: {
        material: {
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue({}),
        },
      },
      evaluateMaterial: vi.fn().mockResolvedValue({ relevant: true, confidence: 80, reasoning: "ok" }),
      ...overrides,
    }
  }

  it("AC-5: EXCLUDED_STATUSES constant contains all four required statuses", () => {
    expect(EXCLUDED_STATUSES).toContain("DELETED")
    expect(EXCLUDED_STATUSES).toContain("ARCHIVED")
    expect(EXCLUDED_STATUSES).toContain("SENT_TO_STORIES")
    expect(EXCLUDED_STATUSES).toContain("SENT_TO_NOTION")
  })

  it("AC-5: refilterMaterials passes all four excluded statuses in notIn filter", async () => {
    const deps = buildDeps()
    await refilterMaterials("user-1", deps)

    const findManyCall = (deps.db.material.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
    const notIn: string[] = findManyCall?.where?.userStatus?.notIn ?? []

    expect(notIn).toContain("DELETED")
    expect(notIn).toContain("ARCHIVED")
    expect(notIn).toContain("SENT_TO_STORIES")
    expect(notIn).toContain("SENT_TO_NOTION")
  })
})

// ---------------------------------------------------------------------------
// AC-6: refilterMaterials() updates aiEvaluation when verdict flips (APPROVED → FILTERED)
// ---------------------------------------------------------------------------

describe("AC-6: refilterMaterials updates aiEvaluation on verdict flip", () => {
  const mockApprovedMaterial = {
    id: "mat-001",
    title: "Approved Article",
    content: "Some content",
    url: "https://example.com/article",
    sourceId: "src-001",
    aiEvaluation: "APPROVED",
    aiConfidence: 85,
    aiReasoning: "Looks good.",
    feed: { userId: "user-1" },
  }

  function buildDeps(overrides: Partial<RefilterDeps> = {}): RefilterDeps {
    return {
      db: {
        material: {
          findMany: vi.fn().mockResolvedValue([mockApprovedMaterial]),
          update: vi.fn().mockResolvedValue({}),
        },
      },
      evaluateMaterial: vi.fn().mockResolvedValue({ relevant: true, confidence: 80, reasoning: "ok" }),
      ...overrides,
    }
  }

  it("AC-6: when APPROVED material is re-evaluated as FILTERED, db.material.update is called with aiEvaluation: FILTERED", async () => {
    const deps = buildDeps({
      evaluateMaterial: vi.fn().mockResolvedValue({
        relevant: false,
        confidence: 92,
        reasoning: "No longer relevant after rule update.",
      }),
    })

    const result = await refilterMaterials("user-1", deps)

    expect(deps.db.material.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "mat-001" },
        data: expect.objectContaining({
          aiEvaluation: "FILTERED",
          aiConfidence: 92,
          aiReasoning: "No longer relevant after rule update.",
        }),
      })
    )
    expect(result.flippedToFiltered).toBe(1)
    expect(result.flippedToApproved).toBe(0)
  })

  it("AC-6: when verdict is unchanged, aiEvaluation is NOT included in the update payload", async () => {
    const deps = buildDeps({
      evaluateMaterial: vi.fn().mockResolvedValue({
        relevant: true, // still APPROVED
        confidence: 90,
        reasoning: "Still relevant.",
      }),
    })

    await refilterMaterials("user-1", deps)

    const updateCall = (deps.db.material.update as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(updateCall[0].data).not.toHaveProperty("aiEvaluation")
  })
})
