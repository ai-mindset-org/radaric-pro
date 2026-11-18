import { NextRequest, NextResponse } from "next/server"
import { timingSafeEqual } from "node:crypto"
import { sweepDueCollections } from "@/lib/saved/subscription"

export const dynamic = "force-dynamic"

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(`Bearer ${expected}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

// POST /api/collections/regenerate-due — manual/ops trigger for the worker's
// self-filling freshness sweep (regenerate tracked answers that are due via the
// trailing-edge debounce or the cadence freshness floor). NOT a cron: the
// long-running worker already runs this every SELF_FILLING_SWEEP_INTERVAL_MS.
// This shared-secret entry point only exists so ops/tests can fire it on demand.
// Disabled (404) unless WORKER_TRIGGER_SECRET is configured. NOTE: it's
// whitelisted in proxy.ts (auth middleware) since callers use the secret, not a
// session — without that exemption the middleware would 307-redirect it to login.
export async function POST(request: NextRequest) {
  const secret = process.env.WORKER_TRIGGER_SECRET
  if (!secret) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  if (!secretMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    // The per-sweep regen cap (SWEEP_MAX_REGENS) bounds the work even here.
    const { regenerated } = await sweepDueCollections()
    return NextResponse.json({ ok: true, regenerated })
  } catch (error) {
    console.error("Error running regenerate-due sweep:", error)
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 })
  }
}
