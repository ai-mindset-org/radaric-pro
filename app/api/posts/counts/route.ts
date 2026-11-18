import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { countMaterialsForScope } from "@/lib/materials/material-counts"

// GET /api/posts/counts — the posts toolbar's counts, live (RAD-343).
//
// The heading, the view menu and the type menu render the same numbers the SSR
// page computes (countMaterialsForScope), refreshed as materials change: the
// client listens for `radaric:stats-changed` — fired by every mutation path and
// at the end of a run — and polls every 30s for changes made elsewhere.
// `?sourceId=` scopes the counts to one source, exactly as /feeds/[id] does;
// `?folderId=` scopes to a folder's visible member sources (/folders/[id]).
export async function GET(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const sourceId = request.nextUrl.searchParams.get("sourceId")
    const folderId = request.nextUrl.searchParams.get("folderId")
    if (sourceId) {
      // Ownership is the isolation boundary: a foreign id must look absent,
      // not leak another account's counts.
      const source = await db.feed.findFirst({
        where: { id: sourceId, userId },
        select: { id: true },
      })
      if (!source) return NextResponse.json({ error: "Source not found" }, { status: 404 })
    } else if (folderId) {
      const folder = await db.folder.findFirst({
        where: { id: folderId, userId },
        select: { id: true },
      })
      if (!folder) return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }

    const counts = await countMaterialsForScope({ userId, sourceId, folderId })
    return NextResponse.json(counts, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    console.error("[POST COUNTS ERROR]:", error)
    return NextResponse.json({ error: "Failed to fetch post counts" }, { status: 500 })
  }
}
