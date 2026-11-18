// @vitest-environment node

/**
 * RAD-296 — in-process rate limiting (lib/rate-limit.ts).
 *
 * Unit surface: the store's window semantics, the ADMIN exemption, and the
 * client-IP derivation. The derivation is load-bearing: a CDN fronting the
 * instance sends `X-Real-IP` = end-user IP and `X-Forwarded-For` =
 * "<cdn-ip>, <user-ip>", so keying on XFF[0] (the old behaviour) buckets every
 * visitor under the CDN's own address.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  getClientIp,
  rateLimit,
  checkUserRateLimit,
  resetRateLimits,
} from "@/lib/rate-limit"

function headersOf(init: Record<string, string>): Headers {
  return new Headers(init)
}

beforeEach(() => {
  resetRateLimits()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("getClientIp", () => {
  it("prefers X-Real-IP (the CDN sets it to the end-user IP)", () => {
    expect(getClientIp(headersOf({ "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("normalizes a comma chain and a port in X-Real-IP", () => {
    expect(getClientIp(headersOf({ "x-real-ip": "172.16.0.1, 203.0.113.9" }))).toBe("203.0.113.9")
    expect(getClientIp(headersOf({ "x-real-ip": "203.0.113.9:5678" }))).toBe("203.0.113.9")
  })

  it("leaves a bare IPv6 address intact (the port strip must not eat a hextet)", () => {
    expect(getClientIp(headersOf({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1")
    expect(getClientIp(headersOf({ "x-real-ip": "2600:1005:b0a0:1234::1" }))).toBe("2600:1005:b0a0:1234::1")
    expect(getClientIp(headersOf({ "x-real-ip": "[2001:db8::1]:4321" }))).toBe("[2001:db8::1]")
  })

  it("takes the LAST X-Forwarded-For hop, not the CDN address", () => {
    expect(getClientIp(headersOf({ "x-forwarded-for": "172.16.0.1, 203.0.113.9" }))).toBe("203.0.113.9")
  })

  it("handles a single-value XFF and whitespace", () => {
    expect(getClientIp(headersOf({ "x-forwarded-for": "  203.0.113.9  " }))).toBe("203.0.113.9")
  })

  it("falls back to 'unknown' with no headers", () => {
    expect(getClientIp(headersOf({}))).toBe("unknown")
  })
})

describe("rateLimit (fixed window)", () => {
  it("allows up to the limit and blocks the next call with Retry-After", () => {
    for (let i = 0; i < 3; i++) {
      expect(rateLimit("t", "key", 3, 60_000)).toEqual({ ok: true })
    }
    const blocked = rateLimit("t", "key", 3, 60_000)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60)
    }
  })

  it("resets once the window elapses", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"))
    expect(rateLimit("t", "key", 1, 60_000).ok).toBe(true)
    expect(rateLimit("t", "key", 1, 60_000).ok).toBe(false)
    vi.setSystemTime(new Date("2026-09-14T00:01:01Z"))
    expect(rateLimit("t", "key", 1, 60_000).ok).toBe(true)
  })

  it("advertises the full remaining window for a long (1h) bucket", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"))
    expect(rateLimit("t", "hour", 1, 3_600_000).ok).toBe(true)
    const blocked = rateLimit("t", "hour", 1, 3_600_000)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.retryAfterSeconds).toBe(3600)
  })

  it("isolates buckets by name and by key", () => {
    expect(rateLimit("a", "same", 1, 60_000).ok).toBe(true)
    expect(rateLimit("b", "same", 1, 60_000).ok).toBe(true)
    expect(rateLimit("a", "other", 1, 60_000).ok).toBe(true)
    expect(rateLimit("a", "same", 1, 60_000).ok).toBe(false)
  })

  it("fails closed for NEW keys when one name's map is full, without starving other names", () => {
    // Fill the "flood" namespace to its cap with spoofed-key-like distinct keys.
    for (let i = 0; i < 10_000; i++) {
      rateLimit("flood", `key-${i}`, 1, 60_000)
    }
    // A new key in the exhausted namespace is refused…
    expect(rateLimit("flood", "brand-new", 1, 60_000).ok).toBe(false)
    // …while an existing key still counts and other namespaces are untouched.
    expect(rateLimit("flood", "key-0", 1, 60_000).ok).toBe(false)
    expect(rateLimit("other-name", "user-1", 1, 60_000).ok).toBe(true)
  })
})

describe("checkUserRateLimit", () => {
  it("blocks a user past the limit", () => {
    expect(checkUserRateLimit("u", "user-1", "USER", { limit: 1, windowMs: 60_000 })).toBeNull()
    const blocked = checkUserRateLimit("u", "user-1", "USER", { limit: 1, windowMs: 60_000 })
    expect(blocked).not.toBeNull()
    expect(blocked?.status).toBe(429)
    expect(blocked?.headers.get("Retry-After")).toBeTruthy()
  })

  it("never limits ADMIN", () => {
    for (let i = 0; i < 50; i++) {
      expect(checkUserRateLimit("u", "admin-1", "ADMIN", { limit: 1, windowMs: 60_000 })).toBeNull()
    }
  })
})
