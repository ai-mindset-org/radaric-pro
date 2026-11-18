/**
 * Heartbeat Monitor — spec section 2.5 requirement 6
 *
 * Per spec:
 *   - Daily summary via Telegram: "Processed X items, Y stories, Z errors"
 *   - Immediate alert on critical errors (GramJS disconnect, DB unreachable)
 *
 * Exports under test:
 *   - HeartbeatStats interface
 *   - getHeartbeatStats(db) — queries DB for stats since last heartbeat
 *   - formatDailySummary(stats) — formats stats as TG message
 *   - formatErrorAlert(errorType, details) — formats immediate error alert
 *   - HeartbeatDeps interface
 *   - HeartbeatMonitor class — start() / stop() / sendDailySummary() / sendAlert() / isRunning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getHeartbeatStats,
  formatDailySummary,
  formatErrorAlert,
  HeartbeatMonitor,
} from '@/lib/story-aggregator/heartbeat'
import type { HeartbeatStats, HeartbeatDeps } from '@/lib/story-aggregator/heartbeat'

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal DB deps mock for HeartbeatDeps.
 * Counts are configurable per test.
 */
function makeMockDb(counts: {
  processed?: number
  stories?: number
  errors?: number
  pending?: number
} = {}) {
  const { processed = 0, stories = 0, errors = 0, pending = 0 } = counts

  return {
    inboxItem: {
      count: vi.fn().mockImplementation(async (args: { where: { status: string } }) => {
        const status = args?.where?.status
        if (status === 'PROCESSED') return processed
        if (status === 'ERROR') return errors
        if (status === 'PENDING') return pending
        return 0
      }),
    },
    story: {
      count: vi.fn().mockResolvedValue(stories),
    },
  }
}

