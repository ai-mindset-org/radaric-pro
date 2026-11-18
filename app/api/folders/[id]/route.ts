import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { folderBodySchema, folderNameLower, isUniqueConflict } from "@/lib/validations/folder"

/** PATCH /api/folders/[id] — rename a folder (RAD-393). Ownership-scoped. */
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
    const parsed = folderBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid folder name" }, { status: 400 })
    }
    const name = parsed.data.name
    const nameLower = folderNameLower(name)

    const folder = await db.folder.findUnique({
      where: { id, userId },
      select: { id: true, nameLower: true },
    })
    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }

    // Only check for a clash when the uniqueness key actually changes — renaming
    // "Design" → "design" must not collide with itself.
    if (folder.nameLower !== nameLower) {
      const clash = await db.folder.findFirst({
        where: { userId, nameLower, NOT: { id } },
        select: { id: true },
      })
      if (clash) {
        return NextResponse.json(
          { error: "A folder with this name already exists" },
          { status: 409 }
        )
      }
    }

    const updated = await db.folder.update({
      where: { id },
      data: { name, nameLower },
      select: { id: true, name: true },
    })

    revalidatePath("/", "layout")

    return NextResponse.json({ folder: updated })
  } catch (error) {
    if (isUniqueConflict(error)) {
      return NextResponse.json(
        { error: "A folder with this name already exists" },
        { status: 409 }
      )
    }
    console.error("Error renaming folder:", error)
    return NextResponse.json({ error: "Failed to rename folder" }, { status: 500 })
  }
}

/**
 * DELETE /api/folders/[id] — delete a folder (RAD-393).
 * Its sources survive: the FK is ON DELETE SET NULL, returning them to
 * Uncategorized. Nothing is cascaded.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const { id } = await params
    const folder = await db.folder.findUnique({
      where: { id, userId },
      select: { id: true },
    })
    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }

    await db.folder.delete({ where: { id } })

    revalidatePath("/", "layout")

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("Error deleting folder:", error)
    return NextResponse.json({ error: "Failed to delete folder" }, { status: 500 })
  }
}
