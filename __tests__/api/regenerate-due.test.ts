/**
 * POST /api/collections/regenerate-due — the secret-auth manual trigger for the
 * worker's self-filling freshness sweep (Slice 4). Disabled unless the shared
 * secret is configured; runs the sweep only with the right Bearer token.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/saved/subscription", () => ({
  sweepDueCollections: vi.fn(async () => ({ regenerated: 2, considered: 4 })),
}))

import { POST } from "@/app/api/collections/regenerate-due/route"
import { sweepDueCollections } from "@/lib/saved/subscription"

const sweep = sweepDueCollections as ReturnType<typeof vi.fn>

function req(headers: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NextRequest is structurally a Request here
  return new Request("http://localhost/api/collections/regenerate-due", { method: "POST", headers }) as any
}

describe("POST /api/collections/regenerate-due", () => {
  const orig = process.env.WORKER_TRIGGER_SECRET
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    if (orig === undefined) delete process.env.WORKER_TRIGGER_SECRET
    else process.env.WORKER_TRIGGER_SECRET = orig
  })

  it("404s (disabled) when the secret isn't configured", async () => {
    delete process.env.WORKER_TRIGGER_SECRET
    const res = await POST(req({ authorization: "Bearer anything" }))
    expect(res.status).toBe(404)
    expect(sweep).not.toHaveBeenCalled()
  })

  it("401s on a wrong/absent secret", async () => {
    process.env.WORKER_TRIGGER_SECRET = "s3cret"
    expect((await POST(req({ authorization: "Bearer nope" }))).status).toBe(401)
    expect((await POST(req())).status).toBe(401)
    expect(sweep).not.toHaveBeenCalled()
  })

  it("runs the sweep with the right secret (returns only {ok, regenerated})", async () => {
    process.env.WORKER_TRIGGER_SECRET = "s3cret"
    const res = await POST(req({ authorization: "Bearer s3cret" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, regenerated: 2 }) // no cross-tenant `considered`
    expect(sweep).toHaveBeenCalledTimes(1)
  })
})
