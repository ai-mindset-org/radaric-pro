import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  ProcessingQueue,
  withRetry,
  type ProcessFn,
} from "@/lib/story-aggregator/processing-queue"

// ---------------------------------------------------------------------------
// 1. ProcessingQueue — sequential execution (spec 2.5 item 4: concurrency=1)
// ---------------------------------------------------------------------------

describe("ProcessingQueue — sequential execution (concurrency=1)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("processes items one at a time — second item starts only after first completes", async () => {
    const order: string[] = []
    let resolveFirst!: () => void

    const processFn: ProcessFn<string> = (item) => {
      if (item === "first") {
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            order.push("first-done")
            resolve()
          }
        })
      }
      order.push("second-start")
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    queue.enqueue("first")
    queue.enqueue("second")

    // Second should not have started yet because first is still running
    expect(order).not.toContain("second-start")

    // Complete first item
    resolveFirst()
    await queue.drain()

    // Second started only after first finished
    expect(order).toEqual(["first-done", "second-start"])
  })

  it("processes items in FIFO order", async () => {
    const processed: number[] = []

    const processFn: ProcessFn<number> = (item) => {
      processed.push(item)
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    queue.enqueue(1)
    queue.enqueue(2)
    queue.enqueue(3)

    await queue.drain()

    expect(processed).toEqual([1, 2, 3])
  })

  it("size reflects the number of items waiting plus currently processing", async () => {
    let resolveItem!: () => void

    const processFn: ProcessFn<string> = (_item) =>
      new Promise<void>((resolve) => {
        resolveItem = resolve
      })

    const queue = new ProcessingQueue(processFn)

    queue.enqueue("a")
    queue.enqueue("b")
    queue.enqueue("c")

    // One item is processing, two are waiting: size = 3
    expect(queue.size).toBe(3)

    resolveItem()
    // Allow the next item to start processing
    await Promise.resolve()
    await Promise.resolve()

    // Still two remaining (one processing, one waiting)
    expect(queue.size).toBe(2)

    resolveItem()
    await Promise.resolve()
    await Promise.resolve()

    expect(queue.size).toBe(1)

    resolveItem()
    await queue.drain()

    expect(queue.size).toBe(0)
  })

  it("isProcessing is true while an item is being processed and false when idle", async () => {
    let resolveItem!: () => void

    const processFn: ProcessFn<string> = (_item) =>
      new Promise<void>((resolve) => {
        resolveItem = resolve
      })

    const queue = new ProcessingQueue(processFn)

    expect(queue.isProcessing).toBe(false)

    queue.enqueue("item")

    // Processing must begin immediately
    expect(queue.isProcessing).toBe(true)

    resolveItem()
    await queue.drain()

    expect(queue.isProcessing).toBe(false)
  })

  it("drain() resolves only when the queue is fully empty", async () => {
    const processed: string[] = []

    const processFn: ProcessFn<string> = (item) => {
      processed.push(item)
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    queue.enqueue("x")
    queue.enqueue("y")

    await queue.drain()

    expect(processed).toHaveLength(2)
    expect(queue.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 2. ProcessingQueue — error handling
//    Per spec 4.2: on failure, item moves to ERROR but queue continues.
// ---------------------------------------------------------------------------

describe("ProcessingQueue — error handling", () => {
  it("continues processing subsequent items when one item's processFn throws", async () => {
    const processed: string[] = []

    const processFn: ProcessFn<string> = (item) => {
      if (item === "bad") return Promise.reject(new Error("boom"))
      processed.push(item)
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    queue.enqueue("good-1")
    queue.enqueue("bad")
    queue.enqueue("good-2")

    await queue.drain()

    expect(processed).toContain("good-1")
    expect(processed).toContain("good-2")
  })

  it("error in one item does not prevent other items from being processed", async () => {
    const results: string[] = []
    let callCount = 0

    const processFn: ProcessFn<string> = (_item) => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error("first fails"))
      results.push(`item-${callCount}`)
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    queue.enqueue("a")
    queue.enqueue("b")
    queue.enqueue("c")

    await queue.drain()

    // Items b and c must have been processed despite item a failing
    expect(results).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 3. ProcessingQueue — shutdown
//    Per spec 2.5 item 2: stop accepting new items, finish current.
// ---------------------------------------------------------------------------

describe("ProcessingQueue — shutdown", () => {
  it("enqueue() is silently ignored after shutdown() is called", async () => {
    const processed: string[] = []

    const processFn: ProcessFn<string> = (item) => {
      processed.push(item)
      return Promise.resolve()
    }

    const queue = new ProcessingQueue(processFn)

    await queue.shutdown()

    queue.enqueue("should-be-ignored")

    // Allow any microtasks to run
    await new Promise((r) => setTimeout(r, 0))

    expect(processed).not.toContain("should-be-ignored")
  })

  it("shutdown() waits for the currently processing item to finish before resolving", async () => {
    let resolveCurrentItem!: () => void
    let currentItemFinished = false

    const processFn: ProcessFn<string> = (_item) =>
      new Promise<void>((resolve) => {
        resolveCurrentItem = () => {
          currentItemFinished = true
          resolve()
        }
      })

    const queue = new ProcessingQueue(processFn)
    queue.enqueue("in-flight")

    const shutdownPromise = queue.shutdown()

    // Shutdown must not resolve before the in-flight item completes
    let shutdownResolved = false
    shutdownPromise.then(() => {
      shutdownResolved = true
    })

    // Give microtasks a chance to settle — shutdown should still be pending
    await Promise.resolve()
    expect(shutdownResolved).toBe(false)

    // Finish the in-flight item
    resolveCurrentItem()
    await shutdownPromise

    expect(currentItemFinished).toBe(true)
    expect(shutdownResolved).toBe(true)
  })

  it("drain() resolves immediately when called after shutdown on an empty queue", async () => {
    const processFn: ProcessFn<string> = () => Promise.resolve()

    const queue = new ProcessingQueue(processFn)
    await queue.shutdown()

    // drain() must resolve without hanging
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. withRetry()
//    Per spec 4.2: retryCount < 3 means up to 3 retries (4 total attempts).
// ---------------------------------------------------------------------------

describe("withRetry()", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves immediately with the return value when fn succeeds on the first try", async () => {
    const fn = vi.fn().mockResolvedValue("ok")

    const resultPromise = withRetry(fn)
    // No timers to advance — first call succeeds
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it("retries on failure and succeeds on a subsequent attempt", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockResolvedValue("success-on-retry")

    const resultPromise = withRetry(fn, { delayMs: 0 })
    await vi.runAllTimersAsync()

    await expect(resultPromise).resolves.toBe("success-on-retry")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("throws after exhausting all retries (default maxRetries=3 means 4 total attempts)", async () => {
    // Per spec: "retryCount < 3" means retry when count is 0, 1, 2 — 3 retries
    // Initial attempt + 3 retries = 4 total calls
    const fn = vi.fn().mockRejectedValue(new Error("always fails"))

    const resultPromise = withRetry(fn, { delayMs: 0 })
    await vi.runAllTimersAsync()

    await expect(resultPromise).rejects.toThrow("always fails")
    expect(fn).toHaveBeenCalledTimes(4)
  })

  it("respects a custom maxRetries option", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"))

    const resultPromise = withRetry(fn, { maxRetries: 1, delayMs: 0 })
    await vi.runAllTimersAsync()

    await expect(resultPromise).rejects.toThrow()
    // 1 initial attempt + 1 retry = 2 total calls
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("waits delayMs between retry attempts", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok")

    const delayMs = 500
    const resultPromise = withRetry(fn, { delayMs })

    // After the first call, we should be waiting for the delay
    expect(fn).toHaveBeenCalledTimes(1)

    // Advance time just before the delay — second call must not have happened
    await vi.advanceTimersByTimeAsync(delayMs - 1)
    expect(fn).toHaveBeenCalledTimes(1)

    // Advance past the delay — second call should now run
    await vi.advanceTimersByTimeAsync(2)
    expect(fn).toHaveBeenCalledTimes(2)

    await resultPromise
  })

  it("default maxRetries is 3 — spec: retryCount < 3", async () => {
    // Verify the default without passing options
    const fn = vi.fn().mockRejectedValue(new Error("always fails"))

    const resultPromise = withRetry(fn)
    await vi.runAllTimersAsync()

    await expect(resultPromise).rejects.toThrow()
    // Default = 3 retries: 1 initial + 3 retries = 4 total
    expect(fn).toHaveBeenCalledTimes(4)
  })
})
