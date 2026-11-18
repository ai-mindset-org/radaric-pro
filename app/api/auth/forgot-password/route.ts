import { after, NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { checkKeyRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit"
import {
  issuePasswordResetToken,
  sendOAuthAccountEmail,
  sendPasswordResetEmail,
} from "@/lib/password-reset"

const OK = { message: "If an account exists, we sent a reset link." }

// POST /api/auth/forgot-password — enumeration-safe by design: identical body
// for existing and unknown addresses, and the per-address budget applies before
// the lookup so it cannot be used as an oracle either. The token issue + send
// run AFTER the response via `after()`: awaiting the mail round-trip in the
// request path made "exists" measurably slower than "unknown" (timing oracle).
// RAD-324.
export async function POST(req: Request) {
  if (!process.env.RESEND_API_KEY) {
    console.error("[forgot-password] RESEND_API_KEY not set — cannot send reset emails")
    return NextResponse.json(
      { error: "Password reset is temporarily unavailable. Please try again later." },
      { status: 503 }
    )
  }

  const body = (await req.json().catch(() => ({}))) as { email?: unknown }
  const email = typeof body.email === "string" ? body.email.toLowerCase() : ""
  if (!email) return NextResponse.json({ error: "Email required" }, { status: 400 })

  // RAD-296/324: bounded per IP and per address.
  const ipLimited = checkKeyRateLimit("forgot-password-ip", getClientIp(req.headers), RATE_LIMITS.passwordResetIp)
  if (ipLimited) return ipLimited
  const emailLimited = checkKeyRateLimit("forgot-password-email", email, RATE_LIMITS.passwordResetEmail)
  if (emailLimited) return emailLimited

  // Case-insensitive lookup: legacy OAuth rows may hold mixed-case addresses
  // (credential signup always lowercases). Same neutral response either way.
  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, passwordHash: true, isActive: true },
  })
  if (!user || !user.isActive) return NextResponse.json(OK)

  const sendReset = async () => {
    try {
      if (!user.passwordHash) {
        await sendOAuthAccountEmail(email)
      } else {
        const token = await issuePasswordResetToken(user.id)
        await sendPasswordResetEmail(email, token)
      }
    } catch (err) {
      // Response stays enumeration-safe; the operator gets the real signal.
      // Never forward the raw Resend message (may carry the address).
      Sentry.captureException(new Error("password-reset email rejected"), {
        tags: { route: "forgot-password" },
        extra: { userId: user.id, reason: err instanceof Error ? err.name : "unknown" },
      })
      console.error("[forgot-password] send failed", err)
    }
  }
  try {
    after(sendReset)
  } catch {
    // Direct invocation outside a request scope (unit tests): run it now.
    await sendReset()
  }
  return NextResponse.json(OK)
}
