/**
 * Follow a server-owned parse run after its stream is gone (RAD-346, RAD-407).
 *
 * A CDN or reverse proxy in front of the app can truncate the parse stream,
 * and the run keeps going on the server (`lib/parse-runs.ts`). A client that lost
 * its stream polls `GET /api/parse-stream/status` until the run settles, then
 * shows the run's real result. The posts card (`use-post-processing.ts`) and the
 * feed card both follow through this one loop, so the race tolerance, the
 * failure cap and the ceiling cannot drift between them. Client-safe.
 */

import type { ParseRunSnapshot } from "@/lib/parse-runs"
import { isSignedOutResponse } from "@/lib/stream-refusal"

/** How often a detached client asks the server about its run. */
export const STATUS_POLL_MS = 4000
/** Consecutive failures (~1 minute) before a detached run settles as gone. */
const STATUS_MAX_FAILURES = 15
/** A detached run that never settles stops being polled after this long. */
const DETACHED_MAX_MS = 20 * 60_000

/**
 * RAD-347: one unusable status body is a race, not a verdict. The route claims
 * the run only after auth + rate limit + email gate + two DB reads, so a drop
 * inside that window answers `{ run: null }` while the server is about to parse
 * the whole account. A second consecutive unusable body — with a usable
 * `running` snapshot resetting the count — is the verdict.
 */
const STATUS_UNUSABLE_TOLERANCE = 2

/**
 * Read a status body into a snapshot, or `null` when it says nothing usable.
 *
 * `{ run: null }`, `{}` and any shape whose `status` is unknown all mean "the
 * registry has nothing to say" — read naively (`{}` is truthy, and so is
 * `body.run` when the field is missing on some shapes) a client would settle as
 * a success with invented zero totals.
 */
export function readRunSnapshot(body: unknown): ParseRunSnapshot | null {
  const snapshot = (body as { run?: unknown } | null | undefined)?.run
  if (!snapshot || typeof snapshot !== "object") return null
  const candidate = snapshot as Record<string, unknown>
  const status = candidate.status
  if (status !== "running" && status !== "done" && status !== "stopped") return null
  // The numbers are what a client renders and counts with: a status-only body
  // would otherwise print "undefined of undefined sources processed".
  const numbers = [candidate.processed, candidate.total, candidate.approved, candidate.filtered]
  if (!numbers.every(value => typeof value === "number" && Number.isFinite(value))) return null
  return snapshot as ParseRunSnapshot
}

type FollowResult =
  /** The run finished (`done` or `stopped`); its snapshot carries the results. */
  | { outcome: "settled"; snapshot: ParseRunSnapshot }
  /** The registry cannot say what happened: no record, the failure cap, or the ceiling. */
  | { outcome: "gone" }
  /** The session ended while following: the status check came back signed out. */
  | { outcome: "unauthorized" }
  /** The caller tore the follow down. */
  | { outcome: "aborted" }

interface FollowOptions {
  /** Aborting it clears the timer, cancels the request in flight and resolves "aborted". */
  signal: AbortSignal
  /** A running snapshot, on every poll that returns one. */
  onProgress?: (snapshot: ParseRunSnapshot) => void
  /** Checked before and after every request; false resolves "aborted". */
  isCurrent?: () => boolean
  /**
   * The run this follow is for, as the stream's `parse_start` named it. The
   * registry is per user and keeps a finished run for 15 minutes, so without an
   * id the first poll could answer with an EARLIER run and the card would
   * report that run's results as its own. A snapshot with another id is
   * unusable, and two in a row settle the follow as "gone".
   *
   * Without an id (the stream died before `parse_start`) the follow cannot tell
   * its run from an earlier one, so it only takes a run it has seen RUNNING —
   * a finished snapshot it never saw running is unusable — and then locks onto
   * that run's id. A run that started and finished between two polls is
   * reported as "gone" rather than borrowed: honest copy beats another run's
   * numbers. No baseline read is taken before the stream opens; that would
   * cost a request on every parse to cover a drop that happens before the
   * server's first frame.
   */
  runId?: string | null
  /**
   * Take a finished run even when no id is known. Only for a card the server
   * refused because a run was ALREADY running: the refusal is proof that the
   * registry holds that run, and nothing else, until it finishes.
   */
  acceptFinishedRun?: boolean
}

/** Poll the status endpoint until the run settles, is gone, or the follow is aborted. */
export function followServerRun({
  signal,
  onProgress,
  isCurrent = () => true,
  runId = null,
  acceptFinishedRun = false,
}: FollowOptions): Promise<FollowResult> {
  return new Promise(resolve => {
    const detachedAt = Date.now()
    let failures = 0
    let unusable = 0
    let ownRunId = runId

    /** Is this snapshot the run being followed? Locks onto the first one it accepts. */
    const isOwnRun = (snapshot: ParseRunSnapshot): boolean => {
      if (ownRunId) return snapshot.id === ownRunId
      if (snapshot.status !== "running" && !acceptFinishedRun) return false
      ownRunId = snapshot.id
      return true
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false
    // Each poll's request is abortable: without this a request that hangs in
    // the browser outlives both the ceiling and the failure cap, and the
    // client can never settle — the one outcome those bounds exist to prevent.
    const inFlight = new AbortController()

    const settle = (result: FollowResult) => {
      if (done) return
      done = true
      inFlight.abort()
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = () => settle({ outcome: "aborted" })
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener("abort", onAbort)

    const poll = async () => {
      if (!isCurrent()) {
        settle({ outcome: "aborted" })
        return
      }
      // A run that never settles must not be polled for the life of the page:
      // the ceiling turns the worst case into an honest "gone".
      if (Date.now() - detachedAt >= DETACHED_MAX_MS) {
        settle({ outcome: "gone" })
        return
      }

      try {
        const response = await fetch("/api/parse-stream/status", { signal: inFlight.signal })
        if (done) return
        if (!isCurrent()) {
          settle({ outcome: "aborted" })
          return
        }
        // An ended session is a verdict, not a failure to retry: without this,
        // fifteen polls fail on the sign-in page's HTML and the run reads as lost.
        if (isSignedOutResponse(response)) {
          settle({ outcome: "unauthorized" })
          return
        }
        if (!response.ok) throw new Error("Status unavailable")
        const body = (await response.json()) as { run?: unknown }
        if (done) return
        failures = 0
        const read = readRunSnapshot(body)
        // Another run's snapshot says nothing about this one.
        const snapshot = read && isOwnRun(read) ? read : null
        if (!snapshot) {
          // The first unusable body is tolerated — the route may still be
          // claiming the run — and only the second consecutive one gives up.
          unusable++
          if (unusable >= STATUS_UNUSABLE_TOLERANCE) {
            settle({ outcome: "gone" })
            return
          }
        } else {
          // A real snapshot proves the run is alive, so the tolerance resets.
          unusable = 0
          if (snapshot.status !== "running") {
            settle({ outcome: "settled", snapshot })
            return
          }
          onProgress?.(snapshot)
        }
      } catch {
        if (done) return
        failures++
        // A failed read is not an unusable body: "consecutive unusable" means
        // two bodies in a row, not two bodies with an error between.
        unusable = 0
        if (failures >= STATUS_MAX_FAILURES) {
          settle({ outcome: "gone" })
          return
        }
      }

      if (!done) timer = setTimeout(poll, STATUS_POLL_MS)
    }

    timer = setTimeout(poll, STATUS_POLL_MS)
  })
}
