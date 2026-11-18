// Referral trial: a NEW account that arrives with `?ref=<TRIAL_REF>` gets the
// same complimentary (Lite, no X) access an admin grants by hand, for
// TRIAL_DAYS. The ref is carried from the landing or /signup to account
// creation in a cookie the proxy sets, because the OAuth round-trip through
// Google/Apple drops every query param on the way back.
//
// `TRIAL_REF` is read on every call. Unset or blank turns the trial off: the
// proxy remembers nothing, account creation grants nothing, and the "7 days
// free" line never shows. Only the exact configured value counts — anything
// else, including a different case, is treated as no ref at all. Existing
// accounts never get a grant: the expiry (trialCompUntil in lib/comp-access.ts)
// is written only inside `user.create`.
//
// The offer also ends at TRIAL_REF_ENDS_AT (RAD-419); see isTrialOfferOpen.
export const TRIAL_DAYS = 7
export const TRIAL_REF_COOKIE = "radaric_ref"
// Long enough to read the landing today and sign up later in the week.
export const TRIAL_REF_COOKIE_MAX_AGE = 7 * 24 * 60 * 60

/** The configured referral value, or null when the trial is off. */
export function getTrialRef(): string | null {
  const value = process.env.TRIAL_REF?.trim()
  return value ? value : null
}

export function isTrialRef(value: string | null | undefined): boolean {
  const ref = getTrialRef()
  return ref !== null && value === ref
}

/**
 * Reads the carried ref out of a raw `Cookie` request header.
 *
 * Next percent-encodes a cookie value that is not a cookie-octet string, and
 * the OAuth path reads through `cookies()`, which decodes. Decode here too, or
 * a configured value with a space (`?ref=Product Hunt`) would grant on one
 * sign-up path and not the other.
 */
export function trialRefFromCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === TRIAL_REF_COOKIE) return decodeCookieValue(part.slice(eq + 1).trim())
  }
  return null
}

function decodeCookieValue(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

const DAY_MS = 86_400_000
// The grant is written in the same `user.create` as the account, so its gap to
// createdAt is TRIAL_DAYS almost to the millisecond; ten minutes covers a slow
// transaction (the first-user advisory lock) and nothing a person types.
const LAUNCH_TRIAL_TOLERANCE_MS = 10 * 60_000
// Every trial length trialCompUntil has ever granted. Append (never replace)
// when TRIAL_DAYS changes, or past trials silently read as manual comps.
const LAUNCH_TRIAL_DAYS_HISTORY: readonly number[] = [7]
// Date.parse reads "1" or "2026" as a year, so a value must look like an ISO
// 8601 date (optionally with a time and offset) before it is trusted.
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i
// Unreadable values already reported, so a bad variable warns once, not per request.
const warnedValues = new Set<string>()

/**
 * Whether the referral trial still takes sign-ups. `TRIAL_REF_ENDS_AT` (ISO
 * 8601) closes it from that instant on; unset, empty or unparseable keeps it
 * open-ended (the trial itself is still off while `TRIAL_REF` is unset). When
 * closed the proxy stops remembering the ref, account creation grants nothing
 * even for a cookie set earlier, and the "7 days free" line disappears. Read
 * on every call, so a changed variable needs no rebuild.
 *
 * A value pasted with its quotes or with a lowercase t/z still closes it. An
 * unreadable one (including a calendar-impossible date such as 2026-11-31,
 * which V8 would roll forward) keeps the offer open and logs a warning, since
 * the operator believes they closed it.
 */
export function isTrialOfferOpen(now: number = Date.now()): boolean {
  const raw = process.env.TRIAL_REF_ENDS_AT?.trim().replace(/^(["'])(.*)\1$/, "$2")
  if (!raw) return true
  const m = ISO_8601.exec(raw)
  const end = m && isCalendarDate(+m[1], +m[2], +m[3]) ? Date.parse(raw.toUpperCase()) : NaN
  if (Number.isNaN(end)) {
    if (!warnedValues.has(raw)) {
      warnedValues.add(raw)
      console.warn(`[trial-ref] TRIAL_REF_ENDS_AT=${JSON.stringify(raw)} is not an ISO 8601 date; the referral trial stays OPEN`)
    }
    return true
  }
  return now < end
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day
}

/**
 * Whether a comp is the referral trial rather than a hand grant: the expiry
 * sits TRIAL_DAYS after the account's creation, within
 * LAUNCH_TRIAL_TOLERANCE_MS. No schema column records it. A manual comp never
 * matches unless an admin grants exactly TRIAL_DAYS within ten minutes of
 * sign-up, and an admin extend on a trial turns it into a manual comp.
 */
export function isLaunchTrialComp(account: {
  createdAt: Date
  complimentaryAccessUntil: Date | null
}): boolean {
  if (!account.complimentaryAccessUntil) return false
  const gap = account.complimentaryAccessUntil.getTime() - account.createdAt.getTime()
  return LAUNCH_TRIAL_DAYS_HISTORY.some((days) => Math.abs(gap - days * DAY_MS) <= LAUNCH_TRIAL_TOLERANCE_MS)
}
