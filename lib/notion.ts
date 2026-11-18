import { Client } from "@notionhq/client"
import { db } from "./db"
import { openNotionToken } from "./notion-token"
import { TokenDecryptError, TokenKeyError } from "./token-crypto"
import { convertTelegramEntitiesToNotionRichText, splitTextWithEntities } from "./telegram-entities-to-notion"
import { postMediaEntries } from "./media-urls"
import { notionMediaSections } from "./notion-media"

/** Notion accepts at most 100 children per pages.create / blocks.children.append call. */
const NOTION_CHILDREN_MAX = 100

/**
 * Send a material to Notion database
 */
export async function sendMaterialToNotion(materialId: string, userId: string) {
  console.log("[Notion] Starting sendMaterialToNotion for materialId:", materialId, "userId:", userId)

  // Get user's Notion settings
  const userSettings = await db.userSettings.findUnique({
    where: { userId },
  })

  if (!userSettings) {
    throw new Error("User settings not found. Please configure Notion in Settings page.")
  }

  if (!userSettings.notionToken) {
    throw new Error("Notion token is not configured. Please add it in Settings.")
  }

  if (!userSettings.notionDatabaseId) {
    throw new Error("Notion database ID is not configured. Please add it in Settings.")
  }

  console.log("[Notion] Settings found, fetching material...")

  // Get material
  const material = await db.material.findUnique({
    where: { id: materialId },
    include: {
      feed: true,
    },
  })

  if (!material) {
    throw new Error("Material not found")
  }

  if (!material.feed) {
    throw new Error("Material source not found. Data integrity issue.")
  }

  console.log("[Notion] Material found:", {
    id: material.id,
    title: material.title,
    sourceId: material.sourceId,
    sourceName: material.feed.name,
    contentLength: material.content.length,
  })

  // Initialize Notion client with user's token
  // RAD-221: the stored value is sealed; open it for this user. The reason a
  // token does not open (env names, key ids) stays in the server log: the
  // posts route returns this message to the browser.
  let notionToken: string
  try {
    notionToken = openNotionToken(userSettings.notionToken, userId)
  } catch (error) {
    if (error instanceof TokenKeyError || error instanceof TokenDecryptError) {
      console.error("[Notion] Notion token unavailable:", error.message)
      throw new Error("The saved Notion token cannot be read. Save it again in Settings.")
    }
    throw error
  }
  const notion = new Client({ auth: notionToken })

  try {
    console.log("[Notion] Creating page in Notion database:", userSettings.notionDatabaseId)
    console.log("[Notion] Material data:", {
      title: material.title,
      url: material.url,
      source: material.feed.name,
      publishedAt: material.publishedAt,
    })

    // First, retrieve database to check available properties
    const database = await notion.databases.retrieve({
      database_id: userSettings.notionDatabaseId,
    })

    console.log("[Notion] Database retrieved:", {
      id: database.id,
      hasProperties: !!(database as any).properties,
      propertiesType: typeof (database as any).properties,
    })

    const dbProperties = (database as any).properties || {}
    console.log("[Notion] Database properties:", Object.keys(dbProperties))

    // Build properties dynamically based on what's available in the database
    const properties: any = {
      // Title property (required, always present)
      title: {
        title: [
          {
            text: {
              content: material.title,
            },
          },
        ],
      },
    }

    // Check and add optional properties if they exist in the database
    // dbProperties already defined above

    // Add Ссылка (URL) if property exists and is correct type
    if (dbProperties?.Ссылка?.type === "url") {
      properties.Ссылка = {
        url: material.url,
      }
    }

    console.log("[Notion] Properties to send:", Object.keys(properties))

    // Build children blocks with content: cover image, text, then the rest of
    // the post's media after a divider — the same layout as a story page.
    const children: any[] = []
    const media = notionMediaSections(postMediaEntries(material))
    if (media.cover) children.push(media.cover)

    // Check if material has Telegram entities (formatting)
    if (material.contentEntities && Array.isArray(material.contentEntities)) {
      console.log("[Notion] Material has entities, using formatted text")

      // Split content into chunks while preserving entities
      const chunks = splitTextWithEntities(
        material.content,
        material.contentEntities as any[],
        1900
      )

      // Convert each chunk to Notion rich_text format
      for (const chunk of chunks.slice(0, 5)) {
        const richText = convertTelegramEntitiesToNotionRichText(
          chunk.text,
          chunk.entities
        )

        children.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: richText,
          },
        })
      }
    } else {
      console.log("[Notion] Material has no entities, using plain text")

      // Add content in chunks (Notion has a 2000 character limit per block)
      // Using [\s\S] instead of . with 's' flag for ES5 compatibility
      const contentChunks = material.content.match(/[\s\S]{1,1900}/g) || []
      for (const chunk of contentChunks.slice(0, 5)) {
        // Limit to first 5 chunks
        children.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: {
                  content: chunk,
                },
              },
            ],
          },
        })
      }
    }

    if (media.rest.length > 0) {
      children.push({ type: "divider", divider: {} }, ...media.rest)
    }

    // Create page in Notion database
    const response = await notion.pages.create({
      parent: {
        database_id: userSettings.notionDatabaseId,
      },
      properties,
      children: children.slice(0, NOTION_CHILDREN_MAX),
    })

    console.log("[Notion] Page created successfully:", response.id)

    // An album can outgrow the per-request cap; the rest is appended in order.
    // The page already exists at this point, so a failed append must not turn
    // into a failed export: the user would retry and get a second page. Stop at
    // the first failure (a later batch would land out of order) and report the
    // page as truncated instead.
    let truncated = false
    for (let i = NOTION_CHILDREN_MAX; i < children.length; i += NOTION_CHILDREN_MAX) {
      try {
        await notion.blocks.children.append({
          block_id: response.id,
          children: children.slice(i, i + NOTION_CHILDREN_MAX),
        })
      } catch (appendError: any) {
        console.error("[Notion] Append failed, page left truncated:", {
          pageId: response.id,
          appended: i,
          total: children.length,
          code: appendError?.code,
          message: appendError?.message,
        })
        truncated = true
        break
      }
    }

    // Update material status
    await db.material.update({
      where: { id: materialId },
      data: {
        userStatus: "SENT_TO_NOTION",
      },
    })

    console.log("[Notion] Material status updated to SENT_TO_NOTION")

    return {
      success: true,
      notionPageId: response.id,
      notionUrl: (response as any).url || `https://notion.so/${response.id.replace(/-/g, "")}`,
      truncated,
    }
  } catch (error: any) {
    console.error("[Notion] Error sending to Notion:", {
      code: error.code,
      message: error.message,
      body: error.body,
      stack: error.stack,
    })

    // Check for common Notion API errors
    if (error.code === "object_not_found") {
      throw new Error("Notion database not found. Check your database ID.")
    } else if (error.code === "unauthorized") {
      throw new Error("Notion token is invalid or expired.")
    } else if (error.code === "validation_error") {
      throw new Error(
        `Notion validation error: ${error.message}. Check your database properties.`
      )
    }

    throw new Error(`Failed to send to Notion: ${error.message}`)
  }
}

/**
 * Test Notion connection
 */
export async function testNotionConnection(
  token: string,
  databaseId: string
) {
  const notion = new Client({ auth: token })

  try {
    const database = await notion.databases.retrieve({
      database_id: databaseId,
    })

    return {
      success: true,
      databaseName: (database as any).title?.[0]?.plain_text || "Unknown",
    }
  } catch (error: any) {
    if (error.code === "object_not_found") {
      throw new Error("Database not found")
    } else if (error.code === "unauthorized") {
      throw new Error("Invalid token")
    }

    throw new Error(`Connection failed: ${error.message}`)
  }
}
