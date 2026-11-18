// @vitest-environment node

/**
 * RAD-323 — background spend paths must respect the access gates.
 *
 * The Parallel webhook, the worker's routing pass and the self-filling sweep
 * spend real money (Parallel API + LLM) with no session to trust. They
 * previously checked only `user.isActive`, so an account armed inside its 24h
 * demo window — or a cancelled subscriber — kept driving spend indefinitely.
 * These tests pin:
 *
 *  1. the webhook skips processing (200 "ignored") when the owner has no access,
 *     and asks Parallel to retry (503) when access could not be determined;
 *  2. the sweep skips the paid regen for lapsed owners;
 *  3. reconcileMonitorsForAccess pauses monitors of lapsed owners (marking the
 *     feed accessPaused), never acts on an unknown lookup, and re-arms ONLY
 *     lapse-paused feeds once access returns — with a compare-and-swap write and
 *     a monitor rollback, so a paid monitor is never orphaned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "node:crypto"

vi.mock("@/lib/db", () => ({
  db: {
    settings: { findFirst: vi.fn() },
    feed: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    collection: { findMany: vi.fn(), updateMany: vi.fn() },
    material: { count: vi.fn() },
    collectionMaterial: { count: vi.fn() },
    savedItem: { count: vi.fn() },
  },
}))

vi.mock("@/lib/subscription", () => ({
  hasAccessForUserId: vi.fn(),
  resolveAccessWithReason: vi.fn(),
}))

vi.mock("@/lib/parsers/interest", () => ({
  processParallelEvent: vi.fn(),
  createParallelMonitor: vi.fn(),
  deleteParallelMonitor: vi.fn(),
  buildWebhookUrl: vi.fn(() => "https://radaric.pro/api/webhooks/parallel"),
}))

vi.mock("@/lib/saved/synthesis", () => ({
  regenerateSynthesis: vi.fn(),
}))

import { db } from "@/lib/db"
import { hasAccessForUserId, resolveAccessWithReason } from "@/lib/subscription"
import {
  processParallelEvent,
  createParallelMonitor,
  deleteParallelMonitor,
} from "@/lib/parsers/interest"
import { regenerateSynthesis } from "@/lib/saved/synthesis"
import { POST as parallelWebhook } from "@/app/api/webhooks/parallel/route"
import { sweepDueCollections, reconcileMonitorsForAccess } from "@/lib/saved/subscription"

const mockDb = db as unknown as {
  settings: { findFirst: ReturnType<typeof vi.fn> }
  feed: {
    findFirst: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
  }
  user: { findUnique: ReturnType<typeof vi.fn> }
  collection: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> }
  material: { count: ReturnType<typeof vi.fn> }
  collectionMaterial: { count: ReturnType<typeof vi.fn> }
  savedItem: { count: ReturnType<typeof vi.fn> }
}
const access = hasAccessForUserId as ReturnType<typeof vi.fn>
const resolve = resolveAccessWithReason as ReturnType<typeof vi.fn>
const processEvent = processParallelEvent as ReturnType<typeof vi.fn>
const createMonitor = createParallelMonitor as ReturnType<typeof vi.fn>
const deleteMonitor = deleteParallelMonitor as ReturnType<typeof vi.fn>
const regenerate = regenerateSynthesis as ReturnType<typeof vi.fn>

const SECRET = "test_webhook_secret"
const WEBHOOK_ID = "msg_2abc"
const WEBHOOK_TS = "1700000000"

function signedParallelRequest(body: string): Request {
  const sig = crypto.createHmac("sha256", SECRET).update(`${WEBHOOK_ID}.${WEBHOOK_TS}.${body}`).digest("base64")
  return new Request("http://localhost/api/webhooks/parallel", {
    method: "POST",
    body,
    headers: {
      "webhook-id": WEBHOOK_ID,
      "webhook-timestamp": WEBHOOK_TS,
      "webhook-signature": `v1,${sig}`,
    },
  })
}

const EVENT_BODY = JSON.stringify({
  event_type: "monitor.event.detected",
  monitor_id: "mon-1",
  event_group_id: "grp-1",
})

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.settings.findFirst.mockResolvedValue({ parallelWebhookSecret: SECRET, parallelApiKey: "pk_live" })
  mockDb.feed.findFirst.mockResolvedValue({
    id: "feed-1",
    name: "Tracked question feed",
    isActive: true,
    userId: "user-lapsed",
    parallelMonitorId: "mon-1",
  })
  mockDb.collection.updateMany.mockResolvedValue({})
  mockDb.material.count.mockResolvedValue(0)
  mockDb.collectionMaterial.count.mockResolvedValue(0)
  mockDb.savedItem.count.mockResolvedValue(0)
})

describe("Parallel webhook — RAD-323 access gate", () => {
  it("skips processing and returns 200 ignored when the owner has no access", async () => {
    resolve.mockResolvedValue({ allowed: false, unverified: false })

    const res = await parallelWebhook(signedParallelRequest(EVENT_BODY) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ignored", reason: "access_inactive" })
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("asks Parallel to RETRY when the owner is merely unverified (RAD-297)", async () => {
    resolve.mockResolvedValue({ allowed: false, unverified: true })

    const res = await parallelWebhook(signedParallelRequest(EVENT_BODY) as never)

    expect(res.status).toBe(503)
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("processes the event when the owner has access", async () => {
    resolve.mockResolvedValue({ allowed: true })
    processEvent.mockResolvedValue({ created: 1, skipped: 0 })

    const res = await parallelWebhook(signedParallelRequest(EVENT_BODY) as never)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", created: 1, skipped: 0 })
    expect(processEvent).toHaveBeenCalledWith("feed-1", "grp-1", "user-lapsed")
  })

  it("returns 503 retryable when access could not be determined (DB error)", async () => {
    resolve.mockRejectedValue(new Error("connection refused"))

    const res = await parallelWebhook(signedParallelRequest(EVENT_BODY) as never)

    expect(res.status).toBe(503)
    expect(processEvent).not.toHaveBeenCalled()
  })

  it("still rejects a bad signature before any access check", async () => {
    resolve.mockResolvedValue({ allowed: true })

    const res = await parallelWebhook(
      new Request("http://localhost/api/webhooks/parallel", {
        method: "POST",
        body: EVENT_BODY,
        headers: { "webhook-id": WEBHOOK_ID, "webhook-timestamp": WEBHOOK_TS, "webhook-signature": "v1,bogus" },
      }) as never
    )

    expect(res.status).toBe(401)
    expect(processEvent).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })
})

describe("sweepDueCollections — RAD-323 access gate", () => {
  const dueCollection = {
    id: "col-1",
    userId: "user-lapsed",
    autoSynthAt: new Date(Date.now() - 10 * 60_000),
    synthesisUpdatedAt: new Date(Date.now() - 60 * 60_000),
    cadence: "DAILY",
    monitorFeedId: null,
  }

  it("does not regenerate a due answer for a lapsed owner", async () => {
    mockDb.collection.findMany.mockResolvedValue([dueCollection])
    access.mockResolvedValue(false)

    const result = await sweepDueCollections()

    expect(regenerate).not.toHaveBeenCalled()
    expect(result.regenerated).toBe(0)
  })

  it("regenerates the due answer when the owner has access", async () => {
    mockDb.collection.findMany.mockResolvedValue([dueCollection])
    access.mockResolvedValue(true)
    regenerate.mockResolvedValue({ status: "ok", synthesis: "x", synthesisDelta: "", synthesisUpdatedAt: new Date(), sourceCount: 1 })

    const result = await sweepDueCollections()

    expect(regenerate).toHaveBeenCalledWith("user-lapsed", "col-1")
    expect(result.regenerated).toBe(1)
  })
})

describe("reconcileMonitorsForAccess — RAD-323", () => {
  it("pauses the monitor of a lapsed owner and marks the feed accessPaused", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-1",
        userId: "user-lapsed",
        isActive: true,
        hidden: true,
        parallelMonitorId: "mon-1",
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: { id: "col-1" },
      },
    ])
    resolve.mockResolvedValue({ allowed: false, unverified: false })
    deleteMonitor.mockResolvedValue(undefined)
    mockDb.feed.update.mockResolvedValue({})

    const result = await reconcileMonitorsForAccess()

    expect(deleteMonitor).toHaveBeenCalledWith("mon-1")
    expect(mockDb.feed.update).toHaveBeenCalledWith({
      where: { id: "feed-1" },
      data: { parallelMonitorId: null, isActive: false, accessPaused: true },
    })
    expect(result).toEqual({ paused: 1, resumed: 0 })
  })

  it("cleans a stale monitor of an already-paused feed WITHOUT arming auto-recovery", async () => {
    // A user pause whose monitor delete failed leaves isActive:false + a live
    // monitor id. Cleaning it up must not set accessPaused (that would restart
    // the feed behind the user's back once access returns).
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-stale",
        userId: "user-lapsed",
        isActive: false,
        hidden: false,
        parallelMonitorId: "mon-stale",
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: null,
      },
    ])
    resolve.mockResolvedValue({ allowed: false, unverified: false })
    deleteMonitor.mockResolvedValue(undefined)
    mockDb.feed.update.mockResolvedValue({})

    const result = await reconcileMonitorsForAccess()

    expect(deleteMonitor).toHaveBeenCalledWith("mon-stale")
    expect(mockDb.feed.update).toHaveBeenCalledWith({
      where: { id: "feed-stale" },
      data: { parallelMonitorId: null, isActive: false, accessPaused: false },
    })
    expect(result).toEqual({ paused: 1, resumed: 0 })
  })

  it("re-arms a lapse-paused tracked question once access returns (CAS write)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-2",
        userId: "user-active",
        isActive: false,
        hidden: true,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "WEEKLY",
        accessPaused: true,
        backedCollection: { id: "col-2" },
      },
    ])
    resolve.mockResolvedValue({ allowed: true })
    createMonitor.mockResolvedValue("mon-new")
    mockDb.feed.updateMany.mockResolvedValue({ count: 1 })

    const result = await reconcileMonitorsForAccess()

    expect(createMonitor).toHaveBeenCalledWith(
      { query: "EU AI Act enforcement", cadence: "weekly" },
      "https://radaric.pro/api/webhooks/parallel"
    )
    expect(mockDb.feed.updateMany).toHaveBeenCalledWith({
      where: { id: "feed-2", parallelMonitorId: null, accessPaused: true },
      data: { parallelMonitorId: "mon-new", isActive: true, accessPaused: false },
    })
    expect(result).toEqual({ paused: 0, resumed: 1 })
  })

  it("re-arms a lapse-paused VISIBLE feed too (recovery after resubscribe)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-visible",
        userId: "user-active",
        isActive: false,
        hidden: false,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: true,
        backedCollection: null,
      },
    ])
    resolve.mockResolvedValue({ allowed: true })
    createMonitor.mockResolvedValue("mon-visible")
    mockDb.feed.updateMany.mockResolvedValue({ count: 1 })

    const result = await reconcileMonitorsForAccess()

    expect(createMonitor).toHaveBeenCalled()
    expect(result.resumed).toBe(1)
  })

  it("does not re-arm an ORPHANED hidden backing feed", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-orphan",
        userId: "user-active",
        isActive: false,
        hidden: true,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: true,
        backedCollection: null,
      },
    ])
    resolve.mockResolvedValue({ allowed: true })

    const result = await reconcileMonitorsForAccess()

    expect(createMonitor).not.toHaveBeenCalled()
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })

  it("rolls back the created monitor when the CAS write loses (or the feed vanished)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-3",
        userId: "user-active",
        isActive: false,
        hidden: true,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: true,
        backedCollection: { id: "col-3" },
      },
    ])
    resolve.mockResolvedValue({ allowed: true })
    createMonitor.mockResolvedValue("mon-dup")
    mockDb.feed.updateMany.mockResolvedValue({ count: 0 })

    const result = await reconcileMonitorsForAccess()

    expect(deleteMonitor).toHaveBeenCalledWith("mon-dup")
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })

  it("does not re-arm a lapsed owner's tracked question", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-4",
        userId: "user-lapsed",
        isActive: false,
        hidden: true,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: true,
        backedCollection: { id: "col-4" },
      },
    ])
    resolve.mockResolvedValue({ allowed: false, unverified: false })

    const result = await reconcileMonitorsForAccess()

    expect(createMonitor).not.toHaveBeenCalled()
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })

  it("never re-arms a user-paused feed (no accessPaused flag)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-user-paused",
        userId: "user-active",
        isActive: false,
        hidden: false,
        parallelMonitorId: null,
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: null,
      },
    ])
    resolve.mockResolvedValue({ allowed: true })

    const result = await reconcileMonitorsForAccess()

    expect(createMonitor).not.toHaveBeenCalled()
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })

  it("pauses (recoverably) the monitor of an UNVERIFIED owner (RAD-297)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-uv",
        userId: "user-unverified",
        isActive: true,
        hidden: false,
        parallelMonitorId: "mon-uv",
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: null,
      },
    ])
    resolve.mockResolvedValue({ allowed: false, unverified: true })
    deleteMonitor.mockResolvedValue(undefined)
    mockDb.feed.update.mockResolvedValue({})

    const result = await reconcileMonitorsForAccess()

    // Paused with the flag set, so verifying re-arms it on a later tick — the
    // Parallel-side cost for never-verified accounts is bounded either way.
    expect(deleteMonitor).toHaveBeenCalledWith("mon-uv")
    expect(mockDb.feed.update).toHaveBeenCalledWith({
      where: { id: "feed-uv" },
      data: { parallelMonitorId: null, isActive: false, accessPaused: true },
    })
    expect(result).toEqual({ paused: 1, resumed: 0 })
  })

  it("never acts on an unknown access resolution (DB error)", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-5",
        userId: "user-blip",
        isActive: true,
        hidden: false,
        parallelMonitorId: "mon-5",
        interestQuery: "EU AI Act enforcement",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: null,
      },
    ])
    resolve.mockRejectedValue(new Error("statement timeout"))

    const result = await reconcileMonitorsForAccess()

    expect(deleteMonitor).not.toHaveBeenCalled()
    expect(createMonitor).not.toHaveBeenCalled()
    expect(mockDb.feed.update).not.toHaveBeenCalled()
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })

  it("skips ownerless system feeds without touching the access check", async () => {
    mockDb.feed.findMany.mockResolvedValue([
      {
        id: "feed-system",
        userId: null,
        isActive: true,
        hidden: false,
        parallelMonitorId: "mon-system",
        interestQuery: "System query",
        interestCadence: "DAILY",
        accessPaused: false,
        backedCollection: null,
      },
    ])

    const result = await reconcileMonitorsForAccess()

    expect(resolve).not.toHaveBeenCalled()
    expect(deleteMonitor).not.toHaveBeenCalled()
    expect(result).toEqual({ paused: 0, resumed: 0 })
  })
})
