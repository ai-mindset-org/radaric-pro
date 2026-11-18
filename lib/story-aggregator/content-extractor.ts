import { Readability } from "@mozilla/readability"
import { DOMParser } from "linkedom"
import {
  isYouTubeUrl,
  extractVideoId,
  fetchYouTubeMetadata,
  fetchYouTubeTranscript,
} from "@/lib/youtube"

export interface ExtractedContent {
  title: string | null
  content: string | null
  ogImage: string | null
  author: string | null
}

const DEFAULT_MAX_LENGTH = 5000

// ---------------------------------------------------------------------------
// X.com / Twitter detection & FixTweet extraction
// ---------------------------------------------------------------------------

const TWEET_URL_REGEX =
  /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i

/**
 * Check if a URL is a tweet (x.com or twitter.com status link).
 */
export function isTweetUrl(url: string): boolean {
  return TWEET_URL_REGEX.test(url)
}

/**
 * Convert a tweet URL to the FixTweet API URL.
 * Returns null if the URL is not a valid tweet URL.
 */
export function toFixTweetApiUrl(url: string): string | null {
  const match = url.match(TWEET_URL_REGEX)
  if (!match) return null
  const [, screenName, statusId] = match
  return `https://api.fxtwitter.com/${screenName}/status/${statusId}`
}

/**
 * Extract content from a tweet via the FixTweet API.
 * Returns ExtractedContent with tweet text, author, and media.
 * Never throws — returns all nulls on any error.
 */
export async function extractContentFromTweet(url: string): Promise<ExtractedContent> {
  const nullResult: ExtractedContent = {
    title: null,
    content: null,
    ogImage: null,
    author: null,
  }

  const apiUrl = toFixTweetApiUrl(url)
  if (!apiUrl) return nullResult

  try {
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RadaricBot/1.0)",
      },
    })

    if (!response.ok) return nullResult

    const data = await response.json() as {
      code?: number
      tweet?: {
        text?: string
        author?: { name?: string; screen_name?: string }
        media?: { photos?: Array<{ url?: string }>; videos?: Array<{ thumbnail_url?: string }> }
      }
    }

    if (!data.tweet) return nullResult

    const tweet = data.tweet
    const authorName = tweet.author?.name ?? null
    const screenName = tweet.author?.screen_name
    const author = authorName && screenName
      ? `${authorName} (@${screenName})`
      : authorName

    // Use first photo or video thumbnail as ogImage
    const ogImage =
      tweet.media?.photos?.[0]?.url ??
      tweet.media?.videos?.[0]?.thumbnail_url ??
      null

    const title = author
      ? `${author} on X`
      : "Post on X"

    return {
      title,
      content: tweet.text ? truncateContent(tweet.text) : null,
      ogImage,
      author,
    }
  } catch {
    return nullResult
  }
}

// ---------------------------------------------------------------------------
// YouTube detection & transcript extraction
// ---------------------------------------------------------------------------
// Primitives live in lib/youtube.ts (shared with the YouTube feed parser);
// re-exported here so existing importers keep working.

export { isYouTubeUrl, extractVideoId }

/**
 * Extract content from a YouTube video — metadata + transcript.
 * Never throws — returns all nulls on any error.
 */
export async function extractContentFromYouTube(url: string): Promise<ExtractedContent> {
  const nullResult: ExtractedContent = {
    title: null,
    content: null,
    ogImage: null,
    author: null,
  }

  const videoId = extractVideoId(url)
  if (!videoId) return nullResult

  try {
    const [metadata, transcript] = await Promise.all([
      fetchYouTubeMetadata(videoId),
      fetchYouTubeTranscript(videoId),
    ])

    const title =
      metadata.title && metadata.author
        ? `${metadata.title} — ${metadata.author}`
        : metadata.title ?? null

    let content: string
    const headerParts: string[] = []
    if (metadata.title) headerParts.push(`Video: ${metadata.title}`)
    if (metadata.author) headerParts.push(`Channel: ${metadata.author}`)
    const header = headerParts.join("\n")

    if (transcript) {
      // Transcript arrives pre-capped at YOUTUBE_TRANSCRIPT_MAX_LENGTH
      content = header
        ? `${header}\n\nTranscript:\n${transcript}`
        : `Transcript:\n${transcript}`
    } else {
      content = header
        ? `${header}\nVideo content without available transcript.`
        : "Video content without available transcript."
    }

    return {
      title,
      content,
      ogImage: metadata.thumbnail,
      author: metadata.author,
    }
  } catch {
    return nullResult
  }
}

/**
 * Truncate text to maxLength characters at a word boundary, appending "..."
 * if truncation occurs. Returns text unchanged when length <= maxLength.
 */
export function truncateContent(text: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  if (text.length <= maxLength) {
    return text
  }

  // Find the last space at or before maxLength to avoid cutting mid-word
  const slice = text.slice(0, maxLength)
  const lastSpace = slice.lastIndexOf(" ")

  if (lastSpace === -1) {
    // No word boundary found — hard cut
    return slice + "..."
  }

  return slice.slice(0, lastSpace) + "..."
}

/**
 * Extract content from a plain-text string.
 * The first non-empty line becomes the title; the full text becomes content (truncated).
 * Returns null title and content for an empty string.
 */
export function extractContentFromText(rawText: string): ExtractedContent {
  if (!rawText) {
    return { title: null, content: null, ogImage: null, author: null }
  }

  const lines = rawText.split("\n")
  const firstNonEmpty = lines.find((line) => line.trim().length > 0) ?? null

  return {
    title: firstNonEmpty,
    content: truncateContent(rawText),
    ogImage: null,
    author: null,
  }
}

/**
 * Fetch a URL and extract article content using Readability + linkedom.
 * For X.com/Twitter URLs, uses the FixTweet API instead (X.com returns
 * empty JS shells that Readability cannot parse).
 * Also extracts og:image from the page's meta tags.
 * Never throws — returns all nulls on any error or for non-HTML responses.
 */
export async function extractContentFromUrl(url: string): Promise<ExtractedContent> {
  // X.com / Twitter — use FixTweet API
  if (isTweetUrl(url)) {
    return extractContentFromTweet(url)
  }

  // YouTube — extract transcript + metadata
  if (isYouTubeUrl(url)) {
    return extractContentFromYouTube(url)
  }

  const nullResult: ExtractedContent = {
    title: null,
    content: null,
    ogImage: null,
    author: null,
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RadaricBot/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
      },
    })

    if (!response.ok) {
      return nullResult
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/html")) {
      return nullResult
    }

    const html = await response.text()
    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")

    // Extract og:image before Readability modifies the document
    const ogImageMeta = document.querySelector('meta[property="og:image"]')
    const ogImage = ogImageMeta?.getAttribute("content") ?? null

    // Extract author from meta tag
    const authorMeta = document.querySelector('meta[name="author"]')
    const author = authorMeta?.getAttribute("content") ?? null

    // Use Readability to extract clean article content
    const reader = new Readability(document as unknown as Document)
    const article = reader.parse()

    if (!article) {
      return { ...nullResult, ogImage, author }
    }

    const rawContent = article.textContent?.trim() || article.content?.trim() || ""

    return {
      title: article.title || null,
      content: rawContent ? truncateContent(rawContent) : null,
      ogImage,
      author: article.byline || author || null,
    }
  } catch {
    return nullResult
  }
}
