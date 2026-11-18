/**
 * Pipeline orchestrator tests — TDD RED phase
 *
 * These tests import from lib/story-aggregator/pipeline.ts, which does NOT exist yet.
 * All tests are expected to FAIL until the implementation is written.
 *
 * Spec reference: the Story Aggregator specification sections 4.1–4.4, 4.6
 *
 * PipelineDeps interface (injected into all exported functions):
 *   db.inboxItem.findUnique / update / updateMany
 *   db.story.create / findUnique / update
 *   db.userSettings.findUnique / update
 *   generateStory(systemPrompt, userContent) => Promise<unknown>
 *   saveToNotion(databaseId, properties, blocks) => Promise<{ pageId, url }>
 *   extractContent.fromUrl(url) => Promise<ExtractedContent>
 *   extractContent.fromText(text) => ExtractedContent
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  processInboxItem,
  extractAndSave,
  generateAndSaveStory,
  publishToNotion,
  mergeSourceUrls,
  type PipelineDeps,
  type ProcessResult,
} from "@/lib/story-aggregator/pipeline"
import { buildNotionBlocks } from "@/lib/story-aggregator/notion-builder"

// ---------------------------------------------------------------------------
// Module mock: spy on notion-builder so we can inspect storyForNotion args
// ---------------------------------------------------------------------------

vi.mock("@/lib/story-aggregator/notion-builder", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/story-aggregator/notion-builder")>()
  return {
    ...original,
    buildNotionBlocks: vi.fn(original.buildNotionBlocks),
  }
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = "clx_inbox_001"
const ITEM_ID_TEXT = "clx_inbox_002"
const STORY_ID = "clx_story_001"
const NOTION_PAGE_ID = "notion_page_abc123"
const NOTION_URL = "https://notion.so/workspace/notion_page_abc123"
const USER_ID = "clx_user_001"
const NOTION_DB_ID = "notion_db_abc123"

/** A fully-populated InboxItem with a URL, as returned by Prisma */
const mockInboxItemWithUrl = {
  id: ITEM_ID,
  userId: USER_ID,
  externalId: "-1001234567890:12345",
  messageId: 12345,
  rawText: "Check out this great article about design systems",
  rawEntities: null,
  extractedUrl: "https://nngroup.com/articles/design-system-enforcement",
  extractedTitle: null,
  extractedContent: null,
  mediaUrls: [] as string[],
  thumbnailUrl: null,
  sourceChannel: "Design Weekly",
  forwardedFromId: null,
  telegramPostUrl: null,
  status: "PENDING",
  storyId: null,
  retryCount: 0,
  processedAt: null,
  errorMessage: null,
  createdAt: new Date("2026-02-19T10:00:00Z"),
}

/** An InboxItem without a URL — pure text / media post */
const mockInboxItemTextOnly = {
  ...mockInboxItemWithUrl,
  id: ITEM_ID_TEXT,
  externalId: "-1001234567890:12346",
  messageId: 12346,
  rawText: "Interesting thoughts on typography\nThere is a lot to consider when choosing fonts.",
  extractedUrl: null,
  sourceChannel: null,
}

/** An InboxItem that has already been through content extraction */
const mockInboxItemExtracted = {
  ...mockInboxItemWithUrl,
  extractedTitle: "Design System Needs an Enforcer",
  extractedContent:
    "Lora Kleyn from NNGroup explains why design systems fail without enforcement. " +
    "Key insight: tooling alone is not enough; you need a dedicated person to drive adoption.",
  thumbnailUrl: "https://nngroup.com/images/og-design-enforcement.jpg",
  status: "EXTRACTED",
}

/** A valid AI-generated story output matching StoryOutputSchema */
const mockValidStoryOutput = {
  languageFlag: "GB" as const,
  title: "Design System Needs an Enforcer",
  rubrics: ["Инструмент"],
  authorLevel: "expert" as const,
  materialType: "article" as const,
  materialCharacter: "useful" as const,
  summary:
    "Lora Kleyn iz NNGroup utverzhdaet, chto dizayn-sistemy provalivayutsya bez sotrudnika.",
  body:
    "## Pochemu dizayn-sistemy provalivayutsya\n\n" +
    "Bol'shinstvo dizayn-sistem umiraet ne iz-za nedostatka raboty.",
  keyPoints: [
    "Sistemy trebuyut nadzora — ne tol'ko instrumentov",
    "Odin chelovek mozhet izmenit' sud'bu dizayn-sistemy",
  ],
  sourceUrls: ["https://nngroup.com/articles/design-system-enforcement"],
}

/** A Story record as returned by Prisma after creation */
const mockSavedStory = {
  id: STORY_ID,
  userId: USER_ID,
  title: mockValidStoryOutput.title,
  languageFlag: mockValidStoryOutput.languageFlag,
  summary: mockValidStoryOutput.summary,
  body: mockValidStoryOutput.body,
  keyPoints: mockValidStoryOutput.keyPoints,
  sourceUrls: mockValidStoryOutput.sourceUrls,
  rubrics: mockValidStoryOutput.rubrics,
  archiveLinks: null,
  notionPageId: null,
  notionUrl: null,
  status: "DRAFT",
  version: 1,
  createdAt: new Date("2026-02-19T10:05:00Z"),
  updatedAt: new Date("2026-02-19T10:05:00Z"),
}

