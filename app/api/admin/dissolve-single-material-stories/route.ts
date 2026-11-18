import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { dissolveSingleMaterialStories } from "@/lib/story-aggregator/dissolve-single-material-stories"

export const runtime = "nodejs"

// POST /api/admin/dissolve-single-material-stories
// One-time backfill: detach + delete auto-created single-material stories so lone
// posts revert to their original content. Excludes Notion-exported, manually-sent,
// inbox-backed, and multi-source stories. Idempotent — safe to re-run.
// Query params:
//   ?scope=self (default) — only the calling admin's stories
//   ?scope=all            — every user's stories (multi-user backfill)
export async function POST(request: NextRequest) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId, role } = authResult

  if (role !== "ADMIN") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 })
  }

  const deps = {
    db: {
      story: {
        findMany: (args: Record<string, unknown>) => db.story.findMany(args as never) as never,
        delete: (args: { where: { id: string } }) => db.story.delete(args as never),
      },
      material: {
        updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) =>
          db.material.updateMany(args as never),
      },
    },
  }

  const scope = new URL(request.url).searchParams.get("scope") || "self"

  if (scope === "all") {
    const users = await db.user.findMany({ select: { id: true } })
    let dissolved = 0
    let materialsDetached = 0
    for (const u of users) {
      const r = await dissolveSingleMaterialStories(u.id, deps)
      dissolved += r.dissolved
      materialsDetached += r.materialsDetached
    }
    return NextResponse.json({ scope: "all", users: users.length, dissolved, materialsDetached })
  }

  const result = await dissolveSingleMaterialStories(userId, deps)
  return NextResponse.json({ scope: "self", ...result })
}
