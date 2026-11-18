import { NextRequest, NextResponse } from "next/server"
import { verifyTelegramCode } from "@/lib/parsers/telegram"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"

// POST /api/telegram/auth/verify - Verify Telegram code (ADMIN only)
export async function POST(request: NextRequest) {
  // Only admins can manage Telegram authentication
  const authResult = await requireAdmin()
  if (isErrorResponse(authResult)) return authResult

  try {
    const { phoneNumber, phoneCode, phoneCodeHash, sessionString, password } = await request.json()

    if (!phoneNumber || !phoneCode || !phoneCodeHash || !sessionString) {
      return NextResponse.json(
        { error: "Phone number, code, code hash, and session string are required" },
        { status: 400 }
      )
    }

    const result = await verifyTelegramCode(
      phoneNumber,
      phoneCode,
      phoneCodeHash,
      sessionString,
      password
    )

    return NextResponse.json({
      success: true,
      message: "Telegram authentication successful",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error("[TELEGRAM AUTH VERIFY ERROR]:", error)

    // Check for specific error types
    if (errorMessage.includes("PHONE_CODE_INVALID")) {
      return NextResponse.json(
        {
          error: "Invalid code",
          details: "The code you entered is incorrect. Please try again.",
        },
        { status: 400 }
      )
    }

    if (errorMessage.includes("PHONE_CODE_EXPIRED")) {
      return NextResponse.json(
        {
          error: "Code expired",
          details: "The code has expired. Please request a new one.",
        },
        { status: 400 }
      )
    }

    if (errorMessage.includes("SESSION_PASSWORD_NEEDED")) {
      return NextResponse.json(
        {
          error: "2FA required",
          details: "Two-factor authentication is enabled. Please provide your password.",
          requiresPassword: true,
        },
        { status: 400 }
      )
    }

    return NextResponse.json(
      {
        error: "Failed to verify Telegram code",
        details: errorMessage,
      },
      { status: 500 }
    )
  }
}
