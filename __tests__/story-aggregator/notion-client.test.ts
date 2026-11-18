/**
 * Tests for the Story Aggregator Notion client wrapper.
 * TDD RED phase — notion-client.ts does not exist yet, all tests must fail.
 *
 * Spec reference: the Story Aggregator specification, section 4.6
 *
 * Covers:
 *   1. createStoryPage — creates page with properties + blocks, batches >100 blocks, returns pageId/url
 *   2. updateStoryPage — deletes/re-appends blocks, skips when status is not "Предложено", updates properties, paginates existing blocks
 *   3. checkPageStatus — returns status name, null when missing, null on not_found error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ---------------------------------------------------------------------------
// Mock @notionhq/client BEFORE importing the module under test.
// The implementation must construct a Client from this mock.
// ---------------------------------------------------------------------------

const mockPagesCreate = vi.fn()
const mockPagesRetrieve = vi.fn()
const mockPagesUpdate = vi.fn()
const mockBlocksChildrenList = vi.fn()
const mockBlocksChildrenAppend = vi.fn()
const mockBlocksDelete = vi.fn()

vi.mock("@notionhq/client", () => {
  return {
    Client: vi.fn().mockImplementation(() => ({
      pages: {
        create: mockPagesCreate,
        retrieve: mockPagesRetrieve,
        update: mockPagesUpdate,
      },
      blocks: {
        children: {
          list: mockBlocksChildrenList,
          append: mockBlocksChildrenAppend,
        },
        delete: mockBlocksDelete,
      },
    })),
  }
})

// ---------------------------------------------------------------------------
// Import the module under test — will throw because the file doesn't exist.
// ---------------------------------------------------------------------------

import {
  createStoryPage,
  updateStoryPage,
  checkPageStatus,
} from "@/lib/story-aggregator/notion-client"

import type { StoryForNotion } from "@/lib/story-aggregator/notion-builder"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const DATABASE_ID = "test-database-id-abc123"
const NOTION_TOKEN = "secret_test_notion_token"
const PAGE_ID = "test-page-id-xyz789"

const baseStory: StoryForNotion = {
  title: "Design System Needs an Enforcer",
  languageFlag: "GB",
  summary: "Lora Kleyn explains why design systems fail without enforcement.",
  body: "Most design systems die not from lack of work but from lack of governance.\n\nLora Kleyn from NNGroup outlines practical strategies.",
  keyPoints: [
    "Systems need enforcement mechanisms",
    "Tooling alone is not enough",
    "Clear ownership prevents drift",
  ],
  sourceUrls: ["https://nngroup.com/articles/design-system-enforcement"],
  rubrics: ["Инструмент"],
  media: [{ url: "https://r2.example.com/thumbnails/design-system.jpg", kind: "image" }],
  archiveLinks: [
    {
      title: "Typography fundamentals",
      url: "https://archive.example.com/issue/42/typography",
      issueNumber: 42,
    },
  ],
}

/** A story with enough keyPoints and sourceUrls to push total block count above 100. */
function makeStoryWithManyBlocks(): StoryForNotion {
  return {
    ...baseStory,
    keyPoints: Array.from({ length: 60 }, (_, i) => `Key point ${i + 1}`),
    sourceUrls: Array.from(
      { length: 45 },
      (_, i) => `https://source${i + 1}.example.com`
    ),
    archiveLinks: null,
  }
}

/** Fake Notion page create/retrieve response. */
function makeNotionPageResponse(
  id: string = PAGE_ID,
  url: string = `https://notion.so/${PAGE_ID}`
): Record<string, unknown> {
  return { id, url }
}

/** Fake blocks.children.list response. */
function makeBlocksListResponse(
  count: number,
  hasMore = false,
  nextCursor: string | null = null
): Record<string, unknown> {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      id: `block-id-${i}`,
      type: "paragraph",
    })),
    has_more: hasMore,
    next_cursor: nextCursor,
  }
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// 1. createStoryPage
// ---------------------------------------------------------------------------

