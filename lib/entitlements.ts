// Feature entitlements derived from a user's subscription tier.
//
// Radaric has two paid tiers — Pro and Lite — that differ in exactly one way:
// Pro can parse Twitter/X account feeds, Lite cannot. The tier is NOT stored on
// any model; it is derived live from the subscription's `stripePriceId`, so an
// upgrade/downgrade flips capabilities instantly with no reconciliation job and
// no migration. This module is the single source of truth for that derivation.
import { SubscriptionStatus } from "@prisma/client"
import * as Sentry from "@sentry/nextjs"
import { db } from "@/lib/db"
import { STRIPE_PRICES } from "@/lib/stripe"
import { hasActiveAccess, ONBOARDING_DEMO_WINDOW_MS } from "@/lib/subscription"
import { isSelfHosted } from "@/lib/self-hosted"

export type PlanTier = "pro" | "lite"
export type BillingInterval = "monthly" | "yearly"

export type SubscriptionForEntitlement = {
  status: SubscriptionStatus
  stripePriceId: string
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
}

// price id → { tier, interval }, or null when the id matches no configured price.
// Empty-string env values are ignored so an UNSET price var can never match a
// real id (and "" input never resolves to a tier) — guarding against a
// misconfigured environment silently mapping everything to one tier.
export function planFromPriceId(
  priceId: string
): { tier: PlanTier; interval: BillingInterval } | null {
  if (!priceId) return null
  for (const [key, value] of Object.entries(STRIPE_PRICES)) {
    if (value && value === priceId) {
      const [tier, interval] = key.split("_") as [PlanTier, BillingInterval]
      return { tier, interval }
    }
  }
  return null
}

// Whether the user may parse Twitter/X account feeds. Evaluation order matters
// (pinned by tests):
//   1. ADMIN                          → true (bypasses all gates)
//   2. onboardingCompleted === false  → true (onboarding is the full-access demo)
//   3. no access-granting subscription → false
//   4. tier === "lite"                → false (the one Lite restriction)
//   5. tier === "pro" OR unknown/legacy id → true
// Step 5 FAILS OPEN: an unmappable price id on an access-granting subscription
// grandfathers to Pro. Today every payer is Pro and Lite is brand-new, so an
// unknown id can only be a legacy/rotated Pro price — failing closed would
// wrongly strip Twitter from real Pro customers.
export function subscriptionIncludesTwitter(input: {
  role: string
  onboardingCompleted: boolean | undefined
  subscription: SubscriptionForEntitlement | null
  // Required so tsc enumerates every call site (RAD-294): bounds the
  // onboarding-incomplete demo grant below to ONBOARDING_DEMO_WINDOW_MS.
  accountCreatedAt: Date
  now: Date
}): boolean {
  // SELF_HOSTED (RAD-284): the second, independent gate — short-circuited here
  // so self-hosters are not left with Twitter locked and dead billing links.
  if (isSelfHosted()) return true

  if (input.role === "ADMIN") return true
  if (
    input.onboardingCompleted === false &&
    input.now.getTime() - input.accountCreatedAt.getTime() < ONBOARDING_DEMO_WINDOW_MS
  ) {
    return true
  }

  const sub = input.subscription
  if (sub === null) return false

  const access = hasActiveAccess({
    role: input.role,
    onboardingCompleted: input.onboardingCompleted,
    subscription: {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    },
    // Deliberately null: the Twitter entitlement is derived from the paid
    // subscription ONLY. Comp access is Lite — passing the user's comp date here
    // would grandfather comp users to Pro/Twitter. Do NOT thread comp in.
    complimentaryAccessUntil: null,
    accountCreatedAt: input.accountCreatedAt,
    now: input.now,
  })
  if (!access) return false

  const plan = planFromPriceId(sub.stripePriceId)
  // Observability for the fail-open path: an access-granting subscription whose
  // price id maps to NO known plan grandfathers to Pro (returns true below).
  // That is correct for a legacy/rotated *Pro* id, but if a *Lite* price is ever
  // rotated/archived, a paying Lite subscriber's stored id stops matching and
  // they would silently get Twitter for free. Log it so the leak is detectable.
  // Mitigation when rotating a Lite price: keep the old id mapped to lite.
  if (plan === null) {
    Sentry.captureMessage(
      "entitlement: active subscription with unmapped stripePriceId — failing open to Pro (Twitter enabled)",
      { level: "warning", extra: { stripePriceId: sub.stripePriceId } }
    )
  }

  return plan?.tier !== "lite"
}

// Server helper: load the user and resolve their tier + Twitter capability in
// one place. Used by server components (to thread `includesTwitter` into client
// UI) and by the non-stream /api/parse route (which otherwise has no
// subscription object loaded).
export async function getTwitterEntitlement(
  userId: string,
  role: string
): Promise<{ tier: PlanTier | null; includesTwitter: boolean }> {
  if (role === "ADMIN") return { tier: null, includesTwitter: true }

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { userSettings: true, subscription: true },
  })

  const onboardingCompleted = user?.userSettings?.onboardingCompleted ?? true
  const subscription: SubscriptionForEntitlement | null = user?.subscription
    ? {
        status: user.subscription.status,
        stripePriceId: user.subscription.stripePriceId,
        currentPeriodEnd: user.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
      }
    : null

  const includesTwitter = subscriptionIncludesTwitter({
    role,
    onboardingCompleted,
    subscription,
    accountCreatedAt: user?.createdAt ?? new Date(0),
    now: new Date(),
  })
  const tier = subscription
    ? planFromPriceId(subscription.stripePriceId)?.tier ?? null
    : null

  return { tier, includesTwitter }
}