/** A Story with linked InboxItems, as returned by Prisma findUnique with include */
const mockStoryWithInboxItems = {
  ...mockSavedStory,
  inboxItems: [
    {
      ...mockInboxItemExtracted,
      status: "MATCHED",
      storyId: STORY_ID,
    },
  ],
}

/** UserSettings with Notion configured */
const mockUserSettingsWithNotion = {
  id: "clx_settings_001",
  userId: USER_ID,
  storyInboxChannelId: "-1001234567890",
  storyNotionDatabaseId: NOTION_DB_ID,
  storyLastMessageId: 12340,
  storySystemPrompt: null,
  storyPromptVersion: 1,
}

/** UserSettings without Notion database configured */
const mockUserSettingsNoNotion = {
  ...mockUserSettingsWithNotion,
  storyNotionDatabaseId: null,
}

/** Extracted content as returned by content extractor (URL path) */
const mockExtractedFromUrl = {
  title: "Design System Needs an Enforcer",
  content:
    "Lora Kleyn from NNGroup explains why design systems fail without enforcement.",
  ogImage: "https://nngroup.com/images/og-design-enforcement.jpg",
  author: "Lora Kleyn",
}

/** Extracted content as returned by content extractor (text path) */
const mockExtractedFromText = {
  title: "Interesting thoughts on typography",
  content:
    "Interesting thoughts on typography\nThere is a lot to consider when choosing fonts.",
  ogImage: null,
  author: null,
}

// ---------------------------------------------------------------------------
// Factory: build a fully-mocked PipelineDeps object
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    db: {
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(mockInboxItemWithUrl),
        update: vi.fn().mockResolvedValue(mockInboxItemWithUrl),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      story: {
        create: vi.fn().mockResolvedValue(mockSavedStory),
        findUnique: vi.fn().mockResolvedValue(mockStoryWithInboxItems),
        update: vi.fn().mockResolvedValue({
          ...mockSavedStory,
          notionPageId: NOTION_PAGE_ID,
          notionUrl: NOTION_URL,
          status: "SENT_TO_NOTION",
        }),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue(mockUserSettingsWithNotion),
        update: vi.fn().mockResolvedValue(mockUserSettingsWithNotion),
      },
    },
    generateStory: vi.fn().mockResolvedValue(mockValidStoryOutput),
    saveToNotion: vi
      .fn()
      .mockResolvedValue({ pageId: NOTION_PAGE_ID, url: NOTION_URL }),
    extractContent: {
      fromUrl: vi.fn().mockResolvedValue(mockExtractedFromUrl),
      fromText: vi.fn().mockReturnValue(mockExtractedFromText),
    },
    ...overrides,
  }
}

// ===========================================================================
// 1. processInboxItem — full pipeline orchestration (spec 4.1–4.6)
// ===========================================================================

describe("processInboxItem", () => {
  it("skips processing and returns success:false when item status is PROCESSED", async () => {
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItemWithUrl,
      status: "PROCESSED",
    })

    const result = await processInboxItem(ITEM_ID, deps)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already processed/i)
    // Should NOT have called extractContent, generateStory, or saveToNotion
    expect(deps.extractContent.fromUrl).not.toHaveBeenCalled()
    expect(deps.generateStory).not.toHaveBeenCalled()
    expect(deps.saveToNotion).not.toHaveBeenCalled()
  })

  it("skips processing and returns success:false when item status is ARCHIVED", async () => {
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItemWithUrl,
      status: "ARCHIVED",
    })

    const result = await processInboxItem(ITEM_ID, deps)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already processed/i)
    expect(deps.extractContent.fromUrl).not.toHaveBeenCalled()
  })

  it("happy path with URL: runs full pipeline and returns storyId and notionPageId", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    const result: ProcessResult = await processInboxItem(ITEM_ID, deps)

    // Assert
    expect(result.success).toBe(true)
    expect(result.storyId).toBe(STORY_ID)
    expect(result.notionPageId).toBe(NOTION_PAGE_ID)
    expect(result.error).toBeUndefined()
  })

  it("happy path with text-only item: runs pipeline without URL extraction and returns storyId", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemTextOnly
    )
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStoryWithInboxItems,
      inboxItems: [{ ...mockInboxItemTextOnly, status: "MATCHED", storyId: STORY_ID }],
    })

    // Act
    const result: ProcessResult = await processInboxItem(ITEM_ID_TEXT, deps)

    // Assert
    expect(result.success).toBe(true)
    expect(result.storyId).toBe(STORY_ID)
    // extractContent.fromUrl must NOT have been called — item has no URL
    expect(deps.extractContent.fromUrl).not.toHaveBeenCalled()
  })

  it("sets InboxItem status to ERROR and increments retryCount when content extraction fails", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.extractContent.fromUrl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network timeout")
    )

    // Act
    const result: ProcessResult = await processInboxItem(ITEM_ID, deps)

    // Assert: result signals failure
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()

    // Assert: InboxItem updated to ERROR with incremented retryCount
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ where: unknown; data: { status?: string; retryCount?: unknown; errorMessage?: string } }]
    >
    const errorUpdate = updateCalls.find(([args]) => args.data.status === "ERROR")
    expect(errorUpdate).toBeDefined()
    expect(errorUpdate![0].data.retryCount).toEqual({ increment: 1 })
  })

  it("sets InboxItem status to ERROR when AI generation returns invalid output", async () => {
    // Arrange
    const deps = buildDeps()
    // AI returns something that fails Zod validation (missing all required story fields)
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue({
      invalidField: "this is not a valid story",
    })

    // Act
    const result: ProcessResult = await processInboxItem(ITEM_ID, deps)

    // Assert
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()

    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ data: { status?: string } }]
    >
    const hasErrorUpdate = updateCalls.some(([args]) => args.data.status === "ERROR")
    expect(hasErrorUpdate).toBe(true)
  })

  it("saves error message to errorMessage field on failure", async () => {
    // Arrange
    const errorMessage = "Notion API rate limit exceeded"
    const deps = buildDeps()
    ;(deps.saveToNotion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(errorMessage))

    // Act
    const result: ProcessResult = await processInboxItem(ITEM_ID, deps)

    // Assert: result signals failure
    expect(result.success).toBe(false)

    // Assert: error message was persisted to the DB
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ data: { errorMessage?: string } }]
    >
    const errorUpdate = updateCalls.find(
      ([args]) => typeof args.data.errorMessage === "string"
    )
    expect(errorUpdate).toBeDefined()
    expect(errorUpdate![0].data.errorMessage).toContain(errorMessage)
  })

  it("returns ProcessResult with error property when pipeline fails at any stage (does not throw)", async () => {
    // Arrange: DB throws unexpectedly on first read
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database connection lost")
    )

    // Act — must not propagate the throw to the caller
    const result: ProcessResult = await processInboxItem(ITEM_ID, deps)

    // Assert
    expect(result).toBeDefined()
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe("string")
  })
})

