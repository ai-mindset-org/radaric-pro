import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { requestStopForUser } from "@/lib/parse-runs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Stop the user's running parse (RAD-346). The run belongs to the server now, so
 * closing the browser's transport is no longer enough: this sets the flag the
 * route's task wrapper reads before starting each source. `stopped: false` means
 * there was nothing running — never that the request failed.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return NextResponse.json({ stopped: requestStopForUser(session.user.id) })
}
