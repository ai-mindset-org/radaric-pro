import { DOMParser } from "linkedom"
import { db } from "@/lib/db"

interface SourceInput {
  type: string
  url: string
}

const FETCH_TIMEOUT_MS = 10_000

function fetchWithTimeout(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

/**
 * Fetches a cover image URL for a given source.
 *
 * - RSS/TWITTER: parses og:image or twitter:image from the source HTML
 * - TELEGRAM: calls the worker channel-info endpoint for the channel photo
 * - EVENT_TRIGGER: returns null immediately (no network request)
 *
 * Returns null on any error or when no image is found.
 */
export async function fetchSourceCover(source: SourceInput): Promise<string | null> {
  if (source.type === "EVENT_TRIGGER" || source.type === "INTEREST") {
    return null
  }

  if (source.type === "TELEGRAM") {
    return fetchTelegramCover(source.url)
  }

  if (source.type === "TWITTER") {
    return fetchTwitterCover(source.url)
  }

  // YOUTUBE: the stored canonical channel URL serves og:image = channel avatar
  if (source.type === "YOUTUBE") {
    return fetchHtmlCover(source.url)
  }

  // RSS: try parsing the feed to get homepage link, then fetch OG from there
  if (source.type === "RSS") {
    return fetchRssCover(source.url)
  }

  // Fallback for any other type
  return fetchHtmlCover(source.url)
}

async function fetchHtmlCover(url: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url)
    if (!response.ok) return null

    const contentLength = parseInt(response.headers.get("content-length") || "0", 10)
    if (contentLength > 5 * 1024 * 1024) return null

    const html = await response.text()
    return extractOgFromHtml(html, url)
  } catch {
    return null
  }
}

function extractOgFromHtml(html: string, baseUrl: string): string | null {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, "text/html")

  // Try og:image first
  const ogImage = doc.querySelector('meta[property="og:image"]')
  const ogContent = ogImage?.getAttribute("content") ?? ""

  if (ogContent.trim()) {
    return resolveUrl(ogContent, baseUrl)
  }

  // Fall back to twitter:image
  const twitterImage = doc.querySelector('meta[name="twitter:image"]')
  const twitterContent = twitterImage?.getAttribute("content") ?? ""

  if (twitterContent.trim()) {
    return resolveUrl(twitterContent, baseUrl)
  }

  return null
}

function resolveUrl(imageUrl: string, baseUrl: string): string {
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl
  }
  try {
    return new URL(imageUrl, baseUrl).href
  } catch {
    return imageUrl
  }
}

async function fetchRssCover(feedUrl: string): Promise<string | null> {
  try {
    // First try: parse the RSS feed XML to get the homepage link
    const response = await fetchWithTimeout(feedUrl)
    if (!response.ok) return null

    const contentLength = parseInt(response.headers.get("content-length") || "0", 10)
    if (contentLength > 5 * 1024 * 1024) return null

    const text = await response.text()
    const parser = new DOMParser()

    // Check if it's XML (RSS/Atom feed) by looking for feed indicators
    const isXml = text.trimStart().startsWith("<?xml") || text.includes("<rss") || text.includes("<feed")

    if (isXml) {
      const doc = parser.parseFromString(text, "text/xml")

      // Try <image><url> in RSS
      const imageUrl = doc.querySelector("image > url")
      if (imageUrl?.textContent?.trim()) {
        return imageUrl.textContent.trim()
      }

      // Try <icon> in Atom feeds
      const icon = doc.querySelector("icon")
      if (icon?.textContent?.trim()) {
        return icon.textContent.trim()
      }

      // Get homepage link and fetch OG from there
      // RSS: <channel><link>https://example.com</link>
      // Atom: <link href="https://example.com" rel="alternate"/>
      const rssLink = doc.querySelector("channel > link")
      const atomLink = doc.querySelector('link[rel="alternate"]')
      const homepageUrl = rssLink?.textContent?.trim()
        || atomLink?.getAttribute("href")?.trim()

      if (homepageUrl && homepageUrl.startsWith("http")) {
        return fetchHtmlCover(homepageUrl)
      }
    }

    // If not XML, try parsing as HTML (some "RSS" URLs are actually web pages)
    return extractOgFromHtml(text, feedUrl)
  } catch {
    return null
  }
}

async function fetchTwitterCover(profileUrl: string): Promise<string | null> {
  try {
    const apiKey = process.env.TWITTER_API_IO_KEY
    if (!apiKey) return null

    // Extract username from https://x.com/username
    const username = profileUrl
      .replace(/^https?:\/\/(x\.com|twitter\.com)\//, "")
      .replace(/^@/, "")
      .split("/")[0]
    if (!username) return null

    // Fetch one tweet to get the author's profile picture
    const url = new URL("https://api.twitterapi.io/twitter/user/last_tweets")
    url.searchParams.set("userName", username)

    const response = await fetch(url.toString(), {
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return null

    const data = await response.json()
    const tweets = data.data?.tweets || data.tweets || []
    if (tweets.length > 0 && tweets[0].author?.profilePicture) {
      // Twitter profile pictures have _normal suffix for small size, remove for full size
      return tweets[0].author.profilePicture.replace("_normal", "")
    }

    return null
  } catch {
    return null
  }
}

async function fetchTelegramCover(channelUrl: string): Promise<string | null> {
  try {
    // Extract channel username from URL like https://t.me/mychannel
    const username = channelUrl
      .replace(/^https?:\/\/(t\.me|telegram\.me)\//, "")
      .replace(/^@/, "")
      .split("/")[0]
    if (!username) return null

    const workerPort = process.env.WORKER_HEALTH_PORT || "3001"
    const workerUrl = `http://localhost:${workerPort}`
    const endpoint = `${workerUrl}/telegram/channel-info?username=${encodeURIComponent(username)}&includePhoto=true`

    const response = await fetchWithTimeout(endpoint)
    if (!response.ok) return null

    const data = await response.json()
    return data.photoUrl ?? null
  } catch {
    return null
  }
}

/**
 * Reads a source from DB by id, fetches its cover image, and saves it to DB.
 * Does NOT overwrite if coverUrl is already set.
 */
export async function saveSourceCover(sourceId: string, userId?: string): Promise<void> {
  const source = await db.feed.findUnique({
    where: userId ? { id: sourceId, userId } : { id: sourceId },
  })
  if (!source) return

  // Guard: do not overwrite an existing cover
  if (source.coverUrl) return

  const coverUrl = await fetchSourceCover({ type: source.type, url: source.url })
  if (!coverUrl) return

  await db.feed.update({
    where: { id: sourceId },
    data: { coverUrl },
  })
}
