"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Gift, Timer } from "lucide-react"
import type { SubscriptionStatus } from "@prisma/client"
import type { PlanTier, BillingInterval } from "@/lib/entitlements"
import { TRIAL_DAYS } from "@/lib/trial-ref"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { MorphText } from "@/components/ui/morph-text"

export type TierKey = PlanTier | "unknown"
export type IntervalKey = BillingInterval | "unknown"

type SubscriptionView = {
  status: SubscriptionStatus
  tier: TierKey
  interval: IntervalKey
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
}

type Props = {
  hasActiveAccess: boolean
  subscription: SubscriptionView | null
  // Whether the paid subscription alone grants access (comp excluded). Drives the
  // manage-vs-gift branch so a comp user's dead sub row can't hide the gift card.
  subscriptionActive: boolean
  complimentaryAccessUntil: string | null
  // The comp is the referral sign-up trial (isLaunchTrialComp, judged on the
  // server), not a hand grant: it reads as a free trial. RAD-419.
  launchTrial?: boolean
  // Support, refunds and privacy address — resolved on the server from
  // CONTACT_EMAIL, never inlined into this client bundle.
  contactEmail: string
  // Server render time (ms). Passed in — never Date.now() during render — so SSR
  // and hydration agree exactly and the comp gift card can't flip on hydrate.
  nowMs: number
  successState: boolean
  canceledState: boolean
}

// Two tiers × two intervals. Lite is the full product minus Twitter/X; Pro adds
// it. Savings are per-tier (Pro yearly saves $209/~30%, Lite yearly is "2 months
// free"/~17%), so they live inside each card — never on the interval toggle.
// Single source of display prices (the actual charge is server-authoritative
// via STRIPE_PRICES; these strings must be kept in sync if a Stripe price moves).
const PLANS: Record<
  PlanTier,
  {
    name: string
    blurb: string
    monthlyAmount: number
    monthly: { price: string; note: string }
    yearly: { price: string; note: string }
    yearlySavings: string
    recommended: boolean
  }
> = {
  lite: {
    name: "Lite",
    blurb: "RSS, Telegram, and YouTube with AI-read transcripts — plus Substack, Bluesky, Mastodon, Product Hunt, GitHub, and arXiv. Filtering that learns your taste, and story aggregation.",
    monthlyAmount: 9,
    monthly: { price: "$9", note: "per month" },
    yearly: { price: "$90", note: "per year — 2 months free" },
    yearlySavings: "$18",
    recommended: false,
  },
  pro: {
    name: "Pro",
    blurb: "Everything in Lite, plus Twitter/X account parsing.",
    monthlyAmount: 59,
    monthly: { price: "$59", note: "per month" },
    yearly: { price: "$499", note: "per year — save $209" },
    yearlySavings: "$209",
    recommended: true,
  },
}

// Pinned to UTC: this renders on the server (UTC) and again in the browser, so
// a local zone would print a different day near midnight and break hydration.
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  })
}

function statusCopy(sub: SubscriptionView): string {
  if (sub.status === "ACTIVE" && sub.cancelAtPeriodEnd) {
    return `Access until ${formatDate(sub.currentPeriodEnd)}`
  }
  if (sub.status === "ACTIVE" || sub.status === "TRIALING") {
    return `Renews on ${formatDate(sub.currentPeriodEnd)}`
  }
  if (sub.status === "PAST_DUE") {
    return `Payment failed — retrying. Access until ${formatDate(sub.currentPeriodEnd)}`
  }
  if (sub.status === "CANCELED") {
    return `Canceled on ${formatDate(sub.currentPeriodEnd)}`
  }
  return sub.status
}

function planLabel(sub: SubscriptionView): string {
  const tier =
    sub.tier === "pro" ? "Pro" : sub.tier === "lite" ? "Lite" : "Active"
  const interval =
    sub.interval === "monthly" ? "Monthly" : sub.interval === "yearly" ? "Yearly" : ""
  return interval ? `${tier} — ${interval}` : tier
}

