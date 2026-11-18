/**
 * RAD-318 Phase 1b — the SSE transport has to survive a CDN it was never
 * written for.
 *
 * The hosted instance sits behind a CDN whose edge rule covers `/api/*` exactly
 * as it covers documents, and it replaces `cache-control` wholesale. Measured
 * 2026-09-11 against the deployed instance:
 *
 *   direct origin  cache-control: no-store, must-revalidate
 *                  vary: rsc, next-router-state-tree, …
 *   via the CDN    cache-control: private, no-cache, no-store, max-age=0, must-revalidate
 *                  vary: Accept-Encoding
 *
 * So the `no-transform` these three routes have always set never reaches a
 * browser on the production host. These tests pin the two things that do:
 * `X-Accel-Buffering: no`, and a heartbeat comment frame — because between
 * `source_start` and a source's first `material_created` the stream can
 * legitimately emit nothing for up to SOURCE_TIMEOUT_MS (180s).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SSE_HEADERS, HEARTBEAT_INTERVAL_MS, startHeartbeat } from "@/lib/sse"

describe("SSE response headers", () => {
  it("tells intermediaries not to buffer", () => {
    // The header a proxy actually honours. The CDN does not rewrite it, unlike
    // Cache-Control.
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no")
  })

  it("keeps the event-stream content type and the direct-to-origin cache hints", () => {
    expect(SSE_HEADERS["Content-Type"]).toBe("text/event-stream; charset=utf-8")
    expect(SSE_HEADERS["Cache-Control"]).toContain("no-transform")
    expect(SSE_HEADERS["Connection"]).toBe("keep-alive")
  })
})

describe("heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    return () => vi.useRealTimers()
  })

  function fakeController() {
    const chunks: string[] = []
    let closed = false
    const decoder = new TextDecoder()
    return {
      chunks,
      close: () => { closed = true },
      controller: {
        enqueue: (c: Uint8Array) => {
          if (closed) throw new TypeError("Controller is already closed")
          chunks.push(decoder.decode(c))
        },
      } as unknown as ReadableStreamDefaultController,
    }
  }

  it("emits a comment frame on the interval, which EventSource ignores", () => {
    const { controller, chunks } = fakeController()
    const stop = startHeartbeat(controller, new TextEncoder())

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3)
    stop()

    expect(chunks).toEqual([": heartbeat\n\n", ": heartbeat\n\n", ": heartbeat\n\n"])
    // A comment frame has no `data:` line, so onmessage never fires for it.
    expect(chunks.every(c => c.startsWith(":"))).toBe(true)
  })

  it("stops on request and emits nothing afterwards", () => {
    const { controller, chunks } = fakeController()
    const stop = startHeartbeat(controller, new TextEncoder())

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    stop()
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5)

    expect(chunks).toHaveLength(1)
  })

  it("is idempotent — a second stop is harmless", () => {
    const { controller } = fakeController()
    const stop = startHeartbeat(controller, new TextEncoder())
    stop()
    expect(() => stop()).not.toThrow()
  })

  it("gives up quietly once the controller is closed", () => {
    const { controller, chunks, close } = fakeController()
    startHeartbeat(controller, new TextEncoder())

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    close()
    // Enqueueing on a closed controller throws; that must clear the interval
    // rather than surface as an unhandled error every 15s forever.
    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 4)).not.toThrow()
    expect(chunks).toHaveLength(1)
  })
})
