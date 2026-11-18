/**
 * Notion Page Builder for Story Aggregator
 * Builds properties and content blocks for the "Digest Inbox" Notion database.
 * Spec: the Story Aggregator specification, section 4.6
 */

import { validateRubrics } from "@/lib/story-aggregator/schemas"
import { notionMediaSections, type NotionMediaEntry } from "@/lib/notion-media"

export interface StoryForNotion {
  title: string
  languageFlag: string | null // "GB" or "RU"
  summary: string
  body: string
  keyPoints: string[]
  sourceUrls: string[]
  rubrics: string[]
  archiveLinks: { title: string; url: string; issueNumber?: number }[] | null
  /** Every member post's and inbox item's media, classified (`storyDetailMedia`). */
  media: NotionMediaEntry[]
}

/**
 * Format title for Notion page.
 * Returns the title as-is (language flags removed by design decision).
 */
export function formatNotionTitle(
  title: string,
  _languageFlag: string | null
): string {
  return title
}

/**
 * Build Notion database page properties for a story.
 * Sets Name, Ссылка, Рубрика, and "AI summary" properties.
 */
export function buildNotionProperties(
  story: StoryForNotion,
  sourceUrl: string | null
): Record<string, unknown> {
  const validRubrics = validateRubrics(story.rubrics)

  return {
    Name: {
      title: [
        {
          text: {
            content: formatNotionTitle(story.title, story.languageFlag),
          },
        },
      ],
    },
    Ссылка: {
      url: sourceUrl,
    },
    Рубрика: {
      multi_select: validRubrics.map((name) => ({ name })),
    },
    "AI summary": {
      rich_text: [
        {
          text: {
            content: story.summary,
          },
        },
      ],
    },
  }
}

/**
 * Build Notion page content blocks for a story.
 * Structure: [cover image?] heading_2 paragraph(s) divider heading_3("Главные мысли")
 * bulleted_list_item(s) divider heading_3("Источники") bookmark(s)
 * divider? heading_3("Из архива")? bulleted_list_item(s)?
 * divider? media block(s)?
 */
export function buildNotionBlocks(story: StoryForNotion): unknown[] {
  const blocks: unknown[] = []

  // Cover = the first image Notion accepts; everything else goes to the bottom.
  // Uncapped: the page is the story's archive copy, not a card.
  const { cover, rest } = notionMediaSections(story.media)
  if (cover) blocks.push(cover)

  // Heading 2 with story title
  blocks.push({
    type: "heading_2",
    heading_2: {
      rich_text: [
        {
          type: "text",
          text: {
            content: story.title,
          },
        },
      ],
    },
  })

  // Paragraph blocks for body (split on double newlines or keep as one)
  const bodyParagraphs = story.body.split(/\n\n+/)
  for (const para of bodyParagraphs) {
    if (para.trim()) {
      blocks.push({
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: para.trim(),
              },
            },
          ],
        },
      })
    }
  }

  // Divider
  blocks.push({ type: "divider", divider: {} })

  // Heading 3: Главные мысли
  blocks.push({
    type: "heading_3",
    heading_3: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Главные мысли",
          },
        },
      ],
    },
  })

  // Bullet items for key points
  for (const point of story.keyPoints) {
    blocks.push({
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [
          {
            type: "text",
            text: {
              content: point,
            },
          },
        ],
      },
    })
  }

  // Divider
  blocks.push({ type: "divider", divider: {} })

  // Heading 3: Источники
  blocks.push({
    type: "heading_3",
    heading_3: {
      rich_text: [
        {
          type: "text",
          text: {
            content: "Источники",
          },
        },
      ],
    },
  })

  // Bookmark blocks for each source URL
  for (const url of story.sourceUrls) {
    blocks.push({
      type: "bookmark",
      bookmark: {
        url,
      },
    })
  }

  // Conditional: archive links section
  const archiveLinks = story.archiveLinks
  if (archiveLinks && archiveLinks.length > 0) {
    // Divider before the section
    blocks.push({ type: "divider", divider: {} })

    // Heading 3: Из архива
    blocks.push({
      type: "heading_3",
      heading_3: {
        rich_text: [
          {
            type: "text",
            text: {
              content: "Из архива",
            },
          },
        ],
      },
    })

    // Bullet items with links for each archive material
    for (const link of archiveLinks) {
      blocks.push({
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [
            {
              type: "text",
              text: {
                content: link.title,
                link: {
                  url: link.url,
                },
              },
            },
          ],
        },
      })
    }
  }

  // Remaining media at the bottom
  if (rest.length > 0) {
    blocks.push({ type: "divider", divider: {} })
    blocks.push(...rest)
  }

  return blocks
}
