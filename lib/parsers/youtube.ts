import Parser from "rss-parser"
import pLimit from "p-limit"
import {
  extractChannelId,
  fetchYouTubeTranscript,
  resolveYouTubeChannel,
  youtubeFeedUrl,
} from "@/lib/youtube"
import type { ParsedItem } from "./rss"
import { capTitle } from "@/lib/title"

const FEED_FETCH_TIMEOUT_MS = 15_000
const TRANSCRIPT_TIMEOUT_MS = 30_000
const TRANSCRIPT_CONCURRENCY = 3
const MAX_ITEMS = 20
const USER_AGENT = "Mozilla/5.0 (compatible; RadaricBot/1.0)"

interface MediaThumbnail {
  $?: { url?: string }
}

interface YouTubeFeedEntry {
  title?: string
  link?: string
  isoDate?: string
  pubDate?: string
  videoId?: string
  mediaGroup?: {
    "media:description"?: string[]
    "media:thumbnail"?: MediaThumbnail[]
  }
}

const feedParser: Parser<Record<string, never>, YouTubeFeedEntry> = new Parser({
  customFields: {
    item: [
      ["yt:videoId", "videoId"],
      ["media:group", "mediaGroup"],
    ],
  },
})

/** Reject if `work` doesn't settle within `ms` (the underlying request keeps running but is ignored). */
function raceTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms)
    }),
  ])
}

function buildContent(opts: {
  title: string
  channelTitle: string | null
  description: string
  transcript: string | null
}): string {
  const headerParts = [`Video: ${opts.title}`]
  if (opts.channelTitle) headerParts.push(`Channel: ${opts.channelTitle}`)
  const parts = [headerParts.join("\n")]
  if (opts.description) parts.push(opts.description)
  if (opts.transcript) parts.push(`Transcript:\n${opts.transcript}`)
  return parts.join("\n\n")
}

/**
 * Parse a YouTube channel into ParsedItems: channel RSS (15 latest videos) +
 * per-video transcript as content (capped at 12k inside fetchYouTubeTranscript).
 *
 * Transcripts are fetched only for videos NOT in `knownExternalIds` — known
 * ones are returned shallow and dropped by the route's dedup anyway. One
 * failed/hung transcript degrades only its own video to title+description
 * (per-item catch); it never fails the channel parse.
 */
export async function parseYouTubeChannel(
  url: string,
  opts: { knownExternalIds?: Set<string>; transcriptTimeoutMs?: number } = {}
): Promise<ParsedItem[]> {
  // Feed.url stores the canonical /channel/UC… form; resolve once if a
  // non-canonical URL slipped through an uncanonicalized write path.
  let channelId = extractChannelId(url)
  if (!channelId) {
    channelId = (await resolveYouTubeChannel(url)).channelId
  }

  const response = await fetch(youtubeFeedUrl(channelId), {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`YouTube channel feed returned ${response.status}`)
  }
  const xml = await response.text()
  const feed = await feedParser.parseString(xml)
  const channelTitle = feed.title ?? null

  const transcriptTimeoutMs = opts.transcriptTimeoutMs ?? TRANSCRIPT_TIMEOUT_MS
  const limit = pLimit(TRANSCRIPT_CONCURRENCY)

  const items = await Promise.all(
    (feed.items ?? []).slice(0, MAX_ITEMS).map((entry) =>
      limit(async (): Promise<ParsedItem | null> => {
        const videoId = entry.videoId
        if (!videoId) return null

        const externalId = `youtube:${videoId}`
        const title = capTitle(entry.title || "Untitled video")
        const description = entry.mediaGroup?.["media:description"]?.[0]?.trim() ?? ""
        const thumbnailUrl = entry.mediaGroup?.["media:thumbnail"]?.[0]?.$?.url

        let transcript: string | null = null
        if (!opts.knownExternalIds?.has(externalId)) {
          try {
            transcript = await raceTimeout(
              fetchYouTubeTranscript(videoId),
              transcriptTimeoutMs,
              `transcript ${videoId}`
            )
          } catch (error) {
            console.warn(
              `[YouTube] Transcript unavailable for ${videoId}, falling back to description:`,
              error instanceof Error ? error.message : error
            )
          }
        }

        return {
          title,
          url: entry.link || `https://www.youtube.com/watch?v=${videoId}`,
          externalId,
          content: buildContent({ title, channelTitle, description, transcript }),
          publishedAt: entry.isoDate ? new Date(entry.isoDate) : null,
          excerpt: description ? description.slice(0, 200) : undefined,
          thumbnailUrl,
          mediaUrls: thumbnailUrl ? [thumbnailUrl] : [],
        }
      })
    )
  )

  return items.filter((item): item is ParsedItem => item !== null)
}
