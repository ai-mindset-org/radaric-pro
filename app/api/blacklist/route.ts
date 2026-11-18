import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { z } from "zod"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"

const blacklistItemSchema = z.object({
  term: z.string().min(1, "Term cannot be empty"),
  matchType: z.enum(["EXACT", "CONTAINS", "REGEX"]),
})

export async function GET() {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId } = authResult

    const items = await db.blacklistItem.findMany({
      where: { userId },
      orderBy: {
        createdAt: "desc",
      },
    })

    return NextResponse.json(items)
  } catch (error) {
    console.error("Error fetching blacklist:", error)
    return NextResponse.json(
      { error: "Failed to fetch blacklist" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const body = await request.json()
    const validatedData = blacklistItemSchema.parse(body)

    const item = await db.blacklistItem.create({
      data: {
        userId,
        ...validatedData,
      },
    })

    return NextResponse.json(item)
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message || "Validation error" },
        { status: 400 }
      )
    }

    console.error("Error creating blacklist item:", error)
    return NextResponse.json(
      { error: "Failed to create blacklist item" },
      { status: 500 }
    )
  }
}
