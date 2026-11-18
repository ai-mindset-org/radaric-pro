import type { ParsedItem } from "./rss"
import { extractOpenGraphImage, extractOpenGraphTitle } from "./rss"
import { sleep } from "@/lib/sleep"
import { extractTwitterUsername } from "@/lib/validations/feed"
import { capTitle, derivePostTitle, HEADLINE_MAX_LENGTH } from "@/lib/title"

const TWITTER_API_BASE = "https://api.twitterapi.io"

/** Videos longer than this are skipped — 5 minutes in milliseconds */
const MAX_VIDEO_DURATION_MS = 300_000

/** Maximum pages to fetch when paginating with sinceId */
const MAX_PAGES = 3

/** Delay between TwitterAPI.io requests to respect rate limits.
 * Free tier: 5500ms (1 req/5s). Paid tier: set TWITTER_RATE_LIMIT_MS=100 in env. */
export const TWITTER_RATE_LIMIT_MS = parseInt(process.env.TWITTER_RATE_LIMIT_MS || "5500", 10) || 5500

/**
 * Module-level rate limiter for TwitterAPI.io calls.
 * Persists across HTTP requests within the same Node.js process.
 * Must be called before every API call (pagination + cross-source).
 */
let lastApiCallTime = 0

async function waitForRateLimit(): Promise<void> {
  const now = Date.now()
  const elapsed = now - lastApiCallTime
  if (lastApiCallTime > 0 && elapsed < TWITTER_RATE_LIMIT_MS) {
    const delay = TWITTER_RATE_LIMIT_MS - elapsed
    console.log(`[Twitter Parser] Rate limit: waiting ${Math.round(delay / 1000)}s`)
    await sleep(delay)
  }
  // Don't set lastApiCallTime here — set it AFTER the fetch completes
  // so the 5.5s window starts from response, not from request start
}

/** Mark that an API call just completed — call after every fetch */
function markApiCallDone(): void {
  lastApiCallTime = Date.now()
}

export type TwitterSourceType = "ACCOUNT" | "SEARCH"

export interface TwitterSourceConfig {
  type: TwitterSourceType
  value: string // username for ACCOUNT, query for SEARCH
}

// TwitterAPI.io response types
interface TwitterApiMediaItem {
  media_url_https?: string
  type?: string // "photo" | "video" | "animated_gif"
  video_info?: {
    duration_millis?: number
    variants?: { url: string; bitrate?: number; content_type?: string }[]
  }
}

interface TwitterApiTweet {
  id: string
  url: string
  text: string
  createdAt: string
  author: {
    userName: string
    name: string
    profilePicture?: string
  }
  extendedEntities?: {
    media?: TwitterApiMediaItem[]
  }
  entities?: {
    urls?: { expanded_url: string }[]
  }
  isReply: boolean
  retweetCount: number
  likeCount: number
  quoteCount: number
  replyCount: number
  viewCount: number
  quoted_tweet?: TwitterApiTweet | null
  retweeted_tweet?: TwitterApiTweet | null
}

interface TwitterApiResponse {
  status: "success" | "error"
  msg?: string
  data?: {
    tweets: TwitterApiTweet[]
  }
  // Also support flat format (for backward compat / docs)
  tweets?: TwitterApiTweet[]
  has_next_page: boolean
  next_cursor: string
}

/**
 * Reject internal/private network addresses to prevent SSRF via tweet URLs.
 */
function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
    const host = parsed.hostname.toLowerCase()
    // IPv4 loopback & unspecified
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0") return false
    // IPv6 loopback & private ranges
    if (host === "::1" || host === "[::1]") return false
    if (host.startsWith("fe80:") || host.startsWith("fc00:") || host.startsWith("fd")) return false
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    if (host.startsWith("::ffff:")) return false
    // Private IPv4 ranges
    if (host.startsWith("10.")) return false
    if (host.startsWith("192.168.")) return false
    // 172.16.0.0/12 (172.16.x.x – 172.31.x.x)
    if (host.startsWith("172.")) {
      const second = parseInt(host.split(".")[1], 10)
      if (second >= 16 && second <= 31) return false
    }
    // AWS/cloud metadata
    if (host === "169.254.169.254") return false
    if (host.endsWith(".internal") || host.endsWith(".local")) return false
    return true
  } catch {
    return false
  }
}

