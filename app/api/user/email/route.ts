import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { getStripe } from "@/lib/stripe"
import { checkKeyRateLimit, checkUserRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit"
import {
  isEmailVerificationEnabled,
  isVerificationEnforced,
  issueEmailVerificationToken,
  sendVerificationEmail,
} from "@/lib/email-verification"

const BodySchema = z.object({
  // Trim + RFC-ish format check; lowercasing happens after validation.
  email: z.string().trim().max(254).email(),
})

/**
 * PATCH /api/user/email — set or change the signed-in user's email.
 *
 * Username/credential users sign up without an email and are blocked from
 * subscribing (checkout requires User.email). This lets them set one.
 * OAuth (Google/Apple) accounts are read-only here: sign-in matches strictly
 * by provider email, so editing the DB email would orphan their next login.
 */
export async function PATCH(request: Request) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  const body = await request.json().catch(() => null)
  if (body === null) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 })
  }
  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email." }, { status: 400 })
  }
  const email = parsed.data.email.toLowerCase()

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { email: true, passwordHash: true, stripeCustomerId: true },
    })
    // Row missing (deleted account or a stale JWT) — nothing to update.
    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 })
    }

    // Read-only for provider-managed accounts (no local password = OAuth).
    if (user.passwordHash === null) {
      return NextResponse.json(
        { error: "Email is managed by your sign-in provider." },
        { status: 403 },
      )
    }

    // No-op if unchanged — avoids a needless write and a self-collision 409.
    if (user.email === email) {
      return NextResponse.json({ email })
    }

    // Uniqueness pre-check for a clean 409 (the DB unique constraint is the real
    // fence). The no-op check above guarantees a different email, so any hit is
    // necessarily another user — but keep the id guard as a defensive belt.
    const existing = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (existing && existing.id !== userId) {
      return NextResponse.json({ error: "This email is already in use." }, { status: 409 })
    }

    try {
      // RAD-297: a new address is unverified — clear the stamp; AI spend and
      // background ingestion resume only once the new address is confirmed.
      await db.user.update({ where: { id: userId }, data: { email, emailVerified: null } })
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
        return NextResponse.json({ error: "This email is already in use." }, { status: 409 })
      }
      throw err
    }

    // Best-effort: send a verification link to the NEW address (a cover letter
    // is not sent to the old one — the account owner made this change). Shares
    // the resend budgets so alternating addresses cannot bomb a mailbox.
    if (isVerificationEnforced() && isEmailVerificationEnabled()) {
      const resendLimited = checkUserRateLimit("resend-verification", userId, role, RATE_LIMITS.resendVerification)
      const ipLimited = checkKeyRateLimit("resend-ip", getClientIp(request.headers), RATE_LIMITS.resendVerificationIp)
      if (resendLimited || ipLimited) {
        console.warn("[user-email] verification email skipped — resend budget reached")
      } else {
        try {
          const token = await issueEmailVerificationToken(userId)
          await sendVerificationEmail(email, token)
        } catch (err) {
          console.error("[user-email] verification email after change failed:", err)
        }
      }
    }

    // Keep Stripe's customer email in sync so invoices/receipts reach the user.
    // Best-effort: the DB write is source of truth and must not fail on a Stripe hiccup.
    if (user.stripeCustomerId) {
      try {
        await getStripe().customers.update(user.stripeCustomerId, { email })
      } catch (err) {
        console.error("[user-email] failed to sync email to Stripe customer", err)
      }
    }

    return NextResponse.json({ email })
  } catch (error) {
    console.error("[user-email] error updating email", error)
    return NextResponse.json({ error: "Failed to update email." }, { status: 500 })
  }
}
