import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { AIEvaluation, MaterialStatus } from "@prisma/client"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"

// GET /api/stats - Get counts for materials and sources for current user
export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    // Base filter for user's sources. hidden:false excludes self-filling
    // collections' backing monitor feeds so these stats match the sidebar and
    // posts-page counts (which also exclude them).
    const userSourceFilter = {
      feed: {
        userId,
        hidden: false,
      },
    }

    // Get material counts
    const [
      totalMaterials,
      approvedMaterials,
      filteredMaterials,
      newMaterials,
      sentToNotionMaterials,
      archivedMaterials,
    ] = await Promise.all([
      // Total materials (excluding deleted)
      db.material.count({
        where: {
          ...userSourceFilter,
          userStatus: {
            not: MaterialStatus.DELETED,
          },
        },
      }),
      // Approved by AI (excluding deleted AND archived)
      db.material.count({
        where: {
          ...userSourceFilter,
          aiEvaluation: AIEvaluation.APPROVED,
          userStatus: {
            notIn: [MaterialStatus.DELETED, MaterialStatus.ARCHIVED],
          },
        },
      }),
      // Filtered by AI (excluding deleted AND archived)
      db.material.count({
        where: {
          ...userSourceFilter,
          aiEvaluation: AIEvaluation.FILTERED,
          userStatus: {
            notIn: [MaterialStatus.DELETED, MaterialStatus.ARCHIVED],
          },
        },
      }),
      // New materials
      db.material.count({
        where: {
          ...userSourceFilter,
          userStatus: MaterialStatus.NEW,
        },
      }),
      // Sent to Notion
      db.material.count({
        where: {
          ...userSourceFilter,
          userStatus: MaterialStatus.SENT_TO_NOTION,
        },
      }),
      // Archived materials
      db.material.count({
        where: {
          ...userSourceFilter,
          userStatus: MaterialStatus.ARCHIVED,
        },
      }),
    ])

    // Get source counts
    const [totalSources, activeSources, errorSources, inboxGroups] = await Promise.all([
      db.feed.count({
        where: { userId, hidden: false },
      }),
      db.feed.count({
        where: {
          userId,
          isActive: true,
          hidden: false,
        },
      }),
      db.feed.count({
        where: {
          userId,
          status: "ERROR",
          hidden: false,
        },
      }),
      // Per-source Inbox count (AI-approved, not archived/deleted) — same
      // predicate as the posts-page Inbox filter and the SSR sidebar count
      // (both exclude hidden backing feeds).
      db.material.groupBy({
        by: ["sourceId"],
        where: {
          feed: { userId, isActive: true, hidden: false },
          aiEvaluation: AIEvaluation.APPROVED,
          userStatus: { notIn: [MaterialStatus.DELETED, MaterialStatus.ARCHIVED] },
        },
        _count: { _all: true },
      }),
    ])

    const inboxBySource: Record<string, number> = {}
    for (const g of inboxGroups) inboxBySource[g.sourceId] = g._count._all

    return NextResponse.json({
      materials: {
        total: totalMaterials,
        approved: approvedMaterials,
        filtered: filteredMaterials,
        new: newMaterials,
        sentToNotion: sentToNotionMaterials,
        archived: archivedMaterials,
      },
      feeds: {
        total: totalSources,
        active: activeSources,
        errorCount: errorSources,
      },
      inboxBySource,
    })
  } catch (error) {
    console.error("[STATS ERROR]:", error)
    return NextResponse.json(
      {
        error: "Failed to fetch stats",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
