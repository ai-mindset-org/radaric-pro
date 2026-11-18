/**
 * Parallel Monitor API Parser for INTEREST source type
 *
 * This module handles:
 * - Creating monitors in Parallel API
 * - Deleting monitors
 * - Fetching event groups when webhook is received
 * - Processing events into Materials with AI evaluation
 */

import { db } from "@/lib/db"
import { evaluateMaterialsBatch } from "@/lib/ai"
import { capTitle } from "@/lib/title"
import { AIEvaluation as PrismaAIEvaluation, MaterialStatus, Prisma } from "@prisma/client"
import { extractOpenGraphImage } from "./rss"
import { sanitizeHtml } from "@/lib/sanitize"
import { isRenderableImageUrl } from "@/lib/media-urls"

const PARALLEL_API_BASE = "https://api.parallel.ai/v1alpha"

// ============================================================================
// Types
// ============================================================================

export interface ParallelEvent {
  type: "event"
  event_group_id: string
  output: string
  event_date: string
  source_urls: string[]
}

export interface ParallelMonitorConfig {
  query: string
  cadence: "hourly" | "daily" | "weekly"
}

export interface ParsedInterestItem {
  title: string
  url: string
  externalId: string
  content: string
  publishedAt: Date | null
  sourceUrls: string[]
}

// ============================================================================
// Retry Helper
// ============================================================================

const RETRY_DELAYS = [1000, 2000, 4000] // Exponential backoff: 1s, 2s, 4s

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, options)

      // Don't retry on client errors (4xx), only on server errors (5xx)
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response
      }

      // Server error - will retry
      const errorText = await response.text()
      lastError = new Error(`HTTP ${response.status}: ${errorText}`)
      console.warn(`[Interest Parser] Retry ${attempt + 1}/${retries}: ${lastError.message}`)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      console.warn(`[Interest Parser] Retry ${attempt + 1}/${retries}: ${lastError.message}`)
    }

    // Wait before retrying (exponential backoff)
    if (attempt < retries - 1) {
      const delay = RETRY_DELAYS[attempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1]
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError || new Error("Request failed after retries")
}

// ============================================================================
// OG Image Fetcher
// ============================================================================

/**
 * Fetch Open Graph image from a URL
 */
async function fetchOgImage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RadaricBot/1.0)" },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) return null
    const html = await response.text()
    return extractOpenGraphImage(html, url)
  } catch {
    return null
  }
}

// ============================================================================
// API Client
// ============================================================================

/**
 * Get Parallel API key from settings
 */
async function getParallelApiKey(): Promise<string> {
  const settings = await db.settings.findFirst()
  if (!settings?.parallelApiKey) {
    throw new Error("Parallel API key not configured in settings")
  }
  return settings.parallelApiKey
}

/**
 * Create a new Parallel Monitor
 * @returns Monitor ID
 */
export async function createParallelMonitor(
  config: ParallelMonitorConfig,
  webhookUrl: string
): Promise<string> {
  const apiKey = await getParallelApiKey()

  console.log(`[Interest Parser] Creating monitor with query: "${config.query}", cadence: ${config.cadence}`)

  const response = await fetchWithRetry(`${PARALLEL_API_BASE}/monitors`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query: config.query,
      cadence: config.cadence,
      webhook: {
        url: webhookUrl,
        event_types: ["monitor.event.detected"],
      },
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    console.error(`[Interest Parser] Failed to create monitor:`, error)
    throw new Error(`Failed to create Parallel monitor: ${error}`)
  }

  const data = await response.json()
  console.log(`[Interest Parser] Created monitor: ${data.monitor_id}`)
  return data.monitor_id
}

/**
 * Delete a Parallel Monitor
 */
