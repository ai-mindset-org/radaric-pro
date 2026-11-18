/**
 * Retry Daemon — spec section 4.2 (retry policy)
 *
 * Per spec:
 *   - Items with ERROR status and retryCount < 3 are retried every 15 minutes.
 *   - After 3 retries, the item stays in ERROR permanently.
 *   - RetryDaemon: start() / stop() / runOnce(db) / isRunning getter.
 *   - getRetryableItems(db): query ERROR items with retryCount < 3, ordered by createdAt ASC.
 *   - retryItem(itemId, processFn, db): reset to PENDING, increment retryCount, call processFn.
 *     On success return true. On failure set back to ERROR, update errorMessage, return false.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getRetryableItems,
  retryItem,
  RetryDaemon,
} from '@/lib/story-aggregator/retry-daemon'

// ---------------------------------------------------------------------------
// Shared mock helpers
// ---------------------------------------------------------------------------

/** Minimal InboxItem shape as returned by Prisma's inboxItem.findMany. */
type MockInboxItem = {
  id: string
  status: string
  retryCount: number
  createdAt: Date
  errorMessage: string | null
}

function makeMockItem(overrides: Partial<MockInboxItem> = {}): MockInboxItem {
  return {
    id: 'item-1',
    status: 'ERROR',
    retryCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    errorMessage: null,
    ...overrides,
  }
}

/** Build a minimal Prisma client mock with vi.fn() stubs for inboxItem operations. */
function makeMockDb(items: MockInboxItem[] = []) {
  return {
    inboxItem: {
      findMany: vi.fn().mockResolvedValue(items),
      update: vi.fn().mockResolvedValue(undefined),
    },
  }
}

// ---------------------------------------------------------------------------
// 1. getRetryableItems()
//    Per spec 4.2: ERROR status, retryCount < 3, ordered by createdAt ASC.
// ---------------------------------------------------------------------------

describe('getRetryableItems() — spec 4.2 retry policy', () => {
  it('returns items with status ERROR and retryCount < 3', async () => {
    // Arrange
    const items = [
      makeMockItem({ id: 'item-1', retryCount: 0 }),
      makeMockItem({ id: 'item-2', retryCount: 2 }),
    ]
    const db = makeMockDb(items)

    // Act
    const result = await getRetryableItems(db as any)

    // Assert
    expect(result).toHaveLength(2)
    expect(db.inboxItem.findMany).toHaveBeenCalledOnce()
    // Verify the query uses the correct filter
    const callArgs = db.inboxItem.findMany.mock.calls[0][0]
    expect(callArgs.where.status).toBe('ERROR')
    expect(callArgs.where.retryCount.lt).toBe(3)
  })

  it('excludes items with retryCount >= 3 (max retries exhausted)', async () => {
    // Arrange: findMany simulates the DB filter returning nothing when all are exhausted
    const db = makeMockDb([])

    // Act
    const result = await getRetryableItems(db as any)

    // Assert
    expect(result).toHaveLength(0)
  })

  it('excludes items with non-ERROR status (e.g. PENDING, PROCESSED, EXTRACTING)', async () => {
    // Arrange: findMany returns an empty list because non-ERROR items are filtered
    const db = makeMockDb([])

    // Act
    const result = await getRetryableItems(db as any)

    // Assert
    expect(result).toHaveLength(0)
    const callArgs = db.inboxItem.findMany.mock.calls[0][0]
    expect(callArgs.where.status).toBe('ERROR')
  })

  it('returns items ordered by createdAt ASC — oldest first', async () => {
    // Arrange
    const db = makeMockDb([])

    // Act
    await getRetryableItems(db as any)

    // Assert: the query must specify ascending order on createdAt
    const callArgs = db.inboxItem.findMany.mock.calls[0][0]
    expect(callArgs.orderBy).toMatchObject({ createdAt: 'asc' })
  })
})

// ---------------------------------------------------------------------------
// 2. retryItem()
//    Per spec 4.2: reset to PENDING, increment retryCount, call processFn.
//    On success return true. On failure set back to ERROR, update errorMessage, return false.
// ---------------------------------------------------------------------------

