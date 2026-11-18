// Email verification (RAD-297).
//
// Signup issues a single-use, 24h token; only its SHA-256 hash is stored. The
// verified state lives on `User.emailVerified` (OAuth accounts are created
// already verified — the provider vouches for the address).
//
// Enforcement: when a mail transport exists (RESEND_API_KEY) verification is
// required for AI spend. Self-hosters without mail opt out EXPLICITLY with
// ALLOW_UNVERIFIED_SIGNUP=1; a production deploy that loses the key fails
// CLOSED (accounts are created unverified and can activate once mail returns)
// and reports to Sentry — silent auto-verification would disable the control
// invisibly, which is the failure mode this repo already fixed for
// forgot-password.
import crypto from "crypto"
import { NextResponse } from "next/server"
import { Resend } from "resend"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { getAppBaseUrl, getEmailFrom } from "@/lib/email-sender"
import { isSelfHosted } from "@/lib/self-hosted"

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000

export function isEmailVerificationEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY)
}

/** Whether new credential signups must verify before AI spend. */
export function isVerificationEnforced(): boolean {
  // RAD-284: a self-hosted install has no mail transport by design — accounts
  // are created verified, and the verification gates below skip the check.
  if (isSelfHosted()) return false
  if (isEmailVerificationEnabled()) return true
  if (process.env.ALLOW_UNVERIFIED_SIGNUP === "1") return false
  // Production without a transport fails CLOSED (accounts exist unverified and
  // activate when mail returns); dev/test stay usable without a key.
  return process.env.NODE_ENV === "production"
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/** Issue a fresh token for the user. Returns the raw token (emailed, never stored). */
export async function issueEmailVerificationToken(userId: string): Promise<string> {
  // Keep the table bounded — this user's used/expired rows are worthless.
  await db.emailVerificationToken
    .deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] },
    })
    .catch(() => {})

  const token = crypto.randomBytes(32).toString("base64url")
  await db.emailVerificationToken.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    },
  })
  return token
}

export type EmailVerificationResult = "ok" | "invalid" | "expired" | "used"

/** Single-use verification: conditionally claims the token, then verifies the user. */
export async function consumeEmailVerificationToken(
  token: string
): Promise<EmailVerificationResult> {
  if (!token) return "invalid"
  const row = await db.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) return "invalid"
  if (row.usedAt) return "used"
  if (row.expiresAt < new Date()) return "expired"

  // Conditional claim + verify in one transaction: two parallel clicks race on
  // `usedAt: null` and exactly one wins; if the user write fails the claim
  // rolls back, so the token is not burned without verifying anyone.
  const claimed = await db.$transaction(async (tx) => {
    const res = await tx.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    })
    if (res.count === 0) return false
    await tx.user.update({ where: { id: row.userId }, data: { emailVerified: new Date() } })
    return true
  })
  return claimed ? "ok" : "used"
}

export function buildEmailVerificationUrl(token: string): string {
  return `${getAppBaseUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`
}

export async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const url = buildEmailVerificationUrl(token)
  // The SDK resolves `{ error }` for HTTP AND network failures — it never
  // throws. Ignoring the field turns a rejected send into a silent fake
  // success, so surface it and let callers' try/catch do the rest.
  const { error } = await resend.emails.send({
    from: getEmailFrom(),
    to: email,
    subject: "Verify your email",
    text: `Confirm your email address: ${url}\n\nThe link expires in 24 hours. If you didn't create a Radaric account, ignore this email.`,
  })
  if (error) {
    throw new Error(`Resend rejected the verification email (${error.name}): ${error.message}`)
  }
}

/**
 * Boolean variant for callers that gate a branch rather than the whole request
 * (e.g. the story-matching fire-and-forget inside a material PATCH).
 */
export async function isEmailVerified(userId: string, role: string): Promise<boolean> {
  if (role === "ADMIN") return true
  // RAD-284: self-hosted mode owns verification too — otherwise the flag's
  // "every feature unlocked" promise is false for signup and CLI-created users
  // (scripts/create-user.js writes no emailVerified).
  if (isSelfHosted()) return true
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true },
  })
  return Boolean(user?.emailVerified)
}

/**
 * Gate for AI-spend routes: unverified credential accounts may browse the demo
 * and manage feeds, but must not drive paid LLM/API work. ADMIN is exempt (the
 * operator's own account; consistent with every other gate).
 */
export async function requireVerifiedEmail(
  userId: string,
  role: string
): Promise<NextResponse | null> {
  if (await isEmailVerified(userId, role)) return null
  return NextResponse.json(
    {
      error: "Verify your email address to use AI features. Check your inbox or resend the link.",
      code: "EMAIL_NOT_VERIFIED",
    },
    { status: 403 }
  )
}

/** Loud signal for an enforcement state that should not be silent (once per process). */
let misconfigReported = false
export function reportVerificationMisconfig(reason: string): void {
  if (misconfigReported) return
  misconfigReported = true
  Sentry.captureMessage(`email-verification: ${reason}`, { level: "error" })
  console.error(`[email-verification] ${reason}`)
}
