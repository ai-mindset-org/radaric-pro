/**
 * POST /api/collections/[id]/refresh — the on-demand "check for updates" pull for
 * a tracked question. Pulls the backing monitor's latest events via Parallel,
 * ingests new material, then regenerates the living answer when something changed
 * (or it was never generated). Self-filling only; gated; ownership-checked.
 *
 * The autonomous path is cadence-push only (Parallel → webhook); this manual
 * pull is how a user verifies on demand, so the wiring here is what matters:
 * gate → own → tracked-only → parse → conditional regenerate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(async () => ({ userId: "u1", role: "USER" })),
  isErrorResponse: (r: unknown) => r instanceof NextResponse,
}))
vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn(async () => null),
}))
vi.mock("@/lib/db", () => ({
  db: { collection: { findFirst: vi.fn() } },
}))
vi.mock("@/lib/parsers/interest", () => ({
  parseInterestSource: vi.fn(async () => ({ created: 0, skipped: 0, total: 0, materials: [] })),
}))
vi.mock("@/lib/saved/synthesis", () => ({
  regenerateSynthesis: vi.fn(async () => ({ status: "ok" })),
}))

import { POST } from "@/app/api/collections/[id]/refresh/route"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { db } from "@/lib/db"
import { parseInterestSource } from "@/lib/parsers/interest"
import { regenerateSynthesis } from "@/lib/saved/synthesis"

const mAuth = requireAuth as ReturnType<typeof vi.fn>
const mGate = requireActiveSubscription as ReturnType<typeof vi.fn>
const mFind = db.collection.findFirst as ReturnType<typeof vi.fn>
const mParse = parseInterestSource as ReturnType<typeof vi.fn>
const mSynth = regenerateSynthesis as ReturnType<typeof vi.fn>

// Each test uses a fresh collection id so the in-memory cooldown never collides.
let n = 0
function req() {
  return new Request("http://localhost/api/collections/c/refresh", { method: "POST" }) as never
}
function ctx(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe("POST /api/collections/[id]/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mAuth.mockResolvedValue({ userId: "u1", role: "USER" })
    mGate.mockResolvedValue(null)
    mParse.mockResolvedValue({ created: 0, skipped: 0, total: 0, materials: [] })
    mSynth.mockResolvedValue({ status: "ok" })
  })

  it("401s when unauthenticated (passes the auth error response through)", async () => {
    void isErrorResponse
    mAuth.mockResolvedValue(NextResponse.json({ error: "no" }, { status: 401 }))
    const res = await POST(req(), ctx(`a${n++}`))
    expect(res.status).toBe(401)
    expect(mParse).not.toHaveBeenCalled()
  })

  it("402s when the subscription gate blocks (no pull)", async () => {
    mGate.mockResolvedValue(NextResponse.json({ error: "pay" }, { status: 402 }))
    const res = await POST(req(), ctx(`a${n++}`))
    expect(res.status).toBe(402)
    expect(mParse).not.toHaveBeenCalled()
  })

  it("404s when the collection isn't owned by the user", async () => {
    mFind.mockResolvedValue(null)
    const res = await POST(req(), ctx(`a${n++}`))
    expect(res.status).toBe(404)
    expect(mParse).not.toHaveBeenCalled()
  })

  it("400s for a non-tracked collection (no backing monitor)", async () => {
    const id = `a${n++}`
    mFind.mockResolvedValue({ id, monitorFeedId: null, synthesisUpdatedAt: new Date() })
    const res = await POST(req(), ctx(id))
    expect(res.status).toBe(400)
    expect(mParse).not.toHaveBeenCalled()
  })

  it("pulls and regenerates when new material arrives", async () => {
    const id = `pull${n++}`
    mFind.mockResolvedValue({ id, monitorFeedId: "feed1", synthesisUpdatedAt: new Date() })
    mParse.mockResolvedValue({ created: 3, skipped: 1, total: 4, materials: [] })
    const res = await POST(req(), ctx(id))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fetched: 4, created: 3, skipped: 1, synthesisStatus: "ok" })
    expect(mParse).toHaveBeenCalledWith("feed1", "u1")
    expect(mSynth).toHaveBeenCalledWith("u1", id)
  })

  it("bootstraps the first answer even when nothing new arrived (synth never run)", async () => {
    const id = `boot${n++}`
    mFind.mockResolvedValue({ id, monitorFeedId: "feed1", synthesisUpdatedAt: null })
    mParse.mockResolvedValue({ created: 0, skipped: 0, total: 0, materials: [] })
    const res = await POST(req(), ctx(id))
    expect(res.status).toBe(200)
    expect((await res.json()).synthesisStatus).toBe("ok")
    expect(mSynth).toHaveBeenCalledTimes(1)
  })

  it("skips the paid synthesis when nothing new and an answer already exists", async () => {
    const id = `skip${n++}`
    mFind.mockResolvedValue({ id, monitorFeedId: "feed1", synthesisUpdatedAt: new Date() })
    mParse.mockResolvedValue({ created: 0, skipped: 2, total: 2, materials: [] })
    const res = await POST(req(), ctx(id))
    expect(res.status).toBe(200)
    expect((await res.json()).synthesisStatus).toBeNull()
    expect(mSynth).not.toHaveBeenCalled()
  })

  it("surfaces a parse failure (500) without burning the cooldown", async () => {
    const id = `throw${n++}`
    mFind.mockResolvedValue({ id, monitorFeedId: "feed1", synthesisUpdatedAt: new Date() })
    mParse.mockRejectedValueOnce(new Error("Failed to fetch monitor events: 404"))
    const first = await POST(req(), ctx(id))
    expect(first.status).toBe(500)
    // cooldown must NOT be set on failure — a follow-up retry should reach the parse again
    mParse.mockResolvedValue({ created: 0, skipped: 0, total: 0, materials: [] })
    const second = await POST(req(), ctx(id))
    expect(second.status).toBe(200)
    expect(mParse).toHaveBeenCalledTimes(2)
  })

  it("cooldowns a rapid re-fire for the same collection (429, no second pull)", async () => {
    const id = `cooldown${n++}`
    mFind.mockResolvedValue({ id: "c", monitorFeedId: "feed1", synthesisUpdatedAt: new Date() })
    mParse.mockResolvedValue({ created: 1, skipped: 0, total: 1, materials: [] })
    const first = await POST(req(), ctx(id))
    expect(first.status).toBe(200)
    const second = await POST(req(), ctx(id))
    expect(second.status).toBe(429)
    expect((await second.json()).code).toBe("COOLDOWN")
    expect(mParse).toHaveBeenCalledTimes(1)
  })
})

// RAD-297: the AI routes under test now require a verified email; these tests
// exercise the work BEHIND the gate. The gate itself is covered in
// __tests__/email-verification.test.ts and __tests__/api/email-verification-routes.test.ts.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
