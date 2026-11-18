import { describe, it, expect, afterEach, vi } from "vitest"
import {
  StoryOutputSchema,
  ArchiveLinkSchema,
  ArchiveLinksSchema,
  InboxItemCreateSchema,
  DEFAULT_RUBRICS,
  VALID_RUBRICS,
  validateRubrics,
} from "@/lib/story-aggregator/schemas"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validStoryOutput = {
  languageFlag: "GB",
  title: "Design System Needs an Enforcer",
  rubrics: [DEFAULT_RUBRICS[0]],
  authorLevel: "expert",
  materialType: "article",
  materialCharacter: "useful",
  summary: "Lora Kleyn explains why design systems fail without enforcement.",
  body: "## Why design systems fail\n\nMost design systems die not from lack of work...",
  keyPoints: ["Systems need enforcement", "Tooling alone is not enough"],
  sourceUrls: ["https://nngroup.com/articles/design-system-enforcement"],
}

const validArchiveLink = {
  title: "Typography fundamentals",
  url: "https://archive.example.com/issue/42",
  issueNumber: 42,
  similarity: 0.85,
}

// ---------------------------------------------------------------------------
// 1. StoryOutputSchema — Claude AI JSON output (spec section 4.4)
// ---------------------------------------------------------------------------

describe("StoryOutputSchema", () => {
  it("accepts a valid complete story output", () => {
    const result = StoryOutputSchema.safeParse(validStoryOutput)
    expect(result.success).toBe(true)
  })

  it("rejects languageFlag values other than 'GB' or 'RU'", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      languageFlag: "US",
    })
    expect(result.success).toBe(false)
  })

  it("accepts 'RU' as a valid languageFlag", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      languageFlag: "RU",
    })
    expect(result.success).toBe(true)
  })

  it("rejects missing title", () => {
    const { title: _title, ...withoutTitle } = validStoryOutput
    const result = StoryOutputSchema.safeParse(withoutTitle)
    expect(result.success).toBe(false)
  })

  it("rejects rubrics array with more than 2 items (spec: 1-2 rubrics)", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      rubrics: [DEFAULT_RUBRICS[0], DEFAULT_RUBRICS[1], DEFAULT_RUBRICS[2]],
    })
    expect(result.success).toBe(false)
  })

  it("rejects rubrics as an empty array (spec: at least 1 rubric)", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      rubrics: [],
    })
    expect(result.success).toBe(false)
  })

  it("rejects missing summary", () => {
    const { summary: _summary, ...withoutSummary } = validStoryOutput
    const result = StoryOutputSchema.safeParse(withoutSummary)
    expect(result.success).toBe(false)
  })

  it("rejects missing body", () => {
    const { body: _body, ...withoutBody } = validStoryOutput
    const result = StoryOutputSchema.safeParse(withoutBody)
    expect(result.success).toBe(false)
  })

  it("rejects invalid authorLevel values", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      authorLevel: "god",
    })
    expect(result.success).toBe(false)
  })

  it("accepts all valid authorLevel values", () => {
    const validLevels = [
      "nouname",
      "beginner",
      "mid",
      "expert",
      "industry leader",
      "visionary",
    ] as const

    for (const level of validLevels) {
      const result = StoryOutputSchema.safeParse({
        ...validStoryOutput,
        authorLevel: level,
      })
      expect(result.success, `authorLevel "${level}" should be valid`).toBe(true)
    }
  })

  it("rejects invalid materialType values", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      materialType: "blog-post",
    })
    expect(result.success).toBe(false)
  })

  it("accepts all valid materialType values", () => {
    const validTypes = [
      "article",
      "essay",
      "case",
      "tool",
      "interview",
      "video",
      "news",
      "press-release",
      "practical article",
    ] as const

    for (const type of validTypes) {
      const result = StoryOutputSchema.safeParse({
        ...validStoryOutput,
        materialType: type,
      })
      expect(result.success, `materialType "${type}" should be valid`).toBe(true)
    }
  })

  it("rejects invalid materialCharacter values", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      materialCharacter: "average",
    })
    expect(result.success).toBe(false)
  })

  it("accepts all valid materialCharacter values", () => {
    const validCharacters = [
      "banal",
      "interesting",
      "authorial",
      "original",
      "practical",
      "breakthrough",
      "useful",
    ] as const

    for (const character of validCharacters) {
      const result = StoryOutputSchema.safeParse({
        ...validStoryOutput,
        materialCharacter: character,
      })
      expect(result.success, `materialCharacter "${character}" should be valid`).toBe(true)
    }
  })

  it("rejects invalid URLs in sourceUrls", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      sourceUrls: ["not-a-url"],
    })
    expect(result.success).toBe(false)
  })

  it("strips unknown extra fields (no passthrough)", () => {
    const result = StoryOutputSchema.safeParse({
      ...validStoryOutput,
      unexpectedField: "should be stripped",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).unexpectedField).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. ArchiveLinkSchema — related material links (spec section 3.1)
// ---------------------------------------------------------------------------

describe("ArchiveLinkSchema", () => {
  it("accepts a valid link with all fields", () => {
    const result = ArchiveLinkSchema.safeParse(validArchiveLink)
    expect(result.success).toBe(true)
  })

  it("accepts a link with only required fields (title + url)", () => {
    const result = ArchiveLinkSchema.safeParse({
      title: "Minimal link",
      url: "https://example.com",
    })
    expect(result.success).toBe(true)
  })

  it("rejects missing title", () => {
    const result = ArchiveLinkSchema.safeParse({
      url: "https://example.com",
    })
    expect(result.success).toBe(false)
  })

  it("rejects missing url", () => {
    const result = ArchiveLinkSchema.safeParse({
      title: "Some title",
    })
    expect(result.success).toBe(false)
  })

  it("rejects an invalid URL", () => {
    const result = ArchiveLinkSchema.safeParse({
      title: "Some title",
      url: "not-a-valid-url",
    })
    expect(result.success).toBe(false)
  })

  it("rejects similarity below 0", () => {
    const result = ArchiveLinkSchema.safeParse({
      ...validArchiveLink,
      similarity: -0.1,
    })
    expect(result.success).toBe(false)
  })

  it("rejects similarity above 1", () => {
    const result = ArchiveLinkSchema.safeParse({
      ...validArchiveLink,
      similarity: 1.1,
    })
    expect(result.success).toBe(false)
  })

  it("accepts similarity at boundary values 0 and 1", () => {
    expect(ArchiveLinkSchema.safeParse({ ...validArchiveLink, similarity: 0 }).success).toBe(
      true
    )
    expect(ArchiveLinkSchema.safeParse({ ...validArchiveLink, similarity: 1 }).success).toBe(
      true
    )
  })

  it("issueNumber and similarity are optional", () => {
    const result = ArchiveLinkSchema.safeParse({
      title: "Optional fields test",
      url: "https://example.com",
      // issueNumber and similarity deliberately omitted
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.issueNumber).toBeUndefined()
      expect(result.data.similarity).toBeUndefined()
    }
  })
})

describe("ArchiveLinksSchema", () => {
  it("is an array schema that accepts multiple valid links", () => {
    const result = ArchiveLinksSchema.safeParse([
      validArchiveLink,
      { title: "Another", url: "https://example.com/2" },
    ])
    expect(result.success).toBe(true)
  })

  it("rejects if any item has an invalid URL", () => {
    const result = ArchiveLinksSchema.safeParse([
      validArchiveLink,
      { title: "Bad", url: "bad-url" },
    ])
    expect(result.success).toBe(false)
  })

  it("accepts an empty array", () => {
    const result = ArchiveLinksSchema.safeParse([])
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. VALID_RUBRICS constant and validateRubrics() function (spec section 4.6)
// ---------------------------------------------------------------------------

describe("VALID_RUBRICS", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("is an array of strings", () => {
    expect(Array.isArray(VALID_RUBRICS)).toBe(true)
    expect(VALID_RUBRICS.length).toBeGreaterThan(0)
  })

  it("contains every rubric from DEFAULT_RUBRICS when no override is configured", () => {
    for (const rubric of DEFAULT_RUBRICS) {
      expect(VALID_RUBRICS).toContain(rubric)
    }
  })

  it("uses the STORY_RUBRICS list from the environment when configured", async () => {
    vi.stubEnv("STORY_RUBRICS", "Configured One, Configured Two")
    vi.resetModules()
    const schemas = await import("@/lib/story-aggregator/schemas")
    expect(schemas.VALID_RUBRICS).toEqual(["Configured One", "Configured Two"])
    expect(schemas.VALID_RUBRICS).not.toContain(DEFAULT_RUBRICS[0])
  })

  it("trims whitespace and drops blank entries from STORY_RUBRICS", async () => {
    vi.stubEnv("STORY_RUBRICS", " First , Second ,, ")
    vi.resetModules()
    const schemas = await import("@/lib/story-aggregator/schemas")
    expect(schemas.VALID_RUBRICS).toEqual(["First", "Second"])
  })

  it("falls back to DEFAULT_RUBRICS when STORY_RUBRICS is blank", async () => {
    vi.stubEnv("STORY_RUBRICS", "  ,  ")
    vi.resetModules()
    const schemas = await import("@/lib/story-aggregator/schemas")
    expect(schemas.VALID_RUBRICS).toEqual([...schemas.DEFAULT_RUBRICS])
  })
})

describe("validateRubrics", () => {
  it("returns known rubrics unchanged", () => {
    const known = [DEFAULT_RUBRICS[0], DEFAULT_RUBRICS[1]]
    const result = validateRubrics(known)
    expect(result).toEqual(known)
  })

  it("filters out rubrics not in the known list", () => {
    const result = validateRubrics([DEFAULT_RUBRICS[0], "Not-A-Real-Rubric"])
    expect(result).toEqual([DEFAULT_RUBRICS[0]])
    expect(result).not.toContain("Not-A-Real-Rubric")
  })

  it("returns empty array when all rubrics are unknown", () => {
    const result = validateRubrics(["Not-A-Real-Rubric", "AlsoFake"])
    expect(result).toEqual([])
  })

  it("is case-sensitive — a lowercased known rubric is rejected", () => {
    const result = validateRubrics([DEFAULT_RUBRICS[0].toLowerCase()])
    expect(result).toEqual([])
  })

  it("returns empty array for empty input", () => {
    const result = validateRubrics([])
    expect(result).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. InboxItemCreateSchema — creating an InboxItem (spec section 3.1)
// ---------------------------------------------------------------------------

describe("InboxItemCreateSchema", () => {
  const validInboxItem = {
    userId: "user_cuid_123",
    externalId: "-1009999999999:12345",
    messageId: 12345,
  }

  it("accepts a valid minimal inbox item (required fields only)", () => {
    const result = InboxItemCreateSchema.safeParse(validInboxItem)
    expect(result.success).toBe(true)
  })

  it("rejects missing userId", () => {
    const { userId: _userId, ...without } = validInboxItem
    const result = InboxItemCreateSchema.safeParse(without)
    expect(result.success).toBe(false)
  })

  it("rejects missing externalId", () => {
    const { externalId: _externalId, ...without } = validInboxItem
    const result = InboxItemCreateSchema.safeParse(without)
    expect(result.success).toBe(false)
  })

  it("rejects missing messageId", () => {
    const { messageId: _messageId, ...without } = validInboxItem
    const result = InboxItemCreateSchema.safeParse(without)
    expect(result.success).toBe(false)
  })

  it("rejects externalId that does not match 'channelId:messageId' pattern", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      externalId: "12345",
    })
    expect(result.success).toBe(false)
  })

  it("rejects externalId without the negative channel prefix", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      externalId: "1009999999999:12345",
    })
    expect(result.success).toBe(false)
  })

  it("mediaUrls defaults to empty array when omitted", () => {
    const result = InboxItemCreateSchema.safeParse(validInboxItem)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.mediaUrls).toEqual([])
    }
  })

  it("accepts mediaUrls when provided", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      mediaUrls: ["https://r2.example.com/photo.jpg"],
    })
    expect(result.success).toBe(true)
  })

  it("rawText is optional", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      rawText: "Some raw text from Telegram",
    })
    expect(result.success).toBe(true)
  })

  it("sourceChannel is optional", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      sourceChannel: "Design Weekly",
    })
    expect(result.success).toBe(true)
  })

  it("forwardedFromId is optional", () => {
    const result = InboxItemCreateSchema.safeParse({
      ...validInboxItem,
      forwardedFromId: "-1001234567890",
    })
    expect(result.success).toBe(true)
  })
})
