/**
 * Server-side YouTube primitives — oEmbed metadata, transcript fetching, and
 * channel resolution (network). Used by the story aggregator
 * (lib/story-aggregator/content-extractor.ts) and the YouTube feed parser
 * (lib/parsers/youtube.ts). The pure URL logic lives in lib/youtube-url.ts
 * (client-safe) and is re-exported here for server callers — do NOT import
 * this module from client components (the transcript dependency pulls Node
 * APIs into the browser bundle).
 */

import { isAllowedUrl } from "@/lib/url-validation"
import {
  CHANNEL_ID_PATTERN,
  extractChannelId,
  extractVideoId,
  normalizeYouTubeInput,
  youtubeChannelUrl,
} from "@/lib/youtube-url"

export * from "@/lib/youtube-url"

export const YOUTUBE_TRANSCRIPT_MAX_LENGTH = 12000

/**
 * Fetch video metadata via the public YouTube oEmbed endpoint (no API key needed).
 */
export async function fetchYouTubeMetadata(videoId: string): Promise<{
  title: string | null
  author: string | null
  thumbnail: string | null
  authorUrl: string | null
}> {
  const nullMeta = { title: null, author: null, thumbnail: null, authorUrl: null }

  try {
    const innerUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)
    const oembedUrl = `https://www.youtube.com/oembed?url=${innerUrl}&format=json`
    const response = await fetch(oembedUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RadaricBot/1.0)",
      },
      // Reachable from synchronous request handlers (feeds POST/PATCH,
      // save-feeds) — a stalled oEmbed must not hang the HTTP request
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })

    if (!response.ok) return nullMeta

    const data = (await response.json()) as {
      title?: string
      author_name?: string
      thumbnail_url?: string
      author_url?: string
    }

    return {
      title: data.title ?? null,
      author: data.author_name ?? null,
      thumbnail: data.thumbnail_url ?? null,
      authorUrl: data.author_url ?? null,
    }
  } catch {
    return nullMeta
  }
}

/**
 * Truncate text at a word boundary, appending "..." when truncation occurs.
 */
function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  const slice = text.slice(0, maxLength)
  const lastSpace = slice.lastIndexOf(" ")
  if (lastSpace === -1) return slice + "..."
  return slice.slice(0, lastSpace) + "..."
}

// ---------------------------------------------------------------------------
// Channel resolution — @handle / channel / video / feed-XML input → canonical
// https://www.youtube.com/channel/UC… (the form stored in Feed.url)
// ---------------------------------------------------------------------------

const RESOLVE_TIMEOUT_MS = 10_000
const USER_AGENT = "Mozilla/5.0 (compatible; RadaricBot/1.0)"

export class YouTubeResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "YouTubeResolveError"
  }
}

export interface ResolvedYouTubeChannel {
  channelId: string
  channelUrl: string
  /** Channel title when resolution had to fetch a page; null on the pure fast-path. */
  title: string | null
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
}

/**
 * Pull the channel id out of a channel page's HTML. og:url and canonical are
 * the reliable markers; itemprop=identifier is the fallback. The JSON
 * `"channelId"` blobs are NOT used — they match related channels too.
 */
function extractChannelIdFromHtml(html: string): string | null {
  const patterns = [
    new RegExp(`<meta\\s+property="og:url"\\s+content="https?://www\\.youtube\\.com/channel/(${CHANNEL_ID_PATTERN})"`),
    new RegExp(`<link\\s+rel="canonical"\\s+href="https?://www\\.youtube\\.com/channel/(${CHANNEL_ID_PATTERN})"`),
    new RegExp(`<meta\\s+itemprop="identifier"\\s+content="(${CHANNEL_ID_PATTERN})"`),
  ]
  for (const re of patterns) {
    const match = html.match(re)
    if (match) return match[1]
  }
  return null
}

function extractTitleFromHtml(html: string): string | null {
  const match = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)
  return match ? decodeHtmlEntities(match[1]) : null
}