/** Build a fully-wired HeartbeatDeps mock (db + sendMessage). */
function makeMockDeps(counts: Parameters<typeof makeMockDb>[0] = {}): HeartbeatDeps & {
  sendMessage: ReturnType<typeof vi.fn>
} {
  const db = makeMockDb(counts)
  return {
    db: {
      inboxItem: db.inboxItem,
      story: db.story,
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  }
}

/** A minimal HeartbeatStats object for use in formatter tests. */
function makeStats(overrides: Partial<HeartbeatStats> = {}): HeartbeatStats {
  return {
    processedItems: 15,
    storiesCreated: 8,
    errorsCount: 2,
    pendingItems: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. getHeartbeatStats() — spec 2.5 §6: daily summary counts
// ---------------------------------------------------------------------------

describe('getHeartbeatStats() — spec 2.5 §6 DB queries', () => {
  it('returns processedItems by counting InboxItem with status PROCESSED', async () => {
    const db = makeMockDb({ processed: 15 })

    const stats = await getHeartbeatStats(db as any)

    expect(stats.processedItems).toBe(15)
    // Verify the query uses the correct status filter
    const processedCall = db.inboxItem.count.mock.calls.find(
      (call: any[]) => call[0]?.where?.status === 'PROCESSED'
    )
    expect(processedCall).toBeDefined()
  })

  it('returns storiesCreated from story.count query', async () => {
    const db = makeMockDb({ stories: 8 })

    const stats = await getHeartbeatStats(db as any)

    expect(stats.storiesCreated).toBe(8)
    expect(db.story.count).toHaveBeenCalled()
  })

  it('returns errorsCount by counting InboxItem with status ERROR', async () => {
    const db = makeMockDb({ errors: 3 })

    const stats = await getHeartbeatStats(db as any)

    expect(stats.errorsCount).toBe(3)
    const errorCall = db.inboxItem.count.mock.calls.find(
      (call: any[]) => call[0]?.where?.status === 'ERROR'
    )
    expect(errorCall).toBeDefined()
  })

  it('returns pendingItems by counting InboxItem with status PENDING', async () => {
    const db = makeMockDb({ pending: 5 })

    const stats = await getHeartbeatStats(db as any)

    expect(stats.pendingItems).toBe(5)
    const pendingCall = db.inboxItem.count.mock.calls.find(
      (call: any[]) => call[0]?.where?.status === 'PENDING'
    )
    expect(pendingCall).toBeDefined()
  })

  it('returns zero counts when there is no activity', async () => {
    const db = makeMockDb({ processed: 0, stories: 0, errors: 0, pending: 0 })

    const stats = await getHeartbeatStats(db as any)

    expect(stats.processedItems).toBe(0)
    expect(stats.storiesCreated).toBe(0)
    expect(stats.errorsCount).toBe(0)
    expect(stats.pendingItems).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. formatDailySummary() — spec 2.5 §6: "Processed X items, Y stories, Z errors"
// ---------------------------------------------------------------------------

describe('formatDailySummary() — spec 2.5 §6 message format', () => {
  it('includes processed item count in the output', () => {
    const stats = makeStats({ processedItems: 15 })

    const message = formatDailySummary(stats)

    expect(message).toContain('15')
  })

  it('includes stories created count in the output', () => {
    const stats = makeStats({ storiesCreated: 8 })

    const message = formatDailySummary(stats)

    expect(message).toContain('8')
  })

  it('includes errors count in the output', () => {
    const stats = makeStats({ errorsCount: 2 })

    const message = formatDailySummary(stats)

    expect(message).toContain('2')
  })

  it('shows zero counts as "0" (not empty or omitted)', () => {
    const stats = makeStats({ processedItems: 0, storiesCreated: 0, errorsCount: 0, pendingItems: 0 })

    const message = formatDailySummary(stats)

    // Must show each count explicitly, not hide zeros
    expect(message).toContain('0')
  })

  it('returns a non-empty string with a header line identifying the report', () => {
    const stats = makeStats()

    const message = formatDailySummary(stats)

    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(20)
    // Should identify this as a Story Aggregator report
    expect(message.toLowerCase()).toMatch(/story aggregator|daily report/i)
  })

  it('includes a timestamp in the output', () => {
    const stats = makeStats()

    const message = formatDailySummary(stats)

    // Timestamp can be a date string, "today", or any time indicator
    // Just ensure something date/time-like is present (year or time pattern)
    expect(message).toMatch(/\d{4}|\d{2}:\d{2}|today/i)
  })
})

// ---------------------------------------------------------------------------
// 3. formatErrorAlert() — spec 2.5 §6: immediate alerts on critical errors
// ---------------------------------------------------------------------------

describe('formatErrorAlert() — spec 2.5 §6 critical error alerts', () => {
  it('includes the errorType in the formatted message', () => {
    const message = formatErrorAlert('GramJS disconnected', 'Connection timeout after 30s')

    expect(message).toContain('GramJS disconnected')
  })

  it('includes the details string in the formatted message', () => {
    const message = formatErrorAlert('DB unreachable', 'ECONNREFUSED 5432')

    expect(message).toContain('ECONNREFUSED 5432')
  })

  it('contains an alert header identifying it as an urgent notification', () => {
    const message = formatErrorAlert('GramJS disconnected', 'Connection timeout')

    expect(message.toLowerCase()).toMatch(/alert|error|critical/i)
  })

  it('formats DB unreachable alert with both error type and connection details', () => {
    const message = formatErrorAlert('DB unreachable', 'Connection refused on port 5432')

    expect(message).toContain('DB unreachable')
    expect(message).toContain('Connection refused on port 5432')
  })
})

// ---------------------------------------------------------------------------
// 4. HeartbeatMonitor class — timer lifecycle (spec 2.5 §6)
// ---------------------------------------------------------------------------

describe('HeartbeatMonitor — timer lifecycle (spec 2.5 §6)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('isRunning is false before start()', () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    expect(monitor.isRunning).toBe(false)
  })

  it('isRunning is true after start()', () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    monitor.start()

    expect(monitor.isRunning).toBe(true)
    monitor.stop()
  })

  it('isRunning is false after stop()', () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    monitor.start()
    monitor.stop()

    expect(monitor.isRunning).toBe(false)
  })

  it('stop() prevents further sendMessage calls after the interval fires', async () => {
    const intervalMs = 60 * 60 * 1000 // 1 hour for test speed
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(intervalMs, deps)

    monitor.start()
    monitor.stop()

    const callCountAfterStop = deps.sendMessage.mock.calls.length

    await vi.advanceTimersByTimeAsync(intervalMs * 2)

    expect(deps.sendMessage).toHaveBeenCalledTimes(callCountAfterStop)
  })

  it('start() triggers sendMessage via the interval after intervalMs elapses', async () => {
    const intervalMs = 60 * 60 * 1000
    const deps = makeMockDeps({ processed: 5, stories: 3, errors: 0, pending: 1 })
    const monitor = new HeartbeatMonitor(intervalMs, deps)

    monitor.start()
    await vi.advanceTimersByTimeAsync(intervalMs)

    expect(deps.sendMessage).toHaveBeenCalledAtLeast(1)
    monitor.stop()
  })
})

// ---------------------------------------------------------------------------
// 5. HeartbeatMonitor.sendDailySummary() — manual trigger
// ---------------------------------------------------------------------------

describe('HeartbeatMonitor — sendDailySummary() manual trigger', () => {
  it('calls deps.sendMessage with a formatted daily summary string', async () => {
    const deps = makeMockDeps({ processed: 10, stories: 4, errors: 1, pending: 2 })
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    await monitor.sendDailySummary()

    expect(deps.sendMessage).toHaveBeenCalledOnce()
    const [message] = deps.sendMessage.mock.calls[0]
    expect(typeof message).toBe('string')
    expect(message.length).toBeGreaterThan(0)
  })

  it('the message sent by sendDailySummary contains actual stat values', async () => {
    const deps = makeMockDeps({ processed: 7, stories: 3, errors: 2, pending: 0 })
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    await monitor.sendDailySummary()

    const [message] = deps.sendMessage.mock.calls[0]
    // All three key counts must appear in the sent message
    expect(message).toContain('7')
    expect(message).toContain('3')
    expect(message).toContain('2')
  })
})

// ---------------------------------------------------------------------------
// 6. HeartbeatMonitor.sendAlert() — immediate critical error notification
// ---------------------------------------------------------------------------

describe('HeartbeatMonitor — sendAlert() immediate alerts (spec 2.5 §6)', () => {
  it('calls deps.sendMessage with an alert string for GramJS disconnect', async () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    await monitor.sendAlert('GramJS disconnected', 'Session expired')

    expect(deps.sendMessage).toHaveBeenCalledOnce()
    const [message] = deps.sendMessage.mock.calls[0]
    expect(message).toContain('GramJS disconnected')
    expect(message).toContain('Session expired')
  })

  it('calls deps.sendMessage with an alert string for DB unreachable', async () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    await monitor.sendAlert('DB unreachable', 'ECONNREFUSED')

    expect(deps.sendMessage).toHaveBeenCalledOnce()
    const [message] = deps.sendMessage.mock.calls[0]
    expect(message).toContain('DB unreachable')
    expect(message).toContain('ECONNREFUSED')
  })

  it('can be called independently of start() — alert does not require running monitor', async () => {
    const deps = makeMockDeps()
    const monitor = new HeartbeatMonitor(24 * 60 * 60 * 1000, deps)

    // Monitor is NOT started — sendAlert must still work
    expect(monitor.isRunning).toBe(false)
    await expect(monitor.sendAlert('GramJS disconnected', 'timeout')).resolves.not.toThrow()
    expect(deps.sendMessage).toHaveBeenCalledOnce()
  })
})
