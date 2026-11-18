import { NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { checkKeyRateLimit, checkUserRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit"
import {
  isEmailVerificationEnabled,
  issueEmailVerificationToken,
  sendVerificationEmail,
} from "@/lib/email-verification"

// POST /api/auth/resend-verification — send a fresh verification link to the
// signed-in (unverified) account. Rate-limited per user AND per IP (RAD-297).
export async function POST(request: Request) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  const limited = checkUserRateLimit("resend-verification", userId, role, RATE_LIMITS.resendVerification)
  if (limited) return limited
  const ipLimited = checkKeyRateLimit("resend-ip", getClientIp(request.headers), RATE_LIMITS.resendVerificationIp)
  if (ipLimited) return ipLimited

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  })
  if (!user?.email) {
    return NextResponse.json({ error: "This account has no email address to verify." }, { status: 400 })
  }
  if (user.emailVerified) {
    return NextResponse.json({ error: "Email is already verified.", code: "ALREADY_VERIFIED" }, { status: 400 })
  }
  if (!isEmailVerificationEnabled()) {
    return NextResponse.json({ error: "Email sending is not configured." }, { status: 503 })
  }

  try {
    const token = await issueEmailVerificationToken(userId)
    await sendVerificationEmail(user.email, token)
  } catch (err) {
    // A failing mail transport is operationally urgent — never just a 502 body.
    Sentry.captureException(err, { tags: { route: "resend-verification" } })
    console.error("[resend-verification] failed", err)
    return NextResponse.json(
      { error: "Could not send the verification email. Try again later." },
      { status: 502 }
    )
  }
  return NextResponse.json({ ok: true })
}
