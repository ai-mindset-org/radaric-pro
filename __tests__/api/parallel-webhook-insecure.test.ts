// @vitest-environment node

/**
 * RAD-289 — the Parallel webhook must never process an unverified payload.
 *
 * The handler used to skip signature verification whenever
 * `NODE_ENV !== "production"`. That is an attack recipe the day the source is
 * public, and a trap for self-hosters running a non-standard NODE_ENV. These
 * tests pin the replacement contract:
 *
 *  - no secret configured → 503 and NO processing, in every NODE_ENV;
 *  - the only escape hatch is the explicit, loud `PARALLEL_WEBHOOK_INSECURE=1`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn() },
    feed: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}))

vi.mock("@/lib/subscription", () => ({
  resolveAccessWithReason: vi.fn(async () => ({ allowed: true })),
}))

vi.mock("@/lib/parsers/interest", () => ({
  processParallelEvent: vi.fn(async () => ({ created: 1, skipped: 0 })),
}))

import { db } from "@/lib/db"
import { processParallelEvent } from "@/lib/parsers/interest"
import { POST } from "@/app/api/webhooks/parallel/route"

const mockDb = db as unknown as {
  settings: { findFirst: ReturnType<typeof vi.fn> }
  feed: { findFirst: ReturnType<typeof vi.fn> }
  user: { findUnique: ReturnType<typeof vi.fn> }
}
const processEvent = processParallelEvent as ReturnType<typeof vi.fn>

const BODY = JSON.stringify({
  event_type: "monitor.event.detected",
  monitor_id: "m1",
  event_group_id: "g1",
})

function signedRequest(): Request {
  return new Request("http://localhost/api/webhooks/parallel", { method: "POST", body: BODY })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mockDb.settings.findFirst.mockResolvedValue({})
  mockDb.feed.findFirst.mockResolvedValue({
    id: "f1",
    name: "Feed",
    isActive: true,
    userId: "u1",
    parallelMonitorId: "m1",
  })
  // RAD-297: the access gate also requires a verified email; inside the 24h
  // demo window with a verified address the owner is allowed through.
  mockDb.user.findUnique.mockResolvedValue({
    id: "u1",
    role: "USER",
    isActive: true,
    createdAt: new Date(),
    emailVerified: new Date(),
    complimentaryAccessUntil: null,
    userSettings: { onboardingCompleted: false },
    subscription: null,
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("Parallel webhook — unverified payloads are never processed (RAD-289)", () => {
  it("rejects with 503 when no secret is configured (test env)", async () => {
    const res = await POST(signedRequest() as never)

    expect(res.status).toBe(503)
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("rejects with 503 when no secret is configured, even under NODE_ENV=production", async () => {
    vi.stubEnv("NODE_ENV", "production")

    const res = await POST(signedRequest() as never)

    expect(res.status).toBe(503)
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("processes ONLY with the explicit insecure override, and says so loudly", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_INSECURE", "1")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const res = await POST(signedRequest() as never)

    expect(res.status).toBe(200)
    expect(processEvent).toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("INSECURE"))
    warn.mockRestore()
  })

  it("rejects a bad signature when a secret IS configured", async () => {
    mockDb.settings.findFirst.mockResolvedValue({ parallelWebhookSecret: "s3cret" })

    const res = await POST(signedRequest() as never)

    expect(res.status).toBe(401)
    expect(processEvent).not.toHaveBeenCalled()
  })
})
