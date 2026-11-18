/**
 * RAD-359 P5 — media reconciliation for posts stored before the Telegram media
 * mirror existed. A re-parse used to dedupe-and-early-return, so a pre-feature
 * row's empty `mediaUrls` were never refilled. This pure rule decides whether a
 * fresh parse result may backfill an existing row — media/content fields only,
 * never AI or status.
 */

export interface MediaBackfillInput {
  url?: string | null
  externalId?: string | null
  thumbnailUrl?: string | null
  mediaUrls: string[]
  content: string
}

export interface MediaBackfillPayload {
  thumbnailUrl: string | null
  mediaUrls: string[]
  content: string
}

const MEDIA_PLACEHOLDERS: readonly string[] = ["[Media message]", "[Media album]"]

/**
 * Returns the fields to write when the fresh parse carries media the stored row
 * does not; `null` when there is nothing to reconcile.
 *
 * AC-1: only a strict superset (every stored URL still present, and more) or an
 *       empty stored album gaining its first URL qualifies — an album is never
 *       shrunk.
 * EC-2: a fresh item with no media never produces a payload.
 *
 * AC-2: `thumbnailUrl` prefers the fresh non-null cover; `content` upgrades only
 *       from the two media placeholders to real text.
 */
/**
 * Telegram media placeholders a stored row may carry from the pre-RAD-359
 * parser (`tg://photo/*`, `tg://too-large/*`). They are "no media" for
 * reconciliation: a fresh real URL must be allowed to replace them.
 */
function isPlaceholderUrl(url: string): boolean {
  return url.startsWith("tg://")
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i])
}

export function computeMediaBackfill(
  existing: MediaBackfillInput,
  fresh: MediaBackfillInput
): MediaBackfillPayload | null {
  // A stored `tg://` marker is "no media": the old parser wrote one when an
  // upload failed, and it must not block the fresh real URL from replacing it.
  const storedMedia = existing.mediaUrls ?? []
  const existingMedia = storedMedia.filter((url) => !isPlaceholderUrl(url))
  const freshMedia = fresh.mediaUrls ?? []

  if (freshMedia.length === 0) return null
  // The same list again — typically an oversized post whose only entry is its
  // `tg://too-large/*` marker, which the filter above would read as "no media"
  // and rewrite (plus a `material_updated` event) on every parse. A poster
  // that arrives on a later parse is still a change worth writing.
  const newCover = fresh.thumbnailUrl != null && fresh.thumbnailUrl !== existing.thumbnailUrl
  if (sameList(storedMedia, freshMedia) && !newCover) return null

  const everyExistingStillPresent = existingMedia.every((url) => freshMedia.includes(url))
  const grows = freshMedia.length > existingMedia.length
  if (!everyExistingStillPresent || !grows) return null

  const existingIsPlaceholder = MEDIA_PLACEHOLDERS.includes(existing.content)
  const freshIsPlaceholder = MEDIA_PLACEHOLDERS.includes(fresh.content)

  return {
    thumbnailUrl: fresh.thumbnailUrl ?? existing.thumbnailUrl ?? null,
    mediaUrls: freshMedia,
    content: existingIsPlaceholder && !freshIsPlaceholder ? fresh.content : existing.content,
  }
}
