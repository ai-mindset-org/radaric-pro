/**
 * GET /api/subscription/status — subscription status endpoint
 *
 * Tests: auth guard, onboarding grace, no-sub user, active sub,
 * canceled sub, date serialization, admin override, DB query shape.
 * RAD-148
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
  },
}))

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { requireAuth } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { GET } from "@/app/api/subscription/status/route"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(): Request {
  return new Request("http://localhost/api/subscription/status", { method: "GET" })
}

function makeUserRow(overrides: {
  role?: "USER" | "ADMIN"
  userSettings?: { onboardingCompleted: boolean } | null
  subscription?: {
    status: SubscriptionStatus
    currentPeriodEnd: Date
    cancelAtPeriodEnd: boolean
  } | null
  createdAt?: Date
} = {}) {
  return {
    id: "user_123",
    email: "test@example.com",
    role: overrides.role ?? "USER",
    // RAD-294: feeds the bounded onboarding demo grant. 3h before NOW_REF, i.e.
    // inside the window, so AC-2 below still asserts what it was written to.
    createdAt: overrides.createdAt ?? new Date("2026-05-01T09:00:00.000Z"),
    userSettings: overrides.userSettings ?? { onboardingCompleted: true },
    subscription: overrides.subscription ?? null,
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Pin "now" so date-relative cases (AC-4's future currentPeriodEnd) stay
// deterministic — otherwise the suite rots the moment real time passes the
// hardcoded fixture date.
const NOW_REF = new Date("2026-05-01T12:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_REF)
  vi.mocked(requireAuth).mockResolvedValue({ userId: "user_123", role: "USER" })
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/subscription/status", () => {
  // -------------------------------------------------------------------------
  // AC-1: auth guard
  // -------------------------------------------------------------------------
  it("AC-1: when requireAuth returns a Response (unauthenticated), returns that response without touching DB", async () => {
    const errorResponse = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    vi.mocked(requireAuth).mockResolvedValue(errorResponse as never)

    const res = await GET(makeRequest())

    expect(res).toBe(errorResponse)
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC-2: onboarding grace — no subscription + onboarding not completed
  // -------------------------------------------------------------------------
  it("AC-2: no subscription + onboardingCompleted=false returns hasActiveAccess:true with null status fields (onboarding grace)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({ userSettings: { onboardingCompleted: false }, subscription: null }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      hasActiveAccess: true,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
  })

  // -------------------------------------------------------------------------
  // AC-3: no subscription + onboarding completed → no access
  // -------------------------------------------------------------------------
  it("AC-3: no subscription + onboardingCompleted=true + role USER returns hasActiveAccess:false with null status fields", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({ userSettings: { onboardingCompleted: true }, subscription: null }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      hasActiveAccess: false,
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    })
  })

  // -------------------------------------------------------------------------
  // AC-4: ACTIVE subscription → hasActiveAccess:true + serialized fields
  // AC-6 (implicit): currentPeriodEnd is an ISO string, cancelAtPeriodEnd is boolean
  // -------------------------------------------------------------------------
  it("AC-4: ACTIVE subscription with future currentPeriodEnd returns hasActiveAccess:true and ISO date string", async () => {
    // Relative far-future date so the "active access" assertion can't rot as
    // wall-clock advances past a hardcoded literal (was "2026-06-01").
    const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({
        subscription: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
        },
      }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      hasActiveAccess: true,
      status: "ACTIVE",
      currentPeriodEnd: periodEnd.toISOString(),
      cancelAtPeriodEnd: false,
    })
  })

  // -------------------------------------------------------------------------
  // AC-5: CANCELED subscription → hasActiveAccess:false + serialized fields
  // AC-6 (implicit): cancelAtPeriodEnd boolean preserved
  // -------------------------------------------------------------------------
  it("AC-5: CANCELED subscription returns hasActiveAccess:false with ISO currentPeriodEnd and boolean cancelAtPeriodEnd", async () => {
    const periodEnd = new Date("2026-05-15T00:00:00.000Z")
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({
        subscription: {
          status: SubscriptionStatus.CANCELED,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: true,
        },
      }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({
      hasActiveAccess: false,
      status: "CANCELED",
      currentPeriodEnd: "2026-05-15T00:00:00.000Z",
      cancelAtPeriodEnd: true,
    })
  })

  // -------------------------------------------------------------------------
  // AC-7a: ADMIN + null subscription → hasActiveAccess:true regardless
  // -------------------------------------------------------------------------
  it("AC-7a: ADMIN role with no subscription returns hasActiveAccess:true (admin override)", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user_123", role: "ADMIN" })
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({ role: "ADMIN", subscription: null }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.hasActiveAccess).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC-7b: ADMIN + CANCELED subscription → hasActiveAccess:true regardless
  // -------------------------------------------------------------------------
  it("AC-7b: ADMIN role with CANCELED subscription returns hasActiveAccess:true (admin override)", async () => {
    const periodEnd = new Date("2026-04-01T00:00:00.000Z")
    vi.mocked(requireAuth).mockResolvedValue({ userId: "user_123", role: "ADMIN" })
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({
        role: "ADMIN",
        subscription: {
          status: SubscriptionStatus.CANCELED,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
        },
      }) as never,
    )

    const res = await GET(makeRequest())

    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.hasActiveAccess).toBe(true)
  })

  // -------------------------------------------------------------------------
  // AC-8: DB query uses correct include directive
  // -------------------------------------------------------------------------
  it("AC-8: calls db.user.findUnique with include: { userSettings: true, subscription: true }", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUserRow() as never)

    await GET(makeRequest())

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { userSettings: true, subscription: true },
      }),
    )
  })
})
