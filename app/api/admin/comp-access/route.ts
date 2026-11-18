import { NextResponse } from "next/server"
import * as Sentry from "@sentry/nextjs"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import {
  setComplimentaryAccess,
  CompUserNotFoundError,
  CompValidationError,
} from "@/lib/comp-access"

export const dynamic = "force-dynamic"

// Grant / extend / revoke complimentary (time-limited free) access for a user.
// ADMIN-only. Body: { userId: string, days: number | null }.
//   days = N    → set expiry to max(now, existing) + N days (grant / extend)
//   days = null → revoke
// The expiry is computed server-side; any client-sent date is ignored.
export async function POST(request: Request) {
  const auth = await requireAdmin()
  if (isErrorResponse(auth)) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { userId, days } = (body ?? {}) as { userId?: unknown; days?: unknown }

  if (typeof userId !== "string" || userId.length === 0) {
    return NextResponse.json({ error: "userId is required" }, { status: 400 })
  }
  if (days !== null && typeof days !== "number") {
    return NextResponse.json(
      { error: "days must be a number or null" },
      { status: 400 }
    )
  }

  try {
    const until = await setComplimentaryAccess(userId, days)

    Sentry.captureMessage("admin: complimentary access updated", {
      level: "info",
      extra: { adminId: auth.userId, targetUserId: userId, days, until },
    })

    return NextResponse.json({
      userId,
      complimentaryAccessUntil: until ? until.toISOString() : null,
    })
  } catch (err) {
    if (err instanceof CompValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 })
    }
    if (err instanceof CompUserNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 })
    }
    Sentry.captureException(err, { tags: { route: "admin/comp-access" } })
    return NextResponse.json(
      { error: "Failed to update complimentary access" },
      { status: 500 }
    )
  }
}
