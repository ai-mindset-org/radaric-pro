import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"

// GET /api/materials - Get all materials for current user with filters
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const searchParams = request.nextUrl.searchParams
    const sourceId = searchParams.get("sourceId")
    const folderId = searchParams.get("folderId")
    const aiEvaluation = searchParams.get("aiEvaluation")
    const userStatus = searchParams.get("userStatus")
    const filter = searchParams.get("filter") // FilterType preset (INBOX, APPROVED, etc.)
    const sourceType = searchParams.get("sourceType") // Source type filter (RSS, TELEGRAM, etc.)
    const search = searchParams.get("search")
    const limit = Math.min(Math.max(parseInt(searchParams.get("limit") || "50") || 50, 1), 500)
    const offset = Math.max(parseInt(searchParams.get("offset") || "0") || 0, 0)

    // hidden:false excludes self-filling collections' backing monitor feeds —
    // their material belongs to the tracked-question answer, not the triage feed.
    // An explicitly requested source is exempt: /feeds/[id] for a hidden monitor
    // feed must show its posts (SSR already scopes by id without the filter).
    // A folder (RAD-393) scopes to its visible, active members — the sidebar
    // tree is what the user organized, so an invisible source contributes
    // nothing there. Both params together intersect: the source must be one of
    // the folder's visible members, never a way to read outside the folder.
    // userId stays in every case: it is what isolates the caller.
    const feedScope = sourceId
      ? folderId
        ? { userId, id: sourceId, folderId, hidden: false, isActive: true }
        : { userId }
      : folderId
        ? { userId, folderId, hidden: false, isActive: true }
        : { userId, hidden: false }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic Prisma where builder
    const where: any = {
      feed: feedScope,
    }

    // Server-side search — AND with source.userId for data isolation
    if (search) {
      where.AND = [
        { feed: feedScope },
        {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { content: { contains: search, mode: "insensitive" } },
            { feed: { name: { contains: search, mode: "insensitive" } } },
          ],
        },
      ]
    }

    if (sourceId) {
      where.sourceId = sourceId
    }

    // Filter preset — maps FilterType to Prisma where clauses (server-side filtering)
    if (filter) {
      switch (filter) {
        case "INBOX":
          where.aiEvaluation = "APPROVED"
          where.userStatus = { notIn: ["DELETED", "ARCHIVED"] }
          break
        case "APPROVED":
          where.aiEvaluation = "APPROVED"
          where.userStatus = { notIn: ["DELETED", "ARCHIVED"] }
          break
        case "FILTERED":
          where.aiEvaluation = "FILTERED"
          where.userStatus = { not: "DELETED" }
          break
        case "SENT_TO_NOTION":
          where.userStatus = "SENT_TO_STORIES"
          break
        case "ARCHIVED":
          where.userStatus = "ARCHIVED"
          break
        default: // "ALL"
          where.userStatus = { not: "DELETED" }
      }
    } else {
      // Legacy: individual params
      if (aiEvaluation) {
        where.aiEvaluation = aiEvaluation
      }
      if (userStatus) {
        if (userStatus === "ARCHIVED") {
          where.userStatus = "ARCHIVED"
        } else if (userStatus === "DELETED") {
          where.userStatus = { notIn: ["DELETED", "ARCHIVED"] }
        } else {
          where.userStatus = userStatus
        }
      } else {
        where.userStatus = { not: "DELETED" }
      }
    }

    // Source type filtering (supports comma-separated multi-select: "RSS,TELEGRAM")
    // Maps EVENT_TRIGGER → both values for compat (INTEREST pre-migration, EVENT_TRIGGER post-migration)
    if (sourceType && sourceType !== "ALL") {
      const types = sourceType.split(",").filter(Boolean)
      if (types.length > 0 && !types.includes("ALL")) {
        const dbTypes: string[] = []
        for (const t of types) {
          if (t === "EVENT_TRIGGER") {
            dbTypes.push("EVENT_TRIGGER", "INTEREST")
          } else {
            dbTypes.push(t)
          }
        }
        where.feed = { ...where.feed, type: { in: dbTypes } }
      }
    }

    const materialSelect = {
      id: true, title: true, url: true, content: true, contentEntities: true,
      publishedAt: true, thumbnailUrl: true, mediaUrls: true,
      aiEvaluation: true, aiConfidence: true, aiReasoning: true,
      userStatus: true, createdAt: true, updatedAt: true, storyId: true,
      feed: { select: { id: true, name: true, type: true } },
      story: { select: { id: true, title: true, summary: true, rubrics: true, sourceUrls: true, status: true, version: true, createdAt: true, _count: { select: { materials: true, inboxItems: true } } } },
      feedbacks: { where: { userId }, select: { feedbackType: true }, take: 1 },
    }

    async function runQuery() {
      return Promise.all([
        db.material.findMany({ where, select: materialSelect, orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }], take: limit, skip: offset }),
        db.material.count({ where }),
      ])
    }

    let materials, total
    try {
      ;[materials, total] = await runQuery()
    } catch (queryError) {
      // Fallback: EVENT_TRIGGER enum may not exist in DB yet — retry with INTEREST only
      if (where.feed?.type?.in) {
        where.feed.type.in = where.feed.type.in.filter((t: string) => t !== "EVENT_TRIGGER")
        ;[materials, total] = await runQuery()
      } else {
        throw queryError
      }
    }

    return NextResponse.json({
      materials,
      total,
      limit,
      offset,
    })
  } catch (error) {
    console.error("Error fetching materials:", error)
    return NextResponse.json(
      { error: "Failed to fetch materials" },
      { status: 500 }
    )
  }
}