/**
 * Resolve any accepted channel input to `{ channelId, channelUrl, title }`.
 * Pure fast-path for canonical /channel/ and feed-XML URLs (no network);
 * otherwise fetches the channel page (video URLs go via oEmbed → author_url
 * first). Throws YouTubeResolveError on anything unresolvable.
 */
export async function resolveYouTubeChannel(input: string): Promise<ResolvedYouTubeChannel> {
  const normalized = normalizeYouTubeInput(input)
  if (!normalized) {
    throw new YouTubeResolveError(
      "Enter a channel handle (@name), channel URL, or a video link from the channel"
    )
  }

  const direct = extractChannelId(normalized)
  if (direct) {
    return { channelId: direct, channelUrl: youtubeChannelUrl(direct), title: null }
  }

  let pageUrl = normalized
  let titleHint: string | null = null

  const videoId = extractVideoId(normalized)
  if (videoId) {
    const meta = await fetchYouTubeMetadata(videoId)
    if (!meta.authorUrl) {
      throw new YouTubeResolveError("Could not resolve the video's channel — try the channel URL instead")
    }
    pageUrl = meta.authorUrl
    titleHint = meta.author
  }

  // Defense-in-depth SSRF gate: normalizeYouTubeInput reconstructs the host
  // and oEmbed author_url is YouTube-controlled, but neither invariant is
  // load-bearing here — assert the youtube host + the global allowlist before
  // fetching, matching the isAllowedUrl posture of every other outbound fetch.
  let pageHost: string
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase()
  } catch {
    throw new YouTubeResolveError("Channel not found — check the handle or URL")
  }
  const isYouTubeHost =
    pageHost === "youtube.com" || pageHost.endsWith(".youtube.com") ||
    pageHost === "youtu.be" || pageHost.endsWith(".youtu.be")
  if (!isYouTubeHost || !isAllowedUrl(pageUrl)) {
    throw new YouTubeResolveError("Channel not found — check the handle or URL")
  }

  let response: Response
  try {
    response = await fetch(pageUrl, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
  } catch {
    throw new YouTubeResolveError("Could not reach YouTube to resolve the channel")
  }
  if (!response.ok) {
    throw new YouTubeResolveError(`Channel not found (YouTube returned ${response.status})`)
  }

  const html = await response.text()
  const channelId = extractChannelIdFromHtml(html)
  if (!channelId) {
    throw new YouTubeResolveError("Channel not found — check the handle or URL")
  }

  return {
    channelId,
    channelUrl: youtubeChannelUrl(channelId),
    title: titleHint ?? extractTitleFromHtml(html),
  }
}

// Memoized so concurrent transcript fetches share one import resolution
// (per-call dynamic imports race under concurrency in the vitest module
// registry, and a single promise is cheaper at runtime anyway).
let transcriptModule: Promise<typeof import("youtube-transcript-plus")> | null = null
function getTranscriptModule() {
  transcriptModule ??= import("youtube-transcript-plus")
  return transcriptModule
}

/**
 * Fetch the video transcript via the youtube-transcript-plus package
 * (InnerTube API). Returns joined transcript text — already capped at
 * YOUTUBE_TRANSCRIPT_MAX_LENGTH — or null if unavailable.
 * Uses dynamic import to isolate the dependency.
 */
export async function fetchYouTubeTranscript(videoId: string): Promise<string | null> {
  try {
    const { YoutubeTranscript } = await getTranscriptModule()
    const segments = await YoutubeTranscript.fetchTranscript(videoId)
    if (!segments || segments.length === 0) return null

    const text = segments
      .map((s: { text: string }) =>
        s.text
          .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"')
          .replace(/&nbsp;/g, " ")
      )
      .join(" ")

    if (!text) return null
    return truncateAtWordBoundary(text, YOUTUBE_TRANSCRIPT_MAX_LENGTH)
  } catch (error) {
    console.error(`[YouTube] Transcript fetch failed for ${videoId}:`, error instanceof Error ? error.message : error)
    return null
  }
}
