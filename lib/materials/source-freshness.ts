/**
 * "When did Radaric last check my sources?" (RAD-424).
 *
 * Nothing parses in the background: a feed is read only by Run parsing, the
 * feed card, or the first onboarding run. So `Feed.lastParsedAt` is the honest
 * answer to "is it quiet, or did I not press refresh?" — this module turns the
 * scope's sources into one summary and one phrasing of it. Pure on purpose: the
 * server pages build the props, the client component only renders them.
 */

export type FreshnessSource = {
  status: "ACTIVE" | "PAUSED" | "ERROR"
  isActive: boolean
  lastParsedAt: Date | string | null
}

export interface FreshnessSummary {
  /**
   * The OLDEST `lastParsedAt` among active sources that have one — the
   * guarantee "every source here was checked since X". Null when no active
   * source was ever checked.
   */
  checkedAt: Date | null
  /**
   * The most recent `lastParsedAt` among failed or paused sources. Not part of
   * `checkedAt`; it exists so a single paused or errored feed can still say when
   * it was last read.
   */
  inactiveCheckedAt: Date | null
  /** Active sources: `isActive && status === "ACTIVE"`. */
  activeCount: number
  /** Active sources that were never parsed. */
  neverCount: number
  /** Sources in ERROR (and still switched on). */
  failedCount: number
  /** PAUSED or switched-off sources. */
  pausedCount: number
}

/** The same summary with dates as ISO strings, safe across the RSC boundary. */
export interface FreshnessProps {
  checkedAt: string | null
  inactiveCheckedAt: string | null
  activeCount: number
  neverCount: number
  failedCount: number
  pausedCount: number
}

/**
 * Exported so the sentence lives in one place. The product copy must never
 * imply automatic polling — change the wording here, not at the call sites.
 */
export const MANUAL_CHECK_NOTE = "Sources are checked when you run parsing."

/** A stored last-run result counts as current when it is within this of the server's `checkedAt`. */
export const LAST_RUN_TOLERANCE_MS = 10 * 60_000

function toDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function summarizeFreshness(sources: FreshnessSource[]): FreshnessSummary {
  let oldestActive: Date | null = null
  let latestInactive: Date | null = null
  let activeCount = 0
  let neverCount = 0
  let failedCount = 0
  let pausedCount = 0

  for (const source of sources) {
    const parsed = toDate(source.lastParsedAt)
    if (!source.isActive || source.status === "PAUSED") {
      pausedCount++
    } else if (source.status === "ERROR") {
      failedCount++
    } else {
      activeCount++
      if (!parsed) neverCount++
      else if (!oldestActive || parsed < oldestActive) oldestActive = parsed
      continue
    }
    if (parsed && (!latestInactive || parsed > latestInactive)) latestInactive = parsed
  }

  return { checkedAt: oldestActive, inactiveCheckedAt: latestInactive, activeCount, neverCount, failedCount, pausedCount }
}

/**
 * Whether the "Checked … ago" line is shown at all. Off for now: it was pulled
 * from the posts header and source pages until a new place is chosen. The data
 * path (queries, summary, last-run recorder) stays wired, so turning it back on
 * is this one constant.
 */
export const FRESHNESS_LINE_VISIBLE = false

/** Whether the line has anything to say; false → render no row at all. */
export function hasFreshnessLine(freshness: FreshnessProps): boolean {
  return freshness.activeCount + freshness.failedCount + freshness.pausedCount > 0
}

export function freshnessProps(sources: FreshnessSource[]): FreshnessProps {
  const summary = summarizeFreshness(sources)
  return {
    ...summary,
    checkedAt: summary.checkedAt?.toISOString() ?? null,
    inactiveCheckedAt: summary.inactiveCheckedAt?.toISOString() ?? null,
  }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now" · "N min ago" · "N h ago" · "yesterday" · "N days ago". */
export function formatCheckedRelative(date: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - date.getTime())
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 2 * DAY) return "yesterday"
  const days = Math.floor(elapsed / DAY)
  return `${days} days ago`
}

/** The full timestamp in the reader's locale, for the tooltip. */
export function formatCheckedAbsolute(date: Date): string {
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
