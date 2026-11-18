/**
 * Phase 2 — Generalize story matcher and writer for materials
 * TDD RED phase: all tests are expected to FAIL until implementation is written.
 *
 * Spec: RAD-120 Phase 2
 *
 * Criteria covered:
 *   AC-1: matchContent() accepts content fields directly, runs full matching flow
 *   AC-2: matchItem() delegates to matchContent() internally
 *   AC-3: buildStoryUserContent() uses "Source:" for rss/twitter sourceType
 *   AC-4: buildStoryUserContent() defaults to Telegram labels when sourceType is omitted/"telegram"
 *   AC-5: updateExistingStory() queries both inboxItems and materials, merges for regeneration
 *   AC-6: (removed 2026-09-08) buildMaterialPipelineDeps was dead code — this test was
 *         its only caller. The live material path is buildMaterialStoryDeps.
 *   EC-1: matchContent() with empty title and content returns isNew: true
 *   EC-2: updateExistingStory() when story has only InboxItems behaves as before
 *   EC-3: updateExistingStory() when story has only Materials uses material content
 *   ERR-1: matchContent() returns {match: null, isNew: true} when no stories exist
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  matchItem,
  matchContent,
  type StoryMatcherDeps,
} from "@/lib/story-aggregator/story-matcher"
import {
  buildStoryUserContent,
  type InboxItemForStory,
} from "@/lib/story-aggregator/story-writer"
import {
  updateExistingStory,
  type PipelineDeps,
} from "@/lib/story-aggregator/pipeline"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const USER_ID = "clx_user_001"
const STORY_ID = "clx_story_aaa"

const mockStoryRecord = {
  id: STORY_ID,
  userId: USER_ID,
  title: "Design System Enforcement Trends",
  summary: "Companies push for stricter design system enforcement.",
  sourceUrls: ["https://uxinsight.com/enforcement-trends"],
  status: "DRAFT",
  createdAt: new Date("2026-02-10T10:00:00Z"),
}

/** Factory for a minimal StoryMatcherDeps with mocked methods */
function buildMatcherDeps(overrides: Partial<StoryMatcherDeps> = {}): StoryMatcherDeps {
  return {
    db: {
      story: {
        findMany: vi.fn().mockResolvedValue([mockStoryRecord]),
      },
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    },
    matchWithAI: vi.fn().mockResolvedValue({
      match: STORY_ID,
      reasoning: "Same design enforcement topic.",
    }),
    ...overrides,
  }
}

const validStoryOutput = {
  languageFlag: "GB" as const,
  title: "Updated story title",
  rubrics: ["Инструмент"],
  authorLevel: "expert" as const,
  materialType: "article" as const,
  materialCharacter: "useful" as const,
  summary: "Updated summary.",
  body: "Updated body text here.",
  keyPoints: ["Key point one", "Key point two"],
  sourceUrls: ["https://example.com/article"],
}

