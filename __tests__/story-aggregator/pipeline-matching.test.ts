/**
 * Pipeline Phase 2 Extension — Story Matching & Updating tests — TDD RED phase
 *
 * These tests cover two NEW functions that will be added to pipeline.ts:
 *   matchAndRoute(itemId, deps) — spec 4.3: routes item to create or update
 *   updateExistingStory(storyId, deps) — spec 4.4: re-generates story from ALL items
 *
 * Tests also cover the updated processInboxItem orchestration that calls matchAndRoute
 * after extractAndSave and branches on action="create" vs action="update".
 *
 * Spec references: the Story Aggregator specification sections 4.3, 4.4
 *
 * PipelineDeps extensions required:
 *   matchItem: (itemId: string, userId: string) => Promise<{ match: string | null; isNew: boolean; reasoning: string }>
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  matchAndRoute,
  updateExistingStory,
  processInboxItem,
  type PipelineDeps,
} from "@/lib/story-aggregator/pipeline"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ITEM_ID = "clx_inbox_match_001"
const STORY_ID = "clx_story_001"
const MATCHED_STORY_ID = "clx_story_existing_001"
const NOTION_PAGE_ID = "notion_page_abc123"
const NOTION_URL = "https://notion.so/workspace/notion_page_abc123"
const USER_ID = "clx_user_001"
const NOTION_DB_ID = "notion_db_abc123"

/** An InboxItem that has been through content extraction — ready for matching */
const mockInboxItemExtracted = {
  id: ITEM_ID,
  userId: USER_ID,
  externalId: "-1001234567890:99001",
  messageId: 99001,
  rawText: "Anthropic just released Claude 5 with amazing new capabilities",
  rawEntities: null,
  extractedUrl: "https://anthropic.com/news/claude-5",
  extractedTitle: "Anthropic Releases Claude 5",
  extractedContent:
    "Anthropic has released Claude 5, their most capable model yet. " +
    "The new model features improved reasoning, longer context windows, and better tool use.",
  mediaUrls: [] as string[],
  thumbnailUrl: "https://anthropic.com/images/claude5-og.jpg",
  sourceChannel: "AI News",
  forwardedFromId: null,
  telegramPostUrl: null,
  status: "EXTRACTED",
  storyId: null,
  retryCount: 0,
  processedAt: null,
  errorMessage: null,
  createdAt: new Date("2026-02-19T10:00:00Z"),
}

/** A second InboxItem already linked to the existing story */
const mockExistingLinkedItem = {
  ...mockInboxItemExtracted,
  id: "clx_inbox_existing_001",
  externalId: "-1001234567890:98000",
  messageId: 98000,
  extractedTitle: "Claude 5 Announced by Anthropic",
  extractedContent: "Earlier this week, Anthropic announced Claude 5.",
  status: "MATCHED",
  storyId: MATCHED_STORY_ID,
}

/** An existing story with one inbox item already linked */
const mockExistingStory = {
  id: MATCHED_STORY_ID,
  userId: USER_ID,
  title: "Claude 5 Announced by Anthropic",
  languageFlag: "GB" as const,
  summary: "Anthropic obyavila o vipuske Claude 5.",
  body: "## Claude 5\n\nAnthropic vipustila novuyu model.",
  keyPoints: ["Novaya model' s uluchshennym rassuzhdeniem", "Dlinnyy kontekst"],
  sourceUrls: ["https://anthropic.com/blog/claude-5-announcement"],
  rubrics: ["Инструмент"],
  archiveLinks: null,
  notionPageId: null,
  notionUrl: null,
  status: "DRAFT",
  version: 1,
  createdAt: new Date("2026-02-18T09:00:00Z"),
  updatedAt: new Date("2026-02-18T09:00:00Z"),
  inboxItems: [mockExistingLinkedItem],
}

