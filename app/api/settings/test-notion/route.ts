import { NextResponse } from "next/server"
import { testNotionConnection } from "@/lib/notion"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { openNotionToken } from "@/lib/notion-token"

export async function POST(request: Request) {
  try {
    const authResult = await requireAuth()
    if (isErrorResponse(authResult)) return authResult
    const { userId, role } = authResult

    const gate = await requireActiveSubscription(userId, role)
    if (gate) return gate

    const body = await request.json()
    const { databaseId } = body
    // RAD-380: the form no longer holds the saved token. Without a typed one,
    // test the token saved for this user, opened on the server (RAD-221).
    let token: string | null = typeof body.token === "string" && body.token.trim() ? body.token.trim() : null
    if (!token) {
      const saved = await db.userSettings.findUnique({ where: { userId }, select: { notionToken: true } })
      token = saved?.notionToken ? openNotionToken(saved.notionToken, userId) : null
    }

    if (!token || !databaseId) {
      return NextResponse.json(
        { error: "Token and database ID are required" },
        { status: 400 }
      )
    }

    const result = await testNotionConnection(token, databaseId)

    return NextResponse.json({
      success: true,
      databaseName: result.databaseName
    })
  } catch (error) {
    console.error("Error testing Notion connection:", error)
    return NextResponse.json(
      { error: "Failed to test Notion connection" },
      { status: 500 }
    )
  }
}
