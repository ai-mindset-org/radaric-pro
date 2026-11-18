// Sign-up attribution: which directory or launch site a new account came from.
// Inbound links can carry `?ref=<slug>`. The proxy keeps the
// FIRST ref a browser arrives with in a first-party cookie, and account
// creation writes it once to `User.signupRef` — the OAuth round-trip through
// Google/Apple drops query params, so the cookie is the only carrier.
//
// Separate from the launch-trial cookie (lib/trial-ref.ts): that one grants
// access, lives 7 days and is consumed on sign-up; this one only labels the
// account, lives up to 30 days, is never overwritten by a later ref, and is
// cleared once account creation has written it.
export const SIGNUP_REF_COOKIE = "radaric_src"
export const SIGNUP_REF_COOKIE_MAX_AGE = 30 * 24 * 60 * 60
export const SIGNUP_REF_MAX_LENGTH = 32

/** A short lowercase slug (`a-z`, `0-9`, single dashes), or null for junk. */
export function sanitizeRef(raw: string | null | undefined): string | null {
  if (!raw) return null
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SIGNUP_REF_MAX_LENGTH)
    .replace(/-+$/, "")
  return slug || null
}

/** The ref to store now, or null to leave the cookie as it is (first touch wins). */
export function firstTouchRef(stored: string | null | undefined, incoming: string | null | undefined): string | null {
  if (sanitizeRef(stored) !== null) return null
  return sanitizeRef(incoming)
}

/** Reads the stored ref out of a raw `Cookie` request header. */
export function signupRefFromCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === SIGNUP_REF_COOKIE) return sanitizeRef(part.slice(eq + 1).trim())
  }
  return null
}