export async function deleteParallelMonitor(monitorId: string): Promise<void> {
  const apiKey = await getParallelApiKey()

  console.log(`[Interest Parser] Deleting monitor: ${monitorId}`)

  const response = await fetchWithRetry(`${PARALLEL_API_BASE}/monitors/${monitorId}`, {
    method: "DELETE",
    headers: {
      "x-api-key": apiKey,
    },
  })

  // 404 is acceptable - monitor already deleted
  if (!response.ok && response.status !== 404) {
    const error = await response.text()
    console.error(`[Interest Parser] Failed to delete monitor:`, error)
    throw new Error(`Failed to delete Parallel monitor: ${error}`)
  }

  console.log(`[Interest Parser] Deleted monitor: ${monitorId}`)
}

/**
 * Fetch latest events from monitor (for manual refresh)
 * Uses the List Events endpoint with lookback
 * @param lookback - Time window, e.g. "1d", "7d", "30d"
 */
export async function fetchMonitorEvents(
  monitorId: string,
  lookback: string = "7d"
): Promise<ParallelEvent[]> {
  const apiKey = await getParallelApiKey()

  console.log(`[Interest Parser] Fetching events for monitor: ${monitorId}, lookback: ${lookback}`)

  const response = await fetchWithRetry(
    `${PARALLEL_API_BASE}/monitors/${monitorId}/events?lookback=${lookback}`,
    {
      headers: {
        "x-api-key": apiKey,
      },
    }
  )

  if (!response.ok) {
    const error = await response.text()
    console.error(`[Interest Parser] Failed to fetch monitor events:`, error)
    throw new Error(`Failed to fetch monitor events: ${error}`)
  }

  const data = await response.json()
  // Filter only actual events, skip "completion" type entries
  const allEvents = data.events || []
  const events = allEvents.filter((e: { type: string }) => e.type === "event")
  console.log(`[Interest Parser] Fetched ${events.length} events from monitor (${allEvents.length - events.length} non-event entries skipped)`)
  return events
}

/**
 * Fetch event group details from Parallel
 */
export async function fetchEventGroup(
  monitorId: string,
  eventGroupId: string
): Promise<ParallelEvent[]> {
  const apiKey = await getParallelApiKey()

  console.log(`[Interest Parser] Fetching event group: ${eventGroupId} for monitor: ${monitorId}`)

  const response = await fetchWithRetry(
    `${PARALLEL_API_BASE}/monitors/${monitorId}/event_groups/${eventGroupId}`,
    {
      headers: {
        "x-api-key": apiKey,
      },
    }
  )

  if (!response.ok) {
    const error = await response.text()
    console.error(`[Interest Parser] Failed to fetch event group:`, error)
    throw new Error(`Failed to fetch event group: ${error}`)
  }

  const data = await response.json()
  console.log(`[Interest Parser] Fetched ${data.events?.length || 0} events`)
  return data.events || []
}

// ============================================================================
// Event Processing
// ============================================================================

/**
 * Process Parallel event and create materials
 * Called from webhook handler
 */
