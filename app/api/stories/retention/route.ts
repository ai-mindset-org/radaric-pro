import { NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { runRetention, type DataRetentionDeps } from "@/lib/story-aggregator/data-retention"

export async function POST() {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  const gate = await requireActiveSubscription(userId, role)
  if (gate) return gate

  const deps: DataRetentionDeps = {
    db: {
      inboxItem: {
        updateMany: (args) => db.inboxItem.updateMany(args as never),
        count: (args) => db.inboxItem.count(args as never),
      },
    },
  }

  const result = await runRetention(userId, deps)

  return NextResponse.json({
    success: true,
    ...result,
  })
}
