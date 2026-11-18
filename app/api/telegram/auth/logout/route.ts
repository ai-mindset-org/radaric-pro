import { NextResponse } from "next/server"
import { disconnectTelegram } from "@/lib/parsers/telegram"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"

// POST /api/telegram/auth/logout - Disconnect Telegram session (ADMIN only)
export async function POST() {
  // Only admins can manage Telegram authentication
  const authResult = await requireAdmin()
  if (isErrorResponse(authResult)) return authResult

  try {
    await disconnectTelegram()

    return NextResponse.json({
      success: true,
      message: "Disconnected from Telegram successfully",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[TELEGRAM AUTH LOGOUT ERROR]:", error)

    return NextResponse.json(
      {
        error: "Failed to disconnect from Telegram",
        details: errorMessage,
      },
      { status: 500 }
    )
  }
}