/** The updated story output the AI returns when re-generating from all items */
const mockUpdatedStoryOutput = {
  languageFlag: "GB" as const,
  title: "Anthropic Releases Claude 5",
  rubrics: ["Neuro Updates"],
  authorLevel: "industry leader" as const,
  materialType: "news" as const,
  materialCharacter: "breakthrough" as const,
  summary:
    "Anthropic vipustila Claude 5 — svoyu samuy moshchnuyu model' s uluchshennym rassuzhdeniem.",
  body:
    "## Claude 5: samaya moshchnaya model' Anthropic\n\n" +
    "Anthropic ofitsial'no predstavila Claude 5.",
  keyPoints: [
    "Uluchshennoe rassuzhdenie po sravneniyu s Claude 4",
    "Bol'shoe okno konteksta",
    "Luchshee ispol'zovanie instrumentov",
  ],
  sourceUrls: [
    "https://anthropic.com/blog/claude-5-announcement",
    "https://anthropic.com/news/claude-5",
  ],
}

/** UserSettings with Notion configured */
const mockUserSettingsWithNotion = {
  userId: USER_ID,
  storyInboxChannelId: "-1001234567890",
  storyNotionDatabaseId: NOTION_DB_ID,
  storyLastMessageId: 98000,
  storySystemPrompt: null,
  storyPromptVersion: 1,
}

// ---------------------------------------------------------------------------
// Factory: build a fully-mocked PipelineDeps object for matching tests
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    db: {
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(mockInboxItemExtracted),
        update: vi.fn().mockResolvedValue(mockInboxItemExtracted),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      story: {
        create: vi.fn().mockResolvedValue({ id: STORY_ID }),
        findUnique: vi.fn().mockResolvedValue(mockExistingStory),
        update: vi.fn().mockResolvedValue({
          ...mockExistingStory,
          version: 2,
          title: mockUpdatedStoryOutput.title,
          summary: mockUpdatedStoryOutput.summary,
          body: mockUpdatedStoryOutput.body,
          keyPoints: mockUpdatedStoryOutput.keyPoints,
          sourceUrls: mockUpdatedStoryOutput.sourceUrls,
          rubrics: mockUpdatedStoryOutput.rubrics,
        }),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue(mockUserSettingsWithNotion),
        update: vi.fn().mockResolvedValue(mockUserSettingsWithNotion),
      },
    },
    generateStory: vi.fn().mockResolvedValue(mockUpdatedStoryOutput),
    saveToNotion: vi
      .fn()
      .mockResolvedValue({ pageId: NOTION_PAGE_ID, url: NOTION_URL }),
    extractContent: {
      fromUrl: vi.fn().mockResolvedValue({
        title: mockInboxItemExtracted.extractedTitle,
        content: mockInboxItemExtracted.extractedContent,
        ogImage: mockInboxItemExtracted.thumbnailUrl,
        author: null,
      }),
      fromText: vi.fn().mockReturnValue({
        title: "Raw text title",
        content: mockInboxItemExtracted.rawText,
        ogImage: null,
        author: null,
      }),
    },
    matchItem: vi.fn().mockResolvedValue({
      match: null,
      isNew: true,
      reasoning: "No similar stories found",
    }),
    ...overrides,
  }
}

// ===========================================================================
// 1. matchAndRoute — story matching and routing decision (spec 4.3)
// ===========================================================================