/** Factory for a minimal PipelineDeps for updateExistingStory */
function buildPipelineDeps(storyRecord: Record<string, unknown>): PipelineDeps {
  return {
    db: {
      inboxItem: {
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({}),
      },
      story: {
        create: vi.fn().mockResolvedValue({ id: STORY_ID }),
        findUnique: vi.fn().mockResolvedValue(storyRecord),
        update: vi.fn().mockResolvedValue({}),
      },
      userSettings: {
        findUnique: vi.fn().mockResolvedValue({
          userId: USER_ID,
          storySystemPrompt: null,
          storyNotionDatabaseId: null,
          storyInboxChannelId: null,
          storyLastMessageId: null,
          storyPromptVersion: null,
          storyLanguage: "en",
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    },
    generateStory: vi.fn().mockResolvedValue(validStoryOutput),
    saveToNotion: vi.fn().mockResolvedValue({ pageId: "page_1", url: "https://notion.so/page_1" }),
    extractContent: {
      fromUrl: vi.fn().mockResolvedValue({ title: null, content: null, ogImage: null, author: null }),
      fromText: vi.fn().mockReturnValue({ title: null, content: null, ogImage: null, author: null }),
    },
  } as unknown as PipelineDeps
}

// ===========================================================================
// AC-1: matchContent() accepts content fields directly
// ===========================================================================

describe("AC-1: matchContent accepts content fields directly and runs full matching flow", () => {
  it("AC-1: matchContent is exported from story-matcher and accepts {title, content, url, rawText} + userId", async () => {
    const deps = buildMatcherDeps()
    // matchContent does NOT call db.inboxItem.findUnique — it uses the provided fields directly
    const result = await matchContent(
      {
        title: "Design system enforcement practices",
        content: "Companies are rethinking how they enforce design systems.",
        url: "https://designnews.com/enforcement",
        rawText: "Design system enforcement practices",
      },
      USER_ID,
      deps
    )

    // Should NOT call inboxItem.findUnique — content is passed directly
    expect(deps.db.inboxItem.findUnique).not.toHaveBeenCalled()

    // Returns the standard matching shape
    expect(result).toHaveProperty("match")
    expect(result).toHaveProperty("isNew")
    expect(result).toHaveProperty("reasoning")
    expect(typeof result.reasoning).toBe("string")
  })

  it("AC-1: matchContent fetches recent stories from the DB with correct userId filter", async () => {
    const deps = buildMatcherDeps()
    await matchContent(
      { title: "Some title", content: "Some content", url: null, rawText: null },
      USER_ID,
      deps
    )

    expect(deps.db.story.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      })
    )
  })

  it("AC-1: matchContent calls AI and returns match result when candidates exist", async () => {
    // Use non-versioned content so URL+entity shortcuts don't fire
    const deps = buildMatcherDeps()
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockStoryRecord,
        title: "Design system governance approaches",
        sourceUrls: ["https://other.com/governance"],
      },
    ])

    const result = await matchContent(
      {
        title: "Design enforcement in practice",
        content: "New patterns for design system enforcement are emerging.",
        url: "https://techblog.com/enforcement",
        rawText: null,
      },
      USER_ID,
      deps
    )

    expect(deps.matchWithAI).toHaveBeenCalledOnce()
    expect(result.match).toBe(STORY_ID)
    expect(result.isNew).toBe(false)
  })
})

// ===========================================================================
// AC-2: matchItem() delegates to matchContent() internally
// ===========================================================================

describe("AC-2: matchItem delegates to matchContent internally", () => {
  it("AC-2: matchItem fetches InboxItem then calls matchContent — db.inboxItem.findUnique is called once", async () => {
    const mockInboxItem = {
      id: "clx_inbox_001",
      userId: USER_ID,
      extractedTitle: "Design governance patterns",
      extractedContent: "New patterns for design governance.",
      extractedUrl: "https://techblog.com/governance",
      rawText: "Design governance patterns",
    }
    const deps = buildMatcherDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(mockInboxItem)
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        ...mockStoryRecord,
        title: "Design governance approaches",
        sourceUrls: ["https://other.com/governance"],
      },
    ])

    await matchItem("clx_inbox_001", USER_ID, deps)

    // matchItem must fetch the item then proceed — findUnique called exactly once
    expect(deps.db.inboxItem.findUnique).toHaveBeenCalledOnce()
    expect(deps.db.inboxItem.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "clx_inbox_001" } })
    )
  })

  it("AC-2: existing matchItem behavior preserved — returns {match: null, isNew: true} when item not found", async () => {
    const deps = buildMatcherDeps()
    ;(deps.db.inboxItem.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const result = await matchItem("nonexistent_id", USER_ID, deps)

    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)
  })
})

// ===========================================================================
// AC-3: buildStoryUserContent() uses "Source:" for rss/twitter sourceType
// ===========================================================================