export function BillingSection({ hasActiveAccess, subscription, subscriptionActive, complimentaryAccessUntil, launchTrial = false, contactEmail, nowMs, successState, canceledState }: Props) {
  const router = useRouter()
  const moneyBackLine = `30-day money-back guarantee — email ${contactEmail} within 30 days if it's not for you.`
  // Loading key is `${tier}_${interval}` so the spinner lands on the exact button.
  const [loadingKey, setLoadingKey] = useState<string | null>(null)
  const [interval, setInterval] = useState<BillingInterval>("monthly")
  const [loadingPortal, setLoadingPortal] = useState(false)
  const [pollingActive, setPollingActive] = useState(successState)
  const [error, setError] = useState<string | null>(null)
  // Checkout requires an email; when missing we point the user to set one.
  const [needsEmail, setNeedsEmail] = useState(false)

  useEffect(() => {
    if (!successState) return
    if (hasActiveAccess) {
      router.replace("/posts")
      return
    }

    let cancelled = false
    let attempts = 0
    const maxAttempts = 14 // ~20s at 1.5s interval

    async function poll() {
      if (cancelled) return
      try {
        const res = await fetch("/api/subscription/status", { cache: "no-store" })
        if (res.ok) {
          const data = await res.json()
          if (data.hasActiveAccess) {
            router.replace("/posts")
            return
          }
        }
      } catch {
        // Ignore network blips; retry
      }
      attempts += 1
      if (attempts >= maxAttempts) {
        setPollingActive(false)
        return
      }
      setTimeout(poll, 1500)
    }

    poll()
    return () => {
      cancelled = true
    }
  }, [successState, hasActiveAccess, router])

  async function handleSubscribe(tier: PlanTier, billingInterval: BillingInterval) {
    setLoadingKey(`${tier}_${billingInterval}`)
    setError(null)
    setNeedsEmail(false)
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier, interval: billingInterval }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) {
        // Contract: this string is produced by POST /api/stripe/checkout when
        // the user has no email. Keep the two in sync.
        if (data.error === "Email required") {
          setNeedsEmail(true)
          setError("Add an email address before subscribing.")
        } else {
          setError(data.error || "Failed to start checkout")
        }
        setLoadingKey(null)
        return
      }
      window.location.assign(data.url)
    } catch (err) {
      setError("Network error. Try again.")
      setLoadingKey(null)
    }
  }

  async function handlePortal(flow?: "switch") {
    setLoadingPortal(true)
    setError(null)
    try {
      const res = await fetch("/api/stripe/portal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(flow ? { flow } : {}),
      })
      const data = await res.json()
      if (!res.ok || !data.url) {
        setError(data.error || "Failed to open billing portal")
        setLoadingPortal(false)
        return
      }
      window.location.assign(data.url)
    } catch (err) {
      setError("Network error. Try again.")
      setLoadingPortal(false)
    }
  }

  // Success polling state — show spinner
  if (pollingActive) {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-12">
        <Card>
          <CardContent className="py-12 text-center">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden />
            <h2 className="mt-4 text-lg font-semibold">Setting up your account</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your payment succeeded. Just finalizing things — this takes a moment.
            </p>
            <div role="status" aria-live="polite" className="sr-only">
              Setting up your account
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Manage view only when the PAID subscription itself grants access. Using
  // hasActiveAccess here would treat a comp user's dead sub row as "active".
  const isActive = subscriptionActive && subscription !== null
  // Complimentary (hand-granted, time-limited) access with no paid subscription:
  // show the gift, not the raw paywall — but still surface the plans below (no
  // hidden options) so the user can convert whenever they want.
  const compUntilMs = complimentaryAccessUntil ? new Date(complimentaryAccessUntil).getTime() : null
  const compActive = !isActive && compUntilMs !== null && compUntilMs > nowMs
  const compDaysLeft = compActive ? Math.max(1, Math.ceil((compUntilMs! - nowMs) / 86_400_000)) : 0
  // "Ending" only in the last two days: with a wider window a week-long grant
  // (a hand-granted comp or the referral trial) read as ending from day one.
  const compNearExpiry = compActive && compDaysLeft <= 2
  // A referral trial is a comp too, with its own copy and the same threshold.
  const trialActive = compActive && launchTrial
  const trialEnding = trialActive && compNearExpiry

  // Heading + intro for the plan-choice card adapt to context: a comp user sees
  // forward-looking copy (keep going / ending soon), not the cold "Choose your plan".
  const chooseTitle = trialActive
    ? trialEnding
      ? "Your free trial is ending"
      : "Pick a plan to keep going after your trial"
    : compActive
      ? compNearExpiry
        ? "Your complimentary access is ending"
        : "Keep your access going"
      : subscription?.status === "CANCELED"
        ? "Welcome back"
        : "Choose your plan"
  const chooseIntro = trialActive
    ? `When your trial ends on ${formatDate(complimentaryAccessUntil!)}, choose a plan to keep your feeds and the filters that learned your taste.`
    : compActive
      ? compNearExpiry
        ? `Your complimentary access ends ${formatDate(complimentaryAccessUntil!)}. Subscribe to keep your feeds and the filters that learned your taste.`
        : "When your complimentary access ends, pick a plan to keep your feeds and learned filters — no rush."
      : subscription?.status === "CANCELED"
        ? "Your previous subscription was canceled. Pick a plan to reactivate — your feeds and learned filters are still here."
        : "AI filtering that learns your taste, plus story aggregation. Lite covers RSS, Telegram, YouTube, Substack, Bluesky, and more; Pro adds Twitter/X accounts."

  // Subscribe view shows two tiers — give it more room than the manage view.
  const widthClass = isActive ? "max-w-xl" : "max-w-2xl"

  return (
    <div className={`${widthClass} mx-auto px-4 sm:px-6 py-12 space-y-6`}>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your subscription
        </p>
      </div>

      {successState && hasActiveAccess && (
        <Card className="corner-round bg-primary-subtle ring-1 ring-inset ring-primary/25 animate-fade-in-scale">
          <CardContent className="py-4">
            <p className="text-sm">
              You&apos;re in. Your AI filter is ready to learn your taste.
            </p>
          </CardContent>
        </Card>
      )}

      {canceledState && !isActive && (
        <Card className="animate-fade-in-scale">
          <CardContent className="py-4">
            <p className="text-sm text-muted-foreground">
              Checkout was canceled. You can try again whenever you&apos;re ready.
            </p>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="corner-round border-destructive/30 bg-destructive/5 animate-fade-in-scale">
          <CardContent className="py-4">
            <p className="text-sm text-destructive">{error}</p>
            {needsEmail && (
              <Link
                href="/settings#account"
                className="mt-2 inline-block text-sm font-medium link"
              >
                Add your email in Account settings →
              </Link>
            )}
          </CardContent>
        </Card>
      )}

      {trialActive && (
        <Card className="corner-round bg-primary-subtle ring-1 ring-inset ring-primary/25 animate-fade-in-scale">
          <CardContent className="py-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <Timer className="h-[18px] w-[18px] text-primary" />
              <p className="text-sm font-medium">Free trial</p>
            </div>
            <p className="text-sm">
              Your {TRIAL_DAYS}-day Lite trial runs through{" "}
              <span className="font-medium">{formatDate(complimentaryAccessUntil!)}</span>
              {" · "}
              {compDaysLeft} {compDaysLeft === 1 ? "day" : "days"} left.
              <span className="text-primary-subtle-foreground">
                {" "}No card on file — nothing will be charged. X/Twitter feeds are part of Pro.
              </span>
            </p>
          </CardContent>
        </Card>
      )}

      {compActive && !trialActive && (
        <Card className="corner-round bg-primary-subtle ring-1 ring-inset ring-primary/25 animate-fade-in-scale">
          <CardContent className="py-4 space-y-1.5">
            <div className="flex items-center gap-2">
              <Gift className="h-[18px] w-[18px] text-primary" />
              <p className="text-sm font-medium">Complimentary access</p>
            </div>
            <p className="text-sm">
              You have complimentary access to Radaric, courtesy of the team, through{" "}
              <span className="font-medium">{formatDate(complimentaryAccessUntil!)}</span>.
              <span className="text-muted-foreground">
                {" "}{compDaysLeft} {compDaysLeft === 1 ? "day" : "days"} remaining.
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              Includes everything except Twitter/X account parsing.
            </p>
          </CardContent>
        </Card>
      )}

      {isActive && subscription ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">Current plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-lg font-medium">
                Radaric {planLabel(subscription)}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {statusCopy(subscription)}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                onClick={() => handlePortal()}
                disabled={loadingPortal}
                className="h-11"
              >
                {loadingPortal ? "Opening…" : "Manage billing"}
              </Button>
            </div>

            <p className="text-xs text-muted-foreground">{moneyBackLine}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-semibold">
              {chooseTitle}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <p className="text-sm text-muted-foreground">
              {chooseIntro}
            </p>

            {/* Interval toggle — neutral label; per-tier savings live in the cards */}
            <div
              role="group"
              aria-label="Billing interval"
              className="inline-flex rounded-lg bg-muted p-1 text-sm"
            >
              {(["monthly", "yearly"] as const).map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={interval === opt}
                  disabled={loadingKey !== null}
                  onClick={() => setInterval(opt)}
                  className={`rounded-md px-4 py-2.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 disabled:opacity-50 ${
                    interval === opt
                      ? "bg-background text-foreground shadow-[var(--shadow-card)]"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt === "monthly" ? "Monthly" : "Yearly"}
                </button>
              ))}
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              {(["lite", "pro"] as const).map((tier) => {
                const plan = PLANS[tier]
                const offer = plan[interval]
                const key = `${tier}_${interval}`
                return (
                  <div
                    key={tier}
                    className={`relative flex flex-col rounded-xl p-4 shadow-[var(--shadow-card)] ${
                      plan.recommended ? "ring-1 ring-inset ring-primary/25" : ""
                    }`}
                  >
                    {plan.recommended && (
                      <span className="type-tag absolute right-3 top-3 rounded-xs bg-primary-subtle px-2 py-0.5 text-[11px] font-medium text-primary-subtle-foreground">
                        Recommended
                      </span>
                    )}
                    <p className="type-heading text-sm font-semibold">Radaric {plan.name}</p>
                    <div className="mt-2">
                      <MorphText className="text-2xl font-semibold type-counter">{offer.price}</MorphText>{" "}
                      <span className="text-xs text-muted-foreground">{offer.note}</span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground flex-1">{plan.blurb}</p>
                    <Button
                      onClick={() => handleSubscribe(tier, interval)}
                      disabled={loadingKey !== null}
                      variant={plan.recommended ? "default" : "outline"}
                      className="mt-4 h-11 w-full"
                    >
                      {loadingKey === key ? "Opening…" : `Choose ${plan.name}`}
                    </Button>
                  </div>
                )
              })}
            </div>

            <p className="text-xs text-muted-foreground">{moneyBackLine}</p>
            <p className="text-xs text-muted-foreground">
              Payments processed securely by Stripe. Your card details never touch our servers.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Lite users: a single higher-intent upgrade path (adds Twitter/X). */}
      {isActive && subscription && subscription.tier === "lite" && (
        <Card className="corner-round bg-primary-subtle ring-1 ring-inset ring-primary/25">
          <CardContent className="py-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Upgrade to Pro — adds Twitter/X accounts</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Parse X/Twitter accounts alongside everything in Lite.
              </p>
            </div>
            <Button
              onClick={() => handlePortal("switch")}
              disabled={loadingPortal}
              variant="outline"
              size="sm"
            >
              Upgrade
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Pro monthly users: nudge to yearly (Lite users get the Pro card instead). */}
      {isActive && subscription && subscription.tier === "pro" && subscription.interval === "monthly" && (
        <Card className="corner-round bg-primary-subtle ring-1 ring-inset ring-primary/25">
          <CardContent className="py-4 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Switch to yearly and save {PLANS.pro.yearlySavings}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {PLANS.pro.yearly.price} per year vs {PLANS.pro.monthly.price} × 12 = $
                {PLANS.pro.monthlyAmount * 12}
              </p>
            </div>
            <Button
              onClick={() => handlePortal("switch")}
              disabled={loadingPortal}
              variant="outline"
              size="sm"
            >
              Switch
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