function getApiKey(): string {
  const key = process.env.TWITTER_API_IO_KEY
  if (!key) {
    throw new Error(
      "TWITTER_API_IO_KEY environment variable is not set. Get an API key at twitterapi.io"
    )
  }
  return key
}

/**
 * "… from @user" fallback used when the tweet's text yields no lede headline
 * (link-only tweets, media-only tweets). Picked by what the tweet carries:
 * video > photo/animated_gif > external link > plain post.
 */
function kindFallbackTitle(tweet: TwitterApiTweet): string {
  const user = tweet.author.userName
  const media = tweet.extendedEntities?.media ?? []
  if (media.some((m) => m.type === "video")) return `Video from @${user}`
  if (media.some((m) => m.type === "photo" || m.type === "animated_gif")) return `Photo from @${user}`
  const urls = tweet.entities?.urls ?? []
  const hasExternalLink = urls.some(
    (u) => !u.expanded_url.includes("twitter.com") && !u.expanded_url.includes("x.com")
  )
  if (hasExternalLink) return `Link from @${user}`
  return `Post from @${user}`
}

/**
 * Collect playable media URLs from a tweet: photos as-is, videos/GIFs as their
 * highest-bitrate mp4, videos over MAX_VIDEO_DURATION_MS skipped.
 */
function extractMediaUrls(tweet: TwitterApiTweet): string[] {
  const mediaUrls: string[] = []

  if (tweet.extendedEntities?.media) {
    for (const media of tweet.extendedEntities.media) {
      if (media.type === "photo" && media.media_url_https) {
        mediaUrls.push(media.media_url_https)
      } else if (
        (media.type === "video" || media.type === "animated_gif") &&
        media.video_info?.variants
      ) {
        // Skip videos longer than MAX_VIDEO_DURATION_MS (animated_gifs are always short, skip check)
        if (
          media.type === "video" &&
          media.video_info.duration_millis !== undefined &&
          media.video_info.duration_millis > MAX_VIDEO_DURATION_MS
        ) {
          console.log(`[Twitter Parser] Skipping video (${Math.round(media.video_info.duration_millis / 1000)}s > ${MAX_VIDEO_DURATION_MS / 1000}s limit)`)
          continue
        }
        // Pick highest bitrate mp4 variant, fall back to thumbnail
        const mp4s = media.video_info.variants.filter(
          (v) => v.content_type === "video/mp4" && v.url
        )
        const best = mp4s.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]
        if (best) mediaUrls.push(best.url)
        else if (media.media_url_https) mediaUrls.push(media.media_url_https)
      } else if (media.media_url_https) {
        mediaUrls.push(media.media_url_https)
      }
    }
  }

  return mediaUrls
}

/** "Name (@handle)", degrading to "@handle" or "a post" when the author is partial. */
function quoteAttribution(quoted: TwitterApiTweet): string {
  const handle = quoted.author?.userName
  const name = quoted.author?.name?.trim()
  if (handle) return name ? `${name} (@${handle})` : `@${handle}`
  return name || "a post"
}

/**
 * Convert TwitterAPI.io tweet to ParsedItem format, alongside whether its
 * title is a derived lede (vs. a kind fallback like "Photo from @user") —
 * callers that also need this flag get it without re-deriving the title.
 */