export async function processParallelEvent(
  sourceId: string,
  eventGroupId: string,
  userId: string
): Promise<{ created: number; skipped: number }> {
  const source = await db.feed.findUnique({
    where: { id: sourceId },
  })

  if (!source || !source.parallelMonitorId) {
    throw new Error(`Invalid source or missing monitor ID: ${sourceId}`)
  }

  // A tracked question's backing feed carries its collection's query: events
  // must be judged against THE QUESTION, not the user's global curation prompt.
  // Without this a question-specific source is filtered by unrelated criteria
  // (observed: every Anthropic-research event rejected by the design digest's
  // global prompt, so the answer never grew). User-created monitor feeds have
  // no backing collection and keep their feed-prompt + global evaluation.
  const backedCollection = await db.collection.findUnique({
    where: { monitorFeedId: source.id },
    select: { query: true },
  })
  const criteria = backedCollection?.query || undefined

  console.log(`[Interest Parser] Processing event group: ${eventGroupId} for source: ${source.name}`)

  // Fetch events from Parallel
  const events = await fetchEventGroup(source.parallelMonitorId, eventGroupId)

  if (events.length === 0) {
    console.log(`[Interest Parser] No events to process`)
    return { created: 0, skipped: 0 }
  }

  // Convert events to parsed items (sanitize content for safety)
  const items: ParsedInterestItem[] = events.map((event, index) => ({
    title: extractTitle(event.output),
    url: event.source_urls[0] || `parallel://event/${eventGroupId}/${index}`,
    externalId: `parallel:${eventGroupId}:${index}`,
    content: sanitizeHtml(event.output),
    publishedAt: event.event_date && !isNaN(new Date(event.event_date).getTime())
      ? new Date(event.event_date)
      : new Date(),
    sourceUrls: event.source_urls,
  }))

  // Check for existing materials to avoid duplicates
  const existingMaterials = await db.material.findMany({
    where: {
      sourceId: source.id,
      externalId: { in: items.map((i) => i.externalId) },
    },
    select: { externalId: true },
  })

  const existingIds = new Set(existingMaterials.map((m) => m.externalId))
  const newItems = items.filter((item) => !existingIds.has(item.externalId))

  if (newItems.length === 0) {
    console.log(`[Interest Parser] All ${items.length} items already exist, skipping`)
    return { created: 0, skipped: items.length }
  }

  console.log(`[Interest Parser] Processing ${newItems.length} new items (skipping ${items.length - newItems.length} duplicates)`)

  // Evaluate with AI
  const evaluations = await evaluateMaterialsBatch({
    materials: newItems.map((item) => ({
      title: item.title,
      content: item.content,
      url: item.url,
    })),
    sourceId: source.id,
    userId,
    criteria,
  })

  // Fetch OG images in parallel
  const ogImages = await Promise.all(
    newItems.map((item) =>
      item.sourceUrls[0] ? fetchOgImage(item.sourceUrls[0]) : Promise.resolve(null)
    )
  )

  // Save materials
  const materialsToCreate = newItems.map((item, index) => ({
    sourceId: source.id,
    title: item.title,
    url: item.url,
    externalId: item.externalId,
    content: item.content,
    publishedAt: item.publishedAt,
    thumbnailUrl: ogImages[index],
    // `source_urls` are the PAGES the event was found on, and `mediaUrls` is a
    // media column that every surface renders as images (card cover gallery,
    // detail "Media (N)", story thumbs). Writing article links here put a
    // second "image" on two thirds of the gallery cards that no scrub could
    // ever show. Keep only what is actually an image — Parallel does sometimes
    // return one — and let the OG image in `thumbnailUrl` be the cover.
    // The citation list itself has no column of its own; it is reachable
    // through the material's own `url`.
    mediaUrls: item.sourceUrls.filter(isRenderableImageUrl),
    aiEvaluation: evaluations[index].relevant
      ? PrismaAIEvaluation.APPROVED
      : PrismaAIEvaluation.FILTERED,
    aiConfidence: evaluations[index].confidence,
    aiReasoning: evaluations[index].reasoning,
    userStatus: MaterialStatus.NEW,
  }))

  await db.material.createMany({
    data: materialsToCreate,
    skipDuplicates: true,
  })

  // Update lastParsedAt
  await db.feed.update({
    where: { id: source.id },
    data: { lastParsedAt: new Date() },
  })

  // Self-filling collections: if this monitor feed backs a tracked-question
  // collection and we created relevant new material, mark it for a synthesis
  // refresh. The WORKER regenerates off the request path — NEVER inline here
  // (synthesis is ~90s and would time out this webhook). Swallowed: a failure
  // must not fail the webhook (a 503 → Parallel re-delivers → re-pays the eval).
  try {
    const approvedCount = evaluations.filter((e) => e.relevant).length
    if (approvedCount > 0) {
      await db.collection.updateMany({
        where: { monitorFeedId: source.id },
        data: { autoSynthAt: new Date() },
      })
    }
  } catch (markErr) {
    console.error("[Interest Parser] autoSynthAt mark failed (non-fatal):", markErr)
  }

  console.log(`[Interest Parser] Created ${materialsToCreate.length} materials for source: ${source.name}`)
  return { created: materialsToCreate.length, skipped: items.length - newItems.length }
}

