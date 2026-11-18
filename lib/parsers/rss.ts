import Parser from "rss-parser"
import { Readability } from "@mozilla/readability"
import { DOMParser } from "linkedom"
import pLimit from "p-limit"
import { sanitizeHtml } from "@/lib/sanitize"
import { truncateContent, isHtml } from "@/lib/html-utils"
import { isAllowedUrl, safeFetch } from "@/lib/url-validation"
import { capTitle, derivePostTitle, HEADLINE_MAX_LENGTH } from "@/lib/title"
import { isLandbookFullPageScreenshot, isRenderableImageUrl } from "@/lib/media-urls"

/**
 * Headers production feed fetching sends. Exported because rss-parser only
 * applies its constructor headers inside `parseURL` — `parseString` never sees
 * them — so anything that fetches a feed itself (see `fetchFeedSummary`) must
 * pass these explicitly, or it hits a different server response than
 * `parseRSSFeed` does and rejects feeds that work fine in production.
 *
 * Don't retune `Accept` for other purposes: this object is the module-level
 * `parser`'s config, so it governs every production feed fetch.
 */
export const FEED_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/rss+xml, application/xml, text/xml, */*",
} as const

const parser = new Parser({ headers: { ...FEED_HEADERS } })

/**
 * The headers the module `parser` will actually send on a production fetch.
 *
 * Read back off the instance rather than re-using the FEED_HEADERS literal, so
 * the probe and production parsing cannot drift apart: any edit to the parser's
 * config is picked up here by construction. (rss-parser merges these over its
 * own DEFAULT_HEADERS inside parseURL — since FEED_HEADERS sets both keys it
 * defaults, the merge result is exactly this object.)
 *
 * The cast is because rss-parser's .d.ts doesn't surface `options`, though the
 * constructor assigns it (lib/parser.js:27).
 */
export function productionFeedHeaders(): Record<string, string> {
  return { ...(parser as unknown as { options: { headers: Record<string, string> } }).options.headers }
}

export interface ParsedItem {
  title: string
  url: string
  externalId: string
  content: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contentEntities?: any[]
  publishedAt: Date | null
  excerpt?: string
  thumbnailUrl?: string
  mediaUrls: string[]
}

/** @deprecated Use ParsedItem */
export type ParsedRSSItem = ParsedItem

/**
 * Title for a feed item. Some feeds (e.g. Bluesky profile RSS) carry no
 * <title> — the post text lives in the description — so fall back to the
 * snippet before giving up. Both the real title and the derived one are
 * length-capped by the shared `capTitle` policy. RAD-268
 */
export function pickItemTitle(item: { title?: string; contentSnippet?: string }): string {
  if (item.title) return capTitle(item.title)
  // `derivePostTitle` already caps at HEADLINE_MAX_LENGTH — no second cap.
  const lede = item.contentSnippet ? derivePostTitle(item.contentSnippet) : null
  if (lede) return lede
  const derived = item.contentSnippet?.trim().replace(/\s+/g, " ")
  return derived ? capTitle(derived, HEADLINE_MAX_LENGTH) : "Untitled"
}

/**
 * How many article pages one feed may fetch-and-parse at a time.
 *
 * The loop used to fire all 20 at once. Each page is 0.5–1 MB and costs ~1 s
 * of SYNCHRONOUS Readability CPU, so the burst serialised into a CPU queue
 * while every fetch's own 5 s deadline kept ticking: measured on the live
 * Behance feed, 9–13 of 20 items timed out and silently fell back to the
 * feed's text — losing exactly the article images RAD-336/RAD-340 exist for,
 * and 0 timed out when the same pages were fetched one burst at a time
 * without parsing. A source has a 180 s watchdog, so the wall clock has room;
 * a few pages in flight keeps each parse inside its deadline.
 */
export const ITEM_FETCH_CONCURRENCY = 5

/**
 * Resolves which of a feed's items are already stored, by url or externalId.
 * The routes' dedupe drops stored items anyway, so fetching their article
 * pages only spends the per-source budget and hits bot checks for nothing:
 * most of a 20-item feed is already stored on every re-parse. (RAD-395)
 */
export type KnownItems = (candidates: { url: string; externalId: string }[]) => Promise<Set<string>>

/**
 * Parse an RSS feed and extract full article content
 */
