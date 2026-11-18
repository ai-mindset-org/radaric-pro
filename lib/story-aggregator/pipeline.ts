/**
 * Pipeline Orchestrator for Story Aggregator
 * Connects all building blocks: extraction → AI writing → Notion save
 * Uses dependency injection for testability.
 *
 * Exported functions:
 *   processInboxItem(itemId, deps) — full pipeline, never throws
 *   extractAndSave(itemId, deps) — content extraction step
 *   generateAndSaveStory(itemId, deps) — AI generation step
 *   publishToNotion(storyId, deps) — Notion publish step
 *
 * Spec: the Story Aggregator specification, sections 4.1–4.6
 */

import type { ExtractedContent } from "./content-extractor"
import { buildStorySystemPrompt, buildStoryUserContent, validateStoryOutput } from "./story-writer"
import type { InboxItemForStory } from "./story-writer"
import { buildNotionProperties, buildNotionBlocks } from "./notion-builder"
import type { ArchiveLink } from "./archive-linker"
import type { StoryForNotion } from "./notion-builder"
import { mediaKindFromUrl, storyDetailMedia } from "@/lib/media-urls"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InboxItemRecord {
  id: string
  userId: string
  externalId: string
  messageId: number
  rawText: string | null
  extractedUrl: string | null
  extractedTitle: string | null
  extractedContent: string | null
  mediaUrls: string[]
  thumbnailUrl: string | null
  sourceChannel: string | null
  forwardedFromId: string | null
  telegramPostUrl: string | null
  allMessageIds?: number[]
  telegramDeletedAt?: Date | null
  status: string
  storyId: string | null
  retryCount: number
}

interface MaterialRecord {
  id: string
  title: string | null
  content: string | null
  url: string | null
  rawText: string | null
  thumbnailUrl?: string | null
  mediaUrls?: string[]
  feed?: { name?: string | null; type?: string } | null
}

interface StoryRecord {
  id: string
  userId: string
  title: string
  languageFlag: string | null
  summary: string
  body: string
  keyPoints: string[]
  sourceUrls: string[]
  rubrics: string[]
  archiveLinks: unknown
  notionPageId: string | null
  notionUrl: string | null
  status: string
  version: number
  inboxItems?: InboxItemRecord[]
  materials?: MaterialRecord[]
}

interface UserSettingsRecord {
  userId: string
  storySystemPrompt: string | null
  storyNotionDatabaseId: string | null
  storyInboxChannelId: string | null
  storyLastMessageId: number | null
  storyPromptVersion: number | null
  storyLanguage: string
}

