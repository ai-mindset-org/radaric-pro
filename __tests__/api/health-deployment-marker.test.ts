/**
 * GET /api/health — deployment identity, not just liveness.
 *
 * Liveness alone cannot distinguish "the new build is live" from "the old one
 * is still serving 200": without a build marker — a meta tag in the HTML or a
 * field here — a release is unverifiable, and an unverifiable release is one
 * you cannot walk back. This endpoint reports which deployment answered so a
 * verifier can compare the SHA against the commit it expects.
 *
 * The DB probe is unchanged and still owns the status code.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: vi.fn() },
}))

import { db } from "@/lib/db"
import { GET } from "@/app/api/health/route"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const DEPLOY_ID = "d3adbeef-0000-4444-8888-feedfacecafe"

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // stubEnv snapshots and restores rather than deleting: running the suite
    // where the real values are set (e.g. inside the deployed container) would
    // otherwise destroy them instead of putting them back.
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", SHA)
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", DEPLOY_ID)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("reports the commit SHA of the deployment that answered", async () => {
    vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }])

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.status).toBe("ok")
    expect(body.sha).toBe(SHA)
    expect(body.deploymentId).toBe(DEPLOY_ID)
  })

  it("still reports the deployment identity when the DB probe fails", async () => {
    // A 500 is exactly when you most need to know WHICH build is answering —
    // reporting liveness only on the happy path would hide a bad deploy behind
    // the very failure it caused.
    vi.mocked(db.$queryRaw).mockRejectedValue(new Error("connection refused"))

    const res = await GET()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.status).toBe("error")
    expect(body.sha).toBe(SHA)
  })

  it("returns null rather than a fabricated value when Railway sets no SHA", async () => {
    // Local dev and any non-Railway host. `null` is honest and lets a verifier
    // fail closed; an empty string or "unknown" would compare equal to itself
    // and silently pass a SHA-match check.
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", undefined)
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", undefined)
    vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }])

    const body = await (await GET()).json()

    expect(body.sha).toBeNull()
    expect(body.deploymentId).toBeNull()
  })

  it("treats an EMPTY env var as absent, not as a SHA", async () => {
    // Trivially produced by an empty value in the Railway dashboard or a bare
    // `export RAILWAY_GIT_COMMIT_SHA=`. `??` would have let "" through.
    vi.stubEnv("RAILWAY_GIT_COMMIT_SHA", "")
    vi.stubEnv("RAILWAY_DEPLOYMENT_ID", "")
    vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }])

    const body = await (await GET()).json()

    expect(body.sha).toBeNull()
    expect(body.deploymentId).toBeNull()
  })

  it("refuses caching, so a verifier cannot be served a stale answer", async () => {
    // The public host is CDN-fronted and the origin sends no cache-control of
    // its own, so a CDN edge rule would be the only protection. force-dynamic
    // does not emit this header — the route must.
    vi.mocked(db.$queryRaw).mockResolvedValue([{ "?column?": 1 }])
    const res = await GET()
    expect(res.headers.get("cache-control")).toMatch(/no-store/)
  })
})