describe("createStoryPage", () => {
  it("calls pages.create with properties built from buildNotionProperties", async () => {
    // Arrange
    mockPagesCreate.mockResolvedValueOnce(makeNotionPageResponse())

    // Act
    await createStoryPage(baseStory, DATABASE_ID, NOTION_TOKEN)

    // Assert
    expect(mockPagesCreate).toHaveBeenCalledOnce()

    const call = mockPagesCreate.mock.calls[0][0] as Record<string, unknown>

    // Must target the correct database
    expect((call.parent as Record<string, unknown>).database_id).toBe(DATABASE_ID)

    // Properties must include Title (with flag emoji), Rubrika, AI summary (no Status)
    const props = call.properties as Record<string, unknown>
    expect(props).toHaveProperty("Name")
    expect(props).not.toHaveProperty("Статус")
    expect(props).toHaveProperty("Рубрика")
    expect(props).toHaveProperty("AI summary")
  })

  it("calls pages.create with children blocks built from buildNotionBlocks", async () => {
    // Arrange
    mockPagesCreate.mockResolvedValueOnce(makeNotionPageResponse())

    // Act
    await createStoryPage(baseStory, DATABASE_ID, NOTION_TOKEN)

    // Assert
    const call = mockPagesCreate.mock.calls[0][0] as Record<string, unknown>
    const children = call.children as unknown[]

    // Must be a non-empty array
    expect(Array.isArray(children)).toBe(true)
    expect(children.length).toBeGreaterThan(5)

    // image block must be first (baseStory carries an image in media)
    expect((children[0] as any).type).toBe("image")

    // At least one heading_2 block for the story title
    const headings2 = children.filter((b: any) => b.type === "heading_2")
    expect(headings2.length).toBeGreaterThan(0)

    // Exactly one bookmark per sourceUrl
    const bookmarks = children.filter((b: any) => b.type === "bookmark")
    expect(bookmarks.length).toBe(baseStory.sourceUrls.length)
  })

  it("splits blocks into batches of 100 and uses blocks.children.append for overflow blocks", async () => {
    // Arrange — story produces >100 blocks: ~2 structural + 60 keyPoints + 45 sourceUrls + headings + dividers
    const bigStory = makeStoryWithManyBlocks()
    mockPagesCreate.mockResolvedValueOnce(makeNotionPageResponse())
    mockBlocksChildrenAppend.mockResolvedValue({ results: [] })

    // Act
    await createStoryPage(bigStory, DATABASE_ID, NOTION_TOKEN)

    // Assert — first batch passed to pages.create must be <= 100
    expect(mockPagesCreate).toHaveBeenCalledOnce()
    const firstBatch = (mockPagesCreate.mock.calls[0][0] as any).children as unknown[]
    expect(firstBatch.length).toBeLessThanOrEqual(100)

    // Remaining blocks sent via blocks.children.append
    expect(mockBlocksChildrenAppend).toHaveBeenCalledAtLeast(1)

    // Every append batch must also be <= 100 blocks
    for (const appendCall of mockBlocksChildrenAppend.mock.calls) {
      const appendBatch = (appendCall[0] as any).children as unknown[]
      expect(appendBatch.length).toBeLessThanOrEqual(100)
    }
  })

  it("returns pageId and url from the Notion API response", async () => {
    // Arrange
    const notionId = "page-abc-123"
    const notionUrl = "https://notion.so/Design-System-page-abc-123"
    mockPagesCreate.mockResolvedValueOnce(
      makeNotionPageResponse(notionId, notionUrl)
    )

    // Act
    const result = await createStoryPage(baseStory, DATABASE_ID, NOTION_TOKEN)

    // Assert
    expect(result).toEqual({ pageId: notionId, url: notionUrl })
  })

  it("throws when the Notion API returns an error (e.g. unauthorized)", async () => {
    // Arrange
    const notionError = Object.assign(new Error("Unauthorized"), {
      code: "unauthorized",
    })
    mockPagesCreate.mockRejectedValueOnce(notionError)

    // Act & Assert
    await expect(
      createStoryPage(baseStory, DATABASE_ID, NOTION_TOKEN)
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 2. updateStoryPage
// ---------------------------------------------------------------------------

describe("updateStoryPage", () => {
  it("fetches existing blocks, deletes each one, then appends new blocks from buildNotionBlocks", async () => {
    // Arrange — page has no status (not yet touched by editor), 3 existing blocks
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      url: `https://notion.so/${PAGE_ID}`,
      properties: {
        Status: { select: null },
      },
    })
    mockBlocksChildrenList.mockResolvedValueOnce(makeBlocksListResponse(3))
    mockBlocksDelete.mockResolvedValue({})
    mockBlocksChildrenAppend.mockResolvedValue({ results: [] })
    mockPagesUpdate.mockResolvedValue({})

    // Act
    await updateStoryPage(PAGE_ID, baseStory, NOTION_TOKEN)

    // Assert — all 3 old blocks deleted
    expect(mockBlocksDelete).toHaveBeenCalledTimes(3)
    expect(mockBlocksDelete).toHaveBeenCalledWith(
      expect.objectContaining({ block_id: "block-id-0" })
    )

    // New blocks appended
    expect(mockBlocksChildrenAppend).toHaveBeenCalledAtLeast(1)
    const appendedChildren = (mockBlocksChildrenAppend.mock.calls[0][0] as any).children
    expect(Array.isArray(appendedChildren)).toBe(true)
    expect(appendedChildren.length).toBeGreaterThan(0)
  })

  it("skips update entirely when page has a Status value (editor has taken ownership)", async () => {
    // Arrange — editor has set a status on the page
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      url: `https://notion.so/${PAGE_ID}`,
      properties: {
        Status: { select: { name: "U redaktora" } },
      },
    })

    // Act
    await updateStoryPage(PAGE_ID, baseStory, NOTION_TOKEN)

    // Assert — no blocks listed, deleted, or appended; no properties update
    expect(mockBlocksChildrenList).not.toHaveBeenCalled()
    expect(mockBlocksDelete).not.toHaveBeenCalled()
    expect(mockBlocksChildrenAppend).not.toHaveBeenCalled()
    expect(mockPagesUpdate).not.toHaveBeenCalled()
  })

  it("calls pages.update with rebuilt properties after replacing blocks", async () => {
    // Arrange
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      url: `https://notion.so/${PAGE_ID}`,
      properties: {
        Status: { select: null },
      },
    })
    mockBlocksChildrenList.mockResolvedValueOnce(makeBlocksListResponse(2))
    mockBlocksDelete.mockResolvedValue({})
    mockBlocksChildrenAppend.mockResolvedValue({ results: [] })
    mockPagesUpdate.mockResolvedValue({})

    // Act
    await updateStoryPage(PAGE_ID, baseStory, NOTION_TOKEN)

    // Assert — pages.update called with rebuilt properties
    expect(mockPagesUpdate).toHaveBeenCalledOnce()
    const updateCall = mockPagesUpdate.mock.calls[0][0] as Record<string, unknown>
    expect(updateCall).toHaveProperty("page_id", PAGE_ID)
    const props = updateCall.properties as Record<string, unknown>
    expect(props).toHaveProperty("Name")
    expect(props).toHaveProperty("AI summary")
  })

  it("handles pagination when the page has more than 100 existing blocks", async () => {
    // Arrange — first list call returns 100 blocks with has_more=true, second returns 20
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      url: `https://notion.so/${PAGE_ID}`,
      properties: {
        Status: { select: null },
      },
    })
    mockBlocksChildrenList
      .mockResolvedValueOnce(makeBlocksListResponse(100, true, "cursor-abc"))
      .mockResolvedValueOnce(makeBlocksListResponse(20, false, null))

    mockBlocksDelete.mockResolvedValue({})
    mockBlocksChildrenAppend.mockResolvedValue({ results: [] })
    mockPagesUpdate.mockResolvedValue({})

    // Act
    await updateStoryPage(PAGE_ID, baseStory, NOTION_TOKEN)

    // Assert — listed twice (paginated)
    expect(mockBlocksChildrenList).toHaveBeenCalledTimes(2)

    // Second call must pass the cursor from the first response
    expect(mockBlocksChildrenList.mock.calls[1][0]).toMatchObject({
      start_cursor: "cursor-abc",
    })

    // All 120 blocks deleted
    expect(mockBlocksDelete).toHaveBeenCalledTimes(120)
  })
})

