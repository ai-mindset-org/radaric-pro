import { NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { hasActiveAccess } from "@/lib/subscription"

export async function GET(request: Request): Promise<Response> {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  const user = await db.user.findUnique({
    where: { id: userId },
    include: { userSettings: true, subscription: true },
  })

  const now = new Date()
  const onboardingCompleted = user?.userSettings?.onboardingCompleted ?? true
  const subscription = user?.subscription
    ? {
        status: user.subscription.status,
        currentPeriodEnd: user.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: user.subscription.cancelAtPeriodEnd,
      }
    : null
  const access = hasActiveAccess({
    role,
    onboardingCompleted,
    subscription,
    complimentaryAccessUntil: user?.complimentaryAccessUntil ?? null,
    accountCreatedAt: user?.createdAt ?? new Date(0),
    now,
  })

  return NextResponse.json({
    hasActiveAccess: access,
    status: user?.subscription?.status ?? null,
    currentPeriodEnd: user?.subscription?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: user?.subscription?.cancelAtPeriodEnd ?? false,
  })
}
