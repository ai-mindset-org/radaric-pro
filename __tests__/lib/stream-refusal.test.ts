/**
 * RAD-326, RAD-406 — the one place a pre-stream refusal's copy and in-band
 * frame are read. Shared by the server (which writes the frame) and both
 * EventSource consumers (the posts card and the feed card), so the copy cannot
 * drift between them.
 */

import { describe, it, expect } from "vitest"
import {
  rateLimitCopy,
  readRefusal,
  refusalCopy,
  RATE_LIMITED,
  UNAUTHORIZED,
  EMAIL_NOT_VERIFIED,
  SIGN_IN_PATH,
} from "@/lib/stream-refusal"

describe("rateLimitCopy", () => {
  it("says when to retry, in seconds", () => {
    expect(rateLimitCopy(42)).toBe("Too many requests — try again in 42s")
  })

  it("never promises a wait shorter than a second", () => {
    expect(rateLimitCopy(0)).toBe("Too many requests — try again in 1s")
    expect(rateLimitCopy(2.2)).toBe("Too many requests — try again in 3s")
  })
})

describe("readRefusal", () => {
  it("returns the wait from a RATE_LIMITED error frame", () => {
    expect(readRefusal({ type: "error", code: RATE_LIMITED, retryAfter: 17 })).toEqual({
      code: RATE_LIMITED,
      retryAfter: 17,
    })
  })

  it("reads the sign-in and the email refusals, which carry no wait", () => {
    expect(readRefusal({ type: "error", code: UNAUTHORIZED })).toEqual({ code: UNAUTHORIZED })
    expect(readRefusal({ type: "error", code: EMAIL_NOT_VERIFIED, retryAfter: 9 })).toEqual({
      code: EMAIL_NOT_VERIFIED,
    })
  })

  it("ignores every other error frame — a real failure is not a refusal", () => {
    expect(readRefusal({ type: "error", message: "Story grouping failed" })).toBeNull()
    expect(readRefusal({ type: "error", error: "Subscription required" })).toBeNull()
    expect(readRefusal({ type: "error", code: "SOMETHING_ELSE" })).toBeNull()
    expect(readRefusal({ type: "complete", code: RATE_LIMITED, retryAfter: 5 })).toBeNull()
    expect(readRefusal({ type: "complete", code: UNAUTHORIZED })).toBeNull()
    expect(readRefusal(null)).toBeNull()
    expect(readRefusal("UNAUTHORIZED")).toBeNull()
  })

  it("falls back to a full window when a rate-limit frame carries no usable wait", () => {
    expect(readRefusal({ type: "error", code: RATE_LIMITED })).toEqual({ code: RATE_LIMITED, retryAfter: 60 })
    expect(readRefusal({ type: "error", code: RATE_LIMITED, retryAfter: "soon" })).toEqual({
      code: RATE_LIMITED,
      retryAfter: 60,
    })
  })
})

describe("refusalCopy", () => {
  it("tells a signed-out user to sign in again", () => {
    expect(refusalCopy({ code: UNAUTHORIZED })).toMatch(/sign in again/i)
  })

  it("tells an unverified user to verify, and where the resend action is", () => {
    const copy = refusalCopy({ code: EMAIL_NOT_VERIFIED })
    expect(copy).toMatch(/verify your email/i)
    expect(copy).toMatch(/resend/i)
    expect(copy).toMatch(/banner/i)
  })

  it("is the rate-limit copy for a rate limit", () => {
    expect(refusalCopy({ code: RATE_LIMITED, retryAfter: 42 })).toBe(rateLimitCopy(42))
  })
})

describe("SIGN_IN_PATH", () => {
  it("is the page that signs a user in — /login only redirects to it", () => {
    expect(SIGN_IN_PATH).toBe("/signup")
  })
})