export async function parseRSSFeed(
  feedUrl: string,
  options: { knownItems?: KnownItems } = {}
): Promise<ParsedItem[]> {
  try {
    // SSRF guard on the primary fetch — internal/metadata hosts must not be
    // reachable via a saved feed URL (the per-article guard in
    // extractArticleContent doesn't cover this first request)
    if (!isAllowedUrl(feedUrl)) {
      throw new Error("Feed URL points to a disallowed host")
    }
    const feed = await parser.parseURL(feedUrl)
    const feedItems = (feed.items || []).slice(0, 20)

    // Asked once, before any page fetch: a stored item keeps its feed-level
    // content and media and never reaches extractArticleContent. The lookup
    // only saves work, so a failed one fails open — every page is fetched as
    // before rather than the whole source failing. (RAD-395)
    let known = new Set<string>()
    if (options.knownItems) {
      try {
        known = await options.knownItems(
          feedItems.map((item) => ({ url: item.link || "", externalId: item.guid || item.link || "" }))
        )
      } catch (error) {
        console.warn(`knownItems lookup failed for ${feedUrl}; fetching every item:`, error)
      }
    }

    const itemLimit = pLimit(ITEM_FETCH_CONCURRENCY)
    const items = await Promise.all(
      feedItems.map((item) => itemLimit(async () => {
        // Get full article content
        let fullContent = item.content || item.contentSnippet || ""
        const mediaUrls: string[] = []

        // Extract media from RSS item enclosures (podcasts, videos)
        if (item.enclosure?.url) {
          mediaUrls.push(item.enclosure.url)
        }

        // Extract media from content:encoded or content fields
        const contentHtml = item.content || item["content:encoded"] || ""
        if (contentHtml) {
          const contentMediaUrls = extractMediaFromHTML(contentHtml)
          mediaUrls.push(...contentMediaUrls)
        }

        // Extract from media:content (Media RSS extension)
        type MediaRSSNode = { $?: { url?: string } }
        const rssItem = item as Record<string, unknown>
        const mediaContent = rssItem["media:content"] as MediaRSSNode | MediaRSSNode[] | undefined
        if (mediaContent) {
          if (Array.isArray(mediaContent)) {
            mediaContent.forEach((media) => {
              if (media.$ && media.$.url) {
                mediaUrls.push(media.$.url)
              }
            })
          } else if (mediaContent.$ && mediaContent.$.url) {
            mediaUrls.push(mediaContent.$.url)
          }
        }

        // Extract from media:thumbnail
        const mediaThumbnail = rssItem["media:thumbnail"] as MediaRSSNode | MediaRSSNode[] | undefined
        if (mediaThumbnail) {
          if (Array.isArray(mediaThumbnail)) {
            mediaThumbnail.forEach((thumb) => {
              if (thumb.$ && thumb.$.url) {
                mediaUrls.push(thumb.$.url)
              }
            })
          } else if (mediaThumbnail.$ && mediaThumbnail.$.url) {
            mediaUrls.push(mediaThumbnail.$.url)
          }
        }

        // If we have a link, try to fetch and parse the full article
        // Skip URLs that always fail content extraction (saves 10s timeout per URL)
        let ogImage: string | null = null
        let articleMediaUrls: string[] = []
        // Which of the article's images may become the cover: only the ones
        // Readability's container kept (see the cover rule below).
        let articleCoverUrls: string[] = []
        const skipExtraction = item.link && (
          item.link.includes("nitter.") ||
          item.link.includes("youtube.com/") ||
          item.link.includes("youtu.be/") ||
          item.link.includes("reddit.com/") ||
          item.link.includes("bsky.app/") ||
          /\.pdf(\?|$)/i.test(item.link) ||
          known.has(item.link) ||
          known.has(item.guid || item.link)
        )
        if (item.link && !skipExtraction) {
          try {
            const articleData = await extractArticleContent(item.link)
            if (articleData.content) fullContent = articleData.content
            ogImage = articleData.ogImage
            articleMediaUrls = articleData.mediaUrls
            articleCoverUrls = articleData.mediaFromPageFallback ? [] : articleData.mediaUrls

            // Add Open Graph image to the beginning of mediaUrls (highest priority)
            if (ogImage) {
              mediaUrls.unshift(ogImage)
            }
          } catch (error) {
            console.warn(`Failed to extract full content for ${item.link}:`, error)
            // Fall back to RSS content
          }
        }

        // The cover is chosen from feed-level media only, so capture that list
        // before the article page's own images join it (RAD-336).
        const feedLevelMediaUrls = mediaUrls.slice()

        // Article-page images come after every feed-level source and the
        // og:image — they are the page's, not the feed's (RAD-336).
        mediaUrls.push(...articleMediaUrls)

        // Remove duplicates and filter valid URLs
        const uniqueMediaUrls = Array.from(new Set(mediaUrls)).filter(
          (url) => url && isValidMediaUrl(url)
        )

        // Cover policy stays feed-level (og:image, enclosure, feed body,
        // media:*), exactly as before. `cardGalleryImages` trusts the cover
        // without checking it, so an article-page image may become one only
        // when the feed itself offered no media AND the candidate actually
        // looks like a renderable image — never an extensionless avatar
        // (RAD-336). A fallback page scrape is not eligible at all: it holds
        // the whole page, and sized chrome (a site logo, a related-card
        // thumbnail) is nobody's project cover (RAD-340).
        const uniqueFeedLevelMediaUrls = Array.from(new Set(feedLevelMediaUrls)).filter(
          (url) => url && isValidMediaUrl(url)
        )
        const uniqueArticleCoverUrls = Array.from(new Set(articleCoverUrls)).filter(
          (url) => url && isValidMediaUrl(url)
        )
        // Land Book: the item's own image is the full-page screenshot, and the
        // article's og:image is Landbook's branded social card. Prefer the
        // screenshot, so a new row stores the same cover the card shows
        // (RAD-432). Any other feed keeps the og:image-first rule unchanged.
        const thumbnailUrl =
          uniqueFeedLevelMediaUrls.find((url) => isLandbookFullPageScreenshot(url)) ||
          uniqueFeedLevelMediaUrls[0] ||
          uniqueArticleCoverUrls.find((url) => isLandbookFullPageScreenshot(url)) ||
          uniqueArticleCoverUrls.find((url) => isRenderableImageUrl(url)) ||
          undefined

        // Sanitize content if it wasn't already processed by extractArticleContent
        // (extractArticleContent sanitizes internally, but RSS fallback doesn't)
        const sanitizedContent = isHtml(fullContent)
          ? sanitizeHtml(fullContent)
          : fullContent

        return {
          title: pickItemTitle(item),
          url: item.link || "",
          externalId: item.guid || item.link || "",
          content: truncateContent(sanitizedContent),
          publishedAt: item.pubDate ? new Date(item.pubDate) : null,
          excerpt: item.contentSnippet?.slice(0, 200),
          thumbnailUrl,
          mediaUrls: uniqueMediaUrls,
        }
      }))
    )

    return items.filter((item) => item.url) // Only return items with URLs
  } catch (error) {
    console.error("Error parsing RSS feed:", error)
    throw new Error(`Failed to parse RSS feed: ${error}`)
  }
}