// ===========================================================================
// 2. extractAndSave — content extraction and DB persistence (spec 4.2)
// ===========================================================================

describe("extractAndSave", () => {
  it("calls extractContent.fromUrl when item has extractedUrl", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemWithUrl
    )

    // Act
    await extractAndSave(ITEM_ID, deps)

    // Assert
    expect(deps.extractContent.fromUrl).toHaveBeenCalledWith(
      mockInboxItemWithUrl.extractedUrl
    )
    expect(deps.extractContent.fromText).not.toHaveBeenCalled()
  })

  it("calls extractContent.fromText with rawText when item has no extractedUrl", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemTextOnly
    )

    // Act
    await extractAndSave(ITEM_ID_TEXT, deps)

    // Assert
    expect(deps.extractContent.fromText).toHaveBeenCalledWith(
      mockInboxItemTextOnly.rawText
    )
    expect(deps.extractContent.fromUrl).not.toHaveBeenCalled()
  })

  it("updates InboxItem with extracted title, content, thumbnailUrl and sets status to EXTRACTED", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemWithUrl
    )
    ;(deps.extractContent.fromUrl as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockExtractedFromUrl
    )

    // Act
    await extractAndSave(ITEM_ID, deps)

    // Assert: DB update called with extracted fields and EXTRACTED status
    expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({
          extractedTitle: mockExtractedFromUrl.title,
          extractedContent: mockExtractedFromUrl.content,
          thumbnailUrl: mockExtractedFromUrl.ogImage,
          status: "EXTRACTED",
        }),
      })
    )
  })

  it("sets status to ERROR with errorMessage and increments retryCount when extraction throws", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemWithUrl
    )
    ;(deps.extractContent.fromUrl as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("SSL certificate error")
    )

    // Act — must not throw out of extractAndSave
    await expect(extractAndSave(ITEM_ID, deps)).resolves.not.toThrow()

    // Assert: error state persisted correctly
    expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({
          status: "ERROR",
          errorMessage: expect.any(String),
          retryCount: { increment: 1 },
        }),
      })
    )
  })
})

// ===========================================================================
// 3. generateAndSaveStory — AI story generation and DB persistence (spec 4.4)
// ===========================================================================

describe("generateAndSaveStory", () => {
  it("creates a Story record in the DB from valid AI output and returns the storyId", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue(mockValidStoryOutput)
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSavedStory)

    // Act
    const storyId = await generateAndSaveStory(ITEM_ID, deps)

    // Assert: correct storyId returned
    expect(storyId).toBe(STORY_ID)

    // Assert: story.create called with expected data shape
    expect(deps.db.story.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: USER_ID,
          title: mockValidStoryOutput.title,
          summary: mockValidStoryOutput.summary,
          body: mockValidStoryOutput.body,
          keyPoints: mockValidStoryOutput.keyPoints,
          sourceUrls: mockValidStoryOutput.sourceUrls,
          rubrics: expect.any(Array),
          status: "DRAFT",
        }),
      })
    )
  })

  it("links InboxItem to the new Story by setting storyId and status MATCHED", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue(mockValidStoryOutput)
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSavedStory)

    // Act
    await generateAndSaveStory(ITEM_ID, deps)

    // Assert: InboxItem updated with storyId and MATCHED status
    expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({
          storyId: STORY_ID,
          status: "MATCHED",
        }),
      })
    )
  })

  it("rejects when AI output fails StoryOutputSchema validation", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    // AI returns structurally invalid output — missing all required fields
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue({
      garbage: true,
      notAStory: "at all",
    })

    // Act + Assert: must reject with an error
    await expect(generateAndSaveStory(ITEM_ID, deps)).rejects.toThrow()
  })

  it("includes storySystemPrompt override in the system prompt when set in UserSettings", async () => {
    // Arrange
    const customPrompt = "Focus only on typography and font design. Ignore other topics."
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.db.userSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockUserSettingsWithNotion,
      storySystemPrompt: customPrompt,
    })
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue(mockValidStoryOutput)

    // Act
    await generateAndSaveStory(ITEM_ID, deps)

    // Assert: generateStory called with a systemPrompt that contains the user override
    const [systemPromptArg] = (
      deps.generateStory as ReturnType<typeof vi.fn>
    ).mock.calls[0] as [string, string]
    expect(systemPromptArg).toContain(customPrompt)
  })
})

