// @vitest-environment node

/**
 * RAD-397 — the Parallel monitor webhook must understand BOTH payload
 * envelopes.
 *
 * Parallel migrated deliveries to the Standard Webhooks envelope
 * `{ type, timestamp, data: { monitor_id, event: { event_group_id } } }`.
 * The handler only accepted the pre-migration flat shape
 * `{ event_type, monitor_id, event_group_id }`, so every post-migration
 * delivery answered `400 Invalid payload structure` and autonomous collection
 * silently stopped on prod (found 2026-10-07: Parallel-side events existed,
 * the DB had no materials for them).
 *
 * Also pins the dual signature scheme: Standard Webhooks (whsec_ stripped +
 * base64-decoded key) and the legacy raw-secret key, both of which Parallel
 * has live for different accounts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import crypto from "node:crypto"

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
import {
  POST,
  normalizeParallelPayload,
  verifyWebhookSignature,
} from "@/app/api/webhooks/parallel/route"

const mockDb = db as unknown as {
  settings: { findFirst: ReturnType<typeof vi.fn> }
  feed: { findFirst: ReturnType<typeof vi.fn> }
  user: { findUnique: ReturnType<typeof vi.fn> }
}
const processEvent = processParallelEvent as ReturnType<typeof vi.fn>

const MONITOR = "monitor_0c9d7f7d5a7841a0b6c269b2b9b1e6aa"
const GROUP = "mevtgrp_b0079f70195e4258eab1e7284340f1a9ec3a8033ed236a24"

/** The exact shape from docs.parallel.ai/monitor-api/monitor-webhooks. */
const STANDARD_BODY = JSON.stringify({
  type: "monitor.event.detected",
  timestamp: "2025-10-27T14:56:05.619331Z",
  data: {
    monitor_id: MONITOR,
    event: { event_group_id: GROUP },
    metadata: { team: "research" },
  },
})

const LEGACY_BODY = JSON.stringify({
  event_type: "monitor.event.detected",
  monitor_id: MONITOR,
  event_group_id: GROUP,
})

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks/parallel", {
    method: "POST",
    body,
    headers,
  })
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
    parallelMonitorId: MONITOR,
  })
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

describe("normalizeParallelPayload", () => {
  it("reads the Standard Webhooks envelope", () => {
    expect(normalizeParallelPayload(JSON.parse(STANDARD_BODY))).toEqual({
      eventType: "monitor.event.detected",
      monitorId: MONITOR,
      eventGroupId: GROUP,
    })
  })

  it("still reads the legacy flat envelope", () => {
    expect(normalizeParallelPayload(JSON.parse(LEGACY_BODY))).toEqual({
      eventType: "monitor.event.detected",
      monitorId: MONITOR,
      eventGroupId: GROUP,
    })
  })

  it("tolerates event_group_id directly under data (envelope variants)", () => {
    expect(
      normalizeParallelPayload({
        type: "monitor.event.detected",
        data: { monitor_id: MONITOR, event_group_id: GROUP },
      })
    ).toEqual({ eventType: "monitor.event.detected", monitorId: MONITOR, eventGroupId: GROUP })
  })

  it("returns null for a payload with no event type", () => {
    expect(normalizeParallelPayload({ foo: "bar" })).toBeNull()
    expect(normalizeParallelPayload(null)).toBeNull()
    expect(normalizeParallelPayload("string")).toBeNull()
  })
})

describe("POST /api/webhooks/parallel — envelope acceptance (RAD-397)", () => {
  it("processes a Standard Webhooks envelope (insecure override)", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_INSECURE", "1")

    const res = await POST(request(STANDARD_BODY) as never)

    expect(res.status).toBe(200)
    expect(processEvent).toHaveBeenCalledWith("f1", GROUP, "u1")
  })

  it("still processes the legacy flat envelope", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_INSECURE", "1")

    const res = await POST(request(LEGACY_BODY) as never)

    expect(res.status).toBe(200)
    expect(processEvent).toHaveBeenCalledWith("f1", GROUP, "u1")
  })

  it("rejects a monitor event missing the event group with 400", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_INSECURE", "1")

    const res = await POST(
      request(
        JSON.stringify({ type: "monitor.event.detected", data: { monitor_id: MONITOR } })
      ) as never
    )

    expect(res.status).toBe(400)
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("ignores monitor.execution.completed with 200 — never 400 (Parallel retries non-2xx)", async () => {
    vi.stubEnv("PARALLEL_WEBHOOK_INSECURE", "1")

    const body = JSON.stringify({
      type: "monitor.execution.completed",
      timestamp: "2025-10-27T14:56:05.619331Z",
      data: {
        monitor_id: MONITOR,
        event: { type: "completion", monitor_ts: "completed_2025-01-15T10:30:00Z" },
      },
    })

    const res = await POST(request(body) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ignored", reason: "unknown_event_type" })
    expect(processEvent).not.toHaveBeenCalled()
  })
})

describe("verifyWebhookSignature — dual scheme (RAD-397)", () => {
  const ID = "msg_2abc"
  const TS = "1700000000"

  it("accepts a Standard Webhooks signature (whsec_ prefix, base64-decoded key)", () => {
    const key = Buffer.from("standard-key-material")
    const secret = `whsec_${key.toString("base64")}`
    const sig = crypto
      .createHmac("sha256", key)
      .update(`${ID}.${TS}.${STANDARD_BODY}`)
      .digest("base64")

    expect(verifyWebhookSignature(ID, TS, STANDARD_BODY, `v1,${sig}`, secret)).toBe(true)
  })

  it("still accepts the legacy raw-secret key", () => {
    const secret = "whsec_legacy-account-secret"
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${ID}.${TS}.${STANDARD_BODY}`)
      .digest("base64")

    expect(verifyWebhookSignature(ID, TS, STANDARD_BODY, `v1,${sig}`, secret)).toBe(true)
  })

  it("rejects a signature from neither scheme", () => {
    const sig = crypto
      .createHmac("sha256", "wrong-key")
      .update(`${ID}.${TS}.${STANDARD_BODY}`)
      .digest("base64")

    expect(verifyWebhookSignature(ID, TS, STANDARD_BODY, `v1,${sig}`, "whsec_c2VjcmV0")).toBe(false)
  })
})
