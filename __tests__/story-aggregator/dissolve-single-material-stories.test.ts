/**
 * dissolveSingleMaterialStories — one-time backfill that reverts auto-created
 * single-material stories so lone posts show their original content again.
 */

import { describe, it, expect, vi } from "vitest"
import {
  dissolveSingleMaterialStories,
  type DissolveDeps,
} from "@/lib/story-aggregator/dissolve-single-material-stories"

const USER_ID = "clx_user_001"

function buildDeps(stories: unknown[]): DissolveDeps {
  return {
    db: {
      story: {
        findMany: vi.fn().mockResolvedValue(stories),
        delete: vi.fn().mockResolvedValue({}),
      },
      material: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    },
  } as unknown as DissolveDeps
}

describe("dissolveSingleMaterialStories", () => {
  it("queries only DRAFT, never-exported stories (DB-level guard)", async () => {
    const deps = buildDeps([])
    await dissolveSingleMaterialStories(USER_ID, deps)

    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          status: "DRAFT",
          notionPageId: null,
        }),
      })
    )
  })

  it("dissolves a 1-material / 0-inbox story, detaching the material BEFORE deleting", async () => {
    const deps = buildDeps([
      {
        id: "story_single",
        materials: [{ id: "mat_1", userStatus: "NEW" }],
        _count: { inboxItems: 0 },
      },
    ])

    const result = await dissolveSingleMaterialStories(USER_ID, deps)

    expect(result.dissolved).toBe(1)
    expect(deps.db.material.updateMany).toHaveBeenCalledWith({
      where: { id: "mat_1", storyId: "story_single" },
      data: { storyId: null, storyMatchedAt: null },
    })
    expect(deps.db.story.delete).toHaveBeenCalledWith({ where: { id: "story_single" } })

    // Detach must happen before delete.
    const detachOrder = (deps.db.material.updateMany as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    const deleteOrder = (deps.db.story.delete as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0]
    expect(detachOrder).toBeLessThan(deleteOrder)
  })

  it("leaves a genuine multi-source (2-material) story untouched", async () => {
    const deps = buildDeps([
      {
        id: "story_multi",
        materials: [
          { id: "mat_1", userStatus: "NEW" },
          { id: "mat_2", userStatus: "NEW" },
        ],
        _count: { inboxItems: 0 },
      },
    ])

    const result = await dissolveSingleMaterialStories(USER_ID, deps)

    expect(result.dissolved).toBe(0)
    expect(deps.db.story.delete).not.toHaveBeenCalled()
  })

  it("leaves a mixed 1-material + 1-inbox-item story untouched", async () => {
    const deps = buildDeps([
      {
        id: "story_mixed",
        materials: [{ id: "mat_1", userStatus: "NEW" }],
        _count: { inboxItems: 1 },
      },
    ])

    const result = await dissolveSingleMaterialStories(USER_ID, deps)

    expect(result.dissolved).toBe(0)
    expect(deps.db.story.delete).not.toHaveBeenCalled()
  })

  it("leaves a manually-sent (SENT_TO_STORIES) single-material story untouched", async () => {
    const deps = buildDeps([
      {
        id: "story_manual",
        materials: [{ id: "mat_1", userStatus: "SENT_TO_STORIES" }],
        _count: { inboxItems: 0 },
      },
    ])

    const result = await dissolveSingleMaterialStories(USER_ID, deps)

    expect(result.dissolved).toBe(0)
    expect(deps.db.story.delete).not.toHaveBeenCalled()
  })

  it("sweeps a 0-material orphan story (delete, no detach)", async () => {
    const deps = buildDeps([
      { id: "story_orphan", materials: [], _count: { inboxItems: 0 } },
    ])

    const result = await dissolveSingleMaterialStories(USER_ID, deps)

    expect(result.dissolved).toBe(1)
    expect(deps.db.material.updateMany).not.toHaveBeenCalled()
    expect(deps.db.story.delete).toHaveBeenCalledWith({ where: { id: "story_orphan" } })
  })
})
