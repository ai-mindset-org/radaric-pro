// @vitest-environment node

/**
 * RAD-323 — the DB-backed access resolver used by background spend paths.
 *
 * The webhook, the routing pass and the sweep all depend on this primitive, and
 * it was previously mocked in every test that touched them — so a broken field
 * mapping or a removed catch (fail-open on DB error) would have left the whole
 * suite green. These tests drive the REAL implementation:
 *
 *  - `resolveAccessForUserId` mirrors `hasActiveAccess` inputs from a DB row;
 *  - `hasAccessForUserId` fails closed on missing/inactive users and DB errors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: vi.fn() } },
}))

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

import { db } from "@/lib/db"
import * as Sentry from "@sentry/nextjs"
import { hasAccessForUserId, resolveAccessForUserId } from "@/lib/subscription"

const mockUser = db.user.findUnique as ReturnType<typeof vi.fn>

const NOW = Date.now()

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    isActive: true,
    role: "USER",
    // RAD-297: background spend also requires a verified email; existing rows
    // are grandfathered by the migration, so the default here is verified.
    emailVerified: new Date(NOW - 60 * 60_000),
    createdAt: new Date(NOW - 60 * 60_000),
    complimentaryAccessUntil: null,
    userSettings: { onboardingCompleted: true },
    subscription: null,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("resolveAccessForUserId", () => {
  it("denies a missing user row", async () => {
    mockUser.mockResolvedValue(null)
    expect(await resolveAccessForUserId("ghost")).toBe(false)
  })

  it("denies a deactivated user even with an active subscription", async () => {
    mockUser.mockResolvedValue(
      userRow({
        isActive: false,
        subscription: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: new Date(NOW + 86_400_000),
          cancelAtPeriodEnd: false,
        },
      })
    )
    expect(await resolveAccessForUserId("user-1")).toBe(false)
  })

  it("grants ADMIN unconditionally", async () => {
    mockUser.mockResolvedValue(userRow({ role: "ADMIN" }))
    expect(await resolveAccessForUserId("user-1")).toBe(true)
  })

  it("grants an active subscription", async () => {
    mockUser.mockResolvedValue(
      userRow({
        subscription: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodEnd: new Date(NOW + 86_400_000),
          cancelAtPeriodEnd: false,
        },
      })
    )
    expect(await resolveAccessForUserId("user-1")).toBe(true)
  })

  it("grants the onboarding demo inside the 24h window and denies it after", async () => {
    mockUser.mockResolvedValue(userRow({ userSettings: { onboardingCompleted: false }, createdAt: new Date(NOW - 60 * 60_000) }))
    expect(await resolveAccessForUserId("user-1")).toBe(true)

    mockUser.mockResolvedValue(userRow({ userSettings: { onboardingCompleted: false }, createdAt: new Date(NOW - 30 * 60 * 60_000) }))
    expect(await resolveAccessForUserId("user-1")).toBe(false)
  })

  it("grants a future complimentary grant", async () => {
    mockUser.mockResolvedValue(userRow({ complimentaryAccessUntil: new Date(NOW + 86_400_000) }))
    expect(await resolveAccessForUserId("user-1")).toBe(true)
  })

  it("denies a cancelled subscription", async () => {
    mockUser.mockResolvedValue(
      userRow({
        subscription: {
          status: SubscriptionStatus.CANCELED,
          currentPeriodEnd: new Date(NOW - 60_000),
          cancelAtPeriodEnd: true,
        },
      })
    )
    expect(await resolveAccessForUserId("user-1")).toBe(false)
  })

  it("denies an unverified credential account even inside the demo window (RAD-297)", async () => {
    mockUser.mockResolvedValue(
      userRow({ emailVerified: null, userSettings: { onboardingCompleted: false } })
    )
    expect(await resolveAccessForUserId("user-1")).toBe(false)
  })

  it("exempts an unverified ADMIN (operator bypass)", async () => {
    mockUser.mockResolvedValue(userRow({ emailVerified: null, role: "ADMIN" }))
    expect(await resolveAccessForUserId("user-1")).toBe(true)
  })

  it("throws on a lookup failure (so destructive callers can tell unknown from denied)", async () => {
    mockUser.mockRejectedValue(new Error("connection refused"))
    await expect(resolveAccessForUserId("user-1")).rejects.toThrow("connection refused")
  })
})

describe("hasAccessForUserId (fail-closed wrapper)", () => {
  it("returns true when the resolver grants", async () => {
    mockUser.mockResolvedValue(userRow({ role: "ADMIN" }))
    expect(await hasAccessForUserId("user-1")).toBe(true)
  })

  it("returns false when the DB throws, and reports under the gate tag", async () => {
    mockUser.mockRejectedValue(new Error("connection refused"))

    expect(await hasAccessForUserId("user-1")).toBe(false)
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { gate: "hasAccessForUserId" } })
    )
  })
})