/**
 * Options for `extractMediaFromHTML`. The feed-body call passes none, so its
 * behaviour is unchanged (RAD-336, AC 6).
 */
export interface ExtractMediaOptions {
  /** `<img>` only — no `<video>`, no YouTube/Vimeo iframes. */
  imagesOnly?: boolean
  /**
   * Drop an `<img>` whose `width` or `height` attribute declares a plain
   * pixel dimension below this. A percentage, `auto` or any other
   * non-dimension value is ignored, as is a missing attribute: only a size
   * the tag actually claims can disqualify it.
   */
  minInlineSize?: number
  /** Resolve every `src` against this URL before validation. */
  baseUrl?: string
  /**
   * Admit only an `<img>` that declares a numeric `width` or `height`. The
   * whole-page fallback scan sets this (RAD-340): the page furniture the
   * fallback has no Readability container to filter — author avatars, tool
   * icons, site placeholder assets — is unsized, while a content grid
   * declares its real dimensions.
   */
  requireDeclaredSize?: boolean
}

/**
 * The pixel dimensions the tag itself claims, in attribute order.
 *
 * Behance marks its featured projects with a 31×57 "featured" ribbon icon,
 * and a photo essay routinely carries a 1×1 tracking pixel. Only a plain
 * dimension counts (`/^\d+(px)?$/`): `width="100%"` is a layout instruction,
 * not a size claim, and `auto`/`calc(…)` are unknowable here. A parsed `0` is
 * below any floor — that IS the tracking pixel.
 */
function declaredPixels(el: Element): number[] {
  const out: number[] = []
  for (const attr of ["width", "height"]) {
    const raw = el.getAttribute(attr)?.trim()
    if (raw && /^\d+(px)?$/i.test(raw)) out.push(parseInt(raw, 10))
  }
  return out
}

/**
 * Extract media URLs from HTML content
 */
export function extractMediaFromHTML(html: string, opts: ExtractMediaOptions = {}): string[] {
  try {
    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")
    const mediaUrls: string[] = []

    // linkedom's document.baseURI is null, so nothing is absolutised for us —
    // without `baseUrl` a relative `src` fails validation and is dropped, as
    // it is today (RAD-336).
    const resolve = (raw: string): string => {
      if (!opts.baseUrl) return raw
      try {
        return new URL(raw, opts.baseUrl).href
      } catch {
        return raw
      }
    }

    // Extract images
    const images = document.querySelectorAll("img")
    images.forEach((img: Element) => {
      const src = img.getAttribute("src")
      if (!src) return
      const pixels = declaredPixels(img)
      if (opts.requireDeclaredSize && pixels.length === 0) return
      if (opts.minInlineSize !== undefined && pixels.some((px) => px < opts.minInlineSize!)) return
      const resolved = resolve(src)
      if (isValidMediaUrl(resolved)) {
        mediaUrls.push(resolved)
      }
    })

    if (!opts.imagesOnly) {
      // Extract videos
      const videos = document.querySelectorAll("video source, video")
      videos.forEach((video: Element) => {
        const src = video.getAttribute("src")
        if (src && isValidMediaUrl(src)) {
          mediaUrls.push(src)
        }
      })

      // Extract iframes (for embedded videos like YouTube, Vimeo)
      const iframes = document.querySelectorAll("iframe")
      iframes.forEach((iframe: Element) => {
        const src = iframe.getAttribute("src")
        if (src && (src.includes("youtube.com") || src.includes("vimeo.com") || src.includes("youtu.be"))) {
          mediaUrls.push(src)
        }
      })
    }

    return mediaUrls
  } catch (error) {
    console.error("Error extracting media from HTML:", error)
    return []
  }
}

