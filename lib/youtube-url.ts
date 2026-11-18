/**
 * Pure YouTube URL logic — detection, id extraction, canonical URL builders,
 * and input normalization. No network, no Node APIs: safe to import from
 * client components (feed-form pulls normalizeYouTubeInput via
 * lib/validations/feed.ts). The network/transcript side lives in
 * lib/youtube.ts, which re-exports everything here for server callers.
 */

const YOUTUBE_URL_REGEX =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i

const CHANNEL_ID_PATTERN = "UC[A-Za-z0-9_-]{22}"
const YT_HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/

/**
 * Check if a URL is a YouTube video link.
 */
export function isYouTubeUrl(url: string): boolean {
  return YOUTUBE_URL_REGEX.test(url)
}

/**
 * Extract the 11-character video ID from a YouTube URL.
 * Returns null if the URL is not a valid YouTube video URL.
 */
export function extractVideoId(url: string): string | null {
  const match = url.match(YOUTUBE_URL_REGEX)
  return match ? match[1] : null
}

export function youtubeChannelUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`
}

export function youtubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
}

/**
 * Extract a UC… channel id from a canonical /channel/ URL or a channel feed
 * XML URL. Pure — returns null for handle/video/non-YouTube URLs.
 */
export function extractChannelId(url: string): string | null {
  const s = url.trim()
  if (!/^(?:https?:\/\/)?(?:[\w-]+\.)*youtube\.com\//i.test(s)) return null

  const channelMatch = s.match(new RegExp(`/channel/(${CHANNEL_ID_PATTERN})(?:[/?#]|$)`))
  if (channelMatch) return channelMatch[1]

  const feedMatch = s.match(
    new RegExp(`/feeds/videos\\.xml\\?(?:[^#]*&)?channel_id=(${CHANNEL_ID_PATTERN})(?:[&#]|$)`)
  )
  return feedMatch ? feedMatch[1] : null
}

/**
 * Normalize any channel paste format to a fetchable YouTube URL (pure, no network):
 * @handle · bare handle · youtube.com/@handle · /channel/UC… (→ canonical) ·
 * feed XML (→ canonical) · legacy /c/ /user/ · video URLs (passed through for
 * oEmbed resolution). Returns null for playlists and non-YouTube input.
 */
export function normalizeYouTubeInput(input: string): string | null {
  const s = input.trim()
  if (!s) return null

  if (s.startsWith("@")) {
    const handle = s.slice(1)
    return YT_HANDLE_RE.test(handle) ? `https://www.youtube.com/@${handle}` : null
  }

  // Bare handle — dot-less only (a dotted bare token is ambiguous with a domain)
  if (/^[A-Za-z0-9_-]{3,30}$/.test(s)) {
    return `https://www.youtube.com/@${s}`
  }

  const urlMatch = s.match(/^(?:https?:\/\/)?((?:[\w-]+\.)*(?:youtube\.com|youtu\.be))(\/\S*)?$/i)
  if (!urlMatch) return null
  const host = urlMatch[1].toLowerCase()
  const path = urlMatch[2] ?? "/"

  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    return `https://youtu.be${path}`
  }

  const channelId = extractChannelId(`https://www.youtube.com${path}`)
  if (channelId) return youtubeChannelUrl(channelId)

  // Playlists are out of scope for v1
  if (/^\/playlist\b/.test(path) || /playlist_id=/.test(path)) return null

  const handleMatch = path.match(/^\/@([A-Za-z0-9._-]{3,30})(?:[/?#]|$)/)
  if (handleMatch) return `https://www.youtube.com/@${handleMatch[1]}`

  // Video URLs — preserved verbatim so the resolver can use oEmbed
  if (/^\/(?:watch\?|shorts\/|live\/)/.test(path)) return `https://www.youtube.com${path}`

  const legacyMatch = path.match(/^\/(c|user)\/([^/?#]+)/)
  if (legacyMatch) return `https://www.youtube.com/${legacyMatch[1]}/${legacyMatch[2]}`

  return null
}

export { CHANNEL_ID_PATTERN }