// ===========================================================================
// 4. publishToNotion — Notion page creation and DB update (spec 4.6)
// ===========================================================================

describe("publishToNotion", () => {
  it("creates a Notion page with the correct databaseId, properties, and blocks, then returns notionPageId", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockStoryWithInboxItems
    )
    ;(deps.db.userSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockUserSettingsWithNotion
    )
    ;(deps.saveToNotion as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageId: NOTION_PAGE_ID,
      url: NOTION_URL,
    })

    // Act
    const notionPageId = await publishToNotion(STORY_ID, deps)

    // Assert: returns the page ID
    expect(notionPageId).toBe(NOTION_PAGE_ID)

    // Assert: saveToNotion called with the configured database ID and valid properties/blocks
    expect(deps.saveToNotion).toHaveBeenCalledWith(
      NOTION_DB_ID,
      expect.objectContaining({
        Name: expect.any(Object),
        Рубрика: expect.any(Object),
      }),
      expect.any(Array)
    )
  })

  it("updates Story record with notionPageId, notionUrl and status SENT_TO_NOTION", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockStoryWithInboxItems
    )
    ;(deps.db.userSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockUserSettingsWithNotion
    )
    ;(deps.saveToNotion as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageId: NOTION_PAGE_ID,
      url: NOTION_URL,
    })

    // Act
    await publishToNotion(STORY_ID, deps)

    // Assert: Story updated with Notion page details and correct status
    expect(deps.db.story.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: STORY_ID },
        data: expect.objectContaining({
          notionPageId: NOTION_PAGE_ID,
          notionUrl: NOTION_URL,
          status: "SENT_TO_NOTION",
        }),
      })
    )
  })

  it("sets all linked InboxItems to PROCESSED after successful Notion publish", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockStoryWithInboxItems
    )
    ;(deps.db.userSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockUserSettingsWithNotion
    )
    ;(deps.saveToNotion as ReturnType<typeof vi.fn>).mockResolvedValue({
      pageId: NOTION_PAGE_ID,
      url: NOTION_URL,
    })

    // Act
    await publishToNotion(STORY_ID, deps)

    // Assert: updateMany or update called to set linked items to PROCESSED
    const updateManyCalls = (
      deps.db.inboxItem.updateMany as ReturnType<typeof vi.fn>
    ).mock.calls as Array<[{ data: { status?: string } }]>

    const updateCalls = (
      deps.db.inboxItem.update as ReturnType<typeof vi.fn>
    ).mock.calls as Array<[{ data: { status?: string } }]>

    const processedViaMany = updateManyCalls.some(([args]) => args.data.status === "PROCESSED")
    const processedViaUpdate = updateCalls.some(([args]) => args.data.status === "PROCESSED")

    expect(processedViaMany || processedViaUpdate).toBe(true)
  })

  it("returns null and does not call saveToNotion when storyNotionDatabaseId is not configured", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockStoryWithInboxItems
    )
    ;(deps.db.userSettings.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockUserSettingsNoNotion
    )

    // Act
    const result = await publishToNotion(STORY_ID, deps)

    // Assert: no Notion call; story stays in DRAFT
    expect(result).toBeNull()
    expect(deps.saveToNotion).not.toHaveBeenCalled()

    // Assert: Story status was NOT changed to SENT_TO_NOTION
    const storyCalls = (deps.db.story.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ data: { status?: string } }]
    >
    const wasSentToNotion = storyCalls.some(([args]) => args.data.status === "SENT_TO_NOTION")
    expect(wasSentToNotion).toBe(false)
  })

  it("calls updateNotionPage instead of saveToNotion when story already has a notionPageId", async () => {
    // Arrange: story already has a Notion page
    const storyWithNotionPage = {
      ...mockStoryWithInboxItems,
      notionPageId: NOTION_PAGE_ID,
      notionUrl: NOTION_URL,
      status: "SENT_TO_NOTION",
    }
    const updateNotionPage = vi.fn().mockResolvedValue(undefined)
    const deps = buildDeps({ updateNotionPage })
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(storyWithNotionPage)

    // Act
    const pageId = await publishToNotion(STORY_ID, deps)

    // Assert: updateNotionPage called with existing pageId, saveToNotion NOT called
    expect(updateNotionPage).toHaveBeenCalledWith(
      NOTION_PAGE_ID,
      expect.objectContaining({ Name: expect.any(Object) }),
      expect.any(Array)
    )
    expect(deps.saveToNotion).not.toHaveBeenCalled()
    expect(pageId).toBe(NOTION_PAGE_ID)
  })

  it("falls back to saveToNotion (create) when story has no notionPageId", async () => {
    // Arrange: story with no Notion page yet
    const updateNotionPage = vi.fn().mockResolvedValue(undefined)
    const deps = buildDeps({ updateNotionPage })
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockStoryWithInboxItems)

    // Act
    await publishToNotion(STORY_ID, deps)

    // Assert: saveToNotion called (create), updateNotionPage NOT called
    expect(deps.saveToNotion).toHaveBeenCalled()
    expect(updateNotionPage).not.toHaveBeenCalled()
  })

  it("falls back to saveToNotion (create) when updateNotionPage is not provided", async () => {
    // Arrange: story has notionPageId but deps has no updateNotionPage
    const storyWithNotionPage = {
      ...mockStoryWithInboxItems,
      notionPageId: NOTION_PAGE_ID,
      notionUrl: NOTION_URL,
    }
    const deps = buildDeps() // no updateNotionPage
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(storyWithNotionPage)

    // Act
    await publishToNotion(STORY_ID, deps)

    // Assert: saveToNotion called as fallback
    expect(deps.saveToNotion).toHaveBeenCalled()
  })
})