/**
 * Check if URL is a valid media URL
 */
function isValidMediaUrl(url: string): boolean {
  if (!url || url.startsWith("data:") || url.length < 10) return false

  // Must be a valid http/https URL
  try {
    const parsed = new URL(url)
    if (!parsed.protocol.startsWith("http")) return false
  } catch {
    return false
  }

  // Check for common image/video extensions or domains
  const validPatterns = [
    /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|ogg|bmp|ico|tiff?)(\?.*)?$/i, // Allow query params
    /youtube\.com|youtu\.be|vimeo\.com/i,
    /\/og-image/i, // Common Open Graph image paths
    /\/social-image/i,
    /\/twitter-card/i,
  ]

  // If matches known patterns, definitely valid
  if (validPatterns.some((pattern) => pattern.test(url))) {
    return true
  }

  // For other URLs, check if they look like image URLs (contain "image", "img", "photo", etc.)
  const imageKeywords = /image|img|photo|picture|media|thumbnail|cover|avatar|preview/i
  if (imageKeywords.test(url)) {
    return true
  }

  // Accept CDN domains that commonly serve images
  const cdnDomains = /cloudinary|imgur|cloudfront|cdn\.|imagekit|imgix|cloudimg|pbs\.twimg\.com|video\.twimg\.com/i
  if (cdnDomains.test(url)) {
    return true
  }

  // If nothing else matched, accept it anyway if it's a valid http URL
  // Better to be permissive and let the browser handle invalid images
  return true
}

/**
 * Extract Open Graph image from HTML
 */
