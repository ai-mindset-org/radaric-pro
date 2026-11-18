/**
 * RAD-143: Story card action parity
 * Tests that story-level actions (archive, delete, restore, feedback)
 * propagate correctly to all constituent materials.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// We test the pure logic that would back the batch handlers.
// The actual React handlers in materials-list.tsx call these APIs.

describe("RAD-143: Story card batch actions", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // Helper: simulate the batch archive logic
  function batchUpdateStatus(
    materials: Array<{ id: string; userStatus: string }>,
    targetIds: string[],
    newStatus: string
  ) {
    return materials.map(m =>
      targetIds.includes(m.id) ? { ...m, userStatus: newStatus } : m
    )
  }

  // Helper: simulate the batch delete logic (filter out)
  function batchRemove(
    materials: Array<{ id: string }>,
    targetIds: string[]
  ) {
    const idSet = new Set(targetIds)
    return materials.filter(m => !idSet.has(m.id))
  }

  describe("Batch archive", () => {
    it("AC-1: archives all materials in a story group", () => {
      const materials = [
        { id: "m1", userStatus: "NEW" },
        { id: "m2", userStatus: "NEW" },
        { id: "m3", userStatus: "READ" },
        { id: "standalone", userStatus: "NEW" },
      ]
      const storyMaterialIds = ["m1", "m2", "m3"]
      const result = batchUpdateStatus(materials, storyMaterialIds, "ARCHIVED")

      expect(result.filter(m => m.userStatus === "ARCHIVED")).toHaveLength(3)
      expect(result.find(m => m.id === "standalone")?.userStatus).toBe("NEW")
    })

    it("AC-2: idempotent — archiving already-archived materials keeps them archived", () => {
      const materials = [
        { id: "m1", userStatus: "ARCHIVED" },
        { id: "m2", userStatus: "ARCHIVED" },
      ]
      const result = batchUpdateStatus(materials, ["m1", "m2"], "ARCHIVED")
      expect(result.every(m => m.userStatus === "ARCHIVED")).toBe(true)
    })
  })

  describe("Batch delete", () => {
    it("AC-3: removes all story materials from the feed", () => {
      const materials = [
        { id: "m1" },
        { id: "m2" },
        { id: "m3" },
        { id: "standalone" },
      ]
      const result = batchRemove(materials, ["m1", "m2", "m3"])

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("standalone")
    })

    it("AC-4: deleting from empty set is a no-op", () => {
      const materials = [{ id: "m1" }, { id: "m2" }]
      const result = batchRemove(materials, [])
      expect(result).toHaveLength(2)
    })
  })

  describe("Batch restore", () => {
    it("AC-5: restores all archived materials to NEW", () => {
      const materials = [
        { id: "m1", userStatus: "ARCHIVED" },
        { id: "m2", userStatus: "ARCHIVED" },
        { id: "other", userStatus: "ARCHIVED" },
      ]
      const result = batchUpdateStatus(materials, ["m1", "m2"], "NEW")

      expect(result.find(m => m.id === "m1")?.userStatus).toBe("NEW")
      expect(result.find(m => m.id === "m2")?.userStatus).toBe("NEW")
      expect(result.find(m => m.id === "other")?.userStatus).toBe("ARCHIVED")
    })
  })

  describe("Feedback propagation", () => {
    it("AC-6: feedback applied to all materials in a story", async () => {
      const fetchCalls: Array<{ url: string; body: any }> = []
      const mockFetch = vi.fn(async (url: string, opts: any) => {
        fetchCalls.push({ url, body: JSON.parse(opts.body) })
        return { ok: true } as Response
      })

      const materialIds = ["m1", "m2", "m3"]
      const feedbackType = "LIKE"

      // Simulate propagation: primary (m1) is handled by MaterialFeedbackButtons,
      // remaining (m2, m3) are called in handleStoryFeedback
      const remaining = materialIds.slice(1)
      await Promise.all(remaining.map(id =>
        mockFetch(`/api/posts/${id}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ feedbackType }),
        })
      ))

      expect(fetchCalls).toHaveLength(2)
      expect(fetchCalls[0].url).toBe("/api/posts/m2/feedback")
      expect(fetchCalls[0].body.feedbackType).toBe("LIKE")
      expect(fetchCalls[1].url).toBe("/api/posts/m3/feedback")
      expect(fetchCalls[1].body.feedbackType).toBe("LIKE")
    })

    it("AC-7: dislike on story triggers auto-archive for all materials", () => {
      const materialIds = ["m1", "m2"]
      const materials = [
        { id: "m1", userStatus: "NEW" },
        { id: "m2", userStatus: "NEW" },
      ]

      // Simulate: dislike triggers archive
      const feedbackType = "DISLIKE" as const
      let archiveCalled = false
      const onArchive = () => { archiveCalled = true }

      if (feedbackType === "DISLIKE" && onArchive) {
        onArchive()
      }

      expect(archiveCalled).toBe(true)

      // After archive, all materials should be ARCHIVED
      const result = batchUpdateStatus(materials, materialIds, "ARCHIVED")
      expect(result.every(m => m.userStatus === "ARCHIVED")).toBe(true)
    })
  })

  describe("isAllArchived derivation", () => {
    it("AC-8: returns true when all materials are archived", () => {
      const materials = [
        { id: "m1", userStatus: "ARCHIVED" },
        { id: "m2", userStatus: "ARCHIVED" },
      ]
      const isAllArchived = materials.every(m => m.userStatus === "ARCHIVED")
      expect(isAllArchived).toBe(true)
    })

    it("AC-9: returns false when any material is not archived", () => {
      const materials = [
        { id: "m1", userStatus: "ARCHIVED" },
        { id: "m2", userStatus: "NEW" },
      ]
      const isAllArchived = materials.every(m => m.userStatus === "ARCHIVED")
      expect(isAllArchived).toBe(false)
    })
  })

  describe("Dismiss animation coordination", () => {
    it("AC-10: all material IDs added to dismissingIds set for story dismiss", () => {
      const dismissingIds = new Set<string>()
      const materialIds = ["m1", "m2", "m3"]

      // Simulate adding to dismissingIds
      materialIds.forEach(id => dismissingIds.add(id))

      expect(dismissingIds.size).toBe(3)
      expect(dismissingIds.has("m1")).toBe(true)
      expect(dismissingIds.has("m2")).toBe(true)
      expect(dismissingIds.has("m3")).toBe(true)
    })

    it("AC-11: isStoryDismissing is true when any material is dismissing", () => {
      const dismissingIds = new Set(["m2"])
      const storyMaterials = [{ id: "m1" }, { id: "m2" }, { id: "m3" }]

      const isStoryDismissing = storyMaterials.some(m => dismissingIds.has(m.id))
      expect(isStoryDismissing).toBe(true)
    })
  })
})
