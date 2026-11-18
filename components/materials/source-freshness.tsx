"use client"

/**
 * "Checked 12 min ago" next to Run parsing (RAD-424).
 *
 * The answer to "no new posts, or did I not press refresh?". Nothing polls in
 * the background, so the line is built from `Feed.lastParsedAt` (the server
 * prop, refreshed by the run's own `router.refresh()`) and, as the headline,
 * the result of the last run on this device.
 *
 * Locale and relative text are produced only after mount: the server cannot
 * know the reader's clock or locale, and a first render that differs from the
 * server's is a hydration mismatch.
 */

import { useSyncExternalStore } from "react"
import {
  LAST_RUN_TOLERANCE_MS,
  MANUAL_CHECK_NOTE,
  formatCheckedAbsolute,
  formatCheckedRelative,
  type FreshnessProps,
} from "@/lib/materials/source-freshness"
import type { LastRun } from "@/lib/materials/last-run"

const TICK_MS = 60_000

/**
 * The clock sampled at the last tick, in ms. `useSyncExternalStore` needs a
 * snapshot that is stable between reads, and a number sampled once per minute
 * is — while still being the true time at the moment it was taken, so a check
 * made exactly an hour ago reads "1 h ago", not "59 min ago".
 */
let sampled = 0

function sample(): number {
  const now = Date.now()
  // Re-sample when stale (or when the clock moved backwards, as a test's does).
  if (Math.abs(now - sampled) >= TICK_MS) sampled = now
  return sampled
}

function subscribeToClock(onTick: () => void) {
  sampled = Date.now()
  onTick() // catches a snapshot that went stale between render and subscribe
  const id = setInterval(() => {
    sampled = Date.now()
    onTick()
  }, TICK_MS)
  return () => clearInterval(id)
}

/**
 * Wall-clock `Date`, re-ticking every minute. Null on the server and during
 * hydration (`getServerSnapshot`), so the first client render matches the
 * server's and the relative text appears only once mounted.
 */
export function useNow(): Date | null {
  const ms = useSyncExternalStore(subscribeToClock, sample, () => null)
  return ms === null ? null : new Date(ms)
}

interface SourceFreshnessProps {
  freshness: FreshnessProps
  /** The last parse run on this device, when there is one. */
  lastRun?: LastRun | null
}

const NEVER_CHECKED = "Not checked yet: run parsing to check your sources"

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function SourceFreshness({ freshness, lastRun = null }: SourceFreshnessProps) {
  const now = useNow()
  // Reserves the line's height so the grid below does not jump when it appears.
  if (!now) return <p className="min-h-[1lh] text-xs text-muted-foreground" aria-hidden="true" />

  const serverAt = freshness.checkedAt ? new Date(freshness.checkedAt) : null
  const inactiveAt = freshness.inactiveCheckedAt ? new Date(freshness.inactiveCheckedAt) : null
  const failed = freshness.failedCount > 0 ? ` · ${freshness.failedCount} failed` : ""
  const relative = (date: Date) => formatCheckedRelative(date, now)

  // The line is `before` + <time>relative</time> + `after`; `at` is null for the
  // never-checked state, which has no instant to show.
  let at: Date | null = null
  let before: string
  let after = ""

  const runAt = lastRun ? new Date(lastRun.at) : null
  if (
    lastRun &&
    runAt &&
    serverAt &&
    freshness.activeCount > 0 &&
    Math.abs(runAt.getTime() - serverAt.getTime()) <= LAST_RUN_TOLERANCE_MS
  ) {
    // The run is the headline only while the server agrees the whole scope was
    // checked around then. Two-sided: a newer server value means another device
    // parsed later; a much newer run means it covered only part of this scope
    // (or the refreshed server value has not arrived yet) — the server wins.
    at = runAt
    before = `${lastRun.newPosts === 0 ? "No new posts" : plural(lastRun.newPosts, "new post", "new posts")} · checked `
    after = `${freshness.neverCount > 0 ? ` · ${freshness.neverCount} not checked yet` : ""}${failed}`
  } else if (freshness.activeCount === 0) {
    // A single paused or errored source, or a scope with nothing switched on.
    if (freshness.failedCount > 0) {
      at = inactiveAt
      // lastParsedAt is not bumped by a failure, so the time is the last success.
      before = inactiveAt ? "Last check failed · last success " : "Last check failed"
    } else if (freshness.pausedCount > 0) {
      at = inactiveAt
      before = inactiveAt ? "Paused · checked " : "Paused"
    } else {
      return null
    }
  } else if (!serverAt) {
    before = `${NEVER_CHECKED}${failed}`
  } else {
    at = serverAt
    before = "Checked "
    after = `${freshness.neverCount > 0 ? ` · ${freshness.neverCount} not checked yet` : ""}${failed}`
  }

  const absolute = at ? formatCheckedAbsolute(at) : null
  const tooltip = absolute ? `${absolute}. ${MANUAL_CHECK_NOTE}` : MANUAL_CHECK_NOTE

  return (
    <p className="text-xs text-muted-foreground" data-testid="source-freshness" title={at ? undefined : tooltip}>
      {before}
      {at ? (
        <time
          dateTime={at.toISOString()}
          title={tooltip}
          className="underline decoration-dotted underline-offset-2"
        >
          {relative(at)}
        </time>
      ) : null}
      {after}
      <span className="sr-only">. {tooltip}</span>
    </p>
  )
}
