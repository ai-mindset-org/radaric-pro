/**
 * Pre-stream refusals as an EventSource can see them (RAD-326, RAD-406).
 *
 * EventSource exposes neither the status nor the body of a non-200 response, so
 * a refusal from `/api/parse-stream`, `/api/posts/refilter` or
 * `/api/posts/group-stories` — a 429, a 401, a 403 EMAIL_NOT_VERIFIED — reached
 * the UI as a dead connection. Those routes (and, for a signed-out request, the
 * proxy in front of them) now answer an event-stream caller with one in-band
 * frame, `{ type: "error", code, message, error }` plus `retryAfter` for a rate
 * limit. This module is the single reader of that frame and the single owner of
 * its copy, shared by the server and every client. Client-safe: no server
 * imports.
 */

export const RATE_LIMITED = "RATE_LIMITED"
export const UNAUTHORIZED = "UNAUTHORIZED"
export const EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED"

export type StreamRefusal =
  | { code: typeof RATE_LIMITED; retryAfter: number }
  | { code: typeof UNAUTHORIZED }
  | { code: typeof EMAIL_NOT_VERIFIED }

/**
 * Where a signed-out user signs back in. `/signup` is the unified sign-up and
 * sign-in page — `/login` only redirects to it, and the proxy sends every
 * signed-out page request there too.
 */
export const SIGN_IN_PATH = "/signup"

/**
 * True when a JSON request came back signed out. The proxy answers a signed-out
 * JSON caller with a redirect to the sign-in page, so `fetch` follows it and
 * lands on HTML with `ok: true`; a route that runs anyway answers 401. Any other
 * failure (a 5xx, a CDN error page) is not evidence of a lost session.
 */
export function isSignedOutResponse(response: Response): boolean {
  if (response.status === 401) return true
  if (!response.redirected) return false
  try {
    return new URL(response.url).pathname === SIGN_IN_PATH
  } catch {
    return false
  }
}

/** The wait to assume when a frame says "rate limited" but carries no number. */
const FALLBACK_RETRY_AFTER_SECONDS = 60

export function rateLimitCopy(retryAfterSeconds: number): string {
  return `Too many requests — try again in ${Math.max(1, Math.ceil(retryAfterSeconds))}s`
}

const SIGN_IN_COPY = "Your session has ended — sign in again to continue."
/** The dashboard's verify-email banner carries the resend action (RAD-297). */
const VERIFY_EMAIL_COPY =
  "Verify your email to run AI features — open the link we sent, or resend it from the banner at the top of the page."

export function refusalCopy(refusal: StreamRefusal): string {
  switch (refusal.code) {
    case RATE_LIMITED:
      return rateLimitCopy(refusal.retryAfter)
    case UNAUTHORIZED:
      return SIGN_IN_COPY
    case EMAIL_NOT_VERIFIED:
      return VERIFY_EMAIL_COPY
  }
}

/** The refusal when `data` is an in-band refusal frame, else null. */
export function readRefusal(data: unknown): StreamRefusal | null {
  if (!data || typeof data !== "object") return null
  const frame = data as { type?: unknown; code?: unknown; retryAfter?: unknown }
  if (frame.type !== "error") return null
  switch (frame.code) {
    case RATE_LIMITED: {
      const seconds = frame.retryAfter
      return {
        code: RATE_LIMITED,
        retryAfter:
          typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
            ? seconds
            : FALLBACK_RETRY_AFTER_SECONDS,
      }
    }
    case UNAUTHORIZED:
      return { code: UNAUTHORIZED }
    case EMAIL_NOT_VERIFIED:
      return { code: EMAIL_NOT_VERIFIED }
    default:
      return null
  }
}
