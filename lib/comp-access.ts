// Complimentary (time-limited free) access — the single write path for the
// `User.complimentaryAccessUntil` grant, used by the admin API route so every
// grant goes through the same validation + math. Account creation writes a
// launch-referral trial with the same math (trialCompUntil) inside its create.
//
// Comp = Lite tier: it grants base access (read by hasActiveAccess) but never
// Twitter/X — that restriction is enforced in lib/entitlements.ts.
import { db } from "@/lib/db"
import { isTrialOfferOpen, isTrialRef, TRIAL_DAYS } from "@/lib/trial-ref"

// Upper bound on a single grant. A hand-granted trial should never exceed a
// year; the cap turns a fat-fingered "36500" into a rejected request.
export const COMP_MAX_DAYS = 365

const DAY_MS = 86_400_000

/** The target user does not exist. Maps to HTTP 404. */
export class CompUserNotFoundError extends Error {
  constructor(userId: string) {
    super(`No user with id ${userId}`)
    this.name = "CompUserNotFoundError"
  }
}

/** `days` failed validation. Maps to HTTP 400. */
export class CompValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CompValidationError"
  }
}

function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2025"
  )
}

/**
 * Grant / extend / revoke complimentary access.
 *
 * - `days = null` → revoke (clears the field).
 * - `days = N`    → set the expiry to `max(now, existing) + N days`. Basing off
 *   `max(now, existing)` means "extend" on a still-active grant ADDS to the
 *   remaining time (never shortens it), while a fresh grant starts from now.
 *
 * The expiry is always computed server-side from `days` — callers never pass a
 * raw date, so a skewed/hostile clock can't mint a far-future grant.
 *
 * Returns the new expiry (`null` when revoked).
 * Throws {@link CompValidationError} (bad `days`) or {@link CompUserNotFoundError}.
 */
export async function setComplimentaryAccess(
  userId: string,
  days: number | null
): Promise<Date | null> {
  if (!userId) throw new CompValidationError("userId is required")

  if (days !== null) {
    if (typeof days !== "number" || !Number.isInteger(days)) {
      throw new CompValidationError("days must be an integer or null")
    }
    if (days <= 0 || days > COMP_MAX_DAYS) {
      throw new CompValidationError(`days must be between 1 and ${COMP_MAX_DAYS}`)
    }
  }

  let until: Date | null = null

  if (days !== null) {
    // Read the current grant so an extend can build on remaining time. This also
    // surfaces a missing user before we attempt the write.
    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { complimentaryAccessUntil: true },
    })
    if (!existing) throw new CompUserNotFoundError(userId)

    until = compUntil(days, existing.complimentaryAccessUntil)
  }

  try {
    await db.user.update({
      where: { id: userId },
      data: { complimentaryAccessUntil: until },
    })
  } catch (err) {
    if (isRecordNotFound(err)) throw new CompUserNotFoundError(userId)
    throw err
  }

  return until
}

/**
 * The expiry a grant of `days` produces on top of an existing one: from
 * `max(now, existing)`, so an extend adds to the remaining time and a fresh
 * grant starts from now. The one formula every comp write uses.
 */
export function compUntil(days: number, existing: Date | null, now: number = Date.now()): Date {
  return new Date(Math.max(now, existing?.getTime() ?? 0) + days * DAY_MS)
}

/**
 * The referral-trial expiry for an account being created with `ref`, or
 * null. Written in the same `user.create` as the account, so an account can
 * never commit without the trial it was promised (a separate update could fail
 * after the account exists). Null once the offer has ended, whatever cookie the
 * browser still carries.
 */
export function trialCompUntil(ref: string | null | undefined, now: number = Date.now()): Date | null {
  return isTrialRef(ref) && isTrialOfferOpen(now) ? compUntil(TRIAL_DAYS, null, now) : null
}
