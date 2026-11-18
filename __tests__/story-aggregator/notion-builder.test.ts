import { describe, it, expect } from "vitest"
import { DEFAULT_RUBRICS } from "@/lib/story-aggregator/schemas"
import {
  formatNotionTitle,
  buildNotionProperties,
  buildNotionBlocks,
  type StoryForNotion,
} from "@/lib/story-aggregator/notion-builder"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  rubrics: [DEFAULT_RUBRICS[0]],
  media: [{ url: "https://r2.example.com/thumbnails/design-system.jpg", kind: "image" }],
  archiveLinks: [
    {
      title: "Typography fundamentals",
      url: "https://archive.example.com/issue/42/typography",
      issueNumber: 42,
    },
    {
      title: "Design systems overview",
      url: "https://archive.example.com/issue/100/design-systems",
      issueNumber: 100,
    },
  ],
}

const storyNoMedia: StoryForNotion = {
  ...baseStory,
  media: [],
}

const storyNoArchiveLinks: StoryForNotion = {
  ...baseStory,
  archiveLinks: null,
}

const storyEmptyArchiveLinks: StoryForNotion = {
  ...baseStory,
  archiveLinks: [],
}

const storyRU: StoryForNotion = {
  ...baseStory,
  languageFlag: "RU",
  title: "Типографика для дизайнеров",
}

const storyNoFlag: StoryForNotion = {
  ...baseStory,
  languageFlag: null,
}

// ---------------------------------------------------------------------------
// 1. formatNotionTitle() — spec section 4.6, Title property
// ---------------------------------------------------------------------------

