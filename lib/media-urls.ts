/**
 * Which of a material's media URLs are renderable images.
 *
 * The same decision is inlined at three older call sites
 * (`material-detail-page`, `material-detail-dialog`, `story-detail`) with three
 * different behaviours — one of them forgetting to drop the cover from the
 * gallery, one of them not detecting video at all. This module is the card
 * gallery's copy and the intended home for all of them. `material-detail-page`
 * is migrated (`detailGalleryMedia`), and so is the story page's grid
 * (`storyDetailMedia`, RAD-400); **`material-detail-dialog` is not yet**, so
 * treat the host list below as one of two until it is.
 *
 * Note what is NOT here: an extension ALLOWLIST. A feed's image URL routinely
 * carries no extension (CDN resizers, `/image?id=…`), so allowing only known
 * image extensions would silently hide real images. The rule is negative in
 * both directions: a URL is an image unless it is a known video embed, a
 * Telegram placeholder, or carries an extension that cannot be one.
 */

/** Hosts whose URLs are iframe embeds, not images. Kept in sync with the detail page. */
const VIDEO_EMBED_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
  "vimeo.com",
  "player.vimeo.com",
]

export function isVideoEmbedUrl(url: string): boolean {
  try {
    return VIDEO_EMBED_HOSTS.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

/**
 * A Telegram media reference the parser could not resolve to a file. It is a
 * placeholder, not a URL an `<img>` can load.
 */
export function isTelegramPlaceholder(url: string): boolean {
  return url.startsWith("tg://")
}

/**
 * Extensions an `<img>` cannot render, or should not: the RSS parser collects
 * `<video>` and `<video source>` srcs into `mediaUrls` and its own validator
 * waves through `.mp4`, `.webm`, `.ogg`, `.svg` and `.ico`
 * (`lib/parsers/rss.ts`). Those became frames that could never paint while the
 * count chip and the dashes went on advertising them. A denylist, not an
 * allowlist — an extensionless CDN URL stays an image.
 */
const NON_IMAGE_EXTENSION =
  /\.(mp4|webm|ogv|ogg|mov|m4v|avi|mkv|svg|ico|mp3|m4a|aac|wav|flac|opus|pdf)(\?|#|$)/i

export function isNonImageAsset(url: string): boolean {
  return NON_IMAGE_EXTENSION.test(url)
}

/**
 * What an image URL looks like: a path that names an image file, or the
 * format-in-the-query spelling X and a few CDNs use
 * (`/media/Gx1?format=jpg&name=large`).
 *
 * The point of the predicate is what it EXCLUDES. `mediaUrls` is a media
 * column, but the Parallel parser (`EVENT_TRIGGER` feeds) writes an event's
 * `source_urls` into it — the article pages the event was found on. Nothing
 * rendered that column for those cards until the cover gallery did, and then
 * two thirds of the dev DB's galleries were a card promising a second image
 * that is an HTML page: the count said `1/2`, the scrub had nowhere to go, and
 * the frame dropped out mid-gesture once the "image" failed to decode
 * (2026-09-12).
 *
 * Deliberately NOT applied to the cover: a thumbnail comes from the parser as
 * an image and is routinely extensionless (Habr serves a post's share PNG from
 * `/share/publication/<id>/<hash>/`). Only the extra frames — third-party
 * strings from a body scrape or a monitoring event — have to prove themselves.
 * The cost of the rule is an extensionless *image* in `mediaUrls`, which in the
 * whole dev DB is two seeded `picsum.photos` fixtures and nothing real.
 */
const IMAGE_EXTENSION = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|jfif)(?=[?&#]|$)/i
const IMAGE_FORMAT_QUERY = /[?&](format|fm|ext)=(jpe?g|png|webp|avif|gif)\b/i

export function isRenderableImageUrl(url: string): boolean {
  if (isNonImageAsset(url)) return false
  // Land Book's full-page shot names no file extension — see
  // `isLandbookFullPageScreenshot`. The substring test keeps the URL parse off
  // every ordinary image on a list render.
  if (url.includes("land-book.com") && isLandbookFullPageScreenshot(url)) return true
  return IMAGE_EXTENSION.test(url) || IMAGE_FORMAT_QUERY.test(url)
}

/**
 * Land Book publishes two kinds of image for the same entry, and only one of
 * them is the post.
 *
 * - **The full-page screenshot** — the site itself, top to bottom — is what the
 *   feed's `<description>` carries and what the gallery is for. Its CDN URL
 *   names no file: `/image/0x0:2880x4320/600x0/filters:format(jpeg)/website/…-screenshot-upload`,
 *   with the format in a *path* segment. `isRenderableImageUrl` therefore reads
 *   it as "not an image", so it never became a gallery frame — the card fell
 *   back to the cover alone.
 * - **The branded Open Graph card** — Landbook's own cream-and-purple social
 *   image (`…-og-image.webp`, or `og-media/…` on `storage.land-book.com`) —
 *   which the article's `og:image` made the cover whenever the page fetch
 *   succeeded. That is why one row of Land Book cards alternated between long
 *   site screenshots and a small branded card (RAD-432).
 *
 * `isLandbookFullPageScreenshot` is deliberately narrow: the `/image/0x0:` crop
 * is the whole page, while a section crop carries its own offset
 * (`/image/0x16210:…`) and stays an unusable frame, as it always was. Scoped by
 * host, so no other feed's URLs change meaning.
 */
const LANDBOOK_HOST = /(^|\.)land-book\.com$/i
const LANDBOOK_FULL_PAGE_CROP = /^\/image\/0x0:\d+x\d+\//i
// Two spellings: a `og-media/` directory on storage, and a `…-og-image.webp`
// file name on cdn. Neither ever names the site.
const LANDBOOK_OG_CARD = /(og-image|og-media)[./]/i

export function isLandbookFullPageScreenshot(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      LANDBOOK_HOST.test(parsed.hostname) &&
      LANDBOOK_FULL_PAGE_CROP.test(parsed.pathname) &&
      /screenshot/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

/** Landbook's branded social card — see `isLandbookFullPageScreenshot`. */
export function isLandbookOgCard(url: string): boolean {
  try {
    const parsed = new URL(url)
    return LANDBOOK_HOST.test(parsed.hostname) && LANDBOOK_OG_CARD.test(parsed.pathname)
  } catch {
    return false
  }
}

/** The full-page shot in a media list, if the material has one. */
function landbookScreenshot(
  mediaUrls: (string | null | undefined)[] | null | undefined
): string | null {
  for (const url of mediaUrls ?? []) {
    if (url && isLandbookFullPageScreenshot(url)) return url
  }
  return null
}

/**
 * The Land Book frame a card shows, or `null` when the material is not one.
 *
 * Gated on the stored cover being Landbook's own — the branded card of a page
 * fetch that succeeded, or the shot itself when it failed. An unrelated feed
 * that merely quotes a `cdn.land-book.com` screenshot keeps its editorial
 * `og:image` (RAD-432 review).
 */
function landbookCover(material: {
  thumbnailUrl?: string | null
  mediaUrls?: (string | null | undefined)[] | null
}): string | null {
  const shot = landbookScreenshot(material.mediaUrls)
  if (!shot) return null
  const cover = material.thumbnailUrl
  return !cover || isLandbookOgCard(cover) || isLandbookFullPageScreenshot(cover) ? shot : null
}

/**
 * Whether a Land Book row's frame must be dropped: the branded card, and every
 * OTHER spelling of the shot. The article page re-serves the same asset at
 * other widths (`/image/0x0:2880x2870/2880x0/…` beside the feed's
 * `0x0:2880x4320/600x0/…`), and those are different URLs naming no file, so
 * `sameImageKey` cannot fold them — the card would scrub between copies of one
 * picture and the post page would paint the hero twice (RAD-432 review).
 */
function isLandbookDuplicateFrame(url: string, shot: string | null): boolean {
  if (!shot || url === shot) return false
  return isLandbookOgCard(url) || isLandbookFullPageScreenshot(url)
}

export type MediaKind =
  | "video"
  | "audio"
  | "document"
  | "image"
  | "embed"
  | "placeholder"
  | "unknown"

const VIDEO_EXTENSION = /\.(mp4|webm|mov|m4v|mkv|ogv|avi)(?=[?#]|$)/i
const AUDIO_EXTENSION = /\.(ogg|oga|opus|mp3|m4a|aac|wav|flac|weba)(?=[?#]|$)/i
const DOCUMENT_EXTENSION =
  /\.(pdf|zip|rar|7z|tar|gz|doc|docx|xls|xlsx|ppt|pptx|txt|csv|epub|tgs)(?=[?#]|$)/i

export function mediaKindFromUrl(url: string): MediaKind {
  if (typeof url !== "string" || url.length === 0) return "unknown"
  if (isTelegramPlaceholder(url)) return "placeholder"
  if (isVideoEmbedUrl(url)) return "embed"
  if (VIDEO_EXTENSION.test(url)) return "video"
  if (AUDIO_EXTENSION.test(url)) return "audio"
  if (DOCUMENT_EXTENSION.test(url)) return "document"
  if (isRenderableImageUrl(url)) return "image"
  return "unknown"
}

export function previewImageUrl(material: {
  thumbnailUrl?: string | null
  mediaUrls?: (string | null | undefined)[] | null
}): string | null {
  // Land Book's cover is its own branded social card; the post is the site.
  // The full-page shot wins over the thumbnail wherever the two disagree
  // (RAD-432).
  const landbook = landbookCover(material)
  if (landbook) return landbook

  // The cover is trusted (a parser-supplied thumbnail is routinely
  // extensionless); only a known non-image kind disqualifies it. `mediaUrls`
  // entries still have to prove themselves positively.
  if (material.thumbnailUrl && !isKnownNonImageKind(material.thumbnailUrl)) {
    return material.thumbnailUrl
  }
  for (const url of material.mediaUrls ?? []) {
    if (url && mediaKindFromUrl(url) === "image") return url
  }
  return null
}

function isKnownNonImageKind(url: string): boolean {
  const kind = mediaKindFromUrl(url)
  return kind === "video" || kind === "audio" || kind === "document" || kind === "embed" || kind === "placeholder"
}

/**
 * Whether a card cover should carry the play badge: the material has a video
 * AND the cover is not itself one of its `mediaUrls` frames. A Telegram
 * video-only post's cover is the document's poster URL, which never appears in
 * `mediaUrls`; a mixed album's cover is its first photo, which does — and a
 * photo cover must not be badged (RAD-359 plan decision 5).
 */
export function coverHasVideo(material: {
  thumbnailUrl?: string | null
  mediaUrls?: (string | null | undefined)[] | null
}): boolean {
  const urls = (material.mediaUrls ?? []).filter((url): url is string => !!url)
  if (!urls.some((url) => mediaKindFromUrl(url) === "video")) return false
  const cover = material.thumbnailUrl
  if (!cover) return true
  const coverKey = sameImageKey(cover)
  return !urls.some((url) => sameImageKey(url) === coverKey)
}

/**
 * Hosts that serve someone else's image: the original URL is the rest of the
 * path. Jetpack Photon (`i0.wp.com/<host>/<path>?resize=…`) is on every
 * WordPress feed that has the plugin, which is most of them.
 */
const PATH_PROXY_HOST = /^i[0-9]\.wp\.com$/

/**
 * Strip an image proxy down to the file it proxies, so the two spellings of
 * one image can be compared.
 */
function unwrapProxy(url: URL): URL {
  if (PATH_PROXY_HOST.test(url.hostname)) {
    const inner = url.pathname.replace(/^\//, "")
    const candidate = /^https?:\/\//.test(inner) ? inner : `https://${inner}`
    try {
      return new URL(candidate)
    } catch {
      return url
    }
  }
  // `?url=<encoded>` proxies: Next's own /_next/image, weserv, wsrv.nl.
  const inner = url.searchParams.get("url")
  if (inner && /^https?:\/\//.test(inner)) {
    try {
      return new URL(inner)
    } catch {
      return url
    }
  }
  return url
}

/**
 * WordPress does not store an upload as one file. It stores a family: the
 * original `name.png`, a `name-scaled.png` capped at 2560px, and one
 * `name-1024x576.png` per registered size. A feed hands the cover one member
 * and the article body another, so a card counted two frames of a single
 * photograph — 40 of the dev DB's 328 galleries were this, on top of the
 * proxied twins (2026-09-12).
 *
 * Only a **trailing** suffix is stripped, and only repeatedly-trailing ones
 * (`name-scaled-1024x576.png`), so a dimension the photographer put in the
 * name (`1600X1200PX-MG-TEA1.jpg`) and two different uploads that happen to
 * share a size (`shot-1-1024x576` vs `shot-2-1024x576`) stay distinct.
 *
 * `-e<timestamp>` (WordPress's edited-original marker) and `@2x` are the same
 * shape of rule, and deliberately absent: neither collapsed a single gallery
 * in the dev DB, so neither earns its false-positive risk.
 */
const WP_DERIVATIVE_SUFFIX = /(?:-scaled|-\d{2,5}x\d{2,5})+(\.[a-z0-9]{2,5})$/i

/**
 * Behance stores one project image under many URLs too: a size segment sits
 * between `project_modules` and the file — `1400`, `1400_webp`, `fs_webp`,
 * `max_1200_webp`, `disp`, `source`, … The feed's og:image lands on one and
 * the project page's own `<img>` on another, so a card counted two frames of
 * one picture and the hover scrub changed nothing (RAD-336). The segment is
 * never the identity; the file name is — no variant enumeration.
 *
 * Scoped to Behance hosts: a coincidental `/project_modules/…` path on another
 * site keeps its spelling. `(^|\.)` keeps a `notbehance.net` lookalike out.
 */
const BEHANCE_HOST = /(^|\.)behance\.net$/i
const BEHANCE_SIZE_SEGMENT = /^\/project_modules\/[^/]+\//

function foldBehanceSize(hostname: string, path: string): string {
  if (!BEHANCE_HOST.test(hostname)) return path
  return path.replace(BEHANCE_SIZE_SEGMENT, "/project_modules/")
}

/**
 * What makes two URLs the same picture.
 *
 * A feed routinely carries one image twice: the article's `<img src>` and the
 * same file behind the site's image proxy, or the same file with different
 * transform parameters. String equality sees two images, so a card claimed two
 * frames and a hover scrub changed nothing — the bug this exists to kill
 * (2026-09-12; 111 of the 440 galleries in the dev DB were this).
 *
 * The key is the proxied-away host + the decoded path, with WordPress's size
 * derivatives folded onto their original (`WP_DERIVATIVE_SUFFIX`). The query is dropped
 * **only when the path names a file**: `?resize=960` and `?crop=0,0,100,100`
 * are transforms of one image, whereas `/image?id=42` and `/image?id=43` are
 * two images and there the query IS the identity. Percent-encoding is decoded
 * because a proxy re-encodes what the original left literal (`@2x` → `%402x`).
 *
 * Deliberately NOT a content hash: comparing bytes would need both images
 * fetched server-side, and this has to hold for a list of 96 cards rendered
 * from one query.
 */
export function sameImageKey(url: string): string {
  let parsed: URL
  try {
    parsed = unwrapProxy(new URL(url))
  } catch {
    return url.toLowerCase()
  }

  let path = parsed.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    // A malformed escape sequence: compare what we were given.
  }

  path = path.replace(WP_DERIVATIVE_SUFFIX, "$1")
  path = foldBehanceSize(parsed.hostname, path)

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase()
  const namesAFile = /\.[a-z0-9]{2,5}$/i.test(path)
  return host + path + (namesAFile ? "" : parsed.search)
}

/**
 * How many frames a card's cover can scrub through.
 *
 * The scrub zones and the dashes both shrink with the frame count, so this is
 * a trade against aim: past ~8 of them the zones get small, and a scrape that
 * yielded 30 images — every inline figure, logo and tracking pixel
 * `extractMediaFromHTML` finds, in the feed body or on the article page itself
 * (RAD-336) — would turn the cover into a flicker strip. Telegram albums
 * cannot reach this either way: the worker uploads only the first photo of a
 * group. Raised to 16 after a feed shipped more than 8 usable frames — a
 * portfolio post's gallery is worth more than the narrower zones cost.
 */
export const CARD_GALLERY_MAX = 16

/**
 * The frames a card's cover can scrub through: the cover first (it defines the
 * band's height, so it must stay index 0), then the rest of the material's
 * media — those entries that are actually images (`isRenderableImageUrl`) —
 * deduped by image identity (`sameImageKey`, not string equality) and capped.
 *
 * Returns `[]` when there is nothing to show and `[cover]` when there is only
 * one frame — the caller decides that one frame needs no gallery.
 */
export function cardGalleryImages(
  material: { thumbnailUrl?: string | null; mediaUrls?: string[] | null },
  max: number = CARD_GALLERY_MAX
): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  // Land Book's full-page shot leads, and every other spelling of it — the
  // branded card the parser stored as the cover, plus the article page's
  // re-servings of the same shot — is dropped rather than offered as extra
  // frames: the card is meant to be the site, and a scrub between copies of one
  // picture is not a second view of it (RAD-432).
  const landbook = landbookCover(material)

  // The cover is trusted; everything from `mediaUrls` must look like an image.
  // See `isRenderableImageUrl` for why the asymmetry is the right one.
  const candidates: { url: string | null | undefined; trusted: boolean }[] = landbook
    ? [
        { url: landbook, trusted: true },
        { url: material.thumbnailUrl, trusted: true },
        ...(material.mediaUrls ?? []).map((url) => ({ url, trusted: false })),
      ]
    : [
        { url: material.thumbnailUrl, trusted: true },
        ...(material.mediaUrls ?? []).map((url) => ({ url, trusted: false })),
      ]

  for (const { url, trusted } of candidates) {
    if (!url) continue
    if (isLandbookDuplicateFrame(url, landbook)) continue
    if (isTelegramPlaceholder(url) || isVideoEmbedUrl(url) || isNonImageAsset(url)) continue
    if (!trusted && !isRenderableImageUrl(url)) continue
    // Identity, not string equality — see `sameImageKey`. The cover is visited
    // first, so it is its own spelling that survives a collision.
    const key = sameImageKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
    if (out.length === max) break
  }

  return out
}

/**
 * The cover gallery of a story card: every member post's `cardGalleryImages`,
 * merged round-robin by position — each member's first frame, then each
 * member's second frame, … — so a story of five posts shows five different
 * posts in its first five frames instead of one post's whole album. Members
 * keep the order given (the list passes the primary first), duplicates across
 * members collapse by `sameImageKey` (the earlier member's spelling wins), and
 * the result is capped at `max`.
 *
 * `coverOwner` is the member whose frame is `images[0]` — the caller needs it
 * to decide the play badge, which describes the cover, not the gallery. `null`
 * exactly when `images` is empty.
 */
export function storyGalleryImages<
  M extends { thumbnailUrl?: string | null; mediaUrls?: string[] | null },
>(members: M[], max: number = CARD_GALLERY_MAX): { images: string[]; coverOwner: M | null } {
  const perMember = members.map((member) => cardGalleryImages(member, max))
  const images: string[] = []
  const seen = new Set<string>()
  let coverOwner: M | null = null
  const depth = Math.max(0, ...perMember.map((frames) => frames.length))

  for (let position = 0; position < depth; position++) {
    for (let m = 0; m < members.length; m++) {
      const url = perMember[m][position]
      if (!url) continue
      const key = sameImageKey(url)
      if (seen.has(key)) continue
      seen.add(key)
      if (images.length === 0) coverOwner = members[m]
      images.push(url)
      if (images.length === max) return { images, coverOwner }
    }
  }

  return { images, coverOwner }
}

/**
 * The media grid under a post's hero on `/posts/[id]`: every extra frame at
 * once, uncapped, in feed order.
 *
 * It is the card rule with two differences, both because the page renders
 * more than an `<img>`:
 *
 * - A video embed, a playable file (video/audio) and a Telegram placeholder
 *   are KEPT — `MaterialMedia` renders each kind. A card cover has nowhere to
 *   put any of them, which is why `cardGalleryImages` drops them.
 * - The cover is EXCLUDED. The hero above already paints it, so a gallery
 *   that repeated it would open with the same picture twice — and "the same"
 *   means `sameImageKey`, so its proxied or resized twin goes too. "The cover"
 *   is the thumbnail only when it is what `previewImageUrl` paints: the
 *   Twitter parser stores a video tweet's `.mp4` as `thumbnailUrl`, and
 *   excluding that dropped the tweet's only video (RAD-400 review). The
 *   no-thumbnail fallback cover (first image of `mediaUrls`) is not excluded
 *   here; the callers drop `previewImageUrl` themselves.
 *
 * Only media with a known renderable kind survives: an image under
 * `isRenderableImageUrl`, or video/audio/document/embed/placeholder. Unknown
 * pages (an EVENT_TRIGGER post's source pages) are dropped. Before
 * this, the page's inline filter only dropped an exact string copy of the
 * cover: a Brand New post carrying `[cover.png, reel.mp4]` rendered
 * "Media (1)" over a broken-image tile (2026-09-13).
 */
export function detailGalleryMedia(material: {
  thumbnailUrl?: string | null
  mediaUrls?: string[] | null
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  // Only a thumbnail that actually paints is a cover. A `.mp4` thumbnail (the
  // Twitter parser's `mediaUrls[0]` on a video tweet) paints nothing, and
  // seeding it would drop the only copy of the video. With no thumbnail the
  // fallback cover is left to the caller, as before: both callers drop
  // `previewImageUrl` themselves.
  if (material.thumbnailUrl && previewImageUrl(material) === material.thumbnailUrl) {
    seen.add(sameImageKey(material.thumbnailUrl))
  }

  // Land Book: the hero is the full-page shot, and the stored cover is
  // Landbook's branded social card — not a second picture of the same post.
  // Dropping it here keeps a one-tile grid under the hero from advertising it,
  // and the shot's other widths from repeating it (RAD-432).
  const landbook = landbookCover(material)

  for (const url of material.mediaUrls ?? []) {
    if (!url) continue
    if (isLandbookDuplicateFrame(url, landbook)) continue
    const kind = mediaKindFromUrl(url)
    if (
      kind !== "image" &&
      kind !== "video" &&
      kind !== "audio" &&
      kind !== "document" &&
      kind !== "embed" &&
      kind !== "placeholder"
    ) {
      continue
    }
    // An embed and a placeholder are identified by their exact URL;
    // `sameImageKey` would drop the query, and for `youtube.com/watch?v=…`
    // the query is the video.
    const key = kind === "embed" || kind === "placeholder" ? url : sameImageKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }

  return out
}

/**
 * The post a story leads with: the first member that has a cover, else the
 * first member. The story card picks its primary this way (the frame the
 * gallery opens on must belong to a post that has one), and the story page
 * orders its media grid by the same rule so both start from the same post
 * (RAD-400). `null` only for a story with no members.
 */
export function storyLeadMaterial<M extends { thumbnailUrl?: string | null }>(
  materials: M[]
): M | null {
  return materials.find((m) => !!m.thumbnailUrl) ?? materials[0] ?? null
}

/**
 * Whether a post's cover is its video's poster rather than a picture of its
 * own. Only the Telegram mirror produces one: a video message's thumbnail is
 * the document's `_thumb.jpg`, which never appears in `mediaUrls`. Shown as an
 * image it would repeat the player's first frame right next to the player.
 *
 * Every other cover is editorial — an RSS og:image beside an `.mp4` is a
 * picture the publisher chose, and a Telegram album with no thumbnail has its
 * first PHOTO promoted to cover by `previewImageUrl`, which is a frame, not a
 * poster. Hence the two guards beyond `coverHasVideo`: a real thumbnail, and
 * the thumbnail being what actually paints (a `.mp4` thumbnail is not).
 *
 * Shared by the post page's hero and the story page's grid so the two never
 * disagree about the same post.
 */
export function coverIsVideoPoster(material: {
  thumbnailUrl?: string | null
  mediaUrls?: string[] | null
  feed?: { type: string } | null
}): boolean {
  return (
    material.feed?.type === "TELEGRAM" &&
    !!material.thumbnailUrl &&
    previewImageUrl(material) === material.thumbnailUrl &&
    coverHasVideo(material)
  )
}

/**
 * One tile of a detail-page media grid. `kind` is decided once here so the
 * renderer never re-guesses it — a cover is always `"image"`, because an
 * extensionless cover (Habr's share PNG) classifies as `"unknown"` and would
 * otherwise be dropped or handed to a player.
 */
export type MediaEntry = {
  url: string
  kind: MediaKind
  /** A video's poster — set only on the first video of a Telegram poster post. */
  poster?: string
  alt: string
}

/**
 * One post's media as detail-grid entries: its paintable cover first, then
 * `detailGalleryMedia` minus that cover (by `sameImageKey`, so its proxied or
 * resized twin goes too).
 *
 * When the cover is a video poster (`coverIsVideoPoster`) it is not an entry
 * at all: it rides on the post's first video as `poster`, the same mapping the
 * post page makes (one poster per message, and it belongs to the first video).
 *
 * Images are numbered among images only — "<title> — image k" is what a screen
 * reader announces, and a video in between does not make the next photo the
 * third image (`postMediaAlt`).
 */
export function postMediaEntries(material: {
  title: string
  thumbnailUrl?: string | null
  mediaUrls?: string[] | null
  feed?: { type: string } | null
}): MediaEntry[] {
  const isPoster = coverIsVideoPoster(material)
  const cover = isPoster ? null : previewImageUrl(material)
  const coverKey = cover ? sameImageKey(cover) : null

  const entries: MediaEntry[] = []
  let images = 0
  let posterUsed = !isPoster
  const push = (url: string, kind: MediaKind) => {
    const alt = postMediaAlt(material.title, kind, kind === "image" ? ++images : 0)
    const entry: MediaEntry = { url, kind, alt }
    if (kind === "video" && !posterUsed) {
      entry.poster = material.thumbnailUrl!
      posterUsed = true
    }
    entries.push(entry)
  }

  if (cover) push(cover, "image")
  for (const url of detailGalleryMedia(material)) {
    if (coverKey !== null && sameImageKey(url) === coverKey) continue
    push(url, mediaKindFromUrl(url))
  }
  return entries
}

/**
 * A member post's media label: "<title> — image k" for its k-th image, and
 * "<title> — video" for a player whether it is a file or an embed (a reader
 * does not care which). Other kinds name themselves.
 */
function postMediaAlt(title: string, kind: MediaKind, imageIndex: number): string {
  if (kind === "image") return `${title} — image ${imageIndex}`
  if (kind === "video" || kind === "embed") return `${title} — video`
  return `${title} — ${kind}`
}

/** Kinds that read as a file row, not a tile: they have no picture to show. */
function isFileEntry(entry: MediaEntry): boolean {
  return (
    entry.kind === "audio" ||
    entry.kind === "document" ||
    (entry.kind === "placeholder" && entry.url.startsWith("tg://too-large"))
  )
}

/** A story-grid entry, plus the identity it was deduped by — unique in the list, so it is the React key. */
export type StoryMediaEntry = MediaEntry & { key: string }

/**
 * The media grid of a story page (RAD-400). Before this the page showed only
 * its legacy Telegram inbox items' media, so a story assembled from feed posts
 * — the common case — had no media at all while its card scrubbed through
 * every member's images.
 *
 * - Members are merged round-robin by position, lead first
 *   (`storyLeadMaterial`), then the rest in the order given — so the first row
 *   samples different posts instead of one post's whole album. That matters
 *   because the page shows only the first few tiles until the reader asks.
 * - Inbox-item media follow, as before: thumbnail, then `mediaUrls`. An
 *   unknown kind still renders as an image there, exactly as the old grid did.
 * - Duplicates collapse across everything: `sameImageKey` for files, exact URL
 *   for embeds (`detailGalleryMedia` explains why). A Telegram placeholder is
 *   the exception: `tg://photo/<messageId>` names no channel, and message 12
 *   of one channel is not message 12 of another, so a placeholder is deduped
 *   only within its own post or inbox item. The earlier entry wins, but a
 *   poster on the dropped twin moves onto a kept video that has none — losing
 *   it would paint a black player.
 * - Alts are assigned AFTER the dedupe: a post whose first image was another
 *   post's twin opens at "image 1", not "image 2" (`postMediaAlt`). Inbox
 *   entries are "Media k", counted over the inbox entries that survived.
 * - Uncapped, like the post page; capping is the renderer's job.
 *
 * Each entry carries `key`, the identity it was deduped by. URLs are no longer
 * unique once placeholders are scoped, so the renderer keys by this.
 *
 * The result is split: `visual` tiles go into the grid, `files` (audio,
 * documents, the "not mirrored" placeholder) go below it, so a voice message
 * never lands between two photos.
 */
export function storyDetailMedia(story: {
  materials: Array<{
    title: string
    thumbnailUrl?: string | null
    mediaUrls?: string[] | null
    feed?: { type: string } | null
  }>
  inboxItems: Array<{ thumbnailUrl?: string | null; mediaUrls?: string[] | null }>
}): { visual: StoryMediaEntry[]; files: StoryMediaEntry[] } {
  const lead = storyLeadMaterial(story.materials)
  const members = lead ? [lead, ...story.materials.filter((m) => m !== lead)] : []
  const perMember = members.map(postMediaEntries)

  // `member` indexes `members`; `null` for an inbox item.
  const kept: Array<{ entry: StoryMediaEntry; member: number | null }> = []
  const byKey = new Map<string, StoryMediaEntry>()
  const add = (entry: MediaEntry, scope: string, member: number | null) => {
    const key =
      entry.kind === "placeholder"
        ? `${scope}:${entry.url}`
        : entry.kind === "embed"
          ? entry.url
          : sameImageKey(entry.url)
    const existing = byKey.get(key)
    if (existing) {
      if (entry.poster && !existing.poster) existing.poster = entry.poster
      return
    }
    const stored: StoryMediaEntry = { ...entry, key }
    byKey.set(key, stored)
    kept.push({ entry: stored, member })
  }

  const depth = Math.max(0, ...perMember.map((entries) => entries.length))
  for (let position = 0; position < depth; position++) {
    perMember.forEach((entries, m) => {
      if (entries[position]) add(entries[position], `post-${m}`, m)
    })
  }

  story.inboxItems.forEach((item, i) => {
    for (const url of [item.thumbnailUrl, ...(item.mediaUrls ?? [])]) {
      if (!url) continue
      const detected = mediaKindFromUrl(url)
      const kind = detected === "unknown" ? "image" : detected
      add({ url, kind, alt: "" }, `inbox-${i}`, null)
    }
  })

  // Number what survived: per post among its images, across the inbox items.
  const imagesSeen = members.map(() => 0)
  let inboxCount = 0
  for (const { entry, member } of kept) {
    if (member === null) {
      entry.alt = `Media ${++inboxCount}`
    } else {
      const k = entry.kind === "image" ? ++imagesSeen[member] : 0
      entry.alt = postMediaAlt(members[member].title, entry.kind, k)
    }
  }

  return {
    visual: kept.map((k) => k.entry).filter((entry) => !isFileEntry(entry)),
    files: kept.map((k) => k.entry).filter(isFileEntry),
  }
}
