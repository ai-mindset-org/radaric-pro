/**
 * Worker Health Check — spec section 2.5 items 1 and 6
 *
 * Per spec:
 *   - GET /health checks: GramJS connected, last successful poll < 5 min ago, Prisma can reach DB
 *   - Heartbeat monitoring: immediate alert on critical errors (GramJS disconnect, DB unreachable)
 *
 * Tests verify the HealthStatus shape and composite status logic of WorkerHealthCheck.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WorkerHealthCheck, healthHttpStatus } from '@/lib/story-aggregator/health-check'
import type { HealthStatus } from '@/lib/story-aggregator/health-check'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fully-healthy check instance (gramjs + db connected, poll just recorded). */
function makeHealthyCheck(): WorkerHealthCheck {
  const hc = new WorkerHealthCheck()
  hc.setGramjsConnected(true)
  hc.setDatabaseReachable(true)
  hc.recordSuccessfulPoll()
  return hc
}

// ---------------------------------------------------------------------------
// Suite 1: Initial state
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — initial state (spec 2.5 §1)', () => {
  it('reports status "error" on a fresh instance with nothing connected', () => {
    const hc = new WorkerHealthCheck()
    const status: HealthStatus = hc.getStatus()
    expect(status.status).toBe('error')
  })

  it('reports gramjs as false and database as false initially', () => {
    const hc = new WorkerHealthCheck()
    const status = hc.getStatus()
    expect(status.gramjs).toBe(false)
    expect(status.database).toBe(false)
  })

  it('reports lastPollStale as true when no poll has been recorded', () => {
    const hc = new WorkerHealthCheck()
    expect(hc.getStatus().lastPollStale).toBe(true)
  })

  it('errors array is non-empty on a fresh instance describing what is wrong', () => {
    const hc = new WorkerHealthCheck()
    const { errors } = hc.getStatus()
    expect(Array.isArray(errors)).toBe(true)
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 2: setGramjsConnected()
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — setGramjsConnected()', () => {
  it('marks gramjs as connected when called with true', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    expect(hc.getStatus().gramjs).toBe(true)
  })

  it('marks gramjs as disconnected when called with false after being connected', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setGramjsConnected(false)
    expect(hc.getStatus().gramjs).toBe(false)
  })

  it('includes a "GramJS disconnected" error description when gramjs is false', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(false)
    const { errors } = hc.getStatus()
    expect(errors.some((e) => /gramjs.*disconnected/i.test(e))).toBe(true)
  })

  it('does NOT include a GramJS error when gramjs is connected', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(true)
    hc.recordSuccessfulPoll()
    const { errors } = hc.getStatus()
    expect(errors.some((e) => /gramjs/i.test(e))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suite 3: setDatabaseReachable()
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — setDatabaseReachable()', () => {
  it('marks database as reachable when called with true', () => {
    const hc = new WorkerHealthCheck()
    hc.setDatabaseReachable(true)
    expect(hc.getStatus().database).toBe(true)
  })

  it('marks database as unreachable when called with false', () => {
    const hc = new WorkerHealthCheck()
    hc.setDatabaseReachable(true)
    hc.setDatabaseReachable(false)
    expect(hc.getStatus().database).toBe(false)
  })

  it('includes a "Database unreachable" error description when database is false', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(false)
    const { errors } = hc.getStatus()
    expect(errors.some((e) => /database.*unreachable/i.test(e))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Suite 4: recordSuccessfulPoll() + time tracking
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — recordSuccessfulPoll() (spec 2.5 §1: last poll < 5 min)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sets lastPollStale to false immediately after a poll is recorded', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(true)
    hc.recordSuccessfulPoll()
    expect(hc.getStatus().lastPollStale).toBe(false)
  })

  it('reports lastPollAgo close to zero immediately after a poll', () => {
    const hc = new WorkerHealthCheck()
    hc.recordSuccessfulPoll()
    expect(hc.getStatus().lastPollAgo).toBeLessThan(2) // within 2 seconds
  })

  it('reports lastPollStale as true after 301 seconds without a poll (> 5 min threshold)', () => {
    const hc = new WorkerHealthCheck()
    hc.recordSuccessfulPoll()

    vi.advanceTimersByTime(301_000) // 301 s

    expect(hc.getStatus().lastPollStale).toBe(true)
  })

  it('reports lastPollAgo that reflects elapsed time since last poll', () => {
    const hc = new WorkerHealthCheck()
    hc.recordSuccessfulPoll()

    vi.advanceTimersByTime(120_000) // 2 minutes

    const ago = hc.getStatus().lastPollAgo
    expect(ago).toBeGreaterThanOrEqual(120)
    expect(ago).toBeLessThan(125)
  })
})

