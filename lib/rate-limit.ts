// In-process rate limiting (RAD-296) — an abuse floor, not an authorization
// control.
//
// The app runs as a single long-lived container (`scripts/start.sh`),
// so a module-level Map is honest for now: state resets on deploy and does not
// coordinate across instances. If the app ever scales out, replace the store —
// callers keep their shape. Authenticated routes key on the USER ID (the cost
// unit, and the one identifier a caller cannot spoof); the client IP is used
// only where there is no session yet (signup, the Parallel webhook).
import { NextResponse } from "next/server"

/** The shipped per-route limits. */
export const RATE_LIMITS = {
  parseStream: { limit: 10, windowMs: 60_000 },
  parse: { limit: 10, windowMs: 60_000 },
  refilter: { limit: 5, windowMs: 60_000 },
  groupStories: { limit: 10, windowMs: 60_000 },
  onboardingParseFeeds: { limit: 10, windowMs: 60_000 },
  inboxRetry: { limit: 10, windowMs: 60_000 },
  storiesPoll: { limit: 20, windowMs: 60_000 },
  postStories: { limit: 10, windowMs: 60_000 },
  postStoryMatch: { limit: 10, windowMs: 60_000 },
  // /api/auth/signup is the unified signup+signin endpoint. Account CREATION is
  // the farming risk (per-IP); a returning user's sign-in gets a looser
  // per-(IP,email) budget so mistyped passwords can't lock out a shared NAT IP.
  // signupAll is the aggregate per-IP cap in FRONT of both — without it, an
  // attacker rotating emails is unbounded and the enumeration oracle is free.
  signupAll: { limit: 60, windowMs: 15 * 60_000 },
  signupIp: { limit: 20, windowMs: 60 * 60_000 },
  signupSignin: { limit: 10, windowMs: 15 * 60_000 },
  resendVerification: { limit: 3, windowMs: 15 * 60_000 },
  resendVerificationIp: { limit: 10, windowMs: 60 * 60_000 },
  passwordResetIp: { limit: 5, windowMs: 15 * 60_000 },
  passwordResetEmail: { limit: 3, windowMs: 15 * 60_000 },
  parallelWebhook: { limit: 100, windowMs: 60_000 },
} as const

/**
 * Real client IP behind a CDN.
 *
 * A CDN fronting the instance sets `X-Real-IP` to the end-user IP and
 * `X-Forwarded-For` to "<cdn-ip>, <user-ip>" — so XFF's FIRST entry is the CDN
 * itself, and keying on it throttles every visitor as one client (the bug
 * RAD-296 called out). When the origin is reachable directly, a caller can
 * spoof both headers, so IP-keyed limits are spoofable there; that is
 * acceptable only because this helper feeds an abuse floor — the authenticated
 * routes key on the user id, which is the real guard.
 */
export function getClientIp(headers: Headers): string {
  // Normalize both forms: take the last comma-separated token (a CDN may send a
  // chain) and strip a trailing :port.
  const normalize = (raw: string | null): string | null => {
    if (!raw) return null
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
    const last = parts[parts.length - 1]
    if (!last) return null
    // Strip a port ONLY when one is present — the naive /:\d+$/ also eats the
    // final hextet of a bare IPv6 address ("2001:db8::1" → "2001:db8:").
    if (/^\[.+\]:\d+$/.test(last)) return last.replace(/\]:\d+$/, "]")
    if (/^[^\]:]+:\d+$/.test(last)) return last.replace(/:\d+$/, "")
    return last
  }

  const realIp = normalize(headers.get("x-real-ip"))
  if (realIp) return realIp
  return normalize(headers.get("x-forwarded-for")) ?? "unknown"
}

type Bucket = { count: number; resetAt: number }
// One map per limiter name: the per-name cap means an IP-keyed flood (spoofable
// keys) can never fill the store and starve the per-user buckets, which are the
// real guard.
const mapsByName = new Map<string, Map<string, Bucket>>()
const MAX_BUCKETS_PER_NAME = 10_000

function bucketsFor(name: string): Map<string, Bucket> {
  let map = mapsByName.get(name)
  if (!map) {
    map = new Map()
    mapsByName.set(name, map)
  }
  return map
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number }

/** Fixed-window counter. Returns ok, or the Retry-After to advertise. */
export function rateLimit(
  name: string,
  key: string,
  limit: number,
  windowMs: number
): RateLimitResult {
  const now = Date.now()
  const buckets = bucketsFor(name)
  if (buckets.size >= MAX_BUCKETS_PER_NAME) sweepBuckets(buckets, now)

  const existing = buckets.get(key)
  if (!existing) {
    // Never evict a live bucket to make room: with spoofable keys, a full map
    // must fail closed for new keys rather than reset someone else's counter.
    if (buckets.size >= MAX_BUCKETS_PER_NAME) return { ok: false, retryAfterSeconds: 60 }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true }
  }
  if (now >= existing.resetAt) {
    existing.count = 1
    existing.resetAt = now + windowMs
    return { ok: true }
  }
  if (existing.count >= limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) }
  }
  existing.count++
  return { ok: true }
}

/** Drop expired buckets only — live counters are never discarded. */
function sweepBuckets(buckets: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key)
  }
}

export function rateLimitedResponse(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    { error: "Too many requests", code: "RATE_LIMITED" },
    {
      status: 429,
      // Never let an edge or browser cache a 429 past its window.
      headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" },
    }
  )
}

/**
 * Gate for authenticated routes: ADMIN is exempt (the operator must never be
 * locked out of their own tooling), everyone else buckets by user id.
 */
export function checkUserRateLimit(
  name: string,
  userId: string,
  role: string,
  opts: { limit: number; windowMs: number }
): NextResponse | null {
  if (role === "ADMIN") return null
  const result = rateLimit(name, userId, opts.limit, opts.windowMs)
  return result.ok ? null : rateLimitedResponse(result.retryAfterSeconds)
}

/** Gate over an explicit key (used by signup's IP / IP+email buckets). */
export function checkKeyRateLimit(
  name: string,
  key: string,
  opts: { limit: number; windowMs: number }
): NextResponse | null {
  const result = rateLimit(name, key, opts.limit, opts.windowMs)
  return result.ok ? null : rateLimitedResponse(result.retryAfterSeconds)
}

/** Test helper: clears every bucket. */
export function resetRateLimits(): void {
  mapsByName.clear()
}