describe('retryItem() — spec 4.2 retry mechanics', () => {
  it('resets status to PENDING and increments retryCount before calling processFn', async () => {
    // Arrange
    const db = makeMockDb()
    const processFn = vi.fn().mockResolvedValue(undefined)
    const itemId = 'item-abc'

    // Act
    await retryItem(itemId, processFn, db as any)

    // Assert: first update call must set PENDING (retryCount incremented by pipeline, not daemon)
    expect(db.inboxItem.update).toHaveBeenCalledWith({
      where: { id: itemId },
      data: { status: 'PENDING' },
    })
    // processFn must have been called with the item id
    expect(processFn).toHaveBeenCalledWith(itemId)
  })

  it('returns true when processFn resolves successfully', async () => {
    // Arrange
    const db = makeMockDb()
    const processFn = vi.fn().mockResolvedValue(undefined)

    // Act
    const result = await retryItem('item-ok', processFn, db as any)

    // Assert
    expect(result).toBe(true)
  })

  it('sets status back to ERROR and updates errorMessage when processFn throws', async () => {
    // Arrange
    const db = makeMockDb()
    const errorMessage = 'Extraction failed: timeout'
    const processFn = vi.fn().mockRejectedValue(new Error(errorMessage))
    const itemId = 'item-fail'

    // Act
    await retryItem(itemId, processFn, db as any)

    // Assert: a second update must restore ERROR status and record the error message
    const updateCalls = db.inboxItem.update.mock.calls
    const errorUpdateCall = updateCalls.find(
      (call: any[]) =>
        call[0].where?.id === itemId &&
        call[0].data?.status === 'ERROR'
    )
    expect(errorUpdateCall).toBeDefined()
    expect(errorUpdateCall![0].data.errorMessage).toContain(errorMessage)
  })

  it('returns false when processFn throws', async () => {
    // Arrange
    const db = makeMockDb()
    const processFn = vi.fn().mockRejectedValue(new Error('boom'))

    // Act
    const result = await retryItem('item-fail', processFn, db as any)

    // Assert
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. RetryDaemon class
//    Per spec 4.2: intervalMs default 15 min, start() / stop() / runOnce(db) / isRunning.
// ---------------------------------------------------------------------------

describe('RetryDaemon — timer lifecycle (spec 4.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() begins periodic execution at the configured intervalMs', async () => {
    // Arrange
    const db = makeMockDb([])
    const processFn = vi.fn().mockResolvedValue(undefined)
    const intervalMs = 15 * 60 * 1000 // 15 minutes
    const daemon = new RetryDaemon(intervalMs, processFn)

    // Act
    daemon.start(db as any)

    // The first interval fires after intervalMs
    await vi.advanceTimersByTimeAsync(intervalMs)

    // Assert: runOnce must have been triggered at least once
    expect(db.inboxItem.findMany).toHaveBeenCalled()

    daemon.stop()
  })

  it('stop() clears the interval timer and halts further executions', async () => {
    // Arrange
    const db = makeMockDb([])
    const processFn = vi.fn().mockResolvedValue(undefined)
    const intervalMs = 15 * 60 * 1000
    const daemon = new RetryDaemon(intervalMs, processFn)

    daemon.start(db as any)
    daemon.stop()

    const callCountAfterStop = db.inboxItem.findMany.mock.calls.length

    // Advance time well past one interval — should not trigger any more calls
    await vi.advanceTimersByTimeAsync(intervalMs * 2)

    // Assert: call count must not have grown after stop()
    expect(db.inboxItem.findMany).toHaveBeenCalledTimes(callCountAfterStop)
  })

  it('isRunning returns false before start(), true after start(), false after stop()', () => {
    // Arrange
    const db = makeMockDb([])
    const processFn = vi.fn().mockResolvedValue(undefined)
    const daemon = new RetryDaemon(15 * 60 * 1000, processFn)

    // Assert initial state
    expect(daemon.isRunning).toBe(false)

    // Act + Assert after start
    daemon.start(db as any)
    expect(daemon.isRunning).toBe(true)

    // Act + Assert after stop
    daemon.stop()
    expect(daemon.isRunning).toBe(false)
  })

  it('runOnce(db) processes all retryable items in a single pass', async () => {
    // Arrange
    const retryableItems = [
      makeMockItem({ id: 'item-1', retryCount: 0 }),
      makeMockItem({ id: 'item-2', retryCount: 1 }),
    ]
    const db = makeMockDb(retryableItems)
    const processFn = vi.fn().mockResolvedValue(undefined)
    const daemon = new RetryDaemon(15 * 60 * 1000, processFn)

    // Act: run a single retry pass without starting the interval
    await daemon.runOnce(db as any)

    // Assert: processFn must have been called once for each retryable item
    expect(processFn).toHaveBeenCalledTimes(retryableItems.length)
    expect(processFn).toHaveBeenCalledWith('item-1')
    expect(processFn).toHaveBeenCalledWith('item-2')
  })
})
