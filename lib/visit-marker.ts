// The visit marker behind "offer onboarding again on a new visit" (RAD-168).
//
// A new visit is the first full page load after an hour with no activity.
// proxy.ts creates the cookie only on a page load (a document navigation to a
// non-/api path) and refreshes it on any signed-in request that already
// carries it, so it expires after an hour without requests. A page load
// without this user's marker starts a new visit. Pages cannot read the cookie to find that out:
// Next merges a cookie the proxy sets into the same request's `cookies()`, so a
// page would always see the marker the proxy just wrote. The proxy forwards its
// verdict as a request header instead (lib/onboarding-revisit.ts reads it).
//
// Runs in the proxy, so Web Crypto only — no Node APIs.

export const VISIT_COOKIE = "radaric_visit"
export const VISIT_IDLE_SECONDS = 60 * 60
export const NEW_VISIT_HEADER = "x-radaric-new-visit"

/** First 16 hex chars of SHA-256(userId) — another account on the same browser never matches it. */
export async function visitMarker(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(userId))
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("")
}
