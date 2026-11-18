import { NextRequest, NextResponse } from "next/server"
import { consumeEmailVerificationToken } from "@/lib/email-verification"
import { getAppBaseUrl } from "@/lib/email-sender"

export const dynamic = "force-dynamic"

// GET /api/auth/verify-email?token=… — the link target in the verification
// email. Consumes the single-use token and redirects to a human-readable status
// page. A document navigation (email click) is not an RSC fetch, so the proxy's
// _rsc tagging does not apply here.
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? ""
  let status = "invalid"
  try {
    const result = await consumeEmailVerificationToken(token)
    status = result === "ok" ? "verified" : result
  } catch (err) {
    console.error("[verify-email] failed", err)
    status = "error"
  }
  // Canonical base, not the request host: the origin is reachable directly,
  // bypassing the CDN, and an unauthenticated request could otherwise steer the
  // redirect target. Same resolution as the reset links: NEXT_PUBLIC_APP_URL,
  // then NEXTAUTH_URL, then localhost — and a blank value counts as unset, so
  // this never builds a relative URL (NextResponse.redirect throws on one).
  const base = getAppBaseUrl()
  return NextResponse.redirect(`${base}/verify-email?status=${status}`)
}
