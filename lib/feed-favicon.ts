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
 * Resolves a relative or absolute URL against a base. Returns the input
 * unchanged if it can't be parsed.
 */
function resolveUrl(href: string, baseUrl: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) return href
  try {
    return new URL(href, baseUrl).href
  } catch {
    return href
  }
}

/**
 * Picks the best favicon href declared in a page's HTML. Pure function —
 * exported for unit testing. Prefers `apple-touch-icon` (usually a crisp
 * 180px PNG that downscales cleanly to 24px), then any `rel="icon"` /
 * `rel="shortcut icon"`. Returns an absolute URL, or null when none declared.
 */
export function pickFaviconFromHtml(html: string, baseUrl: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html")
  const links = Array.from(doc.querySelectorAll("link[rel]")) as Array<{
    getAttribute(name: string): string | null
  }>

  const byRel = (predicate: (rel: string) => boolean): string | null => {
    for (const link of links) {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase()
      const href = link.getAttribute("href")?.trim()
      if (href && predicate(rel)) return resolveUrl(href, baseUrl)
    }
    return null
  }

  return (
    byRel((rel) => rel.includes("apple-touch-icon")) ??
    byRel((rel) => rel.split(/\s+/).includes("icon")) ??
    byRel((rel) => rel.includes("shortcut") && rel.includes("icon"))
  )
}

/**
 * The website origin that hosts a source's favicon. For RSS this is the feed
 * URL's origin (e.g. `https://arstechnica.com/feed/` → `https://arstechnica.com`),
 * which hosts the site favicon for the vast majority of feeds. Returns null for
 * sources without a real website (Parallel monitors use `parallel://…`).
 */
function originOf(url: string): string | null {
  if (!url.startsWith("http")) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** Returns the homepage HTML, or null on failure / non-HTML / oversized body. */
async function fetchHomepageHtml(homepageUrl: string): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(homepageUrl)
    if (!response.ok) return null
    const contentLength = parseInt(response.headers.get("content-length") || "0", 10)
    if (contentLength > 5 * 1024 * 1024) return null
    return await response.text()
  } catch {
    return null
  }
}

/**
 * Verifies `<origin>/favicon.ico` exists and is an image. Only returns the URL
 * when it's a real favicon so callers store clean values (null → monogram).
 */
async function faviconIcoFallback(homepageUrl: string): Promise<string | null> {
  try {
    const origin = new URL(homepageUrl).origin
    const icoUrl = `${origin}/favicon.ico`
    const response = await fetchWithTimeout(icoUrl)
    if (!response.ok) return null
    const contentType = response.headers.get("content-type") || ""
    // Some servers send image/x-icon, image/vnd.microsoft.icon, image/png, etc.
    if (!contentType.startsWith("image/")) return null
    return icoUrl
  } catch {
    return null
  }
}

/**
 * Fetches a favicon URL for a source — the small square site icon ideal for
 * the 24px sidebar slot. Returns null when no favicon is found, so the caller
 * keeps the monogram-letter fallback.
 *
 * Scope: RSS / web sources (and any source carrying a real http URL).
 * TELEGRAM, TWITTER, and YOUTUBE return null on purpose — their
 * channel-avatar / profile-pic `coverUrl` is a better per-source icon than
 * the generic platform favicon (every YouTube channel would get the same
 * youtube.com icon). Parallel monitors (`parallel://…`) have no website → null.
 */
export async function fetchSourceFavicon(source: SourceInput): Promise<string | null> {
  if (source.type === "TELEGRAM" || source.type === "TWITTER" || source.type === "YOUTUBE") return null

  const homepageUrl = originOf(source.url)
  if (!homepageUrl) return null

  // 1) Favicon declared in the homepage's <head>.
  const html = await fetchHomepageHtml(homepageUrl)
  if (html) {
    const declared = pickFaviconFromHtml(html, homepageUrl)
    if (declared) return declared
  }

  // 2) Convention fallback: <origin>/favicon.ico (verified to be an image).
  return faviconIcoFallback(homepageUrl)
}

/**
 * Reads a source from DB by id, fetches its favicon, and saves it.
 * Does NOT overwrite an existing faviconUrl.
 */
export async function saveSourceFavicon(sourceId: string, userId?: string): Promise<void> {
  const source = await db.feed.findUnique({
    where: userId ? { id: sourceId, userId } : { id: sourceId },
  })
  if (!source) return
  if (source.faviconUrl) return

  const faviconUrl = await fetchSourceFavicon({ type: source.type, url: source.url })
  if (!faviconUrl) return

  await db.feed.update({
    where: { id: sourceId },
    data: { faviconUrl },
  })
}
