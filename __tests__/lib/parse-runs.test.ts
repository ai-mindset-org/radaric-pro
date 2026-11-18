/**
 * RAD-346 — the in-memory parse-run registry (`lib/parse-runs.ts`).
 *
 * A parse run belongs to the SERVER, not to the transport. When the CDN in front
 * of radaric.pro truncates the SSE stream, the run keeps going and records its
 * outcome here; the card polls `GET /api/parse-stream/status` and settles with
 * the truth. Only an explicit stop ends a run early.
 *
 * Criteria covered:
 *   lifecycle: begin → running at zero; finish stores the outcome; a later begin starts fresh
 *   AC-2: a second begin for a user with a live run returns null
 *   AC-3: requestStopForUser flags the running run; false when nothing is running
 *   AC-4: the snapshot is live — synced counters are visible through the handle and getRunSnapshot
 *   EC-1: a stop that lands on a finished run is a no-op
 *   EC-2: syncRunProgress stores absolute values, never sums them
 *   EC-3: a finished run is GC'd after RUN_RETENTION_MS
 *
 * `__resetParseRunsForTests` is module state, so it runs in `beforeEach` — the
 * suite has to be order-independent (same reason `resetRateLimits` exists).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  beginParseRun,
  syncRunProgress,
  finishParseRun,
  requestStopForUser,
  isStopRequested,
  getRunSnapshot,
  __resetParseRunsForTests,
  RUN_RETENTION_MS,
} from "@/lib/parse-runs"

const USER = "user-run-1"

const results = (over: Record<string, unknown> = {}) => ({
  parsed: 4,
  evaluated: 4,
  approved: 3,
  filtered: 1,
  errors: [],
  ...over,
})

beforeEach(() => {
  __resetParseRunsForTests()
})

afterEach(() => {
  vi.useRealTimers()
  __resetParseRunsForTests()
})

describe("parse runs", () => {
  it("lifecycle: begin opens a running run with the manifest's denominator and zero progress", () => {
    const run = beginParseRun(USER, 3)

    expect(run).not.toBeNull()
    expect(run!.userId).toBe(USER)

    const snap = getRunSnapshot(USER)
    expect(snap?.status).toBe("running")
    expect(snap?.total).toBe(3)
    expect(snap?.processed).toBe(0)
    expect(snap?.approved).toBe(0)
    expect(snap?.filtered).toBe(0)
    expect(snap?.finishedAt).toBeNull()
    expect(snap?.results).toBeNull()
    expect(typeof snap?.startedAt).toBe("number")

    // The handle and the lookup describe the same run.
    expect(snap?.id).toBe(run!.id)
  })

  it("AC-2: a second begin for a user whose run is live returns null", () => {
    const first = beginParseRun(USER, 3)

    const second = beginParseRun(USER, 7)

    expect(second).toBeNull()
    // The live run is untouched — same id, same denominator.
    expect(getRunSnapshot(USER)?.id).toBe(first!.id)
    expect(getRunSnapshot(USER)?.total).toBe(3)
  })

  it("AC-4: syncRunProgress is visible on the handle and through getRunSnapshot", () => {
    const run = beginParseRun(USER, 4)
    syncRunProgress(run!, { processed: 2, approved: 1, filtered: 1 })

    const snap = getRunSnapshot(USER)
    expect(snap?.status).toBe("running")
    expect(snap?.processed).toBe(2)
    expect(snap?.approved).toBe(1)
    expect(snap?.filtered).toBe(1)
    expect(run!.snapshot.processed).toBe(2)
    expect(snap?.finishedAt).toBeNull()
  })

  it("EC-2: syncRunProgress stores absolute totals rather than summing them", () => {
    // The route passes its own running totals, so a call is a SET, not an
    // increment: summing here would double every source the route reports twice.
    const run = beginParseRun(USER, 6)
    syncRunProgress(run!, { processed: 2, approved: 1, filtered: 0 })
    syncRunProgress(run!, { processed: 5, approved: 3, filtered: 2 })
    syncRunProgress(run!, { processed: 5, approved: 3, filtered: 2 }) // a repeat is inert

    const snap = getRunSnapshot(USER)
    expect(snap?.processed).toBe(5)
    expect(snap?.approved).toBe(3)
    expect(snap?.filtered).toBe(2)
  })

  it("lifecycle: finish stores the status, finishedAt and the server's results; the next begin starts fresh", () => {
    const run = beginParseRun(USER, 2)
    finishParseRun(run!, { status: "done", results: results({ parsed: 6, approved: 5, filtered: 1 }) })

    const snap = getRunSnapshot(USER)
    expect(snap?.status).toBe("done")
    expect(snap?.finishedAt).toBeGreaterThan(0)
    expect(snap?.results).toEqual(results({ parsed: 6, approved: 5, filtered: 1 }))
    expect(isStopRequested(run!)).toBe(false)

    const next = beginParseRun(USER, 3)
    expect(next).not.toBeNull()
    expect(next!.id).not.toBe(run!.id)
    expect(getRunSnapshot(USER)?.status).toBe("running")
    expect(getRunSnapshot(USER)?.total).toBe(3)
    expect(getRunSnapshot(USER)?.results).toBeNull()
  })

  it("AC-3 / EC-1: requestStopForUser flags a running run and reports false otherwise", () => {
    // Nothing running for this user yet.
    expect(requestStopForUser(USER)).toBe(false)

    const run = beginParseRun(USER, 2)
    expect(isStopRequested(run!)).toBe(false)

    expect(requestStopForUser(USER)).toBe(true)
    expect(isStopRequested(run!)).toBe(true)

    // EC-1: a stop that lands once the run already settled changes nothing.
    syncRunProgress(run!, { processed: 2, approved: 4, filtered: 1 })
    finishParseRun(run!, { status: "done", results: results({ approved: 4 }) })
    const settled = getRunSnapshot(USER)

    expect(requestStopForUser(USER)).toBe(false)
    expect(getRunSnapshot(USER)).toEqual(settled)
    expect(getRunSnapshot(USER)?.status).toBe("done")
  })

  it("EC-3: a finished run is evicted after RUN_RETENTION_MS and the next begin starts fresh", () => {
    expect(RUN_RETENTION_MS).toBe(15 * 60_000)

    vi.useFakeTimers()
    const run = beginParseRun(USER, 2)
    finishParseRun(run!, { status: "done", results: results() })
    expect(getRunSnapshot(USER)?.status).toBe("done")

    vi.advanceTimersByTime(RUN_RETENTION_MS + 1)

    expect(getRunSnapshot(USER)).toBeNull()

    const next = beginParseRun(USER, 5)
    expect(next).not.toBeNull()
    expect(getRunSnapshot(USER)?.total).toBe(5)
    expect(getRunSnapshot(USER)?.status).toBe("running")
  })
})
