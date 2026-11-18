/**
 * Which feeds a parse run will actually read. The one rule lives here so the
 * run (`/api/parse-stream`) and the "last checked" line (RAD-424) cannot drift:
 * an X feed kept by a user without the X entitlement is never fetched, so a
 * freshness line that counted it would read "stale" forever.
 */

export function isParseableType(type: string, includesTwitter: boolean): boolean {
  return includesTwitter || type !== "TWITTER"
}

export function parseableFeedWhere(options: {
  userId?: string
  includesTwitter: boolean
  sourceIds?: string[]
  /**
   * Keep paused / switched-off feeds. A run skips them; the freshness line still
   * needs them so a lone paused feed can say "Paused".
   */
  includeInactive?: boolean
}) {
  const { userId, includesTwitter, sourceIds, includeInactive = false } = options
  return {
    ...(sourceIds ? { id: { in: sourceIds } } : {}),
    ...(userId ? { userId } : {}),
    ...(includeInactive ? {} : { isActive: true }),
    hidden: false,
    // Exclude X feeds for non-Pro users — they stay in the DB (locked in the
    // UI) but are never fetched.
    ...(includesTwitter ? {} : { type: { not: "TWITTER" as const } }),
  }
}