describe("matchAndRoute", () => {
  it("returns action='create' and storyId=null when matchItem reports no match (isNew=true)", async () => {
    // Arrange: matchItem says no existing story matches
    const deps = buildDeps()
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: null,
      isNew: true,
      reasoning: "No similar stories in the last 30 days",
    })

    // Act
    const result = await matchAndRoute(ITEM_ID, deps)

    // Assert
    expect(result.action).toBe("create")
    expect(result.storyId).toBeNull()
  })

  it("returns action='update' and the matched storyId when matchItem returns a match", async () => {
    // Arrange: matchItem finds an existing story
    const deps = buildDeps()
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: MATCHED_STORY_ID,
      isNew: false,
      reasoning: "Same product launch event",
    })

    // Act
    const result = await matchAndRoute(ITEM_ID, deps)

    // Assert
    expect(result.action).toBe("update")
    expect(result.storyId).toBe(MATCHED_STORY_ID)
  })

  it("sets InboxItem status to MATCHED after routing decision (spec 4.3 step 4/5)", async () => {
    // Arrange: isNew path
    const deps = buildDeps()

    // Act
    await matchAndRoute(ITEM_ID, deps)

    // Assert: InboxItem updated to MATCHED regardless of create vs update path
    expect(deps.db.inboxItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ITEM_ID },
        data: expect.objectContaining({
          status: "MATCHED",
        }),
      })
    )
  })

  it("links InboxItem to the matched story when a match is found", async () => {
    // Arrange: match found path
    const deps = buildDeps()
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: MATCHED_STORY_ID,
      isNew: false,
      reasoning: "Same Claude 5 news event",
    })

    // Act
    await matchAndRoute(ITEM_ID, deps)

    // Assert: InboxItem.storyId set to the matched story
    const updateCalls = (deps.db.inboxItem.update as ReturnType<typeof vi.fn>).mock
      .calls as Array<[{ where: unknown; data: { storyId?: string; status?: string } }]>
    const linkUpdate = updateCalls.find(([args]) => args.data.storyId === MATCHED_STORY_ID)
    expect(linkUpdate).toBeDefined()
  })

  it("calls matchItem with the correct itemId and userId from the InboxItem", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await matchAndRoute(ITEM_ID, deps)

    // Assert: matchItem called with item's userId (fetched from DB)
    expect(deps.matchItem).toHaveBeenCalledWith(
      ITEM_ID,
      USER_ID,
      expect.anything()
    )
  })

  it("returns action='create' when InboxItem is not found in DB", async () => {
    // Arrange: item does not exist
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    // Act
    const result = await matchAndRoute(ITEM_ID, deps)

    // Assert: graceful fallback to create (or error signal), never throws
    expect(result).toBeDefined()
    expect(["create", "error"]).toContain(result.action)
  })
})

// ===========================================================================
// 2. updateExistingStory — re-generation from ALL items combined (spec 4.4)
// ===========================================================================

describe("updateExistingStory", () => {
  it("fetches the story with ALL its inbox items included", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: story.findUnique called with include: { inboxItems: true }
    expect(deps.db.story.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATCHED_STORY_ID },
        include: expect.objectContaining({ inboxItems: true }),
      })
    )
  })

  it("calls generateStory with content from ALL linked inbox items combined, not just the new one", async () => {
    // Arrange: story has two linked items
    const twoItemStory = {
      ...mockExistingStory,
      inboxItems: [
        mockExistingLinkedItem,
        { ...mockInboxItemExtracted, status: "MATCHED", storyId: MATCHED_STORY_ID },
      ],
    }
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(twoItemStory)

    // Act
    await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: generateStory was called (content from both items fed in)
    expect(deps.generateStory).toHaveBeenCalledTimes(1)

    // The user content should reference content from both items
    const [, userContent] = (deps.generateStory as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
    ]
    expect(typeof userContent).toBe("string")
    expect(userContent.length).toBeGreaterThan(0)
  })

  it("updates the existing Story record in-place (does NOT create a new story)", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: story.update called, story.create NOT called
    expect(deps.db.story.update).toHaveBeenCalled()
    expect(deps.db.story.create).not.toHaveBeenCalled()
  })

  it("updates story fields: title, summary, body, keyPoints, sourceUrls, rubrics", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: story.update called with all regenerated fields
    expect(deps.db.story.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: MATCHED_STORY_ID },
        data: expect.objectContaining({
          title: expect.any(String),
          summary: expect.any(String),
          body: expect.any(String),
          keyPoints: expect.any(Array),
          sourceUrls: expect.any(Array),
          rubrics: expect.any(Array),
        }),
      })
    )
  })

  it("increments the story version by 1 (spec 4.4: version tracking)", async () => {
    // Arrange: existing story is at version 1
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockExistingStory,
      version: 1,
    })

    // Act
    await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: version incremented to 2
    const updateCalls = (deps.db.story.update as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ where: unknown; data: { version?: number | { increment: number } } }]
    >
    const versionUpdate = updateCalls.find(([args]) => args.data.version !== undefined)
    expect(versionUpdate).toBeDefined()
    const versionValue = versionUpdate![0].data.version
    // Accept either explicit increment or { increment: 1 } Prisma syntax
    const isVersionIncrement =
      versionValue === 2 ||
      (typeof versionValue === "object" &&
        versionValue !== null &&
        "increment" in versionValue &&
        (versionValue as { increment: number }).increment === 1)
    expect(isVersionIncrement).toBe(true)
  })

  it("returns the updated story ID", async () => {
    // Arrange
    const deps = buildDeps()

    // Act
    const result = await updateExistingStory(MATCHED_STORY_ID, deps)

    // Assert: returns a string ID
    expect(typeof result).toBe("string")
    expect(result).toBe(MATCHED_STORY_ID)
  })

  it("throws when the story is not found", async () => {
    // Arrange
    const deps = buildDeps()
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    // Act + Assert
    await expect(updateExistingStory(MATCHED_STORY_ID, deps)).rejects.toThrow()
  })
})