describe("formatNotionTitle", () => {
  it("returns title as-is regardless of languageFlag", () => {
    expect(formatNotionTitle("Design System Needs an Enforcer", "GB")).toBe("Design System Needs an Enforcer")
    expect(formatNotionTitle("Типографика для дизайнеров", "RU")).toBe("Типографика для дизайнеров")
    expect(formatNotionTitle("Design System Needs an Enforcer", null)).toBe("Design System Needs an Enforcer")
    expect(formatNotionTitle("", "GB")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// 2. buildNotionProperties() — spec section 4.6, database properties
// ---------------------------------------------------------------------------

describe("buildNotionProperties", () => {
  it("sets Name property as title type with plain title (no flags)", () => {
    const props = buildNotionProperties(baseStory, "https://example.com") as any
    expect(props).toHaveProperty("Name")
    expect(props.Name.title).toBeDefined()
    expect(Array.isArray(props.Name.title)).toBe(true)
    const content = props.Name.title[0]?.text?.content as string
    expect(content).toBe("Design System Needs an Enforcer")
  })

  it("sets Ссылка property as url type with the provided sourceUrl", () => {
    const sourceUrl = "https://nngroup.com/articles/design-system-enforcement"
    const props = buildNotionProperties(baseStory, sourceUrl) as any
    expect(props).toHaveProperty("Ссылка")
    expect(props.Ссылка.url).toBe(sourceUrl)
  })

  it("does not set Статус property", () => {
    const props = buildNotionProperties(baseStory, null) as any
    expect(props).not.toHaveProperty("Статус")
  })

  it("sets Рубрика property as multi_select from story rubrics", () => {
    const props = buildNotionProperties(baseStory, null) as any
    expect(props).toHaveProperty("Рубрика")
    expect(Array.isArray(props.Рубрика.multi_select)).toBe(true)
    expect(props.Рубрика.multi_select).toContainEqual({ name: DEFAULT_RUBRICS[0] })
  })

  it("sets 'AI summary' property as rich_text with story summary", () => {
    const props = buildNotionProperties(baseStory, null) as any
    expect(props).toHaveProperty("AI summary")
    const richText = props["AI summary"].rich_text
    expect(Array.isArray(richText)).toBe(true)
    const text = richText[0]?.text?.content as string
    expect(text).toBe(baseStory.summary)
  })

  it("sets Ссылка as null url when sourceUrl is null", () => {
    const props = buildNotionProperties(baseStory, null) as any
    expect(props).toHaveProperty("Ссылка")
    expect(props.Ссылка.url).toBeNull()
  })

  it("filters out unknown rubrics — only known Notion options are written (spec: rubric validation)", () => {
    const storyWithUnknownRubric: StoryForNotion = {
      ...baseStory,
      rubrics: [DEFAULT_RUBRICS[0], "UnknownAIHallucination"],
    }
    const props = buildNotionProperties(storyWithUnknownRubric, null) as any
    const names = props.Рубрика.multi_select.map((r: any) => r.name)
    expect(names).toContain(DEFAULT_RUBRICS[0])
    expect(names).not.toContain("UnknownAIHallucination")
  })
})

// ---------------------------------------------------------------------------
// 3. buildNotionBlocks() — spec section 4.6, page content blocks
// ---------------------------------------------------------------------------

describe("buildNotionBlocks", () => {
  it("AC-3: first block is the cover image block when media has an image", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    expect(blocks[0]).toMatchObject({
      type: "image",
      image: { type: "external", external: { url: "https://r2.example.com/thumbnails/design-system.jpg" } },
    })
    // A single image is only the cover: nothing trails the archive section.
    expect(blocks[blocks.length - 1].type).toBe("bulleted_list_item")
  })

  it("AC-3: no media → no image block and no trailing media divider", () => {
    const blocks = buildNotionBlocks(storyNoMedia) as any[]
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(0)
    expect(blocks[0].type).toBe("heading_2")
    // body | key points | archive — three section dividers, none for media
    expect(blocks.filter((b) => b.type === "divider")).toHaveLength(3)
    expect(blocks[blocks.length - 1].type).toBe("bulleted_list_item")
  })

  it("contains a heading_2 block with the story title", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const headings = blocks.filter((b) => b.type === "heading_2")
    expect(headings.length).toBeGreaterThan(0)
    const headingText = headings[0].heading_2.rich_text
      .map((r: any) => r.text?.content ?? "")
      .join("")
    expect(headingText).toContain("Design System Needs an Enforcer")
  })

  it("contains at least one paragraph block for the body text", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const paragraphs = blocks.filter((b) => b.type === "paragraph")
    expect(paragraphs.length).toBeGreaterThan(0)
  })

  it("contains divider blocks to separate sections", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const dividers = blocks.filter((b) => b.type === "divider")
    expect(dividers.length).toBeGreaterThan(0)
  })

  it("contains a heading_3 block with text 'Главные мысли'", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const keyPointsHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Главные мысли")
    })
    expect(keyPointsHeading).toBeDefined()
  })

  it("contains bulleted_list_item blocks for each key point", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const bullets = blocks.filter((b) => b.type === "bulleted_list_item")
    // At least one bullet per key point
    expect(bullets.length).toBeGreaterThanOrEqual(baseStory.keyPoints.length)
  })

  it("contains a heading_3 block with text 'Источники'", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const sourcesHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Источники")
    })
    expect(sourcesHeading).toBeDefined()
  })

  it("contains bookmark blocks for each sourceUrl", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const bookmarks = blocks.filter((b) => b.type === "bookmark")
    expect(bookmarks.length).toBe(baseStory.sourceUrls.length)
    expect(bookmarks[0].bookmark.url).toBe(baseStory.sourceUrls[0])
  })

  it("contains a heading_3 'Из архива' section when archiveLinks are present", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const archiveHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Из архива")
    })
    expect(archiveHeading).toBeDefined()
  })

  it("does not include 'Из архива' section when archiveLinks is null", () => {
    const blocks = buildNotionBlocks(storyNoArchiveLinks) as any[]
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const archiveHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Из архива")
    })
    expect(archiveHeading).toBeUndefined()
  })

  it("does not include 'Из архива' section when archiveLinks is an empty array", () => {
    const blocks = buildNotionBlocks(storyEmptyArchiveLinks) as any[]
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const archiveHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Из архива")
    })
    expect(archiveHeading).toBeUndefined()
  })

  it("contains bulleted_list_item blocks with links for each archive material", () => {
    const blocks = buildNotionBlocks(baseStory) as any[]
    const bullets = blocks.filter((b) => b.type === "bulleted_list_item")
    // Bullets include keyPoints AND archive links
    const archiveLinkBullets = bullets.filter((b) => {
      const richText = b.bulleted_list_item.rich_text as any[]
      return richText.some(
        (r) => r.text?.link?.url !== undefined && r.text.link.url.includes("archive.example.com")
      )
    })
    expect(archiveLinkBullets.length).toBe(baseStory.archiveLinks!.length)
  })

  it("handles empty keyPoints array — no keyPoint bullet items but section heading still present", () => {
    const storyNoKeyPoints: StoryForNotion = {
      ...baseStory,
      keyPoints: [],
    }
    const blocks = buildNotionBlocks(storyNoKeyPoints) as any[]
    // "Главные мысли" heading must still be present
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const keyPointsHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Главные мысли")
    })
    expect(keyPointsHeading).toBeDefined()
    // Key-point bullets = 0 (archive bullets are separate)
    const allBullets = blocks.filter((b) => b.type === "bulleted_list_item")
    // Only archive bullets should remain (2 from baseStory)
    const keyPointBullets = allBullets.filter((b) => {
      const richText = b.bulleted_list_item.rich_text as any[]
      return richText.every(
        (r) => !r.text?.link?.url?.includes("archive.example.com")
      )
    })
    expect(keyPointBullets.length).toBe(0)
  })

  it("handles empty sourceUrls array — no bookmark blocks but 'Источники' section still present", () => {
    const storyNoSources: StoryForNotion = {
      ...baseStory,
      sourceUrls: [],
    }
    const blocks = buildNotionBlocks(storyNoSources) as any[]
    const bookmarks = blocks.filter((b) => b.type === "bookmark")
    expect(bookmarks.length).toBe(0)
    const headings3 = blocks.filter((b) => b.type === "heading_3")
    const sourcesHeading = headings3.find((h) => {
      const text = h.heading_3.rich_text
        .map((r: any) => r.text?.content ?? "")
        .join("")
      return text.includes("Источники")
    })
    expect(sourcesHeading).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 4. buildNotionBlocks() — media: {url, kind}[] (RAD-401 AC-3, ERR-1)
//    Rewritten from the old thumbnailUrl/mediaUrls contract (cap 10, video → bookmark).
// ---------------------------------------------------------------------------

const img = (url: string) => ({ type: "image", image: { type: "external", external: { url } } })
const vid = (url: string) => ({ type: "video", video: { type: "external", external: { url } } })

describe("buildNotionBlocks — media (cover first, rest at the bottom)", () => {
  it("AC-3: two images → cover at index 0, second image is the last block after a divider", () => {
    const story: StoryForNotion = {
      ...baseStory,
      media: [
        { url: "https://r2.example.com/photo1.jpg", kind: "image" },
        { url: "https://r2.example.com/photo2.png", kind: "image" },
      ],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks[0]).toMatchObject(img("https://r2.example.com/photo1.jpg"))
    expect(blocks.slice(-2)).toMatchObject([{ type: "divider" }, img("https://r2.example.com/photo2.png")])
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2)
  })

  it("AC-3: a video is a video block at the bottom, never a bookmark", () => {
    const story: StoryForNotion = {
      ...baseStory,
      media: [
        { url: "https://r2.example.com/cover.jpg", kind: "image" },
        { url: "https://r2.example.com/video.mp4", kind: "video" },
      ],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks.slice(-2)).toMatchObject([{ type: "divider" }, vid("https://r2.example.com/video.mp4")])
    const bookmarkUrls = blocks.filter((b) => b.type === "bookmark").map((b) => b.bookmark.url)
    expect(bookmarkUrls).toEqual(baseStory.sourceUrls)
  })

  it("AC-3: media with only a video → no cover (heading_2 first), the video sits at the bottom", () => {
    const story: StoryForNotion = {
      ...baseStory,
      media: [{ url: "https://r2.example.com/only.mp4", kind: "video" }],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks[0].type).toBe("heading_2")
    expect(blocks.slice(-2)).toMatchObject([{ type: "divider" }, vid("https://r2.example.com/only.mp4")])
  })

  it("AC-3: the cover is the first IMAGE entry even when a video precedes it; the rest keep their order", () => {
    const story: StoryForNotion = {
      ...baseStory,
      media: [
        { url: "https://r2.example.com/intro.mp4", kind: "video" },
        { url: "https://r2.example.com/photo.jpg", kind: "image" },
        { url: "https://r2.example.com/photo2.jpg", kind: "image" },
      ],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks[0]).toMatchObject(img("https://r2.example.com/photo.jpg"))
    expect(blocks.slice(-3)).toMatchObject([
      { type: "divider" },
      vid("https://r2.example.com/intro.mp4"),
      img("https://r2.example.com/photo2.jpg"),
    ])
  })

  it("AC-3: no cap — 15 images become 15 image blocks in order", () => {
    const urls = Array.from({ length: 15 }, (_, i) => `https://r2.example.com/photo${i + 1}.jpg`)
    const story: StoryForNotion = {
      ...baseStory,
      media: urls.map((url) => ({ url, kind: "image" as const })),
    }
    const blocks = buildNotionBlocks(story) as any[]
    const imageUrls = blocks.filter((b) => b.type === "image").map((b) => b.image.external.url)
    expect(imageUrls).toEqual(urls)
    expect(blocks[0]).toMatchObject(img(urls[0]))
    expect(blocks.slice(-15)).toMatchObject([{ type: "divider" }, ...urls.slice(1).map(img)])
  })

  it("ERR-1: a media entry whose url is > 2000 chars is skipped, the others stay", () => {
    const longUrl = "https://r2.example.com/" + "a".repeat(1980) + ".jpg"
    expect(longUrl.length).toBeGreaterThan(2000)
    const story: StoryForNotion = {
      ...baseStory,
      media: [
        { url: "https://r2.example.com/valid.jpg", kind: "image" },
        { url: longUrl, kind: "image" },
        { url: "https://r2.example.com/other.jpg", kind: "image" },
      ],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks[0]).toMatchObject(img("https://r2.example.com/valid.jpg"))
    expect(blocks.slice(-2)).toMatchObject([{ type: "divider" }, img("https://r2.example.com/other.jpg")])
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2)
  })

  it("AC-3: mixed media → images as image blocks, videos as video blocks, in entry order", () => {
    const story: StoryForNotion = {
      ...baseStory,
      media: [
        { url: "https://r2.example.com/photo1.jpg", kind: "image" },
        { url: "https://r2.example.com/clip.mp4", kind: "video" },
        { url: "https://r2.example.com/photo2.webp", kind: "image" },
        { url: "https://r2.example.com/screen.webm", kind: "video" },
      ],
    }
    const blocks = buildNotionBlocks(story) as any[]
    expect(blocks[0]).toMatchObject(img("https://r2.example.com/photo1.jpg"))
    expect(blocks.slice(-4)).toMatchObject([
      { type: "divider" },
      vid("https://r2.example.com/clip.mp4"),
      img("https://r2.example.com/photo2.webp"),
      vid("https://r2.example.com/screen.webm"),
    ])
    expect(blocks.filter((b) => b.type === "bookmark")).toHaveLength(baseStory.sourceUrls.length)
  })
})
