import { NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import bcrypt from "bcryptjs"
import { checkKeyRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit"
import { consumePasswordResetToken, peekPasswordResetToken } from "@/lib/password-reset"

// POST /api/auth/reset-password — consume a single-use, hash-only reset token
// (RAD-324). No JWT: the token must exist in the DB, be unexpired and unused.
export async function POST(req: Request) {
  // RAD-296/324: this route is public — bound it before doing any work.
  const limited = checkKeyRateLimit("reset-password-ip", getClientIp(req.headers), RATE_LIMITS.passwordResetIp)
  if (limited) return limited

  const body = (await req.json().catch(() => ({}))) as { token?: unknown; password?: unknown }
  const { token, password } = body
  if (!token || !password) {
    return NextResponse.json({ error: "Token and password required" }, { status: 400 })
  }
  if (typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "Min 8 chars" }, { status: 400 })
  }

  try {
    // Validate the token BEFORE hashing: bcrypt on every unauthenticated POST
    // was a CPU-amplification sink (the old JWT flow verified first). The
    // peek is advisory; the consume below is still the race-safe check.
    const peek = await peekPasswordResetToken(String(token))
    if (peek !== "ok") {
      return peek === "expired"
        ? NextResponse.json({ error: "Link expired. Request a new one." }, { status: 400 })
        : NextResponse.json({ error: "Invalid or expired link" }, { status: 400 })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const result = await consumePasswordResetToken(String(token), passwordHash)
    if (result === "ok") return NextResponse.json({ message: "Password updated" })
    if (result === "expired") {
      return NextResponse.json({ error: "Link expired. Request a new one." }, { status: 400 })
    }
    return NextResponse.json({ error: "Invalid or expired link" }, { status: 400 })
  } catch (err) {
    Sentry.captureException(err, { tags: { route: "reset-password" } })
    console.error("[reset-password] failed", err)
    return NextResponse.json(
      { error: "Could not reset the password. Try again later." },
      { status: 503 }
    )
  }
}
