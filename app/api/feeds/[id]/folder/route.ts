import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { folderMoveBodySchema } from "@/lib/validations/folder"

/**
 * PATCH /api/feeds/[id]/folder — move a source into a folder, or out of every
 * folder (`folderId: null`) (RAD-393).
 *
 * Deliberately NOT part of PATCH /api/feeds/[id]: that route is the
 * monitor/Telegram/YouTube pipeline with a compare-and-swap guard, and a folder
 * move is a single-column write that must never run any of it.
 *
 * Hidden backing feeds (self-filling collection monitors) are rejected like a
 * missing feed — they are unreachable in the sidebar and un-fileable by design.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { id } = await params
    const body = await request.json().catch(() => null)
    const parsed = folderMoveBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid folder id" }, { status: 400 })
    }
    const folderId = parsed.data.folderId

    const feed = await db.feed.findUnique({
      where: { id, userId },
      select: { id: true, hidden: true },
    })
    if (!feed || feed.hidden) {
      return NextResponse.json({ error: "Feed not found" }, { status: 404 })
    }

    if (folderId) {
      const folder = await db.folder.findUnique({
        where: { id: folderId, userId },
        select: { id: true },
      })
      if (!folder) {
        return NextResponse.json({ error: "Folder not found" }, { status: 404 })
      }
    }

    const updated = await db.feed.update({
      where: { id },
      data: { folderId },
      select: { id: true, folderId: true },
    })

    revalidatePath("/", "layout")

    return NextResponse.json({ feed: updated })
  } catch (error) {
    console.error("Error moving feed to folder:", error)
    return NextResponse.json({ error: "Failed to move feed" }, { status: 500 })
  }
}
