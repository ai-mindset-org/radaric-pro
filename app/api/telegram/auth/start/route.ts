import { NextRequest, NextResponse } from "next/server"
import { startTelegramAuth } from "@/lib/parsers/telegram"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"

// POST /api/telegram/auth/start - Start Telegram authentication (ADMIN only)
export async function POST(request: NextRequest) {
  // Only admins can manage Telegram authentication
  const authResult = await requireAdmin()
  if (isErrorResponse(authResult)) return authResult

  try {
    const { phoneNumber } = await request.json()

    if (!phoneNumber) {
      return NextResponse.json(
        { error: "Phone number is required" },
        { status: 400 }
      )
    }

    // Validate phone number format (basic validation)
    if (!/^\+?\d{10,15}$/.test(phoneNumber.replace(/[\s-]/g, ""))) {
      return NextResponse.json(
        { error: "Invalid phone number format. Use international format (e.g., +1234567890)" },
        { status: 400 }
      )
    }

    const result = await startTelegramAuth(phoneNumber)

    return NextResponse.json({
      success: true,
      phoneCodeHash: result.phoneCodeHash,
      sessionString: result.sessionString,
      message: `Code sent to ${phoneNumber}`,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[TELEGRAM AUTH START ERROR]:", error)

    return NextResponse.json(
      {
        error: "Failed to start Telegram authentication",
        details: errorMessage,
      },
      { status: 500 }
    )
  }
}
