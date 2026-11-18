/**
 * Notion Client for Story Aggregator
 * Standalone functions that wire notion-builder output to actual Notion API calls.
 * Handles create, update (list+delete+append), status checking, and >100 block batching.
 * Spec: the Story Aggregator specification, section 4.6
 */

import { Client } from "@notionhq/client"
import { buildNotionProperties, buildNotionBlocks } from "./notion-builder"
import type { StoryForNotion } from "./notion-builder"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BLOCKS_PER_REQUEST = 100

// ---------------------------------------------------------------------------
// Internal helper — construct Notion client (supports mocked Client in tests)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function getNotionClient(token: string): any {
  try {
    return new (Client as any)({ auth: token })
  } catch {
    return (Client as any)({ auth: token })
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// createStoryPage
// ---------------------------------------------------------------------------

/**
 * Create a new Notion page in the "Digest Inbox" database.
 * If the total block count exceeds 100, the first 100 are passed with pages.create
 * and the rest are appended via blocks.children.append in batches of 100.
 */
export async function createStoryPage(
  story: StoryForNotion,
  databaseId: string,
  notionToken: string
): Promise<{ pageId: string; url: string }> {
  const notion = getNotionClient(notionToken)

  const properties = buildNotionProperties(story, story.sourceUrls[0] ?? null)
  const allBlocks = buildNotionBlocks(story)

  // Split blocks: first batch goes with pages.create, rest via append
  const firstBatch = allBlocks.slice(0, MAX_BLOCKS_PER_REQUEST)
  const remainingBlocks = allBlocks.slice(MAX_BLOCKS_PER_REQUEST)

  const page = await notion.pages.create({
    parent: { database_id: databaseId },
    properties,
    children: firstBatch,
  } as Parameters<typeof notion.pages.create>[0])

  // Append remaining blocks in batches of 100
  for (let i = 0; i < remainingBlocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    const batch = remainingBlocks.slice(i, i + MAX_BLOCKS_PER_REQUEST)
    await notion.blocks.children.append({
      block_id: page.id,
      children: batch,
    } as Parameters<typeof notion.blocks.children.append>[0])
  }

  return {
    pageId: page.id,
    url: (page as unknown as { url: string }).url ?? `https://notion.so/${page.id.replace(/-/g, "")}`,
  }
}

// ---------------------------------------------------------------------------
// updateStoryPage
// ---------------------------------------------------------------------------

/**
 * Update an existing Notion page: replace blocks and update properties.
 * Edit detection: if the page has a Status value, the editor has taken
 * ownership — skip the update entirely (spec section 4.4).
 * Handles pagination when existing blocks exceed 100.
 */
export async function updateStoryPage(
  pageId: string,
  story: StoryForNotion,
  notionToken: string
): Promise<void> {
  const notion = getNotionClient(notionToken)

  // 1. Check current status — skip if editor has set a status
  const page = await notion.pages.retrieve({ page_id: pageId })
  const statusProp = (page as unknown as { properties: Record<string, unknown> })
    .properties?.Status as { select: { name: string } | null } | undefined
  const currentStatus = statusProp?.select?.name

  if (currentStatus) {
    return // Editor owns this page now
  }

  // 2. Fetch and delete all existing blocks (with pagination)
  let hasMore = true
  let startCursor: string | undefined

  while (hasMore) {
    const listArgs: Record<string, unknown> = { block_id: pageId }
    if (startCursor) {
      listArgs.start_cursor = startCursor
    }

    const response = await notion.blocks.children.list(
      listArgs as Parameters<typeof notion.blocks.children.list>[0]
    )

    const typedResponse = response as unknown as {
      results: { id: string }[]
      has_more: boolean
      next_cursor: string | null
    }

    for (const block of typedResponse.results) {
      await notion.blocks.delete({ block_id: block.id })
    }

    hasMore = typedResponse.has_more
    startCursor = typedResponse.next_cursor ?? undefined
  }

  // 3. Update page properties
  const properties = buildNotionProperties(story, story.sourceUrls[0] ?? null)
  await notion.pages.update({
    page_id: pageId,
    properties,
  } as Parameters<typeof notion.pages.update>[0])

  // 4. Append new blocks (in batches of 100)
  const allBlocks = buildNotionBlocks(story)

  for (let i = 0; i < allBlocks.length; i += MAX_BLOCKS_PER_REQUEST) {
    const batch = allBlocks.slice(i, i + MAX_BLOCKS_PER_REQUEST)
    await notion.blocks.children.append({
      block_id: pageId,
      children: batch,
    } as Parameters<typeof notion.blocks.children.append>[0])
  }
}

// ---------------------------------------------------------------------------
// checkPageStatus
// ---------------------------------------------------------------------------

/**
 * Retrieve the Status property of a Notion page.
 * Returns the status name string, or null if the page doesn't exist
 * or has no Status select value.
 */
export async function checkPageStatus(
  pageId: string,
  notionToken: string
): Promise<string | null> {
  const notion = getNotionClient(notionToken)

  try {
    const page = await notion.pages.retrieve({ page_id: pageId })
    const statusProp = (page as unknown as { properties: Record<string, unknown> })
      .properties?.Status as { select: { name: string } | null } | undefined

    return statusProp?.select?.name ?? null
  } catch (error: unknown) {
    const notionError = error as { code?: string }
    if (notionError.code === "object_not_found") {
      return null
    }
    throw error
  }
}
