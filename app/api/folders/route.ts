import { NextRequest, NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { folderBodySchema, folderNameLower, isUniqueConflict } from "@/lib/validations/folder"

/**
 * POST /api/folders — create a sidebar source folder (RAD-393).
 *
 * Organizational, not a billed action: no subscription gate (the dashboard
 * already sits behind the paywall). `nameLower` is the DB-enforced
 * case-insensitive uniqueness key; the pre-check exists only to return a clean
 * 409, the unique index is what actually enforces it.
 */
export async function POST(request: NextRequest) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const body = await request.json().catch(() => null)
    const parsed = folderBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid folder name" }, { status: 400 })
    }
    const name = parsed.data.name
    const nameLower = folderNameLower(name)

    const existing = await db.folder.findFirst({
      where: { userId, nameLower },
      select: { id: true },
    })
    if (existing) {
      return NextResponse.json(
        { error: "A folder with this name already exists" },
        { status: 409 }
      )
    }

    const folder = await db.folder.create({
      data: { userId, name, nameLower },
      select: { id: true, name: true },
    })

    revalidatePath("/", "layout")

    return NextResponse.json({ folder }, { status: 201 })
  } catch (error) {
    if (isUniqueConflict(error)) {
      return NextResponse.json(
        { error: "A folder with this name already exists" },
        { status: 409 }
      )
    }
    console.error("Error creating folder:", error)
    return NextResponse.json({ error: "Failed to create folder" }, { status: 500 })
  }
}