describe("AC-3: buildStoryUserContent uses Source: label for rss and twitter sourceType", () => {
  it("AC-3: sourceType 'rss' renders 'Source:' instead of 'Channel:'", () => {
    const item: InboxItemForStory = {
      rawText: "An interesting article about design",
      extractedTitle: "Design article title",
      extractedContent: "Content of the design article.",
      sourceChannel: "Design Weekly RSS",
      extractedUrl: "https://designweekly.com/article",
      mediaUrls: [],
      telegramPostUrl: null,
      sourceType: "rss",
    }

    const result = buildStoryUserContent([item])

    expect(result).toContain("Source: Design Weekly RSS")
    expect(result).not.toContain("Channel: Design Weekly RSS")
  })

  it("AC-3: sourceType 'rss' omits the 'Telegram post:' line", () => {
    const item: InboxItemForStory = {
      rawText: "Article text",
      extractedTitle: "Article",
      extractedContent: null,
      sourceChannel: "News Feed",
      extractedUrl: "https://news.com/article",
      mediaUrls: [],
      telegramPostUrl: "https://t.me/channel/999",
      sourceType: "rss",
    }

    const result = buildStoryUserContent([item])

    // telegramPostUrl should be omitted for rss/twitter sources
    expect(result).not.toContain("Telegram post:")
  })

  it("AC-3: sourceType 'twitter' renders 'Source:' instead of 'Channel:'", () => {
    const item: InboxItemForStory = {
      rawText: "Tweet about design",
      extractedTitle: null,
      extractedContent: null,
      sourceChannel: "@designweekly",
      extractedUrl: "https://twitter.com/designweekly/status/123",
      mediaUrls: [],
      telegramPostUrl: null,
      sourceType: "twitter",
    }

    const result = buildStoryUserContent([item])

    expect(result).toContain("Source: @designweekly")
    expect(result).not.toContain("Channel: @designweekly")
  })

  it("AC-3: sourceType 'twitter' omits the 'Telegram post:' line", () => {
    const item: InboxItemForStory = {
      rawText: "Tweet text",
      extractedTitle: null,
      extractedContent: null,
      sourceChannel: "@channel",
      extractedUrl: "https://twitter.com/channel/status/456",
      mediaUrls: [],
      telegramPostUrl: "https://t.me/channel/456",
      sourceType: "twitter",
    }

    const result = buildStoryUserContent([item])

    expect(result).not.toContain("Telegram post:")
  })
})

// ===========================================================================
// AC-4: buildStoryUserContent() defaults to Telegram labels
// ===========================================================================

describe("AC-4: buildStoryUserContent defaults to Telegram labels when sourceType is omitted or telegram", () => {
  it("AC-4: sourceType omitted — uses 'Channel:' label for sourceChannel", () => {
    const item: InboxItemForStory = {
      rawText: "Some content",
      extractedTitle: "Title",
      extractedContent: null,
      sourceChannel: "Design Weekly",
      extractedUrl: null,
      mediaUrls: [],
      telegramPostUrl: null,
    }

    const result = buildStoryUserContent([item])

    expect(result).toContain("Channel: Design Weekly")
    expect(result).not.toContain("Source: Design Weekly")
  })

  it("AC-4: sourceType 'telegram' — uses 'Channel:' label and includes Telegram post URL", () => {
    const item: InboxItemForStory = {
      rawText: "Telegram post content",
      extractedTitle: "Post title",
      extractedContent: null,
      sourceChannel: "Design Channel",
      extractedUrl: null,
      mediaUrls: [],
      telegramPostUrl: "https://t.me/designchannel/100",
      sourceType: "telegram",
    }

    const result = buildStoryUserContent([item])

    expect(result).toContain("Channel: Design Channel")
    expect(result).toContain("Telegram post: https://t.me/designchannel/100")
    expect(result).not.toContain("Source: Design Channel")
  })
})