// ---------------------------------------------------------------------------
// Suite 5: getStatus() — composite status logic
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — getStatus() composite status (spec 2.5 §1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "ok" when gramjs connected, database reachable, and poll is fresh', () => {
    const hc = makeHealthyCheck()
    expect(hc.getStatus().status).toBe('ok')
  })

  it('returns "error" when gramjs is disconnected (critical failure per spec 2.5 §6)', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(false)
    hc.setDatabaseReachable(true)
    hc.recordSuccessfulPoll()
    expect(hc.getStatus().status).toBe('error')
  })

  it('returns "error" when database is unreachable (critical failure per spec 2.5 §6)', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(false)
    hc.recordSuccessfulPoll()
    expect(hc.getStatus().status).toBe('error')
  })

  it('returns "degraded" when gramjs and db are ok but last poll is stale (> 5 min)', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(true)
    hc.recordSuccessfulPoll()

    vi.advanceTimersByTime(301_000) // go stale

    expect(hc.getStatus().status).toBe('degraded')
  })

  it('errors array lists stale-poll description when poll is stale', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsConnected(true)
    hc.setDatabaseReachable(true)
    hc.recordSuccessfulPoll()

    vi.advanceTimersByTime(301_000)

    const { errors } = hc.getStatus()
    expect(errors.some((e) => /stale|5.?min/i.test(e))).toBe(true)
  })

  it('errors array is empty when status is "ok"', () => {
    const hc = makeHealthyCheck()
    expect(hc.getStatus().errors).toHaveLength(0)
  })

  it('uptime is a positive number of seconds after instantiation', () => {
    vi.advanceTimersByTime(5_000) // 5 s
    const hc = new WorkerHealthCheck()
    vi.advanceTimersByTime(10_000) // 10 s pass

    const { uptime } = hc.getStatus()
    expect(uptime).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 6: setPendingItems()
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — setPendingItems()', () => {
  it('reflects the last set value in pendingItems', () => {
    const hc = new WorkerHealthCheck()
    hc.setPendingItems(7)
    expect(hc.getStatus().pendingItems).toBe(7)
  })

  it('updates pendingItems when called multiple times', () => {
    const hc = new WorkerHealthCheck()
    hc.setPendingItems(3)
    hc.setPendingItems(0)
    expect(hc.getStatus().pendingItems).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Suite 7: session state + lock wait (RAD-328)
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — session state and lock wait (RAD-328)', () => {
  it('starts in the "starting" session state with no lock wait', () => {
    const hc = new WorkerHealthCheck()
    const status = hc.getStatus()
    expect(status.gramjsState).toBe('starting')
    expect(status.lockWaitSeconds).toBe(0)
  })

  it('reflects the set session state — a lock wait must be distinguishable from a dead session', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsState('invalid')
    expect(hc.getStatus().gramjsState).toBe('invalid')
    hc.setGramjsState('active')
    expect(hc.getStatus().gramjsState).toBe('active')
  })

  it('reflects the lock wait seconds', () => {
    const hc = new WorkerHealthCheck()
    hc.setLockWaitSeconds(42)
    expect(hc.getStatus().lockWaitSeconds).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Suite 8: Telegram never configured (self-host install, D1)
// ---------------------------------------------------------------------------

describe('WorkerHealthCheck — Telegram never configured (D1)', () => {
  it('reports "unconfigured" with HTTP 200 when the DB is reachable — no listener, no poller, no failure', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsState('unconfigured')
    hc.setDatabaseReachable(true)

    const status = hc.getStatus()

    expect(status.status).toBe('unconfigured')
    expect(status.gramjs).toBe(false)
    expect(status.database).toBe(true)
    // The never-started poller must not report a stale poll, and the absent
    // listener must not report a disconnect: a fresh install is healthy.
    expect(status.errors).toEqual([])
    expect(healthHttpStatus(status.status)).toBe(200)
  })

  it('is still "error" (503) when the database is unreachable while unconfigured', () => {
    const hc = new WorkerHealthCheck()
    hc.setGramjsState('unconfigured')
    hc.setDatabaseReachable(false)

    const status = hc.getStatus()

    expect(status.status).toBe('error')
    expect(status.errors).toContain('Database unreachable')
    expect(healthHttpStatus(status.status)).toBe(503)
  })

  it.each(['starting', 'invalid', 'unavailable', 'active'])(
    'keeps the pre-existing error (503) for session state "%s" without a GramJS client',
    (state) => {
      const hc = new WorkerHealthCheck()
      hc.setGramjsState(state)
      hc.setGramjsConnected(false)
      hc.setDatabaseReachable(true)

      const status = hc.getStatus()

      expect(status.status).toBe('error')
      expect(status.errors).toContain('GramJS disconnected')
      expect(healthHttpStatus(status.status)).toBe(503)
    }
  )

  it('leaves a configured (Telegram active) worker exactly as it was', () => {
    const hc = makeHealthyCheck()
    hc.setGramjsState('active')

    expect(hc.getStatus().status).toBe('ok')
    expect(healthHttpStatus('ok')).toBe(200)

    // Degraded is a stale poller, not an outage — still 200.
    expect(healthHttpStatus('degraded')).toBe(200)
    // Only a real failure is 503.
    expect(healthHttpStatus('error')).toBe(503)
  })
})
