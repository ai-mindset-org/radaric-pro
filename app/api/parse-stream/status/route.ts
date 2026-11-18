import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { getRunSnapshot } from "@/lib/parse-runs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The run a detached card polls until it settles (RAD-346). Additive to the SSE
 * endpoint: no rate limit and no subscription gate — reading the user's own run
 * costs nothing and a card that cannot read it can never finish.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // `no-store` stated here, not left to `force-dynamic`: a CDN or reverse
  // proxy in front of the app rewrites both `Vary` and `Cache-Control`, so a
  // cached snapshot could keep a finished run looking `running` (or, worse,
  // show one account's counters to another). Same reasoning as
  // `app/api/health/route.ts`.
  return NextResponse.json(
    { run: getRunSnapshot(session.user.id) },
    { headers: { "cache-control": "no-store, must-revalidate" } }
  )
}
