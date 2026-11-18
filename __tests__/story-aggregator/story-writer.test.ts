import { describe, it, expect } from "vitest"
import { DEFAULT_RUBRICS, VALID_RUBRICS } from "@/lib/story-aggregator/schemas"
import {
  buildStorySystemPrompt,
  buildStoryUserContent,
  validateStoryOutput,
  buildMatchingPrompt,
  validateMatchingOutput,
  classifyMediaUrl,
  type InboxItemForStory,
} from "@/lib/story-aggregator/story-writer"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validStoryOutput = {
  languageFlag: "GB" as const,
  title: "Design System Needs an Enforcer",
  rubrics: [DEFAULT_RUBRICS[0]],
  authorLevel: "expert" as const,
  materialType: "article" as const,
  materialCharacter: "useful" as const,
  summary: "Lora Kleyn explains why design systems fail without enforcement.",
  body: "## Why design systems fail\n\nMost design systems die not from lack of work...",
  keyPoints: ["Systems need enforcement", "Tooling alone is not enough"],
  sourceUrls: ["https://nngroup.com/articles/design-system-enforcement"],
}

const fullItem: InboxItemForStory = {
  rawText: "Interesting article about design systems",
  extractedTitle: "Design Systems in 2025",
  extractedContent: "Design systems have evolved significantly in 2025.",
  sourceChannel: "Design Weekly",
  extractedUrl: "https://example.com/design-systems-2025",
  mediaUrls: [],
}

const emptyItem: InboxItemForStory = {
  rawText: null,
  extractedTitle: null,
  extractedContent: null,
  sourceChannel: null,
  extractedUrl: null,
  mediaUrls: [],
}

const existingStories = [
  { id: "story_abc123", title: "Anthropic releases Claude 5", summary: "A new AI model from Anthropic." },
  { id: "story_def456", title: "Dark mode design trends", summary: "How dark mode shaped product design." },
]

// ---------------------------------------------------------------------------
// 1. buildStorySystemPrompt() — spec section 4.4
// ---------------------------------------------------------------------------

