import { auth } from "./auth"
import { NextResponse } from "next/server"

/**
 * Get current user ID from session
 * Throws error if not authenticated
 */
export async function getCurrentUserId(): Promise<string> {
  const session = await auth()
  if (!session?.user?.id) {
    throw new Error("Unauthorized")
  }
  return session.user.id
}

/**
 * Get current user ID, returns null if not authenticated
 */
export async function getCurrentUserIdOrNull(): Promise<string | null> {
  const session = await auth()
  return session?.user?.id || null
}

/**
 * Check if current user is admin
 */
export async function isAdmin(): Promise<boolean> {
  const session = await auth()
  return session?.user?.role === "ADMIN"
}

/**
 * Get current user role
 */
export async function getCurrentUserRole(): Promise<string | null> {
  const session = await auth()
  return session?.user?.role || null
}

/**
 * Require authentication - returns error response if not authenticated
 */
export async function requireAuth(): Promise<{ userId: string; role: string } | NextResponse> {
  const session = await auth()

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    )
  }

  return {
    userId: session.user.id,
    role: session.user.role || "USER",
  }
}

/**
 * Require admin role - returns error response if not admin
 */
export async function requireAdmin(): Promise<{ userId: string; role: string } | NextResponse> {
  const session = await auth()

  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    )
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Forbidden: Admin access required" },
      { status: 403 }
    )
  }

  return {
    userId: session.user.id,
    role: "ADMIN",
  }
}

/**
 * Type guard to check if result is an error response
 */
export function isErrorResponse(result: { userId: string; role: string } | NextResponse): result is NextResponse {
  return result instanceof NextResponse
}
