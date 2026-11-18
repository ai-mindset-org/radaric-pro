// Decides whether an authenticated Radaric user can access write operations.
import { NextResponse } from "next/server"
import { SubscriptionStatus } from "@prisma/client"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { isSelfHosted } from "@/lib/self-hosted"

// RAD-294: the onboarding-incomplete demo grant is time-bound to this window,
// measured from account creation. Shared by hasActiveAccess and
// subscriptionIncludesTwitter (which short-circuits on the same condition
// before ever delegating here) so the two gates can't drift out of sync.
export const ONBOARDING_DEMO_WINDOW_MS = 24 * 60 * 60 * 1000

export function hasActiveAccess(input: {
  role: string
  onboardingCompleted: boolean | undefined
  subscription: {
    status: SubscriptionStatus
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
  } | null
  // Hand-granted time-limited free access (comp = Lite tier). Required so tsc
  // enumerates every call site; callers coerce a missing/undefined field to null.
  complimentaryAccessUntil: Date | null
  // Required so tsc enumerates every call site (RAD-294): bounds the
  // onboarding-incomplete demo grant below to ONBOARDING_DEMO_WINDOW_MS.
  accountCreatedAt: Date
  now: Date
}): boolean {
  // SELF_HOSTED (RAD-284): all features unlocked for every local account. This
  // is ONE of two gates — subscriptionIncludesTwitter (lib/entitlements.ts)
  // derives the Twitter entitlement independently and short-circuits on the
  // same flag. Patch both or the self-hoster keeps "Upgrade to Pro" badges.
  if (isSelfHosted()) return true

  if (input.role === "ADMIN") return true

  if (
    input.onboardingCompleted === false &&
    input.now.getTime() - input.accountCreatedAt.getTime() < ONBOARDING_DEMO_WINDOW_MS
  ) {
    return true
  }

  // undefined onboardingCompleted falls through to subscription check (ERR-1: fail-closed)

  // Complimentary grant: checked BEFORE the subscription logic so a comp date
  // rescues a user with no sub OR a lapsed one. Truthy guard (not `!== null`) so
  // an undefined field can never be mistaken for an active grant. Strict `>`
  // mirrors the subscription grace-window contract. Comp never grants Twitter —
  // that Lite restriction lives in lib/entitlements.ts.
  if (input.complimentaryAccessUntil && input.complimentaryAccessUntil > input.now) {
    return true
  }

  const sub = input.subscription
  if (sub === null) return false

  if (
    (sub.status === SubscriptionStatus.ACTIVE ||
      sub.status === SubscriptionStatus.TRIALING) &&
    sub.currentPeriodEnd > input.now
  ) {
    return true
  }

  if (
    sub.status === SubscriptionStatus.PAST_DUE &&
    sub.currentPeriodEnd > input.now
  ) {
    return true
  }

  return false
}

// Gate helper for API routes. Returns null to allow, NextResponse 402 to block.
// Fails open for admins on DB error (never locks out the operator), fails closed
// for regular users (so a DB blip doesn't grant free access).
export async function requireActiveSubscription(
  userId: string,
  role: string
): Promise<NextResponse | null> {
  if (role === "ADMIN") return null

  try {
    const user = await db.user.findUnique({
      where: { id: userId },
      include: { userSettings: true, subscription: true },
    })

    const onboardingCompleted = user?.userSettings?.onboardingCompleted ?? true
    const subscription = user?.subscription
      ? {
          status: user.subscription.status,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
        }
      : null

    const allowed = hasActiveAccess({
      role,
      onboardingCompleted,
      subscription,
      complimentaryAccessUntil: user?.complimentaryAccessUntil ?? null,
      accountCreatedAt: user?.createdAt ?? new Date(0),
      now: new Date(),
    })

    if (allowed) return null
    return NextResponse.json(
      { error: "Subscription required", code: "SUBSCRIPTION_REQUIRED" },
      { status: 402 }
    )
  } catch (err) {
    Sentry.captureException(err, { tags: { gate: "requireActiveSubscription" } })
    return NextResponse.json(
      { error: "Subscription check failed", code: "SUBSCRIPTION_CHECK_FAILED" },
      { status: 503 }
    )
  }
}

// Background paths (the Parallel webhook, the worker's self-filling sweep) have
// no session/JWT to trust, so they resolve access from the database instead.
// RAD-323: both paths previously checked only `user.isActive`, so a throwaway
// account armed inside its 24h demo window (or a cancelled subscriber) kept
// driving paid Parallel fetches and LLM evaluations indefinitely.
//
// `resolveAccessForUserId` THROWS on a lookup failure so callers that mutate
// spend-relevant state (the monitor reconcile) can tell "no access" from
// "couldn't check" and refuse to act on the latter. Spend-only callers use
// `hasAccessForUserId`, which fails closed: if we cannot prove access, we do not
// spend.
export async function resolveAccessForUserId(userId: string): Promise<boolean> {
  return (await resolveAccessWithReason(userId)).allowed
}

export type AccessResolution =
  | { allowed: true }
  | { allowed: false; unverified: boolean }

/**
 * Like `resolveAccessForUserId`, but tells the caller WHY access was denied —
 * "unverified" (RAD-297) is recoverable and must NOT be treated like a lapse:
 * the webhook asks Parallel to retry instead of dropping the event, and the
 * monitor reconcile leaves the owner's monitors alone.
 */
export async function resolveAccessWithReason(userId: string): Promise<AccessResolution> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { userSettings: true, subscription: true },
  })
  if (!user || !user.isActive) return { allowed: false, unverified: false }

  const activeAccess = hasActiveAccess({
    role: user.role,
    onboardingCompleted: user.userSettings?.onboardingCompleted ?? true,
    subscription: user.subscription
      ? {
          status: user.subscription.status,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
        }
      : null,
    complimentaryAccessUntil: user.complimentaryAccessUntil ?? null,
    accountCreatedAt: user.createdAt,
    now: new Date(),
  })
  if (!activeAccess) return { allowed: false, unverified: false }

  // RAD-297: unverified credential accounts get the demo (browse, manage
  // feeds) but NO background spend. RAD-284: self-hosted mode has no mail
  // transport by design, so it owns verification too. OAuth accounts are
  // created verified; ADMIN is exempt.
  if (user.role === "ADMIN" || isSelfHosted()) return { allowed: true }
  if (user.emailVerified === null) return { allowed: false, unverified: true }
  return { allowed: true }
}

// Fail-closed wrapper for spend gates: a missing user, an inactive user, or a DB
// error all resolve to false (no spend).
export async function hasAccessForUserId(userId: string): Promise<boolean> {
  try {
    return await resolveAccessForUserId(userId)
  } catch (err) {
    Sentry.captureException(err, { tags: { gate: "hasAccessForUserId" } })
    return false
  }
}
