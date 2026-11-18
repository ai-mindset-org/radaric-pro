import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Never prerendered, never cached: the entire point of this route is to describe
// the deployment answering *right now*.
export const dynamic = 'force-dynamic'

export async function GET() {
  // Deployment identity: which build actually answered. `||` not `??` — an env var
  // set to an empty string must read as absent, and `null` must never become "" or
  // "unknown", or a SHA comparison degrades into comparing a constant with itself.
  // Release verification compares this SHA against the commit it expects — see
  // docs/DEPLOYMENT.md.
  const deployment = {
    sha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
  }

  // Refuse caching at the origin. `force-dynamic` does NOT emit a no-store header,
  // and a CDN in front of the instance would otherwise edge-cache this: its rule
  // covers `/api/*` exactly as it covers documents, so this route is not exempt
  // from it. Without this header that single rule is the only thing between a
  // verifier and a cached answer.
  const headers = { 'cache-control': 'no-store, must-revalidate' }

  try {
    await db.$queryRaw`SELECT 1`
    return NextResponse.json({ status: 'ok', ...deployment }, { headers })
  } catch {
    // Report identity on the failure path too — a 500 is exactly when you need to
    // know which build is answering.
    return NextResponse.json({ status: 'error', ...deployment }, { status: 500, headers })
  }
}
