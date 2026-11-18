/**
 * Route-level subscription-gate wiring (RAD-223 B5).
 *
 * F7 (`subscription-gate-matrix.test.ts`) proves the `requireActiveSubscription`
 * wrapper returns the right code for every (role × onboarding × status) combo.
 * This file proves the three remaining `requireAuth`-only write routes actually
 * WIRE that gate up — i.e. a curl from an authenticated-but-unsubscribed user
 * gets 402 and the expensive downstream work never runs.
 *
 * Routes under test (the genuine gap — the other candidates,
 * `PUT /api/settings` and `/api/telegram/auth/{start,verify}`, are already
 * `requireAdmin` and so are not a non-paying-user bypass vector):
 *   - POST /api/settings/test-notion   (Notion test — Pro feature)
 *   - POST /api/stories/poll           (runs the AI pipeline — expensive)
 *   - POST /api/stories/retention      (per-user data write)
 *
 * For each route we assert BOTH directions:
 *   block → returns the gate's 402 and downstream stays untouched
 *   allow → gate returns null, route proceeds and downstream runs
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

// ---------------------------------------------------------------------------
// Mocks — hoisted before route imports
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(() => false),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: { findUnique: vi.fn() },
    inboxItem: { findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    story: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  },
}))

vi.mock("@/lib/notion", () => ({
  testNotionConnection: vi.fn(),
}))

vi.mock("@/lib/story-aggregator/stories-api", () => ({
  pollStories: vi.fn(),
}))

vi.mock("@/lib/story-aggregator/pipeline", () => ({
  processInboxItem: vi.fn(),
}))

vi.mock("@/lib/story-aggregator/pipeline-deps", () => ({
  buildPipelineDeps: vi.fn(),
}))

vi.mock("@/lib/story-aggregator/data-retention", () => ({
  runRetention: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { requireAuth } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { testNotionConnection } from "@/lib/notion"
import { pollStories } from "@/lib/story-aggregator/stories-api"
import { buildPipelineDeps } from "@/lib/story-aggregator/pipeline-deps"
import { runRetention } from "@/lib/story-aggregator/data-retention"
import { db } from "@/lib/db"

import { POST as testNotionPOST } from "@/app/api/settings/test-notion/route"
import { POST as pollPOST } from "@/app/api/stories/poll/route"
import { POST as retentionPOST } from "@/app/api/stories/retention/route"

const USER_ID = "user_gate_test"
const ROLE = "USER"

function blockResponse() {
  return NextResponse.json(
    { error: "Subscription required", code: "SUBSCRIPTION_REQUIRED" },
    { status: 402 },
  )
}

function notionRequest() {
  return new Request("http://localhost/api/settings/test-notion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "secret_x", databaseId: "db_y" }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: ROLE })
})

// ---------------------------------------------------------------------------
// Each route: block path + allow path + gate called with (userId, role)
// ---------------------------------------------------------------------------

describe("POST /api/settings/test-notion — subscription gate", () => {
  it("blocks unsubscribed user with 402 and never calls Notion", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(blockResponse())

    const res = await testNotionPOST(notionRequest())

    expect(res.status).toBe(402)
    expect(await res.json()).toEqual({
      error: "Subscription required",
      code: "SUBSCRIPTION_REQUIRED",
    })
    expect(requireActiveSubscription).toHaveBeenCalledWith(USER_ID, ROLE)
    expect(testNotionConnection).not.toHaveBeenCalled()
  })

  it("allows subscribed user (gate returns null) and runs the Notion test", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(null)
    vi.mocked(testNotionConnection).mockResolvedValue({ databaseName: "My DB" } as never)

    const res = await testNotionPOST(notionRequest())

    expect(res.status).toBe(200)
    expect(testNotionConnection).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/stories/poll — subscription gate", () => {
  it("blocks unsubscribed user with 402 and never polls stories", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(blockResponse())

    const res = await pollPOST()

    expect(res.status).toBe(402)
    expect(requireActiveSubscription).toHaveBeenCalledWith(USER_ID, ROLE)
    expect(pollStories).not.toHaveBeenCalled()
    expect(buildPipelineDeps).not.toHaveBeenCalled()
  })

  it("allows subscribed user and runs the poll", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(null)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ notionToken: "" } as never)
    vi.mocked(buildPipelineDeps).mockResolvedValue({} as never)
    vi.mocked(pollStories).mockResolvedValue({ created: 0, processed: 0 } as never)

    const res = await pollPOST()

    expect(res.status).toBe(200)
    expect(pollStories).toHaveBeenCalledTimes(1)
  })
})

describe("POST /api/stories/retention — subscription gate", () => {
  it("blocks unsubscribed user with 402 and never runs retention", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(blockResponse())

    const res = await retentionPOST()

    expect(res.status).toBe(402)
    expect(requireActiveSubscription).toHaveBeenCalledWith(USER_ID, ROLE)
    expect(runRetention).not.toHaveBeenCalled()
  })

  it("allows subscribed user and runs retention", async () => {
    vi.mocked(requireActiveSubscription).mockResolvedValue(null)
    vi.mocked(runRetention).mockResolvedValue({ deleted: 0 } as never)

    const res = await retentionPOST()

    expect(res.status).toBe(200)
    expect(runRetention).toHaveBeenCalledTimes(1)
  })
})

// RAD-297: the AI routes under test now require a verified email; these tests
// exercise the work BEHIND the gate. The gate itself is covered in
// __tests__/email-verification.test.ts and __tests__/api/email-verification-routes.test.ts.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
