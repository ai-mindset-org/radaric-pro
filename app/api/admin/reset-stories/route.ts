import { NextRequest, NextResponse } from "next/server"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"

/**
 * POST /api/admin/reset-stories
 * Reset story grouping: unlink all materials from stories, delete stories.
 * ADMIN only.
 *
 * Body: { allUsers?: boolean }
 * - Default: reset only the current admin's stories
 * - allUsers: true — reset stories for ALL users (one-time migration)
 */
export async function POST(request: NextRequest) {
  const authResult = await requireAdmin()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  const body = await request.json().catch(() => ({}))
  const allUsers = body.allUsers === true

  const userFilter = allUsers ? {} : { feed: { userId } }
  const storyFilter = allUsers ? {} : { userId }
  const inboxFilter = allUsers ? { storyId: { not: null } as const } : { userId, storyId: { not: null } as const }

  // 1. Count before
  const materialsBefore = await db.material.count({
    where: { ...userFilter, storyId: { not: null } },
  })
  const storiesBefore = await db.story.count({ where: storyFilter })

  // 2. Unlink all materials from stories
  await db.material.updateMany({
    where: { ...userFilter, storyId: { not: null } },
    data: { storyId: null, storyMatchedAt: null },
  })

  // 3. Unlink all inbox items from stories
  await db.inboxItem.updateMany({
    where: inboxFilter,
    data: { storyId: null },
  })

  // 4. Delete all stories
  const deleted = await db.story.deleteMany({ where: storyFilter })

  const scope = allUsers ? "all users" : "admin only"
  return NextResponse.json({
    scope,
    materialsUnlinked: materialsBefore,
    storiesDeleted: deleted.count,
    storiesBefore,
    message: `Reset complete (${scope}). ${materialsBefore} materials unlinked, ${deleted.count} stories deleted. Each user's next "Group Stories" will re-group with the improved matcher.`,
  })
}
