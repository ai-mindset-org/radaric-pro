// Admin-dashboard view of a user's PAID subscription.
//
// Deliberately NOT hasActiveAccess: that gate answers "may this user act" and
// early-returns on isSelfHosted / ADMIN / the 24h onboarding demo before ever
// looking at the subscription (lib/subscription.ts). The admin question is
// "does this user PAY", answered from the subscription row alone. Comp access
// is a separate, independent axis and never folded in here.
//
// The legacy complimentary rows whose ids start with `comp_` live in the same
// table but were never Stripe subscriptions — see isStripeSubscriptionId.
import type { SubscriptionStatus } from "@prisma/client"

export type AdminSubState = "active" | "ending" | "past_due" | "lapsed"

/**
 * Classify one subscription row for the admin dashboard. Caller supplies `now`
 * so every row in a response is judged against the same instant.
 */
export function classifyAdminSubscription(
  input: {
    status: SubscriptionStatus
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
  },
  now: Date
): AdminSubState {
  const granting =
    input.status === "ACTIVE" ||
    input.status === "TRIALING" ||
    input.status === "PAST_DUE"
  // Strict <=: a period that ended exactly at `now` is over (mirrors the
  // strict `>` in lib/subscription.ts).
  if (!granting || input.currentPeriodEnd.getTime() <= now.getTime()) return "lapsed"
  // past_due beats ending: the payment problem is the actionable warning.
  if (input.status === "PAST_DUE") return "past_due"
  if (input.cancelAtPeriodEnd) return "ending"
  return "active"
}

/** Whether a classified state still grants paid access (feeds the Subscribers count). */
export function isGrantingAdminSub(state: AdminSubState): boolean {
  return state !== "lapsed"
}

/**
 * Real Stripe subscriptions carry `sub_` ids; legacy complimentary rows whose
 * ids start with `comp_` were never payments and must not read as paying (two
 * such rows once showed a green badge and inflated the Subscribers count).
 * Rotated/legacy REAL plans keep their `sub_` id, so this never hides a payer.
 */
export function isStripeSubscriptionId(id: string): boolean {
  return id.startsWith("sub_")
}

// ---------------------------------------------------------------------------
// Display model — pure data in, strings out (client-safe: no db, no React).
// ---------------------------------------------------------------------------

export type AdminSubscriptionView = {
  state: AdminSubState
  status: SubscriptionStatus
  tier: "pro" | "lite" | null
  interval: "monthly" | "yearly" | null
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  createdAt: string
  stripeSubscriptionId: string
}

export type AdminSubBadge = {
  label: string
  variant: "default" | "warning" | "outline"
  // Pointer tooltip and aria-label share one string.
  tooltip: string
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  })
}

// "Pro" / "Lite" / "Paid" — an unmapped price on a REAL Stripe row (rotated /
// legacy id) deliberately reads "Paid" (the operator's question) rather than
// billing's "Active" (`planLabel` in components/settings/billing-section.tsx)
// for the same row. Legacy comp rows never reach this — they get "Legacy comp".
function tierLabel(tier: AdminSubscriptionView["tier"]): string {
  return tier === "pro" ? "Pro" : tier === "lite" ? "Lite" : "Paid"
}

/** "Radaric Pro — Monthly"; the interval segment is omitted when unmapped. */
function planLabel(view: AdminSubscriptionView): string {
  if (view.tier === null) return "Radaric — unknown plan"
  const tier = view.tier === "pro" ? "Pro" : "Lite"
  const interval =
    view.interval === "monthly" ? "Monthly" : view.interval === "yearly" ? "Yearly" : null
  return `Radaric ${tier}${interval ? ` — ${interval}` : ""}`
}

/** Row badge, or null when the row should show nothing (lapsed / no subscription). */
export function adminSubBadge(view: AdminSubscriptionView): AdminSubBadge | null {
  // Lapsed first: an ended row claims nothing, comp or paid (RAD-413).
  if (view.state === "lapsed") return null
  // Legacy comp rows next: they grant access but were never payments, so they
  // get the muted grant badge — never a green plan badge. The route's
  // Subscribers count filters them with the same predicate.
  if (!isStripeSubscriptionId(view.stripeSubscriptionId)) {
    return {
      label: "Legacy comp",
      variant: "outline",
      tooltip: "Legacy comp row — grants access, not a paid subscription",
    }
  }
  const tier = tierLabel(view.tier)
  const end = formatDate(view.currentPeriodEnd)
  if (view.state === "active") {
    return { label: tier, variant: "default", tooltip: `${tier} — renews ${end}` }
  }
  if (view.state === "ending") {
    return {
      label: `${tier} · not renewing`,
      variant: "default",
      tooltip: `${tier} — access until ${end} (cancels at period end)`,
    }
  }
  if (view.state === "past_due") {
    return {
      label: `${tier} · past due`,
      variant: "warning",
      tooltip: `${tier} — payment failed, retrying; access until ${end}`,
    }
  }
  return null
}

