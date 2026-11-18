/**
 * Tests for Story Aggregator API route handlers.
 * Spec: the Story Aggregator specification, sections 4.1, 5.2
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

import {
  pollStories,
  listStories,
  getStoryById,
  type StoriesApiDeps,
} from "@/lib/story-aggregator/stories-api"

const USER_ID = "user-abc-123"

function buildDeps(overrides: Partial<StoriesApiDeps> = {}): StoriesApiDeps {
  return {
    db: {
      inboxItem: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      story: {
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue({
          userId: USER_ID,
          storyInboxChannelId: "-1001234567890",
          storyLastMessageId: 100,
        }),
      },
    },
    processItem: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("pollStories", () => {
  it("fetches PENDING inbox items and processes each", async () => {
    const pendingItems = [
      { id: "item-1", status: "PENDING" },
      { id: "item-2", status: "PENDING" },
    ]
    const deps = buildDeps({
      db: {
        ...buildDeps().db,
        inboxItem: {
          findMany: vi.fn().mockResolvedValue(pendingItems),
          count: vi.fn().mockResolvedValue(2),
        },
      },
    })
    const result = await pollStories(USER_ID, deps)
    expect(deps.processItem).toHaveBeenCalledTimes(2)
    expect(deps.processItem).toHaveBeenCalledWith("item-1")
    expect(deps.processItem).toHaveBeenCalledWith("item-2")
    expect(result.processed).toBe(2)
  })

  it("returns zero processed when no PENDING items", async () => {
    const deps = buildDeps()
    const result = await pollStories(USER_ID, deps)
    expect(deps.processItem).not.toHaveBeenCalled()
    expect(result.processed).toBe(0)
  })

  it("queries only items with PENDING or ERROR status for current user", async () => {
    const deps = buildDeps()
    await pollStories(USER_ID, deps)
    expect(deps.db.inboxItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          status: { in: ["PENDING", "ERROR"] },
        }),
      })
    )
  })

  it("limits processing to 50 items per poll", async () => {
    const deps = buildDeps()
    await pollStories(USER_ID, deps)
    expect(deps.db.inboxItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 })
    )
  })

  it("continues processing even if one item fails", async () => {
    const pendingItems = [
      { id: "item-1", status: "PENDING" },
      { id: "item-2", status: "PENDING" },
      { id: "item-3", status: "PENDING" },
    ]
    const processItem = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("Processing failed"))
      .mockResolvedValueOnce({ success: true })
    const deps = buildDeps({
      db: {
        ...buildDeps().db,
        inboxItem: {
          findMany: vi.fn().mockResolvedValue(pendingItems),
          count: vi.fn().mockResolvedValue(3),
        },
      },
      processItem,
    })
    const result = await pollStories(USER_ID, deps)
    expect(result.processed).toBe(2)
    expect(result.errors).toBe(1)
  })
})

describe("listStories", () => {
  it("returns stories for the current user", async () => {
    const stories = [
      { id: "s-1", title: "Story 1", status: "DRAFT", createdAt: new Date() },
      { id: "s-2", title: "Story 2", status: "SENT_TO_NOTION", createdAt: new Date() },
    ]
    const deps = buildDeps({
      db: {
        ...buildDeps().db,
        story: {
          findMany: vi.fn().mockResolvedValue(stories),
          findUnique: vi.fn(),
          count: vi.fn().mockResolvedValue(2),
        },
      },
    })
    const result = await listStories(USER_ID, {}, deps)
    expect(result.stories).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it("filters stories by status when provided", async () => {
    const deps = buildDeps()
    await listStories(USER_ID, { status: "DRAFT" }, deps)
    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          status: "DRAFT",
        }),
      })
    )
  })

  it("orders stories by createdAt descending (newest first)", async () => {
    const deps = buildDeps()
    await listStories(USER_ID, {}, deps)
    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } })
    )
  })

  it("supports pagination with page and limit", async () => {
    const deps = buildDeps()
    await listStories(USER_ID, { page: 2, limit: 10 }, deps)
    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 })
    )
  })

  it("includes _count of inbox items in the response", async () => {
    const deps = buildDeps()
    await listStories(USER_ID, {}, deps)
    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: { select: { inboxItems: true } },
        }),
      })
    )
  })
})

describe("getStoryById", () => {
  it("returns the story with its inbox items", async () => {
    const story = {
      id: "s-1",
      userId: USER_ID,
      title: "Test Story",
      summary: "A test story",
      body: "Full body text",
      status: "DRAFT",
      createdAt: new Date(),
      inboxItems: [{ id: "item-1", rawText: "Original text" }],
    }
    const deps = buildDeps({
      db: {
        ...buildDeps().db,
        story: {
          findMany: vi.fn(),
          findUnique: vi.fn().mockResolvedValue(story),
          count: vi.fn(),
        },
      },
    })
    const result = await getStoryById("s-1", USER_ID, deps)
    expect(result).not.toBeNull()
    expect(result!.title).toBe("Test Story")
    expect(result!.inboxItems).toHaveLength(1)
  })

  it("returns null when story not found", async () => {
    const deps = buildDeps()
    const result = await getStoryById("nonexistent", USER_ID, deps)
    expect(result).toBeNull()
  })

  it("returns null when story belongs to different user", async () => {
    const story = {
      id: "s-1",
      userId: "other-user",
      title: "Other User Story",
      summary: "x",
      body: "x",
      status: "DRAFT",
      createdAt: new Date(),
    }
    const deps = buildDeps({
      db: {
        ...buildDeps().db,
        story: {
          findMany: vi.fn(),
          findUnique: vi.fn().mockResolvedValue(story),
          count: vi.fn(),
        },
      },
    })
    const result = await getStoryById("s-1", USER_ID, deps)
    expect(result).toBeNull()
  })

  it("includes inbox items ordered by createdAt", async () => {
    const deps = buildDeps()
    await getStoryById("s-1", USER_ID, deps)
    expect(deps.db.story.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s-1" },
        include: expect.objectContaining({
          inboxItems: expect.objectContaining({
            orderBy: { createdAt: "asc" },
          }),
        }),
      })
    )
  })
})
