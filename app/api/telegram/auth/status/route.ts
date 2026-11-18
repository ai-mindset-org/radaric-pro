import { NextResponse } from "next/server"
import { getTelegramSessionState } from "@/lib/parsers/telegram"
import { db } from "@/lib/db"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"

const MESSAGES: Record<string, string> = {
  active: "Telegram session is active",
  starting: "Telegram is connecting",
  invalid: "Telegram session is invalid or expired",
  unconfigured: "Not authenticated with Telegram",
  unknown: "Telegram status is unavailable",
}

// GET /api/telegram/auth/status - Check Telegram authentication status (ADMIN only)
export async function GET() {
  // Only admins can view Telegram authentication status
  const authResult = await requireAdmin()
  if (isErrorResponse(authResult)) return authResult

  try {
    const settings = await db.settings.findFirst()

    if (!settings?.telegramSessionString || !settings?.telegramPhoneNumber) {
      return NextResponse.json({
        authenticated: false,
        state: "unconfigured",
        message: MESSAGES.unconfigured,
      })
    }

    // Live check against the worker. `state` (RAD-328) tells the UI the
    // difference between "connecting", "session dead" and "worker unreachable";
    // `authenticated` is kept for existing consumers.
    const state = await getTelegramSessionState()

    return NextResponse.json({
      authenticated: state === "active",
      state,
      phoneNumber: settings.telegramPhoneNumber,
      message: MESSAGES[state],
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[TELEGRAM AUTH STATUS ERROR]:", error)

    return NextResponse.json(
      {
        error: "Failed to check Telegram authentication status",
        details: errorMessage,
      },
      { status: 500 }
    )
  }
}
