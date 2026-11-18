/**
 * Notion blocks for a post's / story's media (RAD-401).
 *
 * Both Notion exports — a single post (`sendMaterialToNotion`) and a story
 * (`buildNotionBlocks`) — used to pick images by an extension allowlist, cap
 * them, and turn every video into a bookmark. A post's media already arrive
 * classified (`postMediaEntries`, `storyDetailMedia`), so this module only maps
 * a kind onto the Notion block that plays it. Every block links the external
 * URL; nothing is uploaded to Notion.
 */
import type { MediaKind } from "./media-urls"

export type NotionMediaEntry = { url: string; kind: MediaKind }

type NotionBlock = Record<string, unknown>

/**
 * Notion rejects an external URL longer than 2000 characters with a
 * `validation_error` that fails the WHOLE request (live probe, 2026-10-11), so
 * one oversized CDN link would cost the page every other block.
 */
const NOTION_URL_MAX = 2000

/**
 * The YouTube URLs Notion's `video` block plays: a single video addressed as
 * `/watch?v=<id>`, `/embed/<id>` or `youtu.be/<id>` (all accepted by the live
 * probe). Every other YouTube URL — `/shorts/`, `/live/`, a playlist's
 * `/embed/videoseries`, a channel's `/embed/live_stream`, a channel page — and every other embed host, Vimeo's
 * player included, goes into a generic `embed` block.
 */
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com"]

function isYouTubeVideoUrl(url: URL): boolean {
  if (url.hostname === "youtu.be") return /^\/[^/]+$/.test(url.pathname)
  if (!YOUTUBE_HOSTS.includes(url.hostname)) return false
  if (url.pathname === "/watch") return !!url.searchParams.get("v")
  const embed = url.pathname.match(/^\/embed\/([^/]+)$/)
  return !!embed && embed[1] !== "videoseries" && embed[1] !== "live_stream"
}

/**
 * The one URL a block may carry: absolute http(s), trimmed, and in the parsed
 * `href` form (spaces and non-ASCII percent-encoded). Parser output is not that
 * — a relative `/img/og.png`, a protocol-relative `//cdn…`, a `data:` or `tg:`
 * reference — and Notion answers any of them with a `validation_error` that
 * fails the whole page, so they are dropped here rather than at every caller.
 * The length limit is measured on the href, since that is what Notion receives.
 */
function notionUrl(raw: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
  if (parsed.href.length > NOTION_URL_MAX) return null
  return parsed
}

/** A `.pdf` path, judged before the query or fragment (signed CDN links carry both). */
const PDF_EXTENSION = /\.pdf(?=[?#]|$)/i

function external(type: string, url: string): NotionBlock {
  return { type, [type]: { type: "external", external: { url } } }
}

/** One media entry → the Notion block that shows it, or null when Notion cannot. */
export function notionMediaBlock(entry: NotionMediaEntry): NotionBlock | null {
  const parsed = notionUrl(entry.url)
  if (!parsed) return null
  const url = parsed.href
  switch (entry.kind) {
    case "image":
      return external("image", url)
    case "video":
      return external("video", url)
    case "embed":
      return isYouTubeVideoUrl(parsed) ? external("video", url) : { type: "embed", embed: { url } }
    case "audio":
      return external("audio", url)
    case "document":
      return external(PDF_EXTENSION.test(url) ? "pdf" : "file", url)
    default:
      // A Telegram placeholder names no file, and an unknown kind is an article
      // page more often than a picture — neither has a block to go in.
      return null
  }
}

/**
 * Split media into the page's cover — the first image Notion accepts — and the
 * rest in their original order. An image skipped for its URL (malformed or too
 * long) does not take the cover with it: the next mappable image becomes the
 * cover.
 */
export function notionMediaSections(entries: NotionMediaEntry[]): {
  cover: NotionBlock | null
  rest: NotionBlock[]
} {
  let cover: NotionBlock | null = null
  const rest: NotionBlock[] = []
  for (const entry of entries) {
    const block = notionMediaBlock(entry)
    if (!block) continue
    if (!cover && entry.kind === "image") cover = block
    else rest.push(block)
  }
  return { cover, rest }
}