/**
 * The material rows `parseInterestSource` hands to the parse stream: full
 * material rows plus their feed, exactly as the query below fetches them.
 *
 * `aiEvaluation` is load-bearing — the stream derives its approved / filtered
 * counts from it (RAD-333) — so narrowing that query with a `select` that drops
 * the field must fail tsc rather than silently invert the counts.
 */
export type ParsedInterestMaterial = Prisma.MaterialGetPayload<{
  include: { feed: { select: { id: true; name: true; type: true } } }
}>

/**
 * Parse Interest source manually (for refresh button)
 * Fetches latest events and creates materials
 */
export async function parseInterestSource(
  sourceId: string,
  userId: string,
  lookback: string = "7d"
): Promise<{ created: number; skipped: number; total: number; materials: ParsedInterestMaterial[] }> {
  const source = await db.feed.findUnique({
    where: { id: sourceId },
  })

  if (!source || !source.parallelMonitorId) {
    throw new Error(`Invalid source or missing monitor ID: ${sourceId}`)
  }

  // Tracked questions evaluate against their own query (see processParallelEvent).
  const backedCollection = await db.collection.findUnique({
    where: { monitorFeedId: source.id },
    select: { query: true },
  })
  const criteria = backedCollection?.query || undefined

  console.log(`[Interest Parser] Manual parse for source: ${source.name}`)

  // Fetch events from Parallel
  const events = await fetchMonitorEvents(source.parallelMonitorId, lookback)

  if (events.length === 0) {
    console.log(`[Interest Parser] No events found`)
    return { created: 0, skipped: 0, total: 0, materials: [] }
  }

  // Convert events to parsed items (sanitize content for safety)
  const items: ParsedInterestItem[] = events.map((event, index) => ({
    title: extractTitle(event.output),
    url: event.source_urls[0] || `parallel://event/${event.event_group_id}/${index}`,
    externalId: `parallel:${event.event_group_id}:${index}`,
    content: sanitizeHtml(event.output),
    publishedAt: event.event_date && !isNaN(new Date(event.event_date).getTime())
      ? new Date(event.event_date)
      : new Date(),
    sourceUrls: event.source_urls,
  }))

  // Check for existing materials to avoid duplicates
  const existingMaterials = await db.material.findMany({
    where: {
      sourceId: source.id,
      externalId: { in: items.map((i) => i.externalId) },
    },
    select: { externalId: true },
  })

  const existingIds = new Set(existingMaterials.map((m) => m.externalId))
  const newItems = items.filter((item) => !existingIds.has(item.externalId))

  if (newItems.length === 0) {
    console.log(`[Interest Parser] All ${items.length} items already exist, skipping`)
    // Still update lastParsedAt
    await db.feed.update({
      where: { id: source.id },
      data: { lastParsedAt: new Date() },
    })
    return { created: 0, skipped: items.length, total: items.length, materials: [] }
  }

  console.log(`[Interest Parser] Processing ${newItems.length} new items (skipping ${items.length - newItems.length} duplicates)`)

  // Evaluate with AI
  const evaluations = await evaluateMaterialsBatch({
    materials: newItems.map((item) => ({
      title: item.title,
      content: item.content,
      url: item.url,
    })),
    sourceId: source.id,
    userId,
    criteria,
  })

  // Fetch OG images in parallel
  const ogImages = await Promise.all(
    newItems.map((item) =>
      item.sourceUrls[0] ? fetchOgImage(item.sourceUrls[0]) : Promise.resolve(null)
    )
  )

  // Save materials
  const materialsToCreate = newItems.map((item, index) => ({
    sourceId: source.id,
    title: item.title,
    url: item.url,
    externalId: item.externalId,
    content: item.content,
    publishedAt: item.publishedAt,
    thumbnailUrl: ogImages[index],
    // `source_urls` are the PAGES the event was found on, and `mediaUrls` is a
    // media column that every surface renders as images (card cover gallery,
    // detail "Media (N)", story thumbs). Writing article links here put a
    // second "image" on two thirds of the gallery cards that no scrub could
    // ever show. Keep only what is actually an image — Parallel does sometimes
    // return one — and let the OG image in `thumbnailUrl` be the cover.
    // The citation list itself has no column of its own; it is reachable
    // through the material's own `url`.
    mediaUrls: item.sourceUrls.filter(isRenderableImageUrl),
    aiEvaluation: evaluations[index].relevant
      ? PrismaAIEvaluation.APPROVED
      : PrismaAIEvaluation.FILTERED,
    aiConfidence: evaluations[index].confidence,
    aiReasoning: evaluations[index].reasoning,
    userStatus: MaterialStatus.NEW,
  }))

  await db.material.createMany({
    data: materialsToCreate,
    skipDuplicates: true,
  })

  // Fetch created materials to return them for streaming
  const createdMaterials = await db.material.findMany({
    where: {
      sourceId: source.id,
      externalId: { in: newItems.map((i) => i.externalId) },
    },
    include: {
      feed: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: { createdAt: "desc" },
  })

  // Update lastParsedAt
  await db.feed.update({
    where: { id: source.id },
    data: { lastParsedAt: new Date() },
  })

  console.log(`[Interest Parser] Created ${createdMaterials.length} materials for source: ${source.name}`)
  return {
    created: createdMaterials.length,
    skipped: items.length - newItems.length,
    total: items.length,
    materials: createdMaterials,
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract title from event output (first sentence up to period)
 */
function extractTitle(output: string | undefined): string {
  if (!output) {
    return "Parallel Monitor Event"
  }

  const lines = output.split("\n").filter((line) => line.trim())
  const firstLine = lines[0]?.trim() || ""

  if (!firstLine) {
    return "Parallel Monitor Event"
  }

  // Find first period followed by space or end of string (sentence boundary)
  const sentenceMatch = firstLine.match(/^(.+?[а-яёa-z0-9»"'\)]\.)(?:\s|$)/i)

  if (sentenceMatch) {
    return capTitle(sentenceMatch[1])
  }

  // No sentence boundary found — return the (capped) full first line
  return capTitle(firstLine)
}

/**
 * Build webhook URL for Parallel API
 * Priority: NEXT_PUBLIC_APP_URL > VERCEL_URL (preview). Production deployments
 * have no fallback host and must set NEXT_PUBLIC_APP_URL explicitly.
 */
export function buildWebhookUrl(): string {
  // Explicit app URL takes priority
  if (process.env.NEXT_PUBLIC_APP_URL) {
    const url = process.env.NEXT_PUBLIC_APP_URL.startsWith("http")
      ? process.env.NEXT_PUBLIC_APP_URL
      : `https://${process.env.NEXT_PUBLIC_APP_URL}`
    return `${url}/api/webhooks/parallel`
  }

  // In production there is no safe fallback host to guess, so fail loudly
  // instead of pointing Parallel at a URL that may not serve this deployment.
  if (process.env.VERCEL_ENV === "production") {
    throw new Error(
      "NEXT_PUBLIC_APP_URL must be set in production for the Parallel webhook URL"
    )
  }

  // For preview deployments, use VERCEL_URL
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}/api/webhooks/parallel`
  }

  throw new Error("NEXT_PUBLIC_APP_URL or VERCEL_URL must be set for webhook URL")
}