// ===========================================================================
// AC-5: updateExistingStory() queries both inboxItems and materials
// ===========================================================================

describe("AC-5: updateExistingStory queries both inboxItems and materials relations", () => {
  it("AC-5: story.findUnique is called with include: { inboxItems: true, materials: true }", async () => {
    const storyWithBoth = {
      id: STORY_ID,
      userId: USER_ID,
      title: "Design story",
      languageFlag: "GB",
      summary: "Design summary",
      body: "Design body",
      keyPoints: [],
      sourceUrls: ["https://example.com"],
      rubrics: [],
      archiveLinks: null,
      notionPageId: null,
      notionUrl: null,
      status: "DRAFT",
      version: 1,
      inboxItems: [
        {
          id: "inbox_1",
          userId: USER_ID,
          rawText: "Inbox item text",
          extractedTitle: "Inbox title",
          extractedContent: "Inbox content",
          sourceChannel: "Design Channel",
          extractedUrl: "https://example.com/inbox",
          mediaUrls: [],
          telegramPostUrl: "https://t.me/channel/1",
        },
      ],
      materials: [
        {
          id: "mat_1",
          title: "Material title",
          content: "Material content",
          url: "https://example.com/material",
          rawText: null,
        },
      ],
    }

    const deps = buildPipelineDeps(storyWithBoth)

    await updateExistingStory(STORY_ID, deps)

    expect(deps.db.story.findUnique).toHaveBeenCalledWith({
      where: { id: STORY_ID },
      include: {
        inboxItems: true,
        materials: { include: { feed: true } },
      },
    })
  })

  it("AC-5: when story has both inboxItems and materials, generateStory is called with content from both", async () => {
    const storyWithBoth = {
      id: STORY_ID,
      userId: USER_ID,
      title: "Combined story",
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
      inboxItems: [
        {
          id: "inbox_1",
          userId: USER_ID,
          rawText: "UNIQUE_INBOX_TEXT_ABC",
          extractedTitle: "Inbox title",
          extractedContent: null,
          sourceChannel: "Telegram Channel",
          extractedUrl: null,
          mediaUrls: [],
          telegramPostUrl: null,
        },
      ],
      materials: [
        {
          id: "mat_1",
          title: "UNIQUE_MATERIAL_TITLE_XYZ",
          content: "Material content text",
          url: "https://example.com/mat",
          rawText: null,
        },
      ],
    }

    const deps = buildPipelineDeps(storyWithBoth)

    await updateExistingStory(STORY_ID, deps)

    // generateStory userContent should contain data from both sources
    const generateStoryCalls = (deps.generateStory as ReturnType<typeof vi.fn>).mock.calls
    expect(generateStoryCalls.length).toBeGreaterThan(0)
    const userContent = generateStoryCalls[0][1] as string
    expect(userContent).toContain("UNIQUE_INBOX_TEXT_ABC")
    expect(userContent).toContain("UNIQUE_MATERIAL_TITLE_XYZ")
  })
})

// ===========================================================================
// EC-1: matchContent() with empty title and content returns isNew: true
// ===========================================================================

describe("EC-1: matchContent with empty title and content", () => {
  it("EC-1: empty title and empty content — returns isNew: true with no candidates", async () => {
    const deps = buildMatcherDeps()
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await matchContent(
      { title: "", content: "", url: null, rawText: null },
      USER_ID,
      deps
    )

    expect(result.isNew).toBe(true)
    expect(result.match).toBeNull()
  })

  it("EC-1: empty title and content with existing stories — does not crash and returns a valid shape", async () => {
    const deps = buildMatcherDeps()

    const result = await matchContent(
      { title: "", content: "", url: null, rawText: null },
      USER_ID,
      deps
    )

    expect(result).toHaveProperty("match")
    expect(result).toHaveProperty("isNew")
    expect(result).toHaveProperty("reasoning")
  })
})

// ===========================================================================
// EC-2: updateExistingStory with only InboxItems (no materials)
// ===========================================================================

