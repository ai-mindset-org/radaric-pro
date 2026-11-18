/**
 * In-memory registry of parse runs — one per user (RAD-346).
 *
 * A parse run belongs to the server, not to the transport. A CDN or reverse
 * proxy in front of the app can cut the SSE stream, and before this registry
 * existed the route read that as a user stop: every source not yet
 * started was skipped and `parse_complete` was never sent. Now the route finishes
 * every source, records its progress and outcome here, and a card that lost the
 * connection polls `GET /api/parse-stream/status` until it can settle with the
 * truth.
 *
 * Same posture as `lib/rate-limit.ts`: in-process, single instance, no DB
 * writes. Railway runs one long-lived container, so a module-level Map is
 * honest; a multi-instance deployment degrades to losing a run with its
 * instance, the same assumption the rate limiter already documents.
 */

import type { ParseResults } from "@/lib/materials/processing-state"

export type ParseRunStatus = "running" | "done" | "stopped"

export interface ParseRunSnapshot {
  id: string
  startedAt: number
  finishedAt: number | null
  status: ParseRunStatus
  /** Sources in the manifest. */
  total: number
  /** Sources settled (done or failed). */
  processed: number
  approved: number
  filtered: number
  /** Final totals, once the run finished. */
  results: ParseResults | null
}

export interface ParseRunHandle {
  readonly id: string
  readonly userId: string
  readonly snapshot: ParseRunSnapshot
}

/** Finished runs stay visible this long. */
export const RUN_RETENTION_MS = 15 * 60_000

interface ParseRunEntry {
  snapshot: ParseRunSnapshot
  stopRequested: boolean
}

const runsByUser = new Map<string, ParseRunEntry>()

function entryFor(run: ParseRunHandle): ParseRunEntry | null {
  const entry = runsByUser.get(run.userId)
  // The id check makes a handle from a superseded run inert rather than a way
  // to write into the run that replaced it.
  return entry && entry.snapshot.id === run.id ? entry : null
}

/**
 * Drop finished runs past their retention window. Called on every read rather
 * than from a timer: a timer would hold the process open, and the app's only
 * reads are requests that are cheap to sweep over.
 */
function evictExpired(now: number): void {
  for (const [userId, entry] of runsByUser) {
    const { finishedAt } = entry.snapshot
    if (finishedAt !== null && now - finishedAt >= RUN_RETENTION_MS) runsByUser.delete(userId)
  }
}

function handleFor(userId: string, entry: ParseRunEntry): ParseRunHandle {
  return {
    id: entry.snapshot.id,
    userId,
    // Live: a caller holding the handle sees the run's progress without another
    // lookup, and the map holds the one mutable copy both views share.
    get snapshot() {
      return entry.snapshot
    },
  }
}

/**
 * Open a run for this user, or report that one is already live. One run per
 * user is the contract the card polls against; a finished run is replaced.
 */
export function beginParseRun(userId: string, total: number): ParseRunHandle | null {
  const now = Date.now()
  evictExpired(now)

  const existing = runsByUser.get(userId)
  if (existing && existing.snapshot.status === "running") return null

  const entry: ParseRunEntry = {
    snapshot: {
      id: crypto.randomUUID(),
      startedAt: now,
      finishedAt: null,
      status: "running",
      total,
      processed: 0,
      approved: 0,
      filtered: 0,
      results: null,
    },
    stopRequested: false,
  }
  runsByUser.set(userId, entry)
  return handleFor(userId, entry)
}

/**
 * Store the route's running totals as ABSOLUTE values. The route passes its own
 * accumulators, so treating this as an increment would double every count it
 * reports more than once.
 */
export function syncRunProgress(
  run: ParseRunHandle,
  progress: { processed: number; approved: number; filtered: number }
): void {
  const entry = entryFor(run)
  if (!entry || entry.snapshot.status !== "running") return
  entry.snapshot.processed = progress.processed
  entry.snapshot.approved = progress.approved
  entry.snapshot.filtered = progress.filtered
}

export function finishParseRun(
  run: ParseRunHandle,
  outcome: { status: "done" | "stopped"; results: ParseResults }
): void {
  const entry = entryFor(run)
  if (!entry || entry.snapshot.status !== "running") return

  // Stored as an explicit pick, never by reference: the route's accumulator
  // carries internal-only fields (`approvedMaterialIds`) that would otherwise
  // be serialized into every status payload the client polls.
  const stored: ParseResults = {}
  if (typeof outcome.results.parsed === "number") stored.parsed = outcome.results.parsed
  if (typeof outcome.results.evaluated === "number") stored.evaluated = outcome.results.evaluated
  if (typeof outcome.results.approved === "number") stored.approved = outcome.results.approved
  if (typeof outcome.results.filtered === "number") stored.filtered = outcome.results.filtered
  if (outcome.results.errors) stored.errors = outcome.results.errors

  entry.snapshot.status = outcome.status
  entry.snapshot.finishedAt = Date.now()
  entry.snapshot.results = stored
  if (typeof stored.approved === "number") entry.snapshot.approved = stored.approved
  if (typeof stored.filtered === "number") entry.snapshot.filtered = stored.filtered
}

/** True only when a run was actually running and its task wrapper will see it. */
export function requestStopForUser(userId: string): boolean {
  const entry = runsByUser.get(userId)
  if (!entry || entry.snapshot.status !== "running") return false
  entry.stopRequested = true
  return true
}

export function isStopRequested(run: ParseRunHandle): boolean {
  return entryFor(run)?.stopRequested ?? false
}

/** The user's run — live or within its retention window — or null. */
export function getRunSnapshot(userId: string): ParseRunSnapshot | null {
  evictExpired(Date.now())
  const snapshot = runsByUser.get(userId)?.snapshot
  // A copy, so a caller cannot reach in and corrupt the run every other reader
  // sees (the status route serializes, but that is its business, not a promise
  // this module can lean on).
  return snapshot ? { ...snapshot, results: snapshot.results ? { ...snapshot.results } : null } : null
}

export function __resetParseRunsForTests(): void {
  runsByUser.clear()
}
