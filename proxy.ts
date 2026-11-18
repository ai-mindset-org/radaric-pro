import { auth } from "@/lib/auth"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { NEW_VISIT_HEADER, VISIT_COOKIE, VISIT_IDLE_SECONDS, visitMarker } from "@/lib/visit-marker"
import { streamableRefusal, wantsEventStream } from "@/lib/sse"
import { getTrialRef, isTrialOfferOpen, isTrialRef, TRIAL_REF_COOKIE, TRIAL_REF_COOKIE_MAX_AGE } from "@/lib/trial-ref"
import { firstTouchRef, SIGNUP_REF_COOKIE, SIGNUP_REF_COOKIE_MAX_AGE } from "@/lib/signup-ref"

/**
 * Build a redirect target, tagging it with `_rsc` for programmatic fetches.
 *
 * Next strips the `_rsc` cache-buster and the RSC flight headers BEFORE this
 * proxy runs, so a redirect issued for an RSC fetch would point at the clean
 * document URL. A CDN in front of the instance rewrites `Vary: rsc` away, so
 * the browser caches the `text/x-component` flight body under the document URL
 * and later renders it as text. `Sec-Fetch-Mode` still tells us it was a fetch,
 * so we re-add a marker that keeps the RSC response on its own cache key (the
 * server ignores it and Next's client strips it from the canonical URL). A
 * tagged redirect is always a 307: browsers cache a permanent 301/308 by request
 * URL alone, so a marked permanent redirect installed by a prefetch would later
 * send a document navigation onto the marked URL. — RAD-304
 */
function redirectTo(req: NextRequest, pathname: string, status?: number) {
  const url = new URL(pathname, req.url)
  const mode = req.headers.get("sec-fetch-mode")
  if (mode === null || mode === "navigate") return NextResponse.redirect(url, status)
  url.searchParams.set("_rsc", "rsc")
  return NextResponse.redirect(url, 307)
}

/**
 * A signed-out EventSource gets the sign-in refusal in-band (RAD-406).
 *
 * The redirect below is what every other signed-out request gets, and for an
 * EventSource it is unreadable: the browser follows it to the /signup document,
 * sees `text/html`, and fails the connection without saying why — so an expired
 * session read as "The connection was interrupted", and the SSE routes' own
 * refusal never ran. The proxy answers with the same UNAUTHORIZED frame the
 * routes send. No redirect means nothing for RAD-304's tagging to protect.
 * Every other `/api/*` caller keeps the redirect it has always had.
 */