describe("EC-2: updateExistingStory when story has only InboxItems", () => {
  it("EC-2: story with only inboxItems (empty materials) — regenerates correctly from inbox items alone", async () => {
    const storyInboxOnly = {
      id: STORY_ID,
      userId: USER_ID,
      title: "Story from inbox",
      languageFlag: "GB",
      summary: "Summary",
      body: "Body",
      keyPoints: [],
      sourceUrls: ["https://example.com"],
      rubrics: [],
      archiveLinks: null,
      notionPageId: null,
      notionUrl: null,
      status: "DRAFT",
      version: 1,
      inboxItems: [
        {
          id: "inbox_1",
          userId: USER_ID,
          rawText: "INBOX_ONLY_TEXT",
          extractedTitle: "Inbox title only",
          extractedContent: null,
          sourceChannel: "Channel",
          extractedUrl: null,
          mediaUrls: [],
          telegramPostUrl: null,
        },
      ],
      materials: [], // empty — no materials
    }

    const deps = buildPipelineDeps(storyInboxOnly)

    const result = await updateExistingStory(STORY_ID, deps)

    // Should succeed
    expect(result).toBe(STORY_ID)

    // generateStory should have been called with inbox content
    const generateStoryCalls = (deps.generateStory as ReturnType<typeof vi.fn>).mock.calls
    expect(generateStoryCalls.length).toBeGreaterThan(0)
    const userContent = generateStoryCalls[0][1] as string
    expect(userContent).toContain("INBOX_ONLY_TEXT")
  })
})

// ===========================================================================
// EC-3: updateExistingStory with only Materials (no InboxItems)
// ===========================================================================

describe("EC-3: updateExistingStory when story has only Materials", () => {
  it("EC-3: story with only materials (no inboxItems) — uses material content for regeneration", async () => {
    const storyMaterialOnly = {
      id: STORY_ID,
      userId: USER_ID,
      title: "Story from materials",
      languageFlag: "GB",
      summary: "Summary",
      body: "Body",
      keyPoints: [],
      sourceUrls: ["https://example.com/mat"],
      rubrics: [],
      archiveLinks: null,
      notionPageId: null,
      notionUrl: null,
      status: "DRAFT",
      version: 1,
      inboxItems: [], // empty — no inbox items
      materials: [
        {
          id: "mat_1",
          title: "MATERIAL_ONLY_TITLE",
          content: "MATERIAL_ONLY_CONTENT",
          url: "https://example.com/mat",
          rawText: null,
        },
      ],
    }

    const deps = buildPipelineDeps(storyMaterialOnly)

    const result = await updateExistingStory(STORY_ID, deps)

    expect(result).toBe(STORY_ID)

    // generateStory must be called — content comes from the material
    const generateStoryCalls = (deps.generateStory as ReturnType<typeof vi.fn>).mock.calls
    expect(generateStoryCalls.length).toBeGreaterThan(0)
    const userContent = generateStoryCalls[0][1] as string
    expect(userContent).toContain("MATERIAL_ONLY_TITLE")
  })
})

// ===========================================================================
// ERR-1: matchContent() returns {match: null, isNew: true} when no stories
// ===========================================================================

describe("ERR-1: matchContent returns {match: null, isNew: true} when no stories exist", () => {
  it("ERR-1: returns {match: null, isNew: true} without calling AI when story list is empty", async () => {
    const deps = buildMatcherDeps()
    ;(deps.db.story.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const result = await matchContent(
      {
        title: "Brand new topic never seen before",
        content: "Fresh content with no history.",
        url: null,
        rawText: null,
      },
      USER_ID,
      deps
    )

    expect(result.match).toBeNull()
    expect(result.isNew).toBe(true)

    // AI must NOT be called — no candidates to evaluate
    expect(deps.matchWithAI).not.toHaveBeenCalled()
  })
})