// ===========================================================================
// 5. mergeSourceUrls — pure function for deduplicating telegramPostUrls
// ===========================================================================

describe("mergeSourceUrls", () => {
  it("appends telegram URL to AI-generated sourceUrls", () => {
    const result = mergeSourceUrls(
      ["https://example.com/article"],
      ["https://t.me/designweekly/777"]
    )
    expect(result).toEqual([
      "https://example.com/article",
      "https://t.me/designweekly/777",
    ])
  })

  it("does not duplicate when AI already included the telegram URL", () => {
    const telegramUrl = "https://t.me/designweekly/777"
    const result = mergeSourceUrls(
      [telegramUrl, "https://example.com/article"],
      [telegramUrl]
    )
    expect(result).toEqual([telegramUrl, "https://example.com/article"])
  })

  it("filters null values from telegramPostUrls", () => {
    const result = mergeSourceUrls(
      ["https://example.com/article"],
      [null, null]
    )
    expect(result).toEqual(["https://example.com/article"])
  })

  it("handles empty AI sourceUrls", () => {
    const result = mergeSourceUrls([], ["https://t.me/ch/42"])
    expect(result).toEqual(["https://t.me/ch/42"])
  })

  it("handles all-null telegramPostUrls", () => {
    const result = mergeSourceUrls(
      ["https://example.com/article"],
      [null]
    )
    expect(result).toEqual(["https://example.com/article"])
  })

  it("deduplicates multiple telegram URLs from different items", () => {
    const result = mergeSourceUrls(
      ["https://example.com/article"],
      ["https://t.me/ch/1", "https://t.me/ch/2", "https://t.me/ch/1"]
    )
    expect(result).toEqual([
      "https://example.com/article",
      "https://t.me/ch/1",
      "https://t.me/ch/2",
    ])
  })
})

// ===========================================================================
// 6. generateAndSaveStory — telegramPostUrl merging
// ===========================================================================

describe("generateAndSaveStory — telegramPostUrl merging", () => {
  it("merges telegramPostUrl into sourceUrls when the item has one", async () => {
    const telegramUrl = "https://t.me/designweekly/777"
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItemExtracted,
      telegramPostUrl: telegramUrl,
    })
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue(mockValidStoryOutput)
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSavedStory)

    await generateAndSaveStory(ITEM_ID, deps)

    const createCall = (deps.db.story.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: { sourceUrls: string[] }
    }
    expect(createCall.data.sourceUrls).toContain(telegramUrl)
    expect(createCall.data.sourceUrls).toContain(mockValidStoryOutput.sourceUrls[0])
  })

  it("does NOT duplicate telegramPostUrl if AI already included it", async () => {
    const telegramUrl = "https://t.me/designweekly/777"
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItemExtracted,
      telegramPostUrl: telegramUrl,
    })
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockValidStoryOutput,
      sourceUrls: [telegramUrl, "https://nngroup.com/articles/design-system-enforcement"],
    })
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSavedStory)

    await generateAndSaveStory(ITEM_ID, deps)

    const createCall = (deps.db.story.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: { sourceUrls: string[] }
    }
    const count = createCall.data.sourceUrls.filter((u: string) => u === telegramUrl).length
    expect(count).toBe(1)
  })

  it("sourceUrls unchanged when telegramPostUrl is null", async () => {
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockInboxItemExtracted,
      telegramPostUrl: null,
    })
    ;(deps.generateStory as ReturnType<typeof vi.fn>).mockResolvedValue(mockValidStoryOutput)
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockSavedStory)

    await generateAndSaveStory(ITEM_ID, deps)

    const createCall = (deps.db.story.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      data: { sourceUrls: string[] }
    }
    expect(createCall.data.sourceUrls).toEqual(mockValidStoryOutput.sourceUrls)
  })
})

