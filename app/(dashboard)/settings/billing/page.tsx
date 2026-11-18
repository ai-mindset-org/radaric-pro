import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { hasActiveAccess } from "@/lib/subscription"
import { planFromPriceId } from "@/lib/entitlements"
import { isSelfHosted } from "@/lib/self-hosted"
import { isLaunchTrialComp } from "@/lib/trial-ref"
import { getContactEmail } from "@/lib/contact"
import { BillingSection } from "@/components/settings/billing-section"

export const metadata: Metadata = { title: "Billing" }
export const dynamic = "force-dynamic"
export const revalidate = 0

// RAD-284: a self-hosted install has no Stripe configuration at all. Explain
// the state instead of rendering Checkout buttons against missing keys.
function SelfHostedBilling() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      <section className="space-y-2 rounded-xl border border-hairline bg-card p-6">
        <h2 className="text-base font-medium">Self-hosted — all features unlocked</h2>
        <p className="text-sm text-muted-foreground">
          This instance runs in self-hosted mode (<code className="rounded bg-secondary px-1.5 py-0.5 text-xs">SELF_HOSTED=true</code>).
          Every feature is available to every account — there is no subscription, checkout or
          customer portal involved.
        </p>
        <p className="text-sm text-muted-foreground">
          AI usage runs on the instance&apos;s API keys, configured by the administrator in Settings
          (or via the environment). Usage caps still apply: they are spend guards, not plan limits.
        </p>
      </section>
    </div>
  )
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ success?: string; canceled?: string; session_id?: string }>
}) {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }

  if (isSelfHosted()) {
    return <SelfHostedBilling />
  }

  const userId = session.user.id
  const role = session.user.role || "USER"

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { userSettings: true, subscription: true },
  })

  const now = new Date()
  const gateBase = {
    role,
    onboardingCompleted: user?.userSettings?.onboardingCompleted ?? true,
    subscription: user?.subscription
      ? {
          status: user.subscription.status,
          currentPeriodEnd: user.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
        }
      : null,
    accountCreatedAt: user?.createdAt ?? new Date(0),
    now,
  }
  const allowed = hasActiveAccess({
    ...gateBase,
    complimentaryAccessUntil: user?.complimentaryAccessUntil ?? null,
  })
  // Does the paid subscription ITSELF grant access (comp excluded)? Drives the
  // manage-vs-gift branch, so a comp user with a lapsed/canceled sub row still
  // sees the gift card + plan cards rather than a stale "Current plan" panel.
  const subscriptionActive = hasActiveAccess({ ...gateBase, complimentaryAccessUntil: null })

  const params = await searchParams

  return (
    <BillingSection
      hasActiveAccess={allowed}
      subscription={
        user?.subscription
          ? {
              status: user.subscription.status,
              tier: planFromPriceId(user.subscription.stripePriceId)?.tier ?? "unknown",
              interval:
                planFromPriceId(user.subscription.stripePriceId)?.interval ?? "unknown",
              currentPeriodEnd: user.subscription.currentPeriodEnd.toISOString(),
              cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
            }
          : null
      }
      complimentaryAccessUntil={user?.complimentaryAccessUntil?.toISOString() ?? null}
      // RAD-419: the referral sign-up trial reads as a trial, a hand grant as a comp.
      launchTrial={user ? isLaunchTrialComp(user) : false}
      contactEmail={getContactEmail()}
      subscriptionActive={subscriptionActive}
      nowMs={now.getTime()}
      successState={params.success === "1"}
      canceledState={params.canceled === "1"}
    />
  )
}