function tweetToParsedItem(
  tweet: TwitterApiTweet
): { item: ParsedItem; derivedTitle: boolean; ownMediaCount: number } {
  // Own media first, then the quoted post's (one level — a quote's own quote is
  // ignored), deduped in case both carry the same file
  const quoted = tweet.quoted_tweet
  const ownMedia = extractMediaUrls(tweet)
  const mediaUrls = quoted ? [...new Set([...ownMedia, ...extractMediaUrls(quoted)])] : ownMedia

  // API already prefixes retweet text with "RT @user: ..." — use as-is. A quoted
  // post is appended in full under an attribution line (RAD-398); the author's own
  // text stays first so the title and the reading-page lede come from it alone.
  // A deleted or withheld quoted post can arrive as a stub without text or author;
  // it must never throw, or the whole feed parse fails.
  let content = tweet.text
  if (quoted && typeof quoted.text === "string" && quoted.text.trim()) {
    const quoteBlock = `Quoting ${quoteAttribution(quoted)}:\n${quoted.text}`
    content = content ? `${content}\n\n${quoteBlock}` : quoteBlock
  }

  // Parse Twitter's date format: "Tue Dec 10 07:00:30 +0000 2024"
  const publishedAt = tweet.createdAt ? new Date(tweet.createdAt) : null

  const derivedTitle = derivePostTitle(tweet.text)

  return {
    item: {
      title: derivedTitle ?? kindFallbackTitle(tweet),
      url: tweet.url || `https://x.com/${tweet.author.userName}/status/${tweet.id}`,
      externalId: `twitter:${tweet.id}`,
      content,
      publishedAt: publishedAt && !isNaN(publishedAt.getTime()) ? publishedAt : null,
      excerpt: content.slice(0, 280),
      thumbnailUrl: mediaUrls[0],
      mediaUrls,
    },
    derivedTitle: derivedTitle !== null,
    ownMediaCount: ownMedia.length,
  }
}

/**
 * Fetch tweets from a user's timeline via TwitterAPI.io
 */
