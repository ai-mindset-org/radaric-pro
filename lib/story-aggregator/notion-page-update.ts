/**
 * Re-publish a story onto its existing Notion page (RAD-401).
 *
 * Shared by both PipelineDeps factories — the API routes'
 * (`pipeline-deps.ts`) and the worker's (`worker.ts`) — which used to carry
 * two copies that deleted every old block BEFORE appending the new ones. A
 * failed append (one media URL Notion rejects fails the whole request, or a
 * plain 502) then left the page empty.
 *
 * Order now: update properties → collect every old block id → append the new
 * blocks → delete the old ids. A failed append throws before anything old is
 * deleted, so the page keeps its previous content; the batches that did land
 * are removed first (RAD-403), so a run of failing retries cannot stack copies
 * of them under it. (A batch Notion committed but whose response was lost — a
 * 502 or timeout after the write — returns no ids and cannot be removed here.)
 *
 * Old blocks sit ABOVE the new content, so one left behind is outdated text at
 * the top of the page. Deleting them therefore: retries a transient failure
 * (429, 5xx, conflict — the SDK retries nothing itself); counts a block that is
 * already gone (archived, not found) as deleted; stops at once on lost access
 * (401/403); and rejects when any block is still left after the rest were
 * tried — the story then stays un-sent and the next re-publish lists old + new
 * and cleans both up.
 */
import type { Client } from "@notionhq/client"

/** Notion accepts at most 100 children per append, and lists at most 100 per page. */
const NOTION_BATCH_MAX = 100

export async function replaceNotionPageContent(
  notion: Client,
  pageId: string,
  properties: unknown,
  blocks: unknown[]
): Promise<void> {
  // 1. Update page properties
  await notion.pages.update({
    page_id: pageId,
    properties: properties as any,
  } as any)

  // 2. Collect the existing top-level block ids (paginated)
  const oldIds: string[] = []
  let hasMore = true
  let startCursor: string | undefined
  while (hasMore) {
    const response = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: startCursor,
      page_size: NOTION_BATCH_MAX,
    } as any)
    for (const block of response.results) oldIds.push((block as any).id)
    hasMore = response.has_more
    startCursor = response.next_cursor ?? undefined
  }

  // 3. Append the new blocks — appended children land after the old ones
  const appendedIds: string[] = []
  try {
    for (let i = 0; i < blocks.length; i += NOTION_BATCH_MAX) {
      const response = await notion.blocks.children.append({
        block_id: pageId,
        children: blocks.slice(i, i + NOTION_BATCH_MAX) as any,
      } as any)
      for (const block of response?.results ?? []) appendedIds.push((block as any).id)
    }
  } catch (error) {
    // Take the landed batches back off so the page is exactly as before;
    // nothing here may mask the append's own error
    const stale = await deleteBlocks(notion, appendedIds).catch(() => appendedIds.length)
    if (stale > 0) {
      console.warn(`[Notion] ${stale} partially appended block(s) could not be removed from page ${pageId}`)
    }
    throw error
  }

  // 4. Only now remove the old content
  const stale = await deleteBlocks(notion, oldIds)
  if (stale > 0) {
    throw new Error(`${stale} old block(s) could not be removed from Notion page ${pageId}`)
  }
}

/** Waits between delete attempts; the retry count is DELETE_RETRY_DELAYS_MS.length. */
const DELETE_RETRY_DELAYS_MS = [1000, 3000]

type NotionError = { status?: number; code?: string; message?: string }

function isTransient(e: NotionError): boolean {
  return e.status === 429 || (e.status ?? 0) >= 500 || e.code === "rate_limited" || e.code === "conflict_error"
}

function isAlreadyGone(e: NotionError): boolean {
  return e.status === 404 || e.code === "object_not_found" || (e.code === "validation_error" && /archived/i.test(e.message ?? ""))
}

function isAccessLost(e: NotionError): boolean {
  return e.status === 401 || e.status === 403 || e.code === "unauthorized" || e.code === "restricted_resource"
}

/**
 * Delete every id; returns how many are still on the page. Throws only on
 * lost access, where every further request would fail the same way.
 */
async function deleteBlocks(notion: Client, ids: string[]): Promise<number> {
  let failed = 0
  let firstError: unknown
  for (const id of ids) {
    for (let attempt = 0; ; attempt++) {
      try {
        await notion.blocks.delete({ block_id: id })
        break
      } catch (error) {
        const e = (error ?? {}) as NotionError
        if (isAlreadyGone(e)) break
        if (isAccessLost(e)) throw error
        if (isTransient(e) && attempt < DELETE_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, DELETE_RETRY_DELAYS_MS[attempt]))
          continue
        }
        failed++
        firstError ??= error
        break
      }
    }
  }
  if (failed > 0) {
    const reason = firstError instanceof Error ? firstError.message : String(firstError)
    console.warn(`[Notion] ${failed} of ${ids.length} block(s) could not be deleted (first error: ${reason})`)
  }
  return failed
}