/**
 * One-line detail summary. Mirrors billing's status wording (`statusCopy` in
 * components/settings/billing-section.tsx) — kept in sync by review, not by a
 * shared import — and is pinned in tests. Granting rows get a `since` stamp
 * (when the CURRENT subscription started); lapsed rows show their end instead.
 */
export function adminSubSummary(view: AdminSubscriptionView): string {
  if (!isStripeSubscriptionId(view.stripeSubscriptionId)) {
    const comp = "Legacy comp row — no Stripe subscription"
    // Lapsed comp rows never get a `since` (RAD-413). Dates follow the paid
    // lapsed copy below: CANCELED reports canceledAt, an elapsed granting
    // status its period end, and any other status no date — its period end
    // may still be in the future.
    if (view.state === "lapsed") {
      if (view.status === "CANCELED") {
        return `${comp} · ended ${formatDate(view.canceledAt ?? view.currentPeriodEnd)}`
      }
      if (view.status === "ACTIVE" || view.status === "TRIALING" || view.status === "PAST_DUE") {
        return `${comp} · ended ${formatDate(view.currentPeriodEnd)}`
      }
      return `${comp} · no longer grants access`
    }
    return `${comp} · since ${formatDate(view.createdAt)}`
  }
  const plan = planLabel(view)
  const end = formatDate(view.currentPeriodEnd)
  const since = `since ${formatDate(view.createdAt)}`

  if (view.state === "active") return `${plan} · Renews on ${end} · ${since}`
  if (view.state === "ending") {
    return `${plan} · Access until ${end} (cancels at period end) · ${since}`
  }
  if (view.state === "past_due") {
    return `${plan} · Payment failed — retrying. Access until ${end} · ${since}`
  }

  // Lapsed — never claims access. A mid-period immediate cancel keeps a future
  // currentPeriodEnd while access is already gone, so CANCELED reports
  // canceledAt (falling back to the period end), not the untouched period end.
  switch (view.status) {
    case "CANCELED":
      return `${plan} · Canceled ${formatDate(view.canceledAt ?? view.currentPeriodEnd)}`
    case "PAUSED":
      return `${plan} · Paused`
    case "UNPAID":
      // No date claim: retries-exhausted `unpaid` can arrive BEFORE the period
      // end, so currentPeriodEnd is not guaranteed to be past here.
      return `${plan} · Unpaid — access revoked`
    case "INCOMPLETE":
    case "INCOMPLETE_EXPIRED":
      return `${plan} · Checkout incomplete`
    case "UNKNOWN":
      return `${plan} · Unknown status`
    default:
      // ACTIVE / TRIALING / PAST_DUE whose period has passed.
      return `${plan} · Access ended ${end}`
  }
}

// ---------------------------------------------------------------------------
// Referral-trial comp (RAD-419) — the comp axis, not the paid one: nothing here
// feeds classifyAdminSubscription or the Subscribers count. `launchTrial` is
// judged server-side (isLaunchTrialComp in lib/trial-ref.ts) from createdAt,
// which the client row does not need to carry.
// ---------------------------------------------------------------------------

export type AdminTrialBadge = {
  label: string
  variant: "info" | "outline"
  // Pointer tooltip and aria-label share one string.
  tooltip: string
}

/**
 * Row badge for a referral-trial comp, or null when the comp is a manual grant
 * (or absent) and the row keeps its Comp badge. Ends exactly at `nowMs` reads
 * as ended — the strict `>` of the comp gate in lib/subscription.ts.
 */
export function adminTrialBadge(
  input: { complimentaryAccessUntil: string | null; launchTrial: boolean },
  nowMs: number
): AdminTrialBadge | null {
  if (!input.launchTrial || !input.complimentaryAccessUntil) return null
  const until = input.complimentaryAccessUntil
  if (new Date(until).getTime() > nowMs) {
    const short = new Date(until).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    return {
      label: `Trial · ends ${short}`,
      variant: "info",
      tooltip: `Referral trial (Lite, no card) — ends ${formatDate(until)}`,
    }
  }
  return {
    label: "Trial ended",
    variant: "outline",
    tooltip: `Referral trial ended ${formatDate(until)}`,
  }
}