// ===========================================================================
// 7. extractAndSave — media-only post handling (RED phase)
// ===========================================================================

describe("extractAndSave — media-only post handling", () => {
  it("generates a media description for items with no text and no URL but with mediaUrls", async () => {
    // Arrange: inbox item with only media — no rawText, no extractedUrl
    const mediaOnlyItem = {
      ...mockInboxItemWithUrl,
      id: "clx_inbox_media_only",
      rawText: null,
      extractedUrl: null,
      mediaUrls: ["https://r2.example.com/photo1.jpg", "https://r2.example.com/video.mp4"],
      telegramPostUrl: "https://t.me/ch/1",
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mediaOnlyItem)

    // Act
    await extractAndSave("clx_inbox_media_only", deps)

    // Assert: DB update must have been called with non-null extractedContent and extractedTitle
    // (the pipeline generates a synthetic description from the media rather than leaving it null)
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ where: unknown; data: { extractedContent?: unknown; extractedTitle?: unknown; status?: string } }]
    >
    const extractedUpdate = updateCalls.find(([args]) => args.data.status === "EXTRACTED")
    expect(extractedUpdate).toBeDefined()

    const { extractedContent, extractedTitle } = extractedUpdate![0].data
    // extractedContent must be a non-empty string describing the media
    expect(typeof extractedContent).toBe("string")
    expect((extractedContent as string).length).toBeGreaterThan(0)
    // Should reference media type: "image", "video", or "media"
    const contentLower = (extractedContent as string).toLowerCase()
    const mentionsMedia =
      contentLower.includes("image") ||
      contentLower.includes("video") ||
      contentLower.includes("media") ||
      contentLower.includes("photo")
    expect(mentionsMedia).toBe(true)

    // extractedTitle must also be non-null
    expect(extractedTitle).not.toBeNull()
    expect(typeof extractedTitle).toBe("string")
  })

  it("sets status to NO_CONTENT (not EXTRACTED) for items with no text, no URL, and no media", async () => {
    // Arrange: truly empty item — nothing to work with at all
    const emptyItem = {
      ...mockInboxItemWithUrl,
      id: "clx_inbox_empty",
      rawText: null,
      extractedUrl: null,
      mediaUrls: [] as string[],
      telegramPostUrl: null,
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(emptyItem)

    // Act
    await extractAndSave("clx_inbox_empty", deps)

    // Assert: DB update must be called with status "NO_CONTENT" and null extractedContent
    // (not "EXTRACTED" — there is genuinely nothing to extract)
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ where: unknown; data: { status?: string; extractedContent?: unknown } }]
    >
    const statusUpdate = updateCalls.find(
      ([args]) => args.data.status !== undefined
    )
    expect(statusUpdate).toBeDefined()
    expect(statusUpdate![0].data.status).toBe("NO_CONTENT")
    expect(statusUpdate![0].data.extractedContent).toBeNull()
  })

  it("AC-5: classifies audio, document and sticker counts and keeps image/video/GIF behaviour", async () => {
    // A Telegram album is not just photos: voice notes, files and sticker packs
    // arrive in the same `mediaUrls`. The synthetic description must name every
    // kind it can, not collapse them all into "file".
    const mediaOnlyItem = {
      ...mockInboxItemWithUrl,
      id: "clx_inbox_media_kinds",
      rawText: null,
      extractedUrl: null,
      mediaUrls: [
        "https://r2.example.com/album/photo.jpg",
        "https://r2.example.com/album/reel.mp4",
        "https://r2.example.com/album/anim.gif",
        "https://r2.example.com/album/voice.ogg",
        "https://r2.example.com/album/report.pdf",
        "https://r2.example.com/album/pack.tgs",
      ],
      telegramPostUrl: null,
    }
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mediaOnlyItem)

    // Act
    await extractAndSave("clx_inbox_media_kinds", deps)

    // Assert
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ where: unknown; data: { extractedContent?: unknown; extractedTitle?: unknown; status?: string } }]
    >
    const extractedUpdate = updateCalls.find(([args]) => args.data.status === "EXTRACTED")
    expect(extractedUpdate).toBeDefined()

    const { extractedContent, extractedTitle } = extractedUpdate![0].data
    const content = extractedContent as string
    expect(content).toContain("1 image(s)")
    expect(content).toContain("1 video(s)")
    expect(content).toContain("1 GIF(s)")
    expect(content).toContain("1 audio(s)")
    expect(content).toContain("1 document(s)")
    expect(content).toContain("1 sticker(s)")
    expect(extractedTitle).toBe(
      "Media album: 1 image(s), 1 video(s), 1 GIF(s), 1 audio(s), 1 document(s), 1 sticker(s)"
    )
  })
})

// ===========================================================================
// 8. publishToNotion — story media reach Notion (RAD-401 AC-4)
//    Rewritten from the old "mediaUrls pass-through" contract: StoryForNotion
//    now carries `media: {url, kind}[]` = storyDetailMedia(materials, inboxItems).
// ===========================================================================

const notionImg = (url: string) => ({ type: "image", image: { type: "external", external: { url } } })
const notionVid = (url: string) => ({ type: "video", video: { type: "external", external: { url } } })

