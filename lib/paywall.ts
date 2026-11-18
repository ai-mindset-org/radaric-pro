import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { hasActiveAccess } from "@/lib/subscription"
import { redirectToOnboardingOnNewVisit } from "@/lib/onboarding-revisit"

// Server-side paywall guard for protected dashboard pages.
// Runs: auth → onboarding check → subscription check → (opt-in) revisit check.
// Redirects to /signup, /onboarding/feeds, or /settings/billing as needed.
// Returns the userId + role once all gates are cleared.
//
// `revisitOnboarding` (RAD-168) sends a completed user with zero sources back to
// onboarding on a new visit. Only the dashboard landing pages (/posts, /feeds)
// opt in: detail pages must keep working from links, and /feeds/new is already
// where a source gets added.
//
// Uses separate Prisma queries (not include) to match existing test mocks
// for db.userSettings.findUnique, db.feed.count, and db.subscription.findUnique.
export async function requirePaidDashboardAccess(
  options: { revisitOnboarding?: boolean } = {},
): Promise<{
  userId: string
  role: string
}> {
  const session = await auth()
  if (!session?.user?.id) {
    redirect("/signup")
  }
  const userId = session.user.id
  const role = session.user.role || "USER"

  // Read comp-access off the User row DIRECTLY (not via the userSettings
  // relation): a comp user may have no UserSettings row yet, and the
  // auto-complete branch below upserts one without re-reading it — reading comp
  // through userSettings would then drop the grant and bounce a valid comp user
  // to billing while the API gate lets them in. Parallel query, same round-trip.
  const [userSettings, userRow] = await Promise.all([
    db.userSettings.findUnique({
      where: { userId },
      select: { onboardingCompleted: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { complimentaryAccessUntil: true, createdAt: true },
    }),
  ])

  // Onboarding gate: incomplete + 0 feeds → onboarding; incomplete + has feeds → auto-complete
  const onboardingCompleted = userSettings?.onboardingCompleted ?? false
  if (!onboardingCompleted) {
    const feedCount = await db.feed.count({ where: { userId } })
    if (feedCount > 0) {
      await db.userSettings.upsert({
        where: { userId },
        update: { onboardingCompleted: true },
        create: { userId, onboardingCompleted: true },
      })
    } else {
      redirect("/onboarding/feeds")
    }
  }

  // Paywall: completed onboarding + no active sub → /settings/billing
  const subscription = await db.subscription.findUnique({
    where: { userId },
    select: {
      status: true,
      currentPeriodEnd: true,
      cancelAtPeriodEnd: true,
    },
  })

  const allowed = hasActiveAccess({
    role,
    onboardingCompleted: true,
    subscription,
    complimentaryAccessUntil: userRow?.complimentaryAccessUntil ?? null,
    accountCreatedAt: userRow?.createdAt ?? new Date(0),
    now: new Date(),
  })

  if (!allowed) {
    redirect("/settings/billing")
  }

  // After billing, so an unpaid user with zero feeds still lands on billing.
  // Only for a user who was already completed: the incomplete branch above has
  // just counted the feeds and either redirected or found some.
  if (options.revisitOnboarding && onboardingCompleted) {
    await redirectToOnboardingOnNewVisit(userId)
  }

  return { userId, role }
}
