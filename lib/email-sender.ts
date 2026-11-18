// Outbound mail identity and the app's public base URL.
//
// The hosted service sends from radaric.pro and links to radaric.pro. A
// self-hosted install must send from a domain its own Resend account verified —
// Resend rejects a `from` it does not own, and the send fails silently in the
// UI's terms (the reset request still answers 200 by design). One helper, used
// by both mail modules, keeps that address in one place.

export const DEFAULT_EMAIL_FROM = "Radaric <noreply@radaric.pro>"

/** One warning per process, not one per send. */
let warnedMissingEmailFrom = false

/** Resend `from` address — `EMAIL_FROM` when set, the hosted default otherwise. */
export function getEmailFrom(): string {
  const configured = process.env.EMAIL_FROM?.trim()
  if (configured) return configured
  // A self-hoster who configures a transport but not a sender gets every send
  // rejected by Resend ("domain is not verified") and only a 200 in the UI, so
  // say it plainly once instead of failing quietly on every mail.
  if (process.env.RESEND_API_KEY?.trim() && !warnedMissingEmailFrom) {
    warnedMissingEmailFrom = true
    console.warn(
      `[email] RESEND_API_KEY is set but EMAIL_FROM is not. Resend rejects mail from a domain it has not verified, and the default sender is "${DEFAULT_EMAIL_FROM}". Set EMAIL_FROM to an address on a domain verified in your Resend account.`
    )
  }
  return DEFAULT_EMAIL_FROM
}

/**
 * Public base URL without a trailing slash. The one implementation lives in
 * `lib/site-url.ts` (metadata and crawler files read it too); this name stays
 * exported for the mail modules.
 */
export { getSiteUrl as getAppBaseUrl } from "@/lib/site-url"
