/**
 * Error vocabulary for the GramJS worker session (RAD-328).
 *
 * Kept dependency-free so the lock, the client helpers and the lifecycle can
 * all share one classifier without dragging Prisma or GramJS into each other.
 */

/** Raised when another live worker holds the session lock. Retryable — a live
 *  peer is a normal deploy-overlap state, not a failure. */
export class GramJSLockUnavailableError extends Error {
  constructor(message = "Another worker holds the GramJS session lock") {
    super(message)
    this.name = "GramJSLockUnavailableError"
  }
}

/**
 * A GramJS client that could not be destroyed (destroy threw or timed out).
 * Its internal sender may still be reconnecting with the same auth key, so
 * building a second client is unsafe — the worker must restart instead.
 */
export class GramJSClientDestroyError extends Error {
  constructor(message = "GramJS client could not be destroyed") {
    super(message)
    this.name = "GramJSClientDestroyError"
  }
}

export type GramJSSetupErrorKind = "lock-unavailable" | "auth-duplicated" | "orphan-risk" | "transient"

/**
 * A duplicated or unregistered auth key is permanent: Telegram will answer 406
 * for every attempt until the user re-authenticates. Everything else — network
 * failures, timeouts, FLOOD_WAIT, even other 406-class client errors — is
 * transient and must be retried on a bounded cadence.
 *
 * Deliberately NOT keyed on `code === 406`: that class also carries
 * non-permanent errors (FLOOD_WAIT, invalid input), and treating them as a dead
 * session would stop the worker for good.
 */
const PERMANENT_SESSION_ERRORS = ["AUTH_KEY_DUPLICATED", "AUTH_KEY_UNREGISTERED"]

export function classifyGramJSSetupError(error: unknown): GramJSSetupErrorKind {
  if (error instanceof GramJSLockUnavailableError) return "lock-unavailable"
  if (error instanceof GramJSClientDestroyError) return "orphan-risk"

  if (error && typeof error === "object") {
    const { errorMessage, message } = error as { errorMessage?: unknown; message?: unknown }
    const texts = [errorMessage, message].filter((value): value is string => typeof value === "string")
    if (texts.some((text) => PERMANENT_SESSION_ERRORS.some((code) => text.includes(code)))) {
      return "auth-duplicated"
    }
  }

  return "transient"
}

/**
 * Strip credentials from anything headed for a log line. Prisma's connection
 * errors (e.g. P1013) echo the datasource URL, and the lock client's URL is
 * built from DATABASE_URL.
 */
export function redactSecrets(message: string): string {
  return message.replace(/\/\/[^:@/\s]+:[^@/\s]+@/g, "//***:***@")
}