export interface PipelineDeps {
  db: {
    inboxItem: {
      findUnique: (args: { where: { id: string } }) => Promise<InboxItemRecord | null>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
      updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>
    }
    story: {
      create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>
      findUnique: (args: { where: { id: string }; include?: Record<string, unknown> }) => Promise<StoryRecord | null>
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
    userSettings: {
      findUnique: (args: { where: { userId: string } }) => Promise<UserSettingsRecord | null>
      update: (args: { where: { userId: string }; data: Record<string, unknown> }) => Promise<unknown>
    }
    material?: {
      findMany: (args: Record<string, unknown>) => Promise<MaterialRecord[]>
    }
  }
  generateStory: (systemPrompt: string, userContent: string) => Promise<unknown>
  saveToNotion: (
    databaseId: string,
    properties: Record<string, unknown>,
    blocks: unknown[]
  ) => Promise<{ pageId: string; url: string }>
  updateNotionPage?: (
    pageId: string,
    properties: Record<string, unknown>,
    blocks: unknown[]
  ) => Promise<void>
  extractContent: {
    fromUrl: (url: string) => Promise<ExtractedContent>
    fromText: (rawText: string) => ExtractedContent
  }
  matchItem?: (
    itemId: string,
    userId: string,
    item: InboxItemRecord
  ) => Promise<{ match: string | null; isNew: boolean; reasoning: string }>
  findRelatedMaterials?: (
    storyTitle: string,
    storySummary: string
  ) => Promise<ArchiveLink[]>
}

export interface ProcessResult {
  success: boolean
  storyId?: string
  notionPageId?: string
  error?: string
}

// ---------------------------------------------------------------------------
// mergeSourceUrls
// ---------------------------------------------------------------------------

/**
 * Merge telegramPostUrls from inbox items into AI-generated sourceUrls.
 * Deduplicates and preserves order: AI URLs first, then Telegram URLs.
 */
export function mergeSourceUrls(
  aiSourceUrls: string[],
  telegramPostUrls: (string | null)[]
): string[] {
  const seen = new Set<string>(aiSourceUrls)
  const extra: string[] = []
  for (const url of telegramPostUrls) {
    if (url && !seen.has(url)) {
      seen.add(url)
      extra.push(url)
    }
  }
  return [...aiSourceUrls, ...extra]
}

// ---------------------------------------------------------------------------
// extractAndSave
// ---------------------------------------------------------------------------

/**
 * Extract content from a URL or raw text, update the InboxItem.
 * On error: sets status to ERROR with errorMessage and increments retryCount.
 * Never throws. Returns true on success, false on failure.
 */
export async function extractAndSave(
  itemId: string,
  deps: PipelineDeps
): Promise<boolean> {
  const item = await deps.db.inboxItem.findUnique({ where: { id: itemId } })
  if (!item) return false

  try {
    let extracted: ExtractedContent

    if (item.extractedUrl) {
      extracted = await deps.extractContent.fromUrl(item.extractedUrl)
    } else if (item.rawText) {
      extracted = deps.extractContent.fromText(item.rawText)
    } else if (item.mediaUrls && item.mediaUrls.length > 0) {
      // Media-only post: generate a synthetic description from media info.
      // A Telegram album carries more than photos — voice notes, files and
      // sticker packs arrive in the same list, so name every kind rather than
      // collapsing the unknown ones into "file".
      const counts: Record<string, number> = {}
      for (const url of item.mediaUrls) {
        const ext = /\.([a-z0-9]{2,5})(?=[?#]|$)/i.exec(url)?.[1]?.toLowerCase() ?? ""
        let type = "file"
        if (["jpg", "jpeg", "png"].includes(ext)) type = "image"
        else if (["mp4", "webm", "mov"].includes(ext)) type = "video"
        else if (ext === "gif") type = "GIF"
        else if (["ogg", "oga", "opus", "mp3", "m4a"].includes(ext)) type = "audio"
        else if (["pdf", "zip"].includes(ext)) type = "document"
        else if (["tgs", "webp"].includes(ext)) type = "sticker"
        counts[type] = (counts[type] ?? 0) + 1
      }
      const summary = Object.entries(counts)
        .map(([type, count]) => `${count} ${type}(s)`)
        .join(", ")
      extracted = {
        title: `Media album: ${summary}`,
        content: `Media-only post with ${summary}. See the original Telegram post for visual content.`,
        ogImage: item.thumbnailUrl,
        author: null,
      }
    } else {
      // Truly empty: no text, no URL, no media
      await deps.db.inboxItem.update({
        where: { id: itemId },
        data: {
          status: "NO_CONTENT",
          extractedTitle: null,
          extractedContent: null,
        },
      })
      return true
    }

    await deps.db.inboxItem.update({
      where: { id: itemId },
      data: {
        status: "EXTRACTED",
        extractedTitle: extracted.title,
        extractedContent: extracted.content,
        thumbnailUrl: extracted.ogImage ?? item.thumbnailUrl,
      },
    })

    return true
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    await deps.db.inboxItem.update({
      where: { id: itemId },
      data: {
        status: "ERROR",
        errorMessage,
        retryCount: { increment: 1 },
      },
    })
    return false
  }
}

// ---------------------------------------------------------------------------
// generateAndSaveStory
// ---------------------------------------------------------------------------

/**
 * Generate a story via AI from an extracted InboxItem.
 * Creates a Story record and links the InboxItem to it.
 * Throws on invalid AI output.
 */
export async function generateAndSaveStory(
  itemId: string,
  deps: PipelineDeps
): Promise<string> {
  const item = await deps.db.inboxItem.findUnique({ where: { id: itemId } })
  if (!item) throw new Error(`InboxItem not found: ${itemId}`)

  // Get user settings for system prompt
  const userSettings = await deps.db.userSettings.findUnique({
    where: { userId: item.userId },
  })

  // Build prompts
  const storyLanguage = userSettings?.storyLanguage ?? "en"
  const systemPrompt = buildStorySystemPrompt(userSettings?.storySystemPrompt ?? null, storyLanguage)

  const storyInput: InboxItemForStory = {
    rawText: item.rawText,
    extractedTitle: item.extractedTitle,
    extractedContent: item.extractedContent,
    sourceChannel: item.sourceChannel,
    extractedUrl: item.extractedUrl,
    mediaUrls: item.mediaUrls,
    telegramPostUrl: item.telegramPostUrl,
  }
  const userContent = buildStoryUserContent([storyInput])

  // Call AI
  const rawOutput = await deps.generateStory(systemPrompt, userContent)

  // Validate output
  const result = validateStoryOutput(rawOutput)
  if (!result.success || !result.story) {
    throw new Error(`AI output validation failed: ${result.error}`)
  }

  const story = result.story

  // Merge telegram post URL into sourceUrls (for forwarded messages)
  const sourceUrls = mergeSourceUrls(story.sourceUrls, [item.telegramPostUrl])

  // Create Story in database
  const created = await deps.db.story.create({
    data: {
      userId: item.userId,
      title: story.title,
      languageFlag: story.languageFlag,
      summary: story.summary,
      body: story.body,
      keyPoints: story.keyPoints,
      sourceUrls,
      rubrics: story.rubrics,
      status: "DRAFT",
    },
  })

  // Link inbox item to story
  await deps.db.inboxItem.update({
    where: { id: itemId },
    data: {
      storyId: created.id,
      status: "MATCHED",
    },
  })

  return created.id
}

// ---------------------------------------------------------------------------
// publishToNotion
// ---------------------------------------------------------------------------

/**
 * Publish a story to Notion. Returns the Notion page ID, or null if
 * Notion is not configured for this user.
 */
export async function publishToNotion(
  storyId: string,
  deps: PipelineDeps
): Promise<string | null> {
  // Member posts are loaded the way the story page loads them (newest first),
  // so the Notion page carries the same media in the same order — before
  // RAD-401 only legacy inbox items' media reached it. Inbox items keep their
  // arrival order, so the first forwarded post's cover leads the inbox media.
  const story = await deps.db.story.findUnique({
    where: { id: storyId },
    include: {
      inboxItems: { orderBy: { createdAt: "asc" } },
      materials: {
        select: { title: true, thumbnailUrl: true, mediaUrls: true, feed: { select: { type: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  })
  if (!story) throw new Error(`Story not found: ${storyId}`)

  const userSettings = await deps.db.userSettings.findUnique({
    where: { userId: story.userId },
  })

  if (!userSettings?.storyNotionDatabaseId) {
    return null
  }

  // Build Notion data
  const { visual, files } = storyDetailMedia({
    materials: (story.materials ?? []).map((m) => ({
      title: m.title ?? "",
      thumbnailUrl: m.thumbnailUrl,
      mediaUrls: m.mediaUrls,
      feed: m.feed?.type ? { type: m.feed.type } : null,
    })),
    // An inbox item's thumbnail is a cover the extractor chose, so it stays
    // even when extensionless. Its `mediaUrls` are not vetted the same way: an
    // `"unknown"` entry is an article page more often than a picture, and the
    // site grid's "render it as an image" fallback would make it an image
    // block Notion cannot show. storyDetailMedia keeps that rule for the grid.
    inboxItems: (story.inboxItems ?? []).map((item) => ({
      thumbnailUrl: item.thumbnailUrl,
      mediaUrls: (item.mediaUrls ?? []).filter((u) => mediaKindFromUrl(u) !== "unknown"),
    })),
  })

  const storyForNotion: StoryForNotion = {
    title: story.title,
    languageFlag: story.languageFlag,
    summary: story.summary,
    body: story.body,
    keyPoints: story.keyPoints,
    sourceUrls: story.sourceUrls,
    rubrics: story.rubrics,
    archiveLinks: story.archiveLinks as StoryForNotion["archiveLinks"],
    media: [...visual, ...files].map(({ url, kind }) => ({ url, kind })),
  }

  const properties = buildNotionProperties(storyForNotion, story.sourceUrls[0] ?? null)
  const blocks = buildNotionBlocks(storyForNotion)

  let pageId: string
  let url: string

  // If story already has a Notion page, try to update it; fall back to create on archived/deleted pages
  if (story.notionPageId && deps.updateNotionPage) {
    try {
      await deps.updateNotionPage(story.notionPageId, properties, blocks)
      pageId = story.notionPageId
      url = story.notionUrl ?? `https://notion.so/${story.notionPageId.replace(/-/g, "")}`
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr)
      const notionCode = (updateErr as Record<string, unknown>).code as string | undefined
      const isGone =
        notionCode === "object_not_found" ||
        /archived/i.test(msg)
      if (!isGone) throw updateErr
      // Page was archived or deleted in Notion — create a new one
      console.warn(`[Pipeline] Notion page ${story.notionPageId} archived/deleted (code=${notionCode}), creating new page`)
      const result = await deps.saveToNotion(
        userSettings.storyNotionDatabaseId,
        properties,
        blocks
      )
      pageId = result.pageId
      url = result.url
    }
  } else {
    const result = await deps.saveToNotion(
      userSettings.storyNotionDatabaseId,
      properties,
      blocks
    )
    pageId = result.pageId
    url = result.url
  }

  // Update story with Notion info
  await deps.db.story.update({
    where: { id: storyId },
    data: {
      notionPageId: pageId,
      notionUrl: url,
      status: "SENT_TO_NOTION",
    },
  })

  // Mark all linked inbox items as PROCESSED
  const inboxItemIds = story.inboxItems?.map((i) => i.id) ?? []
  if (inboxItemIds.length > 0) {
    await deps.db.inboxItem.updateMany({
      where: { storyId },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    })
  }

  return pageId
}

// ---------------------------------------------------------------------------
// matchAndRoute
// ---------------------------------------------------------------------------

export interface MatchRouteResult {
  action: "create" | "update" | "error"
  storyId: string | null
}

/**
 * Determine whether an InboxItem should create a new story or update an existing one.
 * Calls deps.matchItem to get the matching decision, then updates the InboxItem status.
 * Returns { action: "create", storyId: null } if no match or item not found.
 * Returns { action: "update", storyId } if a match is found.
 */
export async function matchAndRoute(
  itemId: string,
  deps: PipelineDeps
): Promise<MatchRouteResult> {
  const item = await deps.db.inboxItem.findUnique({ where: { id: itemId } })
  if (!item) {
    return { action: "create", storyId: null }
  }

  if (!deps.matchItem) {
    return { action: "create", storyId: null }
  }

  const matchResult = await deps.matchItem(itemId, item.userId, item)

  if (matchResult.match) {
    // Link item to matched story and mark as MATCHED
    await deps.db.inboxItem.update({
      where: { id: itemId },
      data: {
        status: "MATCHED",
        storyId: matchResult.match,
      },
    })
    return { action: "update", storyId: matchResult.match }
  }

  // No match — mark as MATCHED (will create new story)
  await deps.db.inboxItem.update({
    where: { id: itemId },
    data: {
      status: "MATCHED",
    },
  })
  return { action: "create", storyId: null }
}

// ---------------------------------------------------------------------------
// updateExistingStory
// ---------------------------------------------------------------------------

/**
 * Re-generate a story from ALL linked InboxItems and update it in-place.
 * Increments the story version. Throws if story not found.
 * Returns the story ID.
 */
export async function updateExistingStory(
  storyId: string,
  deps: PipelineDeps
): Promise<string> {
  const story = await deps.db.story.findUnique({
    where: { id: storyId },
    include: { inboxItems: true, materials: { include: { feed: true } } },
  })
  if (!story) throw new Error(`Story not found: ${storyId}`)

  // Get user settings for system prompt
  const userSettings = await deps.db.userSettings.findUnique({
    where: { userId: story.userId },
  })

  // Build system prompt
  const storyLanguage = userSettings?.storyLanguage ?? "en"
  const systemPrompt = buildStorySystemPrompt(userSettings?.storySystemPrompt ?? null, storyLanguage)

  // Build user content from ALL linked inbox items
  const inboxItems: InboxItemForStory[] = (story.inboxItems ?? []).map((item) => ({
    rawText: item.rawText,
    extractedTitle: item.extractedTitle,
    extractedContent: item.extractedContent,
    sourceChannel: item.sourceChannel,
    extractedUrl: item.extractedUrl,
    mediaUrls: item.mediaUrls,
    telegramPostUrl: item.telegramPostUrl,
  }))

  // Map materials to InboxItemForStory format
  const materialItems: InboxItemForStory[] = (story.materials ?? []).map((mat) => ({
    rawText: mat.rawText,
    extractedTitle: mat.title,
    extractedContent: mat.content,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the story material rows carry feed only at runtime
    sourceChannel: (mat as any).feed?.name ?? null,
    extractedUrl: mat.url,
    mediaUrls: [],
    telegramPostUrl: null,
    sourceType: "rss" as const,
  }))

  const items = [...inboxItems, ...materialItems]
  const userContent = buildStoryUserContent(items)

  // Call AI
  const rawOutput = await deps.generateStory(systemPrompt, userContent)

  // Validate output
  const result = validateStoryOutput(rawOutput)
  if (!result.success || !result.story) {
    throw new Error(`AI output validation failed: ${result.error}`)
  }

  const updatedStory = result.story

  // Re-merge telegram post URLs from all linked inbox items
  const telegramPostUrls = (story.inboxItems ?? []).map((item) => item.telegramPostUrl)
  const sourceUrls = mergeSourceUrls(updatedStory.sourceUrls, telegramPostUrls)

  // Update story in-place, incrementing version
  await deps.db.story.update({
    where: { id: storyId },
    data: {
      title: updatedStory.title,
      languageFlag: updatedStory.languageFlag,
      summary: updatedStory.summary,
      body: updatedStory.body,
      keyPoints: updatedStory.keyPoints,
      sourceUrls,
      rubrics: updatedStory.rubrics,
      version: { increment: 1 },
      status: "DRAFT",
    },
  })

  return storyId
}

// ---------------------------------------------------------------------------
// processInboxItem — full pipeline orchestration
// ---------------------------------------------------------------------------

/**
 * Run the full pipeline for a single InboxItem.
 * Never throws — always returns a ProcessResult.
 */
export async function processInboxItem(
  itemId: string,
  deps: PipelineDeps
): Promise<ProcessResult> {
  try {
    // 1. Fetch item
    const item = await deps.db.inboxItem.findUnique({ where: { id: itemId } })
    if (!item) {
      return { success: false, error: `InboxItem not found: ${itemId}` }
    }

    // 1b. Guard: skip items that have already been processed or archived
    if (item.status === "PROCESSED" || item.status === "ARCHIVED") {
      return { success: false, error: `Item ${itemId} already processed (status: ${item.status})` }
    }

    // 2. Extract content — returns false on failure (error already persisted to DB)
    const extractionOk = await extractAndSave(itemId, deps)
    if (!extractionOk) {
      return { success: false, error: "Content extraction failed" }
    }

    // 3. Match and route (if matchItem dep provided), then generate or update story
    let storyId: string
    try {
      if (deps.matchItem) {
        const routeResult = await matchAndRoute(itemId, deps)
        if (routeResult.action === "update" && routeResult.storyId) {
          storyId = await updateExistingStory(routeResult.storyId, deps)
        } else {
          storyId = await generateAndSaveStory(itemId, deps)
        }
      } else {
        storyId = await generateAndSaveStory(itemId, deps)
      }
    } catch (genErr) {
      const message = genErr instanceof Error ? genErr.message : String(genErr)
      await deps.db.inboxItem.update({
        where: { id: itemId },
        data: {
          status: "ERROR",
          errorMessage: message,
          retryCount: { increment: 1 },
        },
      })
      return { success: false, error: message }
    }

    // 4. Archive linking (non-blocking — failures just skip "See also")
    if (deps.findRelatedMaterials) {
      try {
        const story = await deps.db.story.findUnique({ where: { id: storyId } })
        if (story) {
          const links = await deps.findRelatedMaterials(story.title, story.summary)
          if (links.length > 0) {
            await deps.db.story.update({
              where: { id: storyId },
              data: { archiveLinks: links },
            })
          }
        }
      } catch (linkErr) {
        // Non-blocking: log and continue
        console.error(`[Pipeline] Archive linking failed for story ${storyId}:`, linkErr)
      }
    }

    // 5. Publish to Notion
    let notionPageId: string | null
    try {
      notionPageId = await publishToNotion(storyId, deps)
    } catch (notionErr) {
      const message = notionErr instanceof Error ? notionErr.message : String(notionErr)
      await deps.db.inboxItem.update({
        where: { id: itemId },
        data: {
          status: "ERROR",
          errorMessage: message,
        },
      })
      return { success: false, error: message }
    }

    return {
      success: true,
      storyId,
      notionPageId: notionPageId ?? undefined,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: errorMessage }
  }
}