async function fetchUserTimeline(
  userName: string,
  apiKey: string,
  options?: { sinceId?: string; includeRetweets?: boolean }
): Promise<ParsedItem[]> {
  const sinceId = options?.sinceId
  const includeRetweets = options?.includeRetweets ?? false
  const maxPages = sinceId ? MAX_PAGES : 1
  let cursor: string | undefined
  const allPairs: { item: ParsedItem; tweet: TwitterApiTweet; derivedTitle: boolean; ownMediaCount: number }[] = []
  let foundSinceId = false

  for (let page = 0; page < maxPages; page++) {
    // Global rate limit: wait if another API call was made recently (any source, any page)
    await waitForRateLimit()

    const url = new URL(`${TWITTER_API_BASE}/twitter/user/last_tweets`)
    url.searchParams.set("userName", userName)
    if (cursor) url.searchParams.set("cursor", cursor)

    console.log(`[Twitter Parser] Fetching timeline for @${userName} via TwitterAPI.io (page ${page + 1})`)

    let data: TwitterApiResponse
    try {
      const response = await fetch(url.toString(), {
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(15_000),
      })
      markApiCallDone()

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`TwitterAPI.io returned ${response.status}: ${text}`)
      }

      const raw = await response.text()
      try {
        data = JSON.parse(raw)
      } catch {
        throw new Error(
          `TwitterAPI.io returned invalid JSON (status ${response.status}): ${raw.slice(0, 200)}`
        )
      }

      if (data.status === "error") {
        throw new Error(`TwitterAPI.io error: ${data.msg || "Unknown error"}`)
      }
    } catch (error) {
      if (page > 0) {
        // ERR-1: graceful degradation on subsequent pages
        break
      }
      throw error
    }

    // API returns tweets under data.tweets or tweets (handle both)
    let tweets = data.data?.tweets || data.tweets || []

    // sinceId truncation on raw tweets (before reply filtering)
    if (sinceId) {
      const sinceIndex = tweets.findIndex((t) => t.id === sinceId)
      if (sinceIndex !== -1) {
        tweets = tweets.slice(0, sinceIndex)
        foundSinceId = true
      }
    }

    console.log(`[Twitter Parser] Got ${tweets.length} tweets for @${userName}`)

    for (const tweet of tweets.filter((t) => !t.isReply && (includeRetweets || !t.retweeted_tweet))) {
      allPairs.push({ ...tweetToParsedItem(tweet), tweet })
    }

    if (foundSinceId || !data.has_next_page) break
    cursor = data.next_cursor || undefined
  }

  // For tweets with no native media of their own, try to extract OG image from
  // linked URLs — a quoted post's media must not suppress the author's own link.
  // Cap concurrency to 5 to avoid thundering herd on external domains
  const OG_FETCH_CONCURRENCY = 5
  const ogTasks = allPairs.filter(({ ownMediaCount }) => ownMediaCount === 0)
  for (let i = 0; i < ogTasks.length; i += OG_FETCH_CONCURRENCY) {
    const chunk = ogTasks.slice(i, i + OG_FETCH_CONCURRENCY)
    await Promise.all(
      chunk.map(async ({ item, tweet, derivedTitle }) => {
      const urls = tweet.entities?.urls ?? []
      const externalUrl = urls.find(
        (u) =>
          !u.expanded_url.includes("twitter.com") &&
          !u.expanded_url.includes("x.com")
      )
      if (!externalUrl || !isSafeExternalUrl(externalUrl.expanded_url)) return
      try {
        const res = await fetch(externalUrl.expanded_url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; RadaricBot/1.0)" },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) return
        // Validate final URL after redirects to prevent SSRF via 302
        if (res.url && !isSafeExternalUrl(res.url)) return
        // Only parse HTML responses
        const contentType = res.headers.get("content-type") || ""
        if (!contentType.includes("text/html") && !contentType.includes("application/xhtml")) return
        // Skip excessively large responses (> 2MB) to prevent memory issues
        const contentLength = res.headers.get("content-length")
        if (contentLength && parseInt(contentLength, 10) > 2_000_000) return
        // Stream body with hard byte limit (Content-Length can be absent or spoofed)
        const MAX_OG_BODY = 2_000_000
        const reader = res.body?.getReader()
        if (!reader) return
        const chunks: Uint8Array[] = []
        let totalBytes = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          totalBytes += value.byteLength
          if (totalBytes > MAX_OG_BODY) { reader.cancel(); return }
          chunks.push(value)
        }
        const html = new TextDecoder().decode(Buffer.concat(chunks))
        const ogImage = extractOpenGraphImage(html, externalUrl.expanded_url)
        if (ogImage) {
          item.mediaUrls.unshift(ogImage)
          item.thumbnailUrl = ogImage
        }
        // Only override the title when the tweet text itself yielded no lede —
        // a real derived headline takes precedence over the linked page's title.
        if (!derivedTitle) {
          // Third-party page text: collapse newlines/control characters and cap
          // it to a headline before it reaches the DB, the UI and the AI prompt.
          const ogTitle = extractOpenGraphTitle(html)
            ?.replace(/[\u0000-\u001f\u007f]+/g, " ")
            .replace(/\s+/g, " ")
            .trim()
          if (ogTitle) item.title = capTitle(ogTitle, HEADLINE_MAX_LENGTH)
        }
      } catch {
        // Network error or timeout — leave item without media
      }
      })
    )
  }

  return allPairs.map(({ item }) => item)
}

/**
 * Parse Twitter source via TwitterAPI.io
 */
export async function parseTwitterSource(
  config: TwitterSourceConfig,
  sinceId?: string,
  options?: { includeRetweets?: boolean }
): Promise<ParsedItem[]> {
  if (config.type === "SEARCH") {
    throw new Error("Twitter search is not supported. Use specific accounts.")
  }

  const apiKey = getApiKey()
  const username = config.value.replace(/^@/, "").trim()
  return fetchUserTimeline(username, apiKey, { sinceId, includeRetweets: options?.includeRetweets })
}

/**
 * Extract TwitterSourceConfig from a source URL.
 * Supports: x.com, twitter.com, legacy Nitter URLs, legacy RSSHub URLs.
 */