/** Inbox item with no media at all. */
const inboxNoMedia = {
  ...mockInboxItemExtracted,
  status: "MATCHED",
  storyId: STORY_ID,
  thumbnailUrl: null,
  mediaUrls: [] as string[],
}

/** Member posts, already in the createdAt-desc order the query asks for. */
const memberMaterials = [
  {
    id: "mat_a",
    title: "Post A",
    content: "A body",
    url: "https://a.example.com/post",
    rawText: null,
    thumbnailUrl: "https://cdn.example.com/a-cover.jpg",
    mediaUrls: ["https://cdn.example.com/a-2.png"],
    createdAt: new Date("2026-10-10T10:00:00Z"),
    feed: { name: "Feed A", type: "RSS" },
  },
  {
    id: "mat_b",
    title: "Post B",
    content: "B body",
    url: "https://b.example.com/post",
    rawText: null,
    thumbnailUrl: null,
    mediaUrls: ["https://cdn.example.com/b-1.jpg", "https://cdn.example.com/b-clip.mp4"],
    createdAt: new Date("2026-10-09T10:00:00Z"),
    feed: { name: "Feed B", type: "RSS" },
  },
]

/**
 * story.findUnique that returns member materials ONLY when the query asks for
 * them (include or select) — an implementation that never loads materials sees none.
 */
function storyFindUniqueWithMaterials(story: Record<string, unknown>) {
  return vi.fn(async (args: { include?: Record<string, unknown>; select?: Record<string, unknown> }) => {
    const asksForMaterials = !!(args?.include?.materials ?? args?.select?.materials)
    return asksForMaterials ? { ...story, materials: memberMaterials } : { ...story }
  })
}

/** Expected order (storyDetailMedia): round-robin lead-first — a-cover, b-1, a-2, b-clip. */
const EXPECTED_MEMBER_TAIL = [
  { type: "divider" },
  notionImg("https://cdn.example.com/b-1.jpg"),
  notionImg("https://cdn.example.com/a-2.png"),
  notionVid("https://cdn.example.com/b-clip.mp4"),
]

describe("publishToNotion — story media (RAD-401)", () => {
  beforeEach(() => {
    vi.mocked(buildNotionBlocks).mockClear()
  })

  it("AC-4: loads the story's materials (createdAt desc) along with inboxItems", async () => {
    const deps = buildDeps()
    const findUnique = storyFindUniqueWithMaterials({ ...mockSavedStory, inboxItems: [inboxNoMedia] })
    deps.db.story.findUnique = findUnique as never

    await publishToNotion(STORY_ID, deps)

    const args = findUnique.mock.calls[0][0] as {
      include?: Record<string, any>
      select?: Record<string, any>
    }
    const materialsQuery = args.include?.materials ?? args.select?.materials
    expect(materialsQuery).toMatchObject({ orderBy: { createdAt: "desc" } })
    expect(args.include?.inboxItems ?? args.select?.inboxItems).toBeTruthy()
  })

  it("AC-4: a story whose only media are its member posts' → saveToNotion gets their image/video blocks", async () => {
    const deps = buildDeps()
    deps.db.story.findUnique = storyFindUniqueWithMaterials({
      ...mockSavedStory,
      inboxItems: [inboxNoMedia],
    }) as never

    await publishToNotion(STORY_ID, deps)

    expect(deps.saveToNotion).toHaveBeenCalledTimes(1)
    const blocks = (deps.saveToNotion as ReturnType<typeof vi.fn>).mock.calls[0][2] as any[]
    expect(blocks[0]).toMatchObject(notionImg("https://cdn.example.com/a-cover.jpg"))
    expect(blocks.slice(-4)).toMatchObject(EXPECTED_MEMBER_TAIL)
  })

  it("AC-4: the update path (story.notionPageId set) passes the same media blocks", async () => {
    const updateNotionPage = vi.fn().mockResolvedValue(undefined)
    const deps = buildDeps({ updateNotionPage })
    deps.db.story.findUnique = storyFindUniqueWithMaterials({
      ...mockSavedStory,
      notionPageId: NOTION_PAGE_ID,
      notionUrl: NOTION_URL,
      inboxItems: [inboxNoMedia],
    }) as never

    await publishToNotion(STORY_ID, deps)

    expect(deps.saveToNotion).not.toHaveBeenCalled()
    expect(updateNotionPage).toHaveBeenCalledTimes(1)
    expect(updateNotionPage.mock.calls[0][0]).toBe(NOTION_PAGE_ID)
    const blocks = updateNotionPage.mock.calls[0][2] as any[]
    expect(blocks[0]).toMatchObject(notionImg("https://cdn.example.com/a-cover.jpg"))
    expect(blocks.slice(-4)).toMatchObject(EXPECTED_MEMBER_TAIL)
  })

  it("AC-4: inbox items' media reach buildNotionBlocks as {url, kind} entries (thumbnail, then mediaUrls, deduped)", async () => {
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStoryWithInboxItems,
      materials: [],
      inboxItems: [
        {
          ...mockInboxItemExtracted,
          status: "MATCHED",
          storyId: STORY_ID,
          mediaUrls: [
            "https://r2.example.com/media/photo1.jpg",
            "https://r2.example.com/media/photo2.jpg",
          ],
        },
        {
          ...mockInboxItemExtracted,
          id: "clx_inbox_002",
          status: "MATCHED",
          storyId: STORY_ID,
          mediaUrls: ["https://r2.example.com/media/video1.mp4"],
        },
      ],
    })

    await publishToNotion(STORY_ID, deps)

    expect(vi.mocked(buildNotionBlocks)).toHaveBeenCalledOnce()
    const arg = vi.mocked(buildNotionBlocks).mock.calls[0][0] as {
      media?: { url: string; kind: string }[]
    }
    expect((arg.media ?? []).map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: "https://nngroup.com/images/og-design-enforcement.jpg", kind: "image" },
      { url: "https://r2.example.com/media/photo1.jpg", kind: "image" },
      { url: "https://r2.example.com/media/photo2.jpg", kind: "image" },
      { url: "https://r2.example.com/media/video1.mp4", kind: "video" },
    ])
    expect(arg.media).toHaveLength(4)
  })

  it("AC-4: media is [] when neither inbox items nor materials carry any", async () => {
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockStoryWithInboxItems,
      materials: [],
      inboxItems: [inboxNoMedia, { ...inboxNoMedia, id: "clx_inbox_003" }],
    })

    await publishToNotion(STORY_ID, deps)

    expect(vi.mocked(buildNotionBlocks)).toHaveBeenCalledOnce()
    const arg = vi.mocked(buildNotionBlocks).mock.calls[0][0] as { media?: unknown }
    expect(arg.media).toEqual([])
  })
})

