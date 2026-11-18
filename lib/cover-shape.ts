/**
 * Whether a source image is shaped like a cover band or like an avatar.
 *
 * A feed's `coverUrl` comes from wherever the fetcher found one — a channel
 * photo, an RSS `<image>` logo, a homepage og:image (`lib/feed-cover.ts`) — so
 * the feed type says nothing about its shape. Only a landscape image wide
 * enough to fill a card column reads as a cover; a square logo stretched to
 * column width, or a small icon upscaled, reads as a mistake.
 */

export type CoverShape = "banner" | "avatar"

/** og:image is 1.91:1 and 16:9 is 1.78:1; a 4:3 still (1.33) also holds up. */
const MIN_BANNER_RATIO = 1.3
/** Below this a banner upscales visibly in a ~360px column. */
const MIN_BANNER_WIDTH = 320

export function classifyCoverShape(width: number, height: number): CoverShape {
  if (height <= 0) return "avatar"
  return width / height >= MIN_BANNER_RATIO && width >= MIN_BANNER_WIDTH ? "banner" : "avatar"
}
