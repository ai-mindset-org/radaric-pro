/**
 * GET /api/admin/dashboard — Admin dashboard data endpoint
 *
 * Tests: auth guard (rejects non-admin), data shape, aggregation logic, the
 * per-user paid-subscription view, and referral-trial recognition (RAD-419).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    user: { findMany: vi.fn() },
    feed: { findMany: vi.fn() },
    material: { groupBy: vi.fn() },
    aIFeedback: { groupBy: vi.fn() },
  },
}))

// Deterministic prices so planFromPriceId resolves against fixtures, never
// against unset env. Mirrors __tests__/entitlements.test.ts.
vi.mock("@/lib/stripe", () => ({
  STRIPE_PRICES: {
    pro_monthly: "price_pro_m",
    pro_yearly: "price_pro_y",
    lite_monthly: "price_lite_m",
    lite_yearly: "price_lite_y",
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import { GET } from "@/app/api/admin/dashboard/route"

const ADMIN_ID = "admin-1"

// Shape of a row in the JSON response (asserted field by field below).
type SubscriptionPayload = {
  state: string
  status: string
  tier: string | null
  interval: string | null
  currentPeriodEnd: string
  cancelAtPeriodEnd: boolean
  canceledAt: string | null
  createdAt: string
  stripeSubscriptionId: string
}

type UserPayload = {
  username: string
  feeds: {
    rss: number
    telegram: number
    twitter: number
    youtube: number
    interest: number
    total: number
    active: number
    error: number
  }
  materials: number
  feedbackCount: number
  lastParsedAt: string | null
  subscription: SubscriptionPayload | null
  complimentaryAccessUntil: string | null
  launchTrial: boolean
}

type DashboardPayload = {
  users: UserPayload[]
  totals: {
    users: number
    feeds: number
    materials: number
    feedback: number
    subscribers: number
    referralTrials: number
    referralTrialsActive: number
  }
}

function setupAdmin() {
  vi.mocked(requireAdmin).mockResolvedValue({ userId: ADMIN_ID, role: "ADMIN" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupNonAdmin() {
  const errorResponse = NextResponse.json({ error: "Forbidden" }, { status: 403 })
  vi.mocked(requireAdmin).mockResolvedValue(errorResponse)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function user(data: DashboardPayload, username: string): UserPayload {
  const found = data.users.find(u => u.username === username)
  if (!found) throw new Error(`user ${username} missing from the payload`)
  return found
}

// FAR_FUTURE keeps the subscription window open against the route's real
// `new Date()` clock. Eight users cover: granting Pro (alice), no row (bob),
// CANCELED with an untouched future period end (carol), unmapped legacy price
// on a real Stripe row (dave), a scripts' legacy comp row (erin), a running
// referral trial (frank), an ended referral trial (gina) and a manual comp (hank).
const FAR_FUTURE = new Date("2099-01-01T00:00:00Z")
const DAY_MS = 86_400_000
// The referral trial is written as createdAt + 7 days in the same create (#210).
const FRANK_CREATED = new Date(Date.now() - DAY_MS)
const GINA_CREATED = new Date("2026-09-01T12:00:00Z")

function subFixture(overrides: Record<string, unknown> = {}) {
  return {
    status: "ACTIVE",
    stripePriceId: "price_pro_m",
    currentPeriodEnd: FAR_FUTURE,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
    stripeSubscriptionId: "sub_1",
    ...overrides,
  }
}

const MOCK_USERS = [
  { id: "user-1", username: "alice", name: "Alice", email: "alice@test.com", role: "ADMIN", isActive: true, createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-03-01"), subscription: subFixture({ stripeSubscriptionId: "sub_pro_1" }) },
  { id: "user-2", username: "bob", name: "Bob", email: null, role: "USER", isActive: true, createdAt: new Date("2026-03-15"), updatedAt: new Date("2026-03-15"), subscription: null },
  { id: "user-3", username: "carol", name: null, email: null, role: "USER", isActive: true, createdAt: new Date("2026-02-10"), updatedAt: new Date("2026-02-10"), subscription: subFixture({ status: "CANCELED", canceledAt: new Date("2026-04-02T00:00:00Z"), stripeSubscriptionId: "sub_canceled_1" }) },
  { id: "user-4", username: "dave", name: null, email: null, role: "USER", isActive: true, createdAt: new Date("2026-02-01"), updatedAt: new Date("2026-02-01"), subscription: subFixture({ stripePriceId: "price_legacy_unknown", stripeSubscriptionId: "sub_legacy_1" }) },
  { id: "user-5", username: "erin", name: null, email: null, role: "USER", isActive: true, createdAt: new Date("2026-01-20"), updatedAt: new Date("2026-01-20"), subscription: subFixture({ stripePriceId: "comp_gift", stripeSubscriptionId: "comp_gift_1" }) },
  { id: "user-6", username: "frank", name: null, email: null, role: "USER", isActive: true, createdAt: FRANK_CREATED, updatedAt: FRANK_CREATED, complimentaryAccessUntil: new Date(FRANK_CREATED.getTime() + 7 * DAY_MS), subscription: null },
  { id: "user-7", username: "gina", name: null, email: null, role: "USER", isActive: true, createdAt: GINA_CREATED, updatedAt: GINA_CREATED, complimentaryAccessUntil: new Date(GINA_CREATED.getTime() + 7 * DAY_MS), subscription: null },
  { id: "user-8", username: "hank", name: null, email: null, role: "USER", isActive: true, createdAt: new Date("2026-01-10"), updatedAt: new Date("2026-01-10"), complimentaryAccessUntil: new Date(Date.now() + 30 * DAY_MS), subscription: null },
]

const MOCK_FEEDS = [
  { id: "feed-1", userId: "user-1", type: "TELEGRAM", status: "ACTIVE", lastParsedAt: new Date("2026-03-30T10:00:00Z") },
  { id: "feed-2", userId: "user-1", type: "RSS", status: "ACTIVE", lastParsedAt: new Date("2026-03-30T09:00:00Z") },
  { id: "feed-3", userId: "user-1", type: "TELEGRAM", status: "ERROR", lastParsedAt: null },
  { id: "feed-4", userId: "user-2", type: "TELEGRAM", status: "ACTIVE", lastParsedAt: new Date("2026-03-29T12:00:00Z") },
  { id: "feed-5", userId: "user-2", type: "TELEGRAM", status: "ACTIVE", lastParsedAt: null },
]

const MOCK_MATERIAL_COUNTS = [
  { sourceId: "feed-1", _count: { id: 120 } },
  { sourceId: "feed-2", _count: { id: 45 } },
  { sourceId: "feed-4", _count: { id: 30 } },
]

const MOCK_FEEDBACK_COUNTS = [
  { userId: "user-1", _count: { id: 25 } },
]

function setupData() {
  vi.mocked(db.user.findMany).mockResolvedValue(MOCK_USERS as never)
  vi.mocked(db.feed.findMany).mockResolvedValue(MOCK_FEEDS as never)
  vi.mocked(db.material.groupBy).mockResolvedValue(MOCK_MATERIAL_COUNTS as never)
  vi.mocked(db.aIFeedback.groupBy).mockResolvedValue(MOCK_FEEDBACK_COUNTS as never)
}

beforeEach(() => vi.clearAllMocks())

describe("GET /api/admin/dashboard", () => {
  it("returns 403 for non-admin users", async () => {
    setupNonAdmin()
    const res = await GET()
    expect(res.status).toBe(403)
  })

  it("returns totals with correct aggregation", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(data.totals).toEqual({
      users: 8,
      feeds: 5,
      materials: 195, // 120 + 45 + 30
      feedback: 25,
      subscribers: 2, // alice (Pro) + dave (real Stripe id, unmapped price) — carol CANCELED, erin (comp_gift, not a Stripe sub), the trials and the manual comp do not count
      referralTrials: 2, // frank (running) + gina (ended) — hank's manual comp is not a referral trial
      referralTrialsActive: 1, // frank
    })
  })

  it("returns per-user feed breakdown by type", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "alice").feeds).toEqual({
      rss: 1,
      telegram: 2,
      twitter: 0,
      youtube: 0,
      interest: 0,
      total: 3,
      active: 2,
      error: 1,
    })
  })

  it("aggregates materials from all user feeds", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "alice").materials).toBe(165) // feed-1: 120 + feed-2: 45
    expect(user(data, "bob").materials).toBe(30)
  })

  it("tracks feedback count per user", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "alice").feedbackCount).toBe(25)
    expect(user(data, "bob").feedbackCount).toBe(0)
  })

  it("picks latest lastParsedAt across user feeds", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "alice").lastParsedAt).toBe("2026-03-30T10:00:00.000Z")
  })

  it("returns null lastParsedAt when no feeds parsed", async () => {
    setupAdmin()
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "user-3", username: "charlie", name: null, email: null, role: "USER", isActive: true, createdAt: new Date(), updatedAt: new Date(), subscription: null },
    ] as never)
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.material.groupBy).mockResolvedValue([] as never)
    vi.mocked(db.aIFeedback.groupBy).mockResolvedValue([] as never)

    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(data.users[0].lastParsedAt).toBeNull()
    expect(data.users[0].feeds.total).toBe(0)
    expect(data.users[0].subscription).toBeNull()
  })

  it("derives the subscription view per user (state, tier, interval, stripe id, ISO dates)", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "alice").subscription).toEqual({
      state: "active",
      status: "ACTIVE",
      tier: "pro",
      interval: "monthly",
      currentPeriodEnd: "2099-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      canceledAt: null,
      createdAt: "2026-02-01T00:00:00.000Z",
      stripeSubscriptionId: "sub_pro_1",
    })

    expect(user(data, "bob").subscription).toBeNull()
  })

  it("classifies CANCELED with an untouched future period end as lapsed", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    const carol = user(data, "carol")
    expect(carol.subscription?.state).toBe("lapsed")
    expect(carol.subscription?.status).toBe("CANCELED")
    expect(carol.subscription?.canceledAt).toBe("2026-04-02T00:00:00.000Z")
  })

  it("an unmapped legacy price still counts as granting, with tier null", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    expect(user(data, "dave").subscription).toMatchObject({
      state: "active",
      tier: null,
      interval: null,
    })
  })

  it("a scripts' legacy comp row passes through as a payload but is not a subscriber", async () => {
    setupAdmin()
    setupData()
    const res = await GET()
    const data = (await res.json()) as DashboardPayload

    // The raw row is still surfaced (state is timing-only), so the client can
    // render the muted "Legacy comp" badge — but the count must not include it.
    expect(user(data, "erin").subscription).toMatchObject({
      state: "active",
      tier: null,
      stripeSubscriptionId: "comp_gift_1",
    })
    expect(data.totals.subscribers).toBe(2)
  })
})

describe("GET /api/admin/dashboard — referral trials (RAD-419)", () => {
  it("flags referral-trial accounts and only them", async () => {
    setupAdmin()
    setupData()
    const data = (await (await GET()).json()) as DashboardPayload

    expect(user(data, "frank").launchTrial).toBe(true)
    expect(user(data, "gina").launchTrial).toBe(true)
    expect(user(data, "hank").launchTrial).toBe(false)
    for (const name of ["alice", "bob", "carol", "dave", "erin"]) {
      expect(user(data, name).launchTrial).toBe(false)
    }
    expect(user(data, "frank").complimentaryAccessUntil).toBe(
      new Date(FRANK_CREATED.getTime() + 7 * DAY_MS).toISOString()
    )
  })

  it("a referral trial is never a subscriber", async () => {
    setupAdmin()
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "t1", username: "trial", name: null, email: null, role: "USER", isActive: true, createdAt: FRANK_CREATED, updatedAt: FRANK_CREATED, complimentaryAccessUntil: new Date(FRANK_CREATED.getTime() + 7 * DAY_MS), subscription: null },
    ] as never)
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.material.groupBy).mockResolvedValue([] as never)
    vi.mocked(db.aIFeedback.groupBy).mockResolvedValue([] as never)

    const data = (await (await GET()).json()) as DashboardPayload
    expect(data.totals).toMatchObject({ subscribers: 0, referralTrials: 1, referralTrialsActive: 1 })
  })

  it("a trial account that subscribed counts once as a subscriber and stays a PH trial", async () => {
    setupAdmin()
    vi.mocked(db.user.findMany).mockResolvedValue([
      { id: "t2", username: "converted", name: null, email: null, role: "USER", isActive: true, createdAt: GINA_CREATED, updatedAt: GINA_CREATED, complimentaryAccessUntil: new Date(GINA_CREATED.getTime() + 7 * DAY_MS), subscription: subFixture({ stripePriceId: "price_lite_m", stripeSubscriptionId: "sub_lite_9" }) },
    ] as never)
    vi.mocked(db.feed.findMany).mockResolvedValue([])
    vi.mocked(db.material.groupBy).mockResolvedValue([] as never)
    vi.mocked(db.aIFeedback.groupBy).mockResolvedValue([] as never)

    const data = (await (await GET()).json()) as DashboardPayload
    expect(data.totals).toMatchObject({ subscribers: 1, referralTrials: 1, referralTrialsActive: 0 })
  })
})
