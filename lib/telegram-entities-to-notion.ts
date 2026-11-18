/**
 * Convert Telegram message entities to Notion rich text format
 * Focused on preserving embedded links (MessageEntityTextUrl)
 */

interface TelegramEntity {
  className: string
  offset: number
  length: number
  url?: string
}

interface NotionRichTextSegment {
  type: "text"
  text: {
    content: string
    link?: { url: string }
  }
}

/**
 * Convert Telegram entities to Notion rich_text array
 * Splits text into segments with proper formatting
 */
export function convertTelegramEntitiesToNotionRichText(
  text: string,
  entities: any[]
): NotionRichTextSegment[] {
  if (!text) return []
  if (!entities || entities.length === 0) {
    // No entities - return plain text
    return [{ type: "text", text: { content: text } }]
  }

  // Filter only TextUrl and Url entities (embedded links)
  const linkEntities = entities.filter(
    (e) =>
      e.className === "MessageEntityTextUrl" || e.className === "MessageEntityUrl"
  )

  if (linkEntities.length === 0) {
    // No links - return plain text
    return [{ type: "text", text: { content: text } }]
  }

  // Sort entities by offset
  const sortedEntities = [...linkEntities].sort((a, b) => a.offset - b.offset)

  const segments: NotionRichTextSegment[] = []
  let currentPosition = 0

  for (const entity of sortedEntities) {
    const start = entity.offset
    const end = entity.offset + entity.length

    // Add text before the entity (if any)
    if (currentPosition < start) {
      const beforeText = text.substring(currentPosition, start)
      if (beforeText) {
        segments.push({ type: "text", text: { content: beforeText } })
      }
    }

    // Add the entity itself (with link)
    const entityText = text.substring(start, end)
    if (entityText) {
      if (entity.className === "MessageEntityTextUrl" && entity.url) {
        // Embedded link [text](url)
        segments.push({
          type: "text",
          text: {
            content: entityText,
            link: { url: entity.url },
          },
        })
      } else if (entity.className === "MessageEntityUrl") {
        // Auto-detected URL - make it clickable
        segments.push({
          type: "text",
          text: {
            content: entityText,
            link: { url: entityText },
          },
        })
      } else {
        // Shouldn't happen with our filter, but just in case
        segments.push({ type: "text", text: { content: entityText } })
      }
    }

    currentPosition = end
  }

  // Add remaining text after last entity
  if (currentPosition < text.length) {
    const remainingText = text.substring(currentPosition)
    if (remainingText) {
      segments.push({ type: "text", text: { content: remainingText } })
    }
  }

  return segments
}

/**
 * Split long text into chunks with preserved formatting
 * Notion has a 2000 character limit per rich_text array
 */
export function splitTextWithEntities(
  text: string,
  entities: any[],
  maxChunkSize: number = 1900
): Array<{ text: string; entities: any[] }> {
  if (text.length <= maxChunkSize) {
    return [{ text, entities: entities || [] }]
  }

  const chunks: Array<{ text: string; entities: any[] }> = []
  let currentPosition = 0

  while (currentPosition < text.length) {
    const chunkEnd = Math.min(currentPosition + maxChunkSize, text.length)
    const chunkText = text.substring(currentPosition, chunkEnd)

    // Filter entities that fall within this chunk and adjust their offsets
    const chunkEntities = (entities || [])
      .filter((e) => {
        const entityStart = e.offset
        const entityEnd = e.offset + e.length
        // Include entity if it overlaps with this chunk
        return entityEnd > currentPosition && entityStart < chunkEnd
      })
      .map((e) => {
        // Adjust offset relative to chunk start
        const adjustedOffset = Math.max(0, e.offset - currentPosition)
        const adjustedLength = Math.min(
          e.length,
          chunkEnd - Math.max(e.offset, currentPosition)
        )
        return {
          ...e,
          offset: adjustedOffset,
          length: adjustedLength,
        }
      })

    chunks.push({ text: chunkText, entities: chunkEntities })
    currentPosition = chunkEnd
  }

  return chunks
}
