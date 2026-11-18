// Password reset (RAD-324).
//
// Single-use, hash-only tokens with a 1h TTL. This REPLACED the previous
// `jwt.sign({ userId }, NEXTAUTH_SECRET)` scheme, which had no server-side
// record and no single-use check: anyone holding NEXTAUTH_SECRET could mint a
// reset token for any account, ADMIN included, and a mailed link was replayable
// for its full lifetime.
import crypto from "crypto"
import { Resend } from "resend"
import { db } from "@/lib/db"
import { getAppBaseUrl, getEmailFrom } from "@/lib/email-sender"

export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/** Issue a fresh token for the user. Returns the raw token (emailed, never stored). */
export async function issuePasswordResetToken(userId: string): Promise<string> {
  await db.passwordResetToken
    .deleteMany({
      where: { userId, OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] },
    })
    .catch(() => {})

  const token = crypto.randomBytes(32).toString("base64url")
  await db.passwordResetToken.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    },
  })
  return token
}

export type PasswordResetResult = "ok" | "invalid" | "expired" | "used"

/**
 * Read-only validity check — lets the route hash the password ONLY for a token
 * that exists, so an unauthenticated caller cannot force bcrypt work with a
 * garbage token (CPU amplification). The authoritative, race-safe check is
 * still the conditional claim inside `consumePasswordResetToken`.
 */
export async function peekPasswordResetToken(token: string): Promise<PasswordResetResult> {
  if (!token) return "invalid"
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) return "invalid"
  if (row.usedAt) return "used"
  if (row.expiresAt < new Date()) return "expired"
  return "ok"
}

/**
 * Single-use consume: conditionally claims the token, sets the new password
 * hash, and invalidates every OTHER outstanding token for the user — all in one
 * transaction, so a failure cannot burn the token without changing the password.
 *
 * Control of the reset link also proves control of the mailbox, so the account
 * is stamped verified here (RAD-324/RAD-325): the squatted-account recovery
 * path (reset → sign in → Google links) then actually completes.
 */
export async function consumePasswordResetToken(
  token: string,
  newPasswordHash: string
): Promise<PasswordResetResult> {
  if (!token) return "invalid"
  const row = await db.passwordResetToken.findUnique({ where: { tokenHash: hashToken(token) } })
  if (!row) return "invalid"
  if (row.usedAt) return "used"
  if (row.expiresAt < new Date()) return "expired"

  const claimed = await db.$transaction(async (tx) => {
    const res = await tx.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    })
    if (res.count === 0) return false
    await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash: newPasswordHash, emailVerified: new Date() },
    })
    // A password change invalidates every other outstanding link.
    await tx.passwordResetToken.updateMany({
      where: { userId: row.userId, usedAt: null },
      data: { usedAt: new Date() },
    })
    return true
  })
  return claimed ? "ok" : "used"
}

export function buildPasswordResetUrl(token: string): string {
  return `${getAppBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * Send a reset link. The Resend SDK resolves `{ error }` for HTTP AND network
 * failures instead of throwing — ignoring it would report a fake success.
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const url = buildPasswordResetUrl(token)
  const { error } = await resend.emails.send({
    from: getEmailFrom(),
    to: email,
    subject: "Reset your password",
    text: `Click to reset: ${url}\nExpires in 1 hour. If you didn't request this, ignore this email.`,
  })
  if (error) {
    throw new Error(`Resend rejected the password-reset email (${error.name}): ${error.message}`)
  }
}

/** OAuth-only accounts have no password; point them at the provider instead. */
export async function sendOAuthAccountEmail(email: string): Promise<void> {
  const resend = new Resend(process.env.RESEND_API_KEY)
  const { error } = await resend.emails.send({
    from: getEmailFrom(),
    to: email,
    subject: "Password Reset",
    // The app's own origin, not the hosted one: on a self-install the reader
    // must land on the instance that sent the mail.
    text: `Your account uses Google/Apple sign-in. Sign in at ${getAppBaseUrl()}/signup`,
  })
  if (error) {
    throw new Error(`Resend rejected the OAuth notice email (${error.name}): ${error.message}`)
  }
}
