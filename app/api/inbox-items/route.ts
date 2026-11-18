import { NextRequest, NextResponse } from "next/server"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { db } from "@/lib/db"

export async function GET(request: NextRequest) {
  const authResult = await requireAuth()
  if (isErrorResponse(authResult)) return authResult
  const { userId } = authResult

  const url = new URL(request.url)
  const status = url.searchParams.get("status") ?? undefined
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200)

  const where: Record<string, unknown> = { userId }
  if (status) where.status = status

  const items = await db.inboxItem.findMany({
    where: where as never,
    select: {
      id: true,
      externalId: true,
      rawText: true,
      extractedUrl: true,
      extractedTitle: true,
      status: true,
      errorMessage: true,
      retryCount: true,
      createdAt: true,
      storyId: true,
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  })

  return NextResponse.json({ items })
}