// ---------------------------------------------------------------------------
// 3. checkPageStatus
// ---------------------------------------------------------------------------

describe("checkPageStatus", () => {
  it("returns the status name when the page has a Status select property", async () => {
    // Arrange
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      properties: {
        Status: { select: { name: "Предложено" } },
      },
    })

    // Act
    const status = await checkPageStatus(PAGE_ID, NOTION_TOKEN)

    // Assert
    expect(status).toBe("Предложено")
    expect(mockPagesRetrieve).toHaveBeenCalledWith({ page_id: PAGE_ID })
  })

  it("returns null when the Status property exists but has no select value", async () => {
    // Arrange — select is null (no option chosen)
    mockPagesRetrieve.mockResolvedValueOnce({
      id: PAGE_ID,
      properties: {
        Status: { select: null },
      },
    })

    // Act
    const status = await checkPageStatus(PAGE_ID, NOTION_TOKEN)

    // Assert
    expect(status).toBeNull()
  })

  it("returns null when the page does not exist (Notion not_found error)", async () => {
    // Arrange
    const notFoundError = Object.assign(new Error("Could not find page"), {
      code: "object_not_found",
    })
    mockPagesRetrieve.mockRejectedValueOnce(notFoundError)

    // Act
    const status = await checkPageStatus(PAGE_ID, NOTION_TOKEN)

    // Assert — must not throw; must return null for not_found
    expect(status).toBeNull()
  })
})