export function extractOpenGraphImage(html: string, baseUrl: string): string | null {
  try {
    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")

    // Try og:image first
    const ogImage = document.querySelector('meta[property="og:image"]')
    if (ogImage) {
      const content = ogImage.getAttribute("content")
      if (content) {
        // Convert relative URLs to absolute
        try {
          const absoluteUrl = new URL(content, baseUrl).href
          if (isValidMediaUrl(absoluteUrl)) {
            return absoluteUrl
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    // Try twitter:image as fallback
    const twitterImage = document.querySelector('meta[name="twitter:image"]')
    if (twitterImage) {
      const content = twitterImage.getAttribute("content")
      if (content) {
        // Convert relative URLs to absolute
        try {
          const absoluteUrl = new URL(content, baseUrl).href
          if (isValidMediaUrl(absoluteUrl)) {
            return absoluteUrl
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    return null
  } catch (error) {
    console.error("Error extracting Open Graph image:", error)
    return null
  }
}

/**
 * Extract Open Graph title from HTML
 */
export function extractOpenGraphTitle(html: string): string | null {
  try {
    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")

    const ogTitle = document.querySelector('meta[property="og:title"]')
    const content = ogTitle?.getAttribute("content")
    return content?.trim() || null
  } catch (error) {
    console.error("Error extracting Open Graph title:", error)
    return null
  }
}

/**
 * How many of an article page's own images one parsed item carries.
 *
 * Photo essays carry 50–150 `<img>` once Readability has kept them, and this
 * list rides on every card in `/api/posts` and every "Attached media: N
 * images" the story-writer prompt receives. The detail grid is uncapped by
 * design, so a scrape with no ceiling would put the whole essay behind the
 * post — 24 keeps a Behance project whole with room to spare. (RAD-336)
 */
export const ARTICLE_IMAGE_MAX = 24

/**
 * The inline-size floor for one of those images: Behance's 31×57 ribbon icon
 * is page furniture, the project images declare ≥ 1000px. Size alone cannot
 * separate content from furniture — the author avatar is unsized — so this
 * only drops what DECLARES itself small. (RAD-336)
 */
const ARTICLE_IMAGE_MIN_SIZE = 200

export interface ArticleContent {
  content: string
  ogImage: string | null
  /** The article page's own images, in document order, capped at ARTICLE_IMAGE_MAX. */
  mediaUrls: string[]
  /**
   * True when `mediaUrls` came from the whole-page fallback rather than
   * Readability's container. A fallback list is a scrape of the whole page, so
   * its entries are kept out of cover eligibility (RAD-340).
   */
  mediaFromPageFallback: boolean
}

const ARTICLE_USER_AGENT = "Mozilla/5.0 (compatible; RadaricBot/1.0)"

/**
 * Challenge cookies learned per origin (`new URL(url).origin`), so one learned
 * over https is never sent in the clear to the same host over http. (RAD-392)
 *
 * Behance's CDN answers an article-page fetch with a 403 whose body sets
 * `js_challenge_value=<hex>` via `document.cookie` and reloads. The value sits
 * in the body in plain text, so no JS has to run: re-requesting with that
 * cookie returns the page. Remembering it per host means only the fetches
 * already in flight before the host's cookie is known pay the extra round
 * trip (the parser fetches 5 pages at once, so 5 of a 20-item feed). A value
 * is stored only for the origin that issued it, so a host's cookie is never
 * sent anywhere else. (RAD-391)
 */
const challengeCookies = new Map<string, string>()

/**
 * How many hosts `challengeCookies` remembers; the oldest is forgotten first,
 * so a long-running worker's memory stays bounded. (RAD-391)
 */
export const CHALLENGE_COOKIE_HOSTS_MAX = 256

/** A challenge body is ~450 B; a 403 declaring more is not a challenge worth reading. (RAD-391) */
const CHALLENGE_BODY_MAX_BYTES = 16_384

/**
 * The `js_challenge_value` a 403 body asks for, or null. The value's charset
 * and length are checked so a hostile page cannot inject into the Cookie
 * header. (RAD-391)
 */
function challengeCookie(body: string): string | null {
  const match = body.match(/js_challenge_value=([A-Za-z0-9]{1,512})[;"]/)
  return match ? `js_challenge_value=${match[1]}` : null
}

/**
 * Fetch an article page, answering a cookie challenge at most once per call.
 * A second 403 is returned as-is for the caller to reject. (RAD-391)
 *
 * Both requests go through `safeFetch`: plain `fetch` follows redirects on its
 * own, so a public article URL that 302s to a metadata or loopback address
 * made the server request it (blind SSRF). `safeFetch` validates every hop,
 * drops the challenge cookie once a hop leaves its origin, and the shared
 * signal keeps each request's whole chain inside 5 s, as plain fetch's single
 * timeout did. Null means a hop was refused or there were too many hops; a
 * timeout still throws, as it always did. (RAD-392)
 */
async function fetchArticlePage(url: string): Promise<Response | null> {
  const origin = new URL(url).origin
  const request = (cookie: string | undefined) =>
    safeFetch(url, {
      headers: {
        "User-Agent": ARTICLE_USER_AGENT,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeoutMs: 5_000,
      signal: AbortSignal.timeout(5_000),
    })

  const response = await request(challengeCookies.get(origin))
  if (!response || response.status !== 403) return response
  // A redirect landed elsewhere: that origin's challenge is not ours to answer.
  if (response.url && new URL(response.url).origin !== origin) return response

  const contentLength = response.headers.get("content-length")
  if (contentLength && parseInt(contentLength, 10) > CHALLENGE_BODY_MAX_BYTES) return response

  const cookie = challengeCookie(await response.text())
  if (!cookie) return response

  if (!challengeCookies.has(origin) && challengeCookies.size >= CHALLENGE_COOKIE_HOSTS_MAX) {
    challengeCookies.delete(challengeCookies.keys().next().value!)
  }
  challengeCookies.set(origin, cookie)
  return request(cookie)
}

/**
 * Pages under this length carrying a bot-check notice are interstitials, not
 * articles; a long real article quoting the notice is still extracted. (RAD-395)
 */
const INTERSTITIAL_MAX_CHARS = 50_000

/**
 * A 2xx challenge interstitial in place of the article: Sucuri/Cloudproxy's
 * JS redirect, or the bot-check notice www.behance.net started serving to
 * production ("A required part of this site couldn’t load…"). Readability
 * would store the notice as the article, with no images and no log line.
 * (RAD-395)
 */
function isChallengeInterstitial(html: string): boolean {
  if (html.includes("sucuri_cloudproxy_js")) return true
  if (html.includes("You are being redirected") && html.length < 5000) return true
  return html.length < INTERSTITIAL_MAX_CHARS && /A required part of this site couldn[’']t load/.test(html)
}

/** The reader renders the page in a headless browser: 5–16 s measured. (RAD-395) */
const READER_TIMEOUT_MS = 25_000

/** The Behance project id of a `/gallery/<id>/…` URL, or null. (RAD-395) */
function behanceGalleryId(url: string): string | null {
  const parsed = new URL(url)
  if (parsed.hostname !== "www.behance.net" && parsed.hostname !== "behance.net") return null
  return parsed.pathname.match(/^\/gallery\/(\d+)(\/|$)/)?.[1] ?? null
}

/**
 * A blocked Behance gallery's modules, read through r.jina.ai, which renders
 * the page past the bot check. Only THIS project's `project_modules` count —
 * the markdown also carries the author avatar, the 404 cover and other
 * projects' modules — deduped by file name so one module at two sizes takes
 * one slot. The reader hands out the 3840 px rendition (up to 5.5 MB a
 * frame); every one of 35 sampled also exists at 1400_webp (0.2–0.9 MB), the
 * size the direct page path stores, so that is the one kept — for still
 * images only, since an animated GIF has no rendition we have seen. Any
 * reader failure is logged and yields the empty result, as a blocked fetch
 * did before. (RAD-395)
 */
function fetchBehanceGalleryViaReader(url: string, projectId: string): Promise<ArticleContent> {
  return readerLimit(() => readBehanceGallery(url, projectId))
}

/**
 * Reader requests in flight at once, across every parse in this process: the
 * keyless reader allows 20 a minute per IP, and parse-stream runs five sources
 * of five items each in parallel. Two at 5–16 s each stays under it. (RAD-395)
 */
const readerLimit = pLimit(2)

async function readBehanceGallery(url: string, projectId: string): Promise<ArticleContent> {
  const empty: ArticleContent = { content: "", ogImage: null, mediaUrls: [], mediaFromPageFallback: false }
  const apiKey = process.env.JINA_API_KEY
  // A fragment is the browser's business; the reader gets the page itself.
  const target = new URL(url)
  target.hash = ""
  // `<6 hex><project id>.` — anchored, so a shorter project id that happens to
  // be a substring of another project's id or hash does not match.
  const ownModule = new RegExp(`^[0-9a-f]{6}${projectId}\\.`)
  try {
    const response = await safeFetch(`https://r.jina.ai/${target.href}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeoutMs: READER_TIMEOUT_MS,
      signal: AbortSignal.timeout(READER_TIMEOUT_MS),
    })
    if (!response?.ok) {
      console.warn(`Reader fallback failed for ${url}: status ${response?.status ?? "refused"}`)
      return empty
    }
    const markdown = await response.text()
    const byFile = new Map<string, string>()
    for (const [moduleUrl] of markdown.matchAll(/https:\/\/mir-s3-cdn-cf\.behance\.net\/project_modules\/[^\s)"'\]]+/g)) {
      const file = moduleUrl.slice(moduleUrl.lastIndexOf("/") + 1)
      if (!ownModule.test(file) || byFile.has(file)) continue
      const still = /\.(jpe?g|png|webp)$/i.test(file)
      byFile.set(file, still ? moduleUrl.replace("/project_modules/max_3840_webp/", "/project_modules/1400_webp/") : moduleUrl)
    }
    const mediaUrls = [...byFile.values()].slice(0, ARTICLE_IMAGE_MAX)
    if (mediaUrls.length === 0) {
      console.warn(`Reader fallback found no project modules for ${url}`)
      return empty
    }
    return { ...empty, mediaUrls }
  } catch (error) {
    console.warn(`Reader fallback failed for ${url}:`, error)
    return empty
  }
}

/**
 * Extract clean article content from a URL using Readability
 */
export async function extractArticleContent(url: string): Promise<ArticleContent> {
  const empty: ArticleContent = { content: "", ogImage: null, mediaUrls: [], mediaFromPageFallback: false }
  try {
    const { isAllowedUrl } = await import("@/lib/url-validation")
    if (!isAllowedUrl(url)) {
      return empty
    }

    const response = await fetchArticlePage(url)
    // A redirect hop was refused (internal host, too many hops). (RAD-392)
    if (!response) return empty

    // Validate post-redirect URL
    if (response.url && !isAllowedUrl(response.url)) {
      return empty
    }

    // A Behance gallery still blocked after the challenge retry goes to the
    // reader instead of failing. (RAD-395)
    const galleryId = behanceGalleryId(url)

    if (!response.ok) {
      // 307 without Location = WAF JS challenge (e.g. Sucuri/Cloudproxy) — not solvable server-side
      if (response.status === 307) {
        return empty
      }
      if (response.status === 403 && galleryId) {
        console.warn(`Article fetch blocked (403) on ${new URL(url).host}; trying the reader for ${url}`)
        return fetchBehanceGalleryViaReader(url, galleryId)
      }
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    // Reject responses larger than 5MB to prevent memory exhaustion
    const contentLength = response.headers.get("content-length")
    if (contentLength && parseInt(contentLength, 10) > 5_000_000) {
      return empty
    }

    const html = await response.text()

    // A 200 challenge interstitial is a blocked fetch, never content. (RAD-395)
    if (isChallengeInterstitial(html)) {
      console.warn(`Article fetch blocked by a challenge interstitial on ${new URL(url).host}: ${url}`)
      return galleryId ? fetchBehanceGalleryViaReader(url, galleryId) : empty
    }

    // Extract Open Graph image before parsing with Readability
    const ogImage = extractOpenGraphImage(html, url)

    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")
    // linkedom's HTMLDocument is compatible with Readability but needs type assertion
    const reader = new Readability(document as unknown as Document)
    const article = reader.parse()

    if (!article) {
      throw new Error("Failed to parse article")
    }

    // The page's own images, in document order — captured before `sanitizeHtml`,
    // whose `allowedTags` has no `img` and would strip them. Readability has
    // already discarded the page chrome; the size floor drops the furniture it
    // kept. Deduped before the cap, so a repeated figure (a header image, an
    // avatar the page repeats) cannot eat a slot from a real frame (RAD-336).
    const articleImages = extractMediaFromHTML(article.content || "", {
      imagesOnly: true,
      minInlineSize: ARTICLE_IMAGE_MIN_SIZE,
      baseUrl: url,
    })

    // Readability picks its container by TEXT, so a portfolio page whose grid
    // carries no prose loses every image with it: a Behance project page has
    // no <article> tag, and a project with a short description holds its whole
    // module grid (4–46 images, measured on ten such pages) outside the chosen
    // container (RAD-340). The gate is what the article CONTAINED, not what
    // survived the size floor: an article whose images were all too small kept
    // images, and scraping the page's chrome in their place is worse than none.
    const articleHadImages = /<img\b/i.test(article.content || "")
    // Re-parse `html` for the fallback: Readability MOVES the nodes it keeps
    // into its own container, so the document parsed above no longer holds the
    // page. Only images that DECLARE a real size are admitted — the chrome
    // Readability would have filtered (author avatars, tool icons, placeholder
    // assets) is unsized, while a content grid declares its dimensions.
    const pageImages = articleHadImages
      ? []
      : extractMediaFromHTML(html, {
          imagesOnly: true,
          minInlineSize: ARTICLE_IMAGE_MIN_SIZE,
          baseUrl: url,
          requireDeclaredSize: true,
        })

    const mediaUrls = Array.from(new Set([...articleImages, ...pageImages])).slice(0, ARTICLE_IMAGE_MAX)

    // Return sanitized HTML content to preserve formatting (paragraphs, headings, lists)
    const htmlContent = sanitizeHtml(article.content || "")
    return {
      content: truncateContent(htmlContent.trim()),
      ogImage,
      mediaUrls,
      mediaFromPageFallback: mediaUrls.length > 0 && pageImages.length > 0,
    }
  } catch (error) {
    console.error("Error extracting article content:", error)
    throw error
  }
}

/**
 * Detect RSS feed from a website URL
 */
export async function detectRSSFeed(websiteUrl: string): Promise<string | null> {
  try {
    const { safeFetch } = await import("@/lib/url-validation")
    // safeFetch validates the URL + every redirect hop (default fetch follows
    // redirects, so a public URL that 302s to an internal address would leak).
    const response = await safeFetch(websiteUrl, { timeoutMs: 10_000 })
    if (!response) return null
    const html = await response.text()
    const domParser = new DOMParser()
    const document = domParser.parseFromString(html, "text/html")

    // Look for RSS/Atom feed links in the HTML
    const feedLinks = document.querySelectorAll(
      'link[type="application/rss+xml"], link[type="application/atom+xml"]'
    )

    if (feedLinks.length > 0) {
      const feedUrl = (feedLinks[0] as HTMLLinkElement).href
      // Make absolute URL if needed
      return new URL(feedUrl, websiteUrl).href
    }

    return null
  } catch (error) {
    console.error("Error detecting RSS feed:", error)
    return null
  }
}

/**
 * Get metadata from an RSS feed (name, description, image)
 */
export async function getRSSMetadata(feedUrl: string): Promise<{
  name: string
  description?: string
  imageUrl?: string
}> {
  try {
    const feed = await parser.parseURL(feedUrl)

    return {
      name: feed.title || "Unknown Feed",
      description: feed.description,
      imageUrl: feed.image?.url,
    }
  } catch (error) {
    console.error("Error getting RSS metadata:", error)
    throw new Error(`Failed to get RSS metadata: ${error}`)
  }
}

/**
 * Outcome of a feed probe. The failures are distinct because callers act on
 * them differently — and getting that split right IS the feature:
 *
 * - `blocked` — the URL is disallowed (SSRF guard). Definitive: we will never
 *   fetch it, and neither will the parser.
 * - `dns_not_found` — the hostname does not exist (NXDOMAIN). Definitive, and
 *   deliberately distinct from `unreachable`: that's a fact about THEIR domain,
 *   not our infrastructure, and it's the shape of a typo'd URL — which would
 *   otherwise be stored as a source that can never produce a post.
 * - `unreachable` — we never got an answer (timeout, network, empty body).
 *   Nothing can be concluded, so it must never reject.
 * - `http_error` — the server answered, just not 2xx. A 403 is usually a WAF,
 *   so this can't reject either.
 * - `not_a_feed` — fetched fine, parsed as not-a-feed. Definitive.
 */
export type FeedSummary =
  | { ok: true; itemCount: number }
  | { ok: false; reason: "blocked" | "dns_not_found" | "unreachable" | "http_error" | "not_a_feed" }

const MAX_FEED_BYTES = 5_000_000

/**
 * Did the fetch fail because THE INPUT's hostname doesn't exist?
 *
 * undici wraps the cause: `TypeError: fetch failed` with `.cause.code`
 * ENOTFOUND and `.cause.hostname` (shape verified against the installed
 * Node/undici). Only ENOTFOUND counts — EAI_AGAIN is a *temporary* resolver
 * failure and must fail open, as must every socket-level error.
 *
 * The hostname check is what makes this a verdict about the user's input.
 * safeFetch throws from anywhere in its redirect loop, so a live host that
 * 301s to a CDN with a lapsed DNS record would otherwise be reported as
 * "<their domain> doesn't exist — check the address for a typo": false, and
 * unactionable, since the typo is not theirs. A dead hop is someone else's
 * outage, so it fails open.
 */
function isDnsNotFound(err: unknown, expectedHostname: string): boolean {
  const cause = (err as { cause?: { code?: string; hostname?: string } })?.cause
  const code = cause?.code ?? (err as { code?: string })?.code
  if (code !== "ENOTFOUND") return false
  // No hostname on the cause: can't attribute it, so don't reject on it.
  return cause?.hostname?.toLowerCase() === expectedHostname.toLowerCase()
}

/**
 * Decode using the charset the server declared, not a hardcoded UTF-8.
 *
 * This guards a REJECTION, not cosmetics: a UTF-16 feed forced through a UTF-8
 * decoder comes out as garbage, `parseString` throws, and a live feed is
 * branded `not_a_feed` and refused at the door. (A single-byte charset like
 * windows-1251 merely mojibakes its text, which the parser survives.)
 */
function decodeBody(bytes: Buffer, contentType: string | null): string {
  const declared = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
  if (declared) {
    try {
      return new TextDecoder(declared).decode(bytes)
    } catch {
      // Unknown label — fall through to the default.
    }
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Read a body, refusing anything over the cap. Bounds the read itself rather
 * than trusting content-length: chunked responses (what most feed CDNs send)
 * declare no length, and this runs on a user-supplied URL. Buffering an
 * unbounded body would OOM the Next.js process, which shares its container
 * with the GramJS worker.
 */
async function readCapped(response: Response): Promise<string | null> {
  const declared = response.headers.get("content-length")
  if (declared && parseInt(declared, 10) > MAX_FEED_BYTES) {
    void response.body?.cancel().catch(() => {}) // same socket-release reason as the http_error path
    return null
  }

  const reader = response.body?.getReader()
  if (!reader) return null

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_FEED_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return decodeBody(Buffer.concat(chunks), response.headers.get("content-type"))
}

/**
 * Fetch a feed and report its title + item count without ingesting it.
 *
 * Deliberately not `parser.parseURL`: that has a 60s default timeout and
 * follows 5 redirects with no per-hop validation, which would both hang a
 * request and re-open the SSRF hole safeFetch exists to close.
 */
export async function fetchFeedSummary(
  feedUrl: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<FeedSummary> {
  const { safeFetch, isAllowedUrl } = await import("@/lib/url-validation")

  // Checked up front so a disallowed host is definitive rather than being
  // reported as "couldn't reach it" — safeFetch returns the same null for a
  // blocked URL as for a redirect loop.
  if (!isAllowedUrl(feedUrl)) return { ok: false, reason: "blocked" }

  let response: Response | null
  try {
    response = await safeFetch(feedUrl, {
      timeoutMs: opts.timeoutMs ?? 8_000,
      headers: productionFeedHeaders(),
      signal: opts.signal,
      // Match rss-parser's DEFAULT_MAX_REDIRECTS (5), not safeFetch's default
      // of 3. A probe that gives up earlier than the parser it stands in for
      // reports "couldn't reach it" about a feed production parses fine.
      maxRedirects: 5,
    })
  } catch (err) {
    // safeFetch's inner fetch is unguarded, so DNS/network errors throw here.
    const host = (() => {
      try {
        return new URL(feedUrl).hostname
      } catch {
        return ""
      }
    })()
    return { ok: false, reason: isDnsNotFound(err, host) ? "dns_not_found" : "unreachable" }
  }

  // null now means a redirect loop or a hop that resolved to a blocked host.
  if (!response) return { ok: false, reason: "unreachable" }
  // safeFetch returns the Response without checking status, and .text() on an
  // error page parses as "not a feed" — which would reject a live feed sitting
  // behind a 403/429.
  if (!response.ok) {
    // Release the socket. Returning without reading pins the connection until
    // GC, in the long-lived Next process that shares a container with the
    // GramJS worker — and a WAF'd feed hits this path on every add.
    void response.body?.cancel().catch(() => {})
    return { ok: false, reason: "http_error" }
  }

  let xml: string | null
  try {
    xml = await readCapped(response)
  } catch {
    return { ok: false, reason: "unreachable" }
  }
  // null = over the byte cap; "" = a 200 with no body, which is an origin/CDN
  // hiccup rather than evidence about the URL, so it must not reject.
  if (xml === null || xml.trim() === "") return { ok: false, reason: "unreachable" }

  try {
    const feed = await parser.parseString(xml)
    return { ok: true, itemCount: feed.items?.length ?? 0 }
  } catch {
    // Fetched fine and it isn't a feed — the one definitive rejection.
    return { ok: false, reason: "not_a_feed" }
  }
}