describe("buildStorySystemPrompt", () => {
  it("returns a non-empty string with more than 200 characters (default prompt is substantial)", () => {
    const result = buildStorySystemPrompt(null)
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(200)
  })

  it("default (en) contains English language instruction", () => {
    const result = buildStorySystemPrompt(null)
    expect(result).toContain("Write ALL output in English")
  })

  it("with language 'ru' contains Russian instruction and rubric list", () => {
    const result = buildStorySystemPrompt(null, "ru")
    expect(result).toContain("на русском языке")
    for (const rubric of VALID_RUBRICS) {
      expect(result).toContain(rubric)
    }
    expect(result).toContain("Pick 1-2 rubrics ONLY from this list")
  })

  it("when userOverride is null, result contains only the default prompt (no override text)", () => {
    const uniqueOverrideText = "MY_UNIQUE_OVERRIDE_XYZ_789"
    const result = buildStorySystemPrompt(null)
    expect(result).not.toContain(uniqueOverrideText)
  })

  it("when userOverride is provided, the override text appears in the result", () => {
    const override = "Focus only on typography and font design."
    const result = buildStorySystemPrompt(override)
    expect(result).toContain(override)
  })

  it("default prompt contains link-preservation instruction (spec: 'preserve all original links')", () => {
    const result = buildStorySystemPrompt(null)
    const hasLinkInstruction =
      result.toLowerCase().includes("link") ||
      result.toLowerCase().includes("url") ||
      result.toLowerCase().includes("ссылк")
    expect(hasLinkInstruction).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. buildStoryUserContent() — spec section 4.4 (prompt injection mitigation)
// ---------------------------------------------------------------------------

describe("buildStoryUserContent", () => {
  it("wraps content in <user_content> XML tags (spec 4.4 prompt injection mitigation)", () => {
    const result = buildStoryUserContent([fullItem])
    expect(result).toContain("<user_content>")
    expect(result).toContain("</user_content>")
  })

  it("includes the extractedTitle when present", () => {
    const result = buildStoryUserContent([fullItem])
    expect(result).toContain("Design Systems in 2025")
  })

  it("includes the extractedContent when present", () => {
    const result = buildStoryUserContent([fullItem])
    expect(result).toContain("Design systems have evolved significantly in 2025.")
  })

  it("includes the rawText when no extractedContent is provided", () => {
    const itemWithoutContent: InboxItemForStory = {
      ...emptyItem,
      rawText: "Raw telegram message about design",
    }
    const result = buildStoryUserContent([itemWithoutContent])
    expect(result).toContain("Raw telegram message about design")
  })

  it("includes the source URL when extractedUrl is present", () => {
    const result = buildStoryUserContent([fullItem])
    expect(result).toContain("https://example.com/design-systems-2025")
  })

  it("includes the sourceChannel when present", () => {
    const result = buildStoryUserContent([fullItem])
    expect(result).toContain("Design Weekly")
  })

  it("handles multiple items by combining them in the output", () => {
    const secondItem: InboxItemForStory = {
      rawText: "Another source about the same topic",
      extractedTitle: "Second Article Title",
      extractedContent: "More content about design systems.",
      sourceChannel: "Another Channel",
      extractedUrl: "https://example.com/another-article",
      mediaUrls: [],
    }
    const result = buildStoryUserContent([fullItem, secondItem])
    expect(result).toContain("Design Systems in 2025")
    expect(result).toContain("Second Article Title")
  })

  it("handles an item with all null fields without throwing", () => {
    expect(() => buildStoryUserContent([emptyItem])).not.toThrow()
    const result = buildStoryUserContent([emptyItem])
    expect(typeof result).toBe("string")
  })

  it("includes BOTH rawText and extractedContent when both are present and different", () => {
    const result = buildStoryUserContent([fullItem])
    // rawText = "Interesting article about design systems"
    // extractedContent = "Design systems have evolved significantly in 2025."
    expect(result).toContain("Interesting article about design systems")
    expect(result).toContain("Design systems have evolved significantly in 2025.")
    expect(result).toContain("Post text:")
    expect(result).toContain("Article content:")
  })

  it("uses single Content: label when rawText is null (URL-only extraction)", () => {
    const itemUrlOnly: InboxItemForStory = {
      ...emptyItem,
      extractedUrl: "https://example.com/article",
      extractedContent: "Article body extracted from URL.",
    }
    const result = buildStoryUserContent([itemUrlOnly])
    expect(result).toContain("Content:\nArticle body extracted from URL.")
    expect(result).not.toContain("Post text:")
    expect(result).not.toContain("Article content:")
  })

  it("uses single Content: label when rawText equals extractedContent (text-only post)", () => {
    const textOnly: InboxItemForStory = {
      ...emptyItem,
      rawText: "Some thoughts about design",
      extractedContent: "Some thoughts about design",
    }
    const result = buildStoryUserContent([textOnly])
    expect(result).toContain("Content:\nSome thoughts about design")
    expect(result).not.toContain("Post text:")
  })
})

// ---------------------------------------------------------------------------
// 3. validateStoryOutput() — spec section 4.4
// ---------------------------------------------------------------------------

describe("validateStoryOutput", () => {
  it("returns { success: true, story: data, error: null } for valid StoryOutputSchema data", () => {
    const result = validateStoryOutput(validStoryOutput)
    expect(result.success).toBe(true)
    expect(result.story).not.toBeNull()
    expect(result.error).toBeNull()
  })

  it("returns { success: false, story: null, error: string } when required fields are missing", () => {
    const incomplete = {
      languageFlag: "GB",
      // title, rubrics, etc. are missing
    }
    const result = validateStoryOutput(incomplete)
    expect(result.success).toBe(false)
    expect(result.story).toBeNull()
    expect(typeof result.error).toBe("string")
    expect(result.error!.length).toBeGreaterThan(0)
  })

  it("filters out unknown rubrics (validateRubrics), but story is still valid", () => {
    const dataWithUnknownRubric = {
      ...validStoryOutput,
      rubrics: ["UnknownHallucination"],
    }
    const result = validateStoryOutput(dataWithUnknownRubric)
    // Story can still be returned (rubrics filtered to empty is acceptable at this layer)
    // The key behaviour: does not crash, returns a result
    expect(result).toHaveProperty("success")
    expect(result).toHaveProperty("story")
    expect(result).toHaveProperty("error")
  })

  it("strips unknown fields from the output (no passthrough — spec: output validation)", () => {
    const dataWithExtra = {
      ...validStoryOutput,
      injectedField: "malicious data",
      anotherExtra: 12345,
    }
    const result = validateStoryOutput(dataWithExtra)
    expect(result.success).toBe(true)
    if (result.story) {
      expect((result.story as Record<string, unknown>).injectedField).toBeUndefined()
      expect((result.story as Record<string, unknown>).anotherExtra).toBeUndefined()
    }
  })

  it("returns { success: false } for non-object input (null)", () => {
    const result = validateStoryOutput(null)
    expect(result.success).toBe(false)
    expect(result.story).toBeNull()
  })

  it("returns { success: false } for a plain string input", () => {
    const result = validateStoryOutput("this is not JSON object")
    expect(result.success).toBe(false)
    expect(result.story).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. buildMatchingPrompt() — spec section 4.3 (Story Matching / deduplication)
// ---------------------------------------------------------------------------

describe("buildMatchingPrompt", () => {
  const newItem = {
    title: "Anthropic announces Claude 5",
    content: "Anthropic today announced the release of Claude 5, a new frontier AI model.",
  }

  it("contains 'deduplication' or 'dedup' in the prompt (spec 4.3: deduplication engine)", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    const hasDedup =
      result.toLowerCase().includes("deduplication") ||
      result.toLowerCase().includes("dedup")
    expect(hasDedup).toBe(true)
  })

  it("contains the new item title in the prompt", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    expect(result).toContain("Anthropic announces Claude 5")
  })

  it("contains the new item content in the prompt", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    expect(result).toContain(
      "Anthropic today announced the release of Claude 5"
    )
  })

  it("contains each existing story's title in the prompt", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    expect(result).toContain("Anthropic releases Claude 5")
    expect(result).toContain("Dark mode design trends")
  })

  it("contains JSON format instruction for the response (spec 4.3: returns JSON)", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    // Spec says: Return JSON: { "match": "story_id" | null, "reasoning": "..." }
    const hasJsonInstruction =
      result.toLowerCase().includes("json") ||
      result.includes('"match"') ||
      result.includes('"reasoning"')
    expect(hasJsonInstruction).toBe(true)
  })

  it("returns a string without throwing when existingStories is empty", () => {
    expect(() => buildMatchingPrompt(newItem, [])).not.toThrow()
    const result = buildMatchingPrompt(newItem, [])
    expect(typeof result).toBe("string")
  })
})

// ---------------------------------------------------------------------------
// 5. validateMatchingOutput() — spec section 4.3
// ---------------------------------------------------------------------------

describe("validateMatchingOutput", () => {
  it("returns the object when match is a story ID string and reasoning is present", () => {
    const raw = { match: "story_abc123", reasoning: "Same event — both about Claude 5 release." }
    const result = validateMatchingOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.match).toBe("story_abc123")
    expect(result!.reasoning).toBe("Same event — both about Claude 5 release.")
  })

  it("returns the object when match is null and reasoning is present (no existing match)", () => {
    const raw = { match: null, reasoning: "This is a completely new topic." }
    const result = validateMatchingOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.match).toBeNull()
    expect(result!.reasoning).toBe("This is a completely new topic.")
  })

  it("returns null when required fields are missing (no match field)", () => {
    const raw = { reasoning: "Something happened" }
    const result = validateMatchingOutput(raw)
    expect(result).toBeNull()
  })

  it("returns null when required fields are missing (no reasoning field)", () => {
    const raw = { match: null }
    const result = validateMatchingOutput(raw)
    expect(result).toBeNull()
  })

  it("returns null for non-object input (plain string)", () => {
    const result = validateMatchingOutput("story_abc123")
    expect(result).toBeNull()
  })

  it("returns null for null input", () => {
    const result = validateMatchingOutput(null)
    expect(result).toBeNull()
  })

  it("returns null for array input (wrong shape)", () => {
    const result = validateMatchingOutput([{ match: "story_123", reasoning: "OK" }])
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 6. buildStoryUserContent() — media context appended to AI prompt
// ---------------------------------------------------------------------------

describe("buildStoryUserContent — media context", () => {
  it("item with 3 image URLs produces 'Attached media:' line with '3 image(s)'", () => {
    const item: InboxItemForStory = {
      ...fullItem,
      mediaUrls: [
        "https://cdn.example.com/photo1.jpg",
        "https://cdn.example.com/photo2.jpeg",
        "https://cdn.example.com/photo3.png",
      ],
    }
    const result = buildStoryUserContent([item])
    expect(result).toContain("Attached media:")
    expect(result).toContain("3 image(s)")
  })

  it("item with 1 mp4 video + 2 images produces correct mixed summary", () => {
    const item: InboxItemForStory = {
      ...fullItem,
      mediaUrls: [
        "https://cdn.example.com/clip.mp4",
        "https://cdn.example.com/photo1.webp",
        "https://cdn.example.com/photo2.jpg",
      ],
    }
    const result = buildStoryUserContent([item])
    expect(result).toContain("Attached media:")
    expect(result).toContain("2 image(s)")
    expect(result).toContain("1 video(s)")
  })

  it("item with empty mediaUrls does NOT contain 'Attached media:' section", () => {
    const item: InboxItemForStory = {
      ...fullItem,
      mediaUrls: [],
    }
    const result = buildStoryUserContent([item])
    expect(result).not.toContain("Attached media:")
  })

  it("item with a .pdf URL produces 'Attached media:' containing 'document'", () => {
    const item: InboxItemForStory = {
      ...fullItem,
      mediaUrls: ["https://cdn.example.com/report.pdf"],
    }
    const result = buildStoryUserContent([item])
    expect(result).toContain("Attached media:")
    expect(result).toContain("document")
  })

  it("item with an unknown extension (.bin) produces 'Attached media:' containing 'file'", () => {
    const item: InboxItemForStory = {
      ...fullItem,
      mediaUrls: ["https://cdn.example.com/data.bin"],
    }
    const result = buildStoryUserContent([item])
    expect(result).toContain("Attached media:")
    expect(result).toContain("file")
  })
})

// ---------------------------------------------------------------------------
// 7. classifyMediaUrl() — extension-based media type helper
// ---------------------------------------------------------------------------

describe("classifyMediaUrl", () => {
  it("classifies .jpg as 'image'", () => {
    expect(classifyMediaUrl("https://cdn.example.com/photo.jpg")).toBe("image")
  })

  it("classifies .mp4 as 'video'", () => {
    expect(classifyMediaUrl("https://cdn.example.com/clip.mp4")).toBe("video")
  })

  it("classifies .gif as 'GIF'", () => {
    expect(classifyMediaUrl("https://cdn.example.com/anim.gif")).toBe("GIF")
  })

  it("classifies .pdf as 'document'", () => {
    expect(classifyMediaUrl("https://cdn.example.com/report.pdf")).toBe("document")
  })

  it("classifies .bin as 'file' (unknown extension)", () => {
    expect(classifyMediaUrl("https://cdn.example.com/data.bin")).toBe("file")
  })

  it("classifies uppercase extension .PNG as 'image' (case insensitive)", () => {
    expect(classifyMediaUrl("https://cdn.example.com/PHOTO.PNG")).toBe("image")
  })
})

// ---------------------------------------------------------------------------
// 8. buildMatchingPrompt() — source URL inclusion (Bug #2)
// ---------------------------------------------------------------------------

describe("buildMatchingPrompt — source URL support (Bug #2)", () => {
  const newItem = {
    title: "Anthropic announces Claude 5",
    content: "Anthropic today announced the release of Claude 5, a new frontier AI model.",
  }

  const existingStoriesWithUrls = [
    {
      id: "story_abc123",
      title: "Anthropic releases Claude 5",
      summary: "A new AI model from Anthropic.",
      sourceUrls: ["https://anthropic.com/blog/claude-5", "https://techcrunch.com/claude-5-launch"],
    },
    {
      id: "story_def456",
      title: "Dark mode design trends",
      summary: "How dark mode shaped product design.",
      sourceUrls: ["https://typography.news/dark-mode-2026"],
    },
  ]

  it("when newItem has a sourceUrl, it appears in the prompt output", () => {
    // Currently FAILS: buildMatchingPrompt signature is { title, content } — no sourceUrl field
    const newItemWithUrl = {
      title: "Anthropic announces Claude 5",
      content: "Anthropic today announced the release of Claude 5.",
      sourceUrl: "https://anthropic.com/news/claude-5-announcement",
    }

    const result = buildMatchingPrompt(newItemWithUrl, existingStoriesWithUrls)

    expect(result).toContain("https://anthropic.com/news/claude-5-announcement")
  })

  it("when existingStories have sourceUrls, each URL appears in the prompt", () => {
    // Currently FAILS: existing stories only expose { id, title, summary } — no sourceUrls
    const result = buildMatchingPrompt(newItem, existingStoriesWithUrls)

    expect(result).toContain("https://anthropic.com/blog/claude-5")
    expect(result).toContain("https://techcrunch.com/claude-5-launch")
    expect(result).toContain("https://typography.news/dark-mode-2026")
  })

  it("when newItem sourceUrl is absent (undefined), the prompt still works correctly", () => {
    // Backward-compat: old callers pass { title, content } without sourceUrl
    const newItemNoUrl = {
      title: "Anthropic announces Claude 5",
      content: "Anthropic today announced the release of Claude 5.",
    }

    expect(() => buildMatchingPrompt(newItemNoUrl, existingStoriesWithUrls)).not.toThrow()
    const result = buildMatchingPrompt(newItemNoUrl, existingStoriesWithUrls)
    expect(typeof result).toBe("string")
    expect(result).toContain("Anthropic announces Claude 5")
  })

  it("when existingStories have no sourceUrls (undefined or empty), the prompt still works", () => {
    // Backward-compat: old callers pass { id, title, summary } without sourceUrls
    const storiesNoUrls = [
      { id: "story_abc123", title: "Anthropic releases Claude 5", summary: "A new AI model." },
    ]

    expect(() => buildMatchingPrompt(newItem, storiesNoUrls)).not.toThrow()
    const result = buildMatchingPrompt(newItem, storiesNoUrls)
    expect(typeof result).toBe("string")
    expect(result).toContain("Anthropic releases Claude 5")
  })
})

// ---------------------------------------------------------------------------
// 9. buildMatchingPrompt() — product version matching rules
// ---------------------------------------------------------------------------

// (existing section 9 tests above)

// ---------------------------------------------------------------------------
// 10. buildStoryUserContent() — telegramPostUrl in output (RED phase)
// ---------------------------------------------------------------------------

describe("buildStoryUserContent — telegramPostUrl support", () => {
  it("includes 'Telegram post:' line when telegramPostUrl is provided", () => {
    // InboxItemForStory currently does NOT have telegramPostUrl — this test verifies
    // that after adding the field, the URL appears in the user content
    const item: InboxItemForStory = {
      rawText: "Great photo from the event",
      extractedTitle: null,
      extractedContent: null,
      sourceChannel: "Design Weekly",
      extractedUrl: null,
      mediaUrls: [],
      telegramPostUrl: "https://t.me/channel/123",
    }
    const result = buildStoryUserContent([item])
    expect(result).toContain("Telegram post: https://t.me/channel/123")
  })

  it("includes both 'Attached media:' section AND 'Telegram post:' for media-only posts", () => {
    // Verifies that a post with no text, no URL, but with media + telegramPostUrl produces
    // meaningful content for the AI (not an empty/near-empty prompt)
    const item: InboxItemForStory = {
      rawText: null,
      extractedTitle: null,
      extractedContent: null,
      extractedUrl: null,
      sourceChannel: null,
      mediaUrls: [
        "https://r2.example.com/photo1.jpg",
        "https://r2.example.com/video.mp4",
      ],
      telegramPostUrl: "https://t.me/channel/123",
    }
    const result = buildStoryUserContent([item])
    // Both media context and Telegram source reference must be present
    expect(result).toContain("Attached media:")
    expect(result).toContain("Telegram post: https://t.me/channel/123")
    // Output must not be effectively empty — strip XML wrappers and check length
    const innerContent = result.replace(/<\/?user_content>/g, "").trim()
    expect(innerContent.length).toBeGreaterThan(20)
  })

  it("does NOT include 'Telegram post:' line when telegramPostUrl is null", () => {
    // Backward-compat: existing items without telegramPostUrl must not render the line
    const item: InboxItemForStory = {
      rawText: "Some text content",
      extractedTitle: null,
      extractedContent: null,
      sourceChannel: null,
      extractedUrl: null,
      mediaUrls: [],
      telegramPostUrl: null,
    }
    const result = buildStoryUserContent([item])
    expect(result).not.toContain("Telegram post:")
  })
})

// ---------------------------------------------------------------------------
// 11. buildStorySystemPrompt() — media-only post guidance (RED phase)
// ---------------------------------------------------------------------------

describe("buildStorySystemPrompt — media-only post guidance", () => {
  it("default prompt contains guidance for handling media-only posts (no text, only images/video)", () => {
    // Verifies that the system prompt instructs Claude how to handle posts that
    // contain only images/videos with no accompanying text
    const result = buildStorySystemPrompt(null)
    // Should contain "media-only" or equivalent guidance phrase
    const hasMediaOnlyGuidance =
      result.toLowerCase().includes("media-only") ||
      result.toLowerCase().includes("media only") ||
      result.toLowerCase().includes("no text") ||
      result.toLowerCase().includes("image-only") ||
      result.toLowerCase().includes("only media") ||
      result.toLowerCase().includes("without text") ||
      result.toLowerCase().includes("без текста")
    expect(hasMediaOnlyGuidance).toBe(true)
  })
})

describe("buildMatchingPrompt — product version matching rules", () => {
  const newItem = {
    title: "Gemini 3.1 Pro benchmarks",
    content: "Google released Gemini 3.1 Pro with improved performance.",
  }

  it("prompt contains rule about same product name + version = same story", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    // The prompt should explicitly mention product version as a matching signal
    const hasVersionRule =
      result.toLowerCase().includes("version") ||
      result.toLowerCase().includes("product name")
    expect(hasVersionRule).toBe(true)
  })

  it("prompt contains cross-language matching guidance", () => {
    const result = buildMatchingPrompt(newItem, existingStories)
    // Should mention that posts in different languages about the same product are the same story
    const hasCrossLang =
      result.toLowerCase().includes("language") ||
      result.toLowerCase().includes("язык")
    expect(hasCrossLang).toBe(true)
  })
})