// ===========================================================================
// 3. processInboxItem — updated orchestration with matchAndRoute (spec 4.3–4.4)
// ===========================================================================

describe("processInboxItem — Phase 2 matching integration", () => {
  it("calls matchItem after extraction when matchItem dep is provided", async () => {
    // Arrange: isNew path — pipeline goes to generateAndSaveStory
    const deps = buildDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockExistingStory,
      id: STORY_ID,
      inboxItems: [{ ...mockInboxItemExtracted, status: "MATCHED", storyId: STORY_ID }],
    })

    // Act
    await processInboxItem(ITEM_ID, deps)

    // Assert: matchItem was invoked during the pipeline
    expect(deps.matchItem).toHaveBeenCalled()
  })

  it("calls generateAndSaveStory (create path) when matchItem returns isNew=true, and matchItem is called before create", async () => {
    // Arrange: no match found
    const deps = buildDeps()
    const callOrder: string[] = []
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("matchItem")
      return { match: null, isNew: true, reasoning: "Unique topic" }
    })
    ;(deps.db.story.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("story.create")
      return { id: STORY_ID }
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...mockExistingStory,
      id: STORY_ID,
      inboxItems: [{ ...mockInboxItemExtracted, status: "MATCHED", storyId: STORY_ID }],
    })

    // Act
    const result = await processInboxItem(ITEM_ID, deps)

    // Assert: matchItem was invoked AND came before story.create
    expect(result.success).toBe(true)
    expect(deps.matchItem).toHaveBeenCalled()
    expect(deps.db.story.create).toHaveBeenCalled()
    const matchIndex = callOrder.indexOf("matchItem")
    const createIndex = callOrder.indexOf("story.create")
    expect(matchIndex).toBeGreaterThanOrEqual(0)
    expect(matchIndex).toBeLessThan(createIndex)
  })

  it("calls updateExistingStory (update path) and skips story.create when matchItem returns a match", async () => {
    // Arrange: match found
    const deps = buildDeps()
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: MATCHED_STORY_ID,
      isNew: false,
      reasoning: "Same product announcement",
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockExistingStory)

    // Act
    const result = await processInboxItem(ITEM_ID, deps)

    // Assert: existing story was updated, no new story created
    expect(result.success).toBe(true)
    expect(deps.db.story.create).not.toHaveBeenCalled()
    expect(deps.db.story.update).toHaveBeenCalled()
  })

  it("publishes to Notion on the update path and passes the matched storyId (not a new one)", async () => {
    // Arrange: update path — matchItem returns a match, so updateExistingStory is called
    const deps = buildDeps()
    ;(deps.matchItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      match: MATCHED_STORY_ID,
      isNew: false,
      reasoning: "Same event",
    })
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockInboxItemExtracted
    )
    ;(deps.db.story.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockExistingStory)

    // Act
    const result = await processInboxItem(ITEM_ID, deps)

    // Assert: Notion publish was called and result carries the matched storyId
    expect(result.success).toBe(true)
    expect(deps.saveToNotion).toHaveBeenCalled()
    // The returned storyId must be the matched (existing) story, not a newly created one
    expect(result.storyId).toBe(MATCHED_STORY_ID)
  })
})
