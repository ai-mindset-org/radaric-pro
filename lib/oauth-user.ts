import { db } from "@/lib/db"
import { FIRST_USER_LOCK_KEY } from "@/lib/first-user"
import { trialCompUntil } from "@/lib/comp-access"
import { sanitizeRef } from "@/lib/signup-ref"

export type OAuthAccount = {
  id: string
  role: string
  username: string
  created: boolean
}

export type OAuthSignInResult =
  | { status: "ok"; account: OAuthAccount }
  // RAD-325: an existing credential account whose address was never verified.
  // Its ownership was never proven — silently attaching the provider identity
  // would hand the account to whoever created it first (pre-hijacking).
  | { status: "link_blocked" }

/**
 * Find-or-create the local account behind a provider sign-in.
 *
 * RAD-297: NEW OAuth accounts are created with `emailVerified` set — Google and
 * Apple vouch for the address, so they skip the verification flow entirely.
 * An EXISTING account is returned untouched: in particular we never flip
 * `emailVerified` for a credential account that shares the email.
 */
export async function findOrCreateOAuthUser(
  profile: {
    email: string
    name?: string | null
  },
  // The launch-referral ref carried by the proxy's cookie; only a NEW account
  // is granted the trial. `signupRef` is the first-touch attribution ref
  // (lib/signup-ref.ts), written on a NEW account only.
  options: { ref?: string | null; signupRef?: string | null } = {},
): Promise<OAuthSignInResult> {
  // Normalize case: credential signup lowercases, and Apple is known to return
  // mixed-case addresses — without this, lookup misses and the create hits the
  // email unique constraint.
  const email = profile.email.toLowerCase()
  const existing = await db.user.findFirst({ where: { email, isActive: true } })
  if (existing) {
    if (existing.passwordHash && existing.emailVerified === null) {
      return { status: "link_blocked" }
    }
    return {
      status: "ok",
      account: { id: existing.id, role: existing.role, username: existing.username, created: false },
    }
  }

  const emailPrefix = email.split("@")[0]
  const suffix = Math.random().toString(36).substring(2, 6)
  const username = `${emailPrefix}_${suffix}`
  let created
  try {
    // RAD-285: first account in an empty database becomes ADMIN; the advisory
    // lock serializes concurrent first signups so exactly one wins. Settings are
    // nested so the account is never half-created (matches the signup route).
    created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIRST_USER_LOCK_KEY}))`
      const userCount = await tx.user.count()
      return tx.user.create({
        data: {
          email,
          username,
          name: profile.name || username,
          passwordHash: null,
          role: userCount === 0 ? "ADMIN" : "USER",
          isActive: true,
          emailVerified: new Date(),
          complimentaryAccessUntil: trialCompUntil(options.ref),
          signupRef: sanitizeRef(options.signupRef),
          userSettings: { create: { onboardingCompleted: false } },
        },
      })
    })
  } catch (err) {
    // A legacy row may hold the address in different case (pre-RAD-297 OAuth
    // stored it verbatim): recover by case-insensitive lookup instead of
    // throwing P2002 inside the signIn callback.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      const raced = await db.user.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
      })
      // Deactivated or unverified-credential row: the same refusal as above —
      // never fall through to a thrown callback error the user cannot act on.
      if (raced && (!raced.isActive || (raced.passwordHash && raced.emailVerified === null))) {
        return { status: "link_blocked" }
      }
      if (raced) {
        return {
          status: "ok",
          account: { id: raced.id, role: raced.role, username: raced.username, created: false },
        }
      }
    }
    throw err
  }
  return {
    status: "ok",
    account: { id: created.id, role: created.role, username: created.username, created: true },
  }
}