export function parseSourceUrlToConfig(url: string): TwitterSourceConfig | null {
  // x.com / twitter.com format: /username or /username/...
  const RESERVED_PATHS = [
    "search", "hashtag", "i", "home", "explore", "notifications",
    "messages", "settings", "compose", "lists", "bookmarks",
    "communities", "premium", "jobs", "tos", "privacy",
  ]
  const xMatch = url.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]+)/)
  if (xMatch && !RESERVED_PATHS.includes(xMatch[1].toLowerCase())) {
    return { type: "ACCOUNT", value: xMatch[1] }
  }

  // Legacy Nitter format: nitter.*/username/rss
  const nitterMatch = url.match(/nitter\.[^/]+\/([^/]+)\/rss$/)
  if (nitterMatch) {
    return { type: "ACCOUNT", value: nitterMatch[1] }
  }

  // Legacy RSSHub format: /twitter/user/{username}
  const rsshubMatch = url.match(/\/twitter\/user\/([^/?]+)/)
  if (rsshubMatch) {
    return { type: "ACCOUNT", value: decodeURIComponent(rsshubMatch[1]) }
  }

  return null
}

/** @deprecated Use parseSourceUrlToConfig */
export function parseRSSHubUrlToConfig(url: string): TwitterSourceConfig | null {
  return parseSourceUrlToConfig(url)
}

/** @deprecated Use parseSourceUrlToConfig */
export function parseNitterUrlToConfig(url: string): TwitterSourceConfig | null {
  return parseSourceUrlToConfig(url)
}

/**
 * Build the canonical URL stored in the database for a Twitter source
 */
export function buildTwitterSourceUrl(config: TwitterSourceConfig): string {
  if (config.type === "SEARCH") {
    throw new Error("Twitter search is not supported. Use specific accounts.")
  }
  // Full extraction, not just @-stripping — a pasted profile URL must not
  // nest into https://x.com/https://x.com/user
  const username = extractTwitterUsername(config.value)
  if (!username) {
    throw new Error(`Cannot extract a Twitter username from "${config.value}"`)
  }
  return `https://x.com/${username}`
}

/** @deprecated Use buildTwitterSourceUrl */
export function buildNitterUrl(config: TwitterSourceConfig): string {
  return buildTwitterSourceUrl(config)
}

/** @deprecated Use buildTwitterSourceUrl */
export function buildRSSHubUrl(config: TwitterSourceConfig): string {
  return buildTwitterSourceUrl(config)
}

/**
 * Validate Twitter username format
 */
export function validateTwitterUsername(username: string): {
  valid: boolean
  error?: string
  normalized?: string
} {
  const cleaned = username.replace(/^@/, "").trim()

  if (!cleaned) {
    return { valid: false, error: "Username is required" }
  }

  if (cleaned.length > 15) {
    return { valid: false, error: "Username cannot exceed 15 characters" }
  }

  if (!/^[A-Za-z0-9_]+$/.test(cleaned)) {
    return {
      valid: false,
      error: "Username can only contain letters, digits, and _",
    }
  }

  return { valid: true, normalized: cleaned }
}

/**
 * Validate Twitter search query
 */
export function validateTwitterQuery(query: string): {
  valid: boolean
  error?: string
} {
  const trimmed = query.trim()

  if (trimmed.length < 2) {
    return { valid: false, error: "Search query must be at least 2 characters" }
  }

  if (trimmed.length > 500) {
    return { valid: false, error: "Search query is too long (max 500 characters)" }
  }

  return { valid: true }
}

/**
 * Get Twitter source metadata for display
 */
export function getTwitterMetadata(config: TwitterSourceConfig): {
  name: string
  description: string
} {
  switch (config.type) {
    case "ACCOUNT": {
      const username = config.value.replace(/^@/, "")
      return {
        name: `@${username}`,
        description: `Twitter account @${username}`,
      }
    }
    case "SEARCH":
      return {
        name: `Twitter: "${config.value}"`,
        description: `Twitter search: "${config.value}"`,
      }
  }
}

/**
 * Check if a URL is a Twitter source URL (any supported format)
 */
export function isTwitterSourceUrl(url: string): boolean {
  return parseSourceUrlToConfig(url) !== null
}

/** @deprecated Use isTwitterSourceUrl */
export function isNitterUrl(url: string): boolean {
  return /nitter\.[^/]+\/[^/]+\/rss/.test(url)
}

/** @deprecated Use isTwitterSourceUrl */
export function isTwitterRSSHubUrl(url: string): boolean {
  return isNitterUrl(url) || /\/twitter\/(user|search)\//.test(url)
}