function signedOutStream(req: NextRequest) {
  return streamableRefusal(req, NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
}

/**
 * Let a signed-in request through and slide its visit marker (RAD-168).
 *
 * A new visit is the first full page load after an hour with no activity, so
 * only a document navigation to a non-/api path may start one: it is the only
 * request that creates the marker (or replaces another user's) and the only one
 * that tells the page "new visit", through a request header the proxy owns and
 * always strips from client input. Background traffic — /api polls, session
 * refreshes on focus, RSC fetches and Link prefetches — only extends this
 * user's marker when it is already there, so it can neither spend the verdict
 * nor start a visit no page will see. The proxy's own redirects never set the
 * marker: a "/" → "/posts" redirect that did would hide the new visit from
 * /posts. Secure follows the request protocol, as Auth.js does, because a
 * Secure cookie is never stored over plain http and a self-hosted instance
 * would then start a new visit on every page load.
 */
async function continueVisit(req: NextRequest, userId: string) {
  const marker = await visitMarker(userId)
  const { pathname } = req.nextUrl
  const mode = req.headers.get("sec-fetch-mode")
  const isPageLoad = (mode === null || mode === "navigate") && pathname !== "/api" && !pathname.startsWith("/api/")
  const hasMarker = req.cookies.get(VISIT_COOKIE)?.value === marker
  const headers = new Headers(req.headers)
  headers.delete(NEW_VISIT_HEADER)
  if (isPageLoad && !hasMarker) headers.set(NEW_VISIT_HEADER, "1")
  const res = NextResponse.next({ request: { headers } })
  if (isPageLoad || hasMarker) res.cookies.set(VISIT_COOKIE, marker, { maxAge: VISIT_IDLE_SECONDS, path: "/", sameSite: "lax", httpOnly: true, secure: req.nextUrl.protocol === "https:" })
  return res
}

/**
 * Remember a referral-trial visit (`?ref=<TRIAL_REF>` on `/` or `/signup`) so
 * account creation can grant the trial. A cookie, not a query param on every
 * CTA: the Google/Apple round-trip drops query params, and Apple returns with a
 * cross-site form POST, so over https the cookie is SameSite=None (a Lax cookie
 * is not sent on that POST). Over plain http (local, self-host) None is
 * refused without Secure, so it falls back to Lax. Nothing is remembered once
 * the offer has ended (TRIAL_REF_ENDS_AT) or while TRIAL_REF is unset.
 */
function rememberTrialRef(req: NextRequest, res: NextResponse) {
  const { pathname, searchParams, protocol } = req.nextUrl
  if (pathname !== "/" && pathname !== "/signup") return res
  const configured = getTrialRef()
  if (configured === null || !isTrialRef(searchParams.get("ref")) || !isTrialOfferOpen()) return res
  const secure = protocol === "https:"
  res.cookies.set(TRIAL_REF_COOKIE, configured, { maxAge: TRIAL_REF_COOKIE_MAX_AGE, path: "/", httpOnly: true, secure, sameSite: secure ? "none" : "lax" })
  return res
}

/**
 * Remember the first `?ref=<slug>` a signed-out browser arrives with on any
 * public page, so account creation can record where the account came from
 * (lib/signup-ref.ts). First touch wins: a stored ref is never replaced. Same
 * SameSite rule as the trial cookie, for Apple's cross-site form POST.
 */
function rememberSignupRef(req: NextRequest, res: NextResponse) {
  const { pathname, searchParams, protocol } = req.nextUrl
  if (pathname === "/api" || pathname.startsWith("/api/")) return res
  const ref = firstTouchRef(req.cookies.get(SIGNUP_REF_COOKIE)?.value, searchParams.get("ref"))
  if (ref === null) return res
  const secure = protocol === "https:"
  res.cookies.set(SIGNUP_REF_COOKIE, ref, { maxAge: SIGNUP_REF_COOKIE_MAX_AGE, path: "/", httpOnly: true, secure, sameSite: secure ? "none" : "lax" })
  return res
}

export default auth(async (req) => {
  const { pathname } = req.nextUrl; const isLoggedIn = !!req.auth
  const isPublicPath = pathname === "/" || pathname === "/login" || pathname === "/signup" || pathname === "/terms" || pathname === "/privacy" || pathname === "/forgot-password" || pathname === "/verify-email" || pathname === "/auth-error" || pathname.startsWith("/reset-password") || pathname.startsWith("/api/auth") || pathname.startsWith("/api/webhooks") || pathname === "/api/health" || pathname === "/api/collections/regenerate-due"
  if (!isLoggedIn && !isPublicPath) {
    if (pathname.startsWith("/api/") && wantsEventStream(req)) return signedOutStream(req)
    return rememberSignupRef(req, redirectTo(req, "/signup"))
  }
  if (isLoggedIn && (pathname === "/" || pathname === "/login" || pathname === "/signup")) return redirectTo(req, "/posts")
  if (pathname.startsWith("/materials")) return redirectTo(req, pathname.replace("/materials", "/posts"), 301)
  const userId = req.auth?.user?.id
  if (userId) return await continueVisit(req, userId)
  return rememberSignupRef(req, rememberTrialRef(req, NextResponse.next()))
})
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|images|.*\\..*).*)"] }