// ===========================================================================
// 9. publishToNotion — RAD-401 review round: query shape, URL safety, inbox
//    mediaUrls hygiene
// ===========================================================================

describe("publishToNotion — RAD-401 review fixes", () => {
  beforeEach(() => {
    vi.mocked(buildNotionBlocks).mockClear()
  })

  function storyArgs(findUnique: ReturnType<typeof vi.fn>) {
    return findUnique.mock.calls[0][0] as {
      include?: Record<string, any>
      select?: Record<string, any>
    }
  }

  it("selects exactly the material fields storyDetailMedia reads (title, thumbnailUrl, mediaUrls, feed.type)", async () => {
    const deps = buildDeps()
    const findUnique = storyFindUniqueWithMaterials({ ...mockSavedStory, inboxItems: [inboxNoMedia] })
    deps.db.story.findUnique = findUnique as never

    await publishToNotion(STORY_ID, deps)

    const args = storyArgs(findUnique)
    const materialsQuery = args.include?.materials ?? args.select?.materials
    expect(materialsQuery.select).toMatchObject({
      title: true,
      thumbnailUrl: true,
      mediaUrls: true,
      feed: { select: { type: true } },
    })
  })

  it("orders the story's inbox items by createdAt asc", async () => {
    const deps = buildDeps()
    const findUnique = storyFindUniqueWithMaterials({ ...mockSavedStory, inboxItems: [inboxNoMedia] })
    deps.db.story.findUnique = findUnique as never

    await publishToNotion(STORY_ID, deps)

    const args = storyArgs(findUnique)
    expect(args.include?.inboxItems ?? args.select?.inboxItems).toMatchObject({ orderBy: { createdAt: "asc" } })
  })

  it("an inbox item's relative thumbnailUrl never reaches saveToNotion; a valid one does", async () => {
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockSavedStory,
      materials: [],
      inboxItems: [
        { ...inboxNoMedia, thumbnailUrl: "/img/og.png" },
        { ...inboxNoMedia, id: "clx_inbox_003", thumbnailUrl: "https://cdn.example.com/valid-cover.jpg" },
      ],
    })

    await publishToNotion(STORY_ID, deps)

    expect(deps.saveToNotion).toHaveBeenCalledTimes(1)
    const blocks = (deps.saveToNotion as ReturnType<typeof vi.fn>).mock.calls[0][2] as any[]
    expect(blocks[0]).toEqual(notionImg("https://cdn.example.com/valid-cover.jpg"))
    expect(JSON.stringify(blocks)).not.toContain("/img/og.png")
  })

  it("inbox mediaUrls of unknown kind (article pages) are dropped; inbox thumbnails are kept even when extensionless", async () => {
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockSavedStory,
      materials: [],
      inboxItems: [
        {
          ...inboxNoMedia,
          // Habr-style share PNG: no extension, classifies "unknown", but a thumbnail is a trusted cover.
          thumbnailUrl: "https://habr.example.com/share/publication/123/abc/",
          mediaUrls: [
            "https://news.example.com/article-about-it",
            "https://r2.example.com/media/photo1.jpg",
            "https://r2.example.com/media/clip.mp4",
          ],
        },
      ],
    })

    await publishToNotion(STORY_ID, deps)

    const arg = vi.mocked(buildNotionBlocks).mock.calls[0][0] as { media: { url: string; kind: string }[] }
    expect(arg.media.map(({ url, kind }) => ({ url, kind }))).toEqual([
      { url: "https://habr.example.com/share/publication/123/abc/", kind: "image" },
      { url: "https://r2.example.com/media/photo1.jpg", kind: "image" },
      { url: "https://r2.example.com/media/clip.mp4", kind: "video" },
    ])
  })
})
