/**
 * F7 — parametrized gate-matrix integration test (RAD-223).
 *
 * F1 (`subscription-gate.test.ts`) covers `hasActiveAccess` as a pure
 * function. F7 covers `requireActiveSubscription` — the async wrapper
 * that production routes actually call. The wrapper adds:
 *   - DB lookup with the correct include shape
 *   - `onboardingCompleted ?? true` default when userSettings is missing
 *   - subscription extraction shape (null when no row, otherwise mapped fields)
 *   - response codes: null (allow) / 402 (block) / 503 (DB error)
 *   - Sentry capture on the error path
 *   - ADMIN early-return that bypasses the DB entirely
 *
 * The matrix below exercises every (role × onboardingCompleted × subscription
 * status × period) combination that affects the response code.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { SubscriptionStatus } from "@prisma/client"

// ---------------------------------------------------------------------------
// Mocks — hoisted before imports
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { db } from "@/lib/db"
import * as Sentry from "@sentry/nextjs"
import { requireActiveSubscription } from "@/lib/subscription"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW_REF = new Date("2026-05-01T12:00:00Z")
const FUTURE = new Date("2026-06-01T00:00:00Z")
const PAST = new Date("2026-04-01T00:00:00Z")
// RAD-294: `createdAt` now feeds the bounded onboarding demo grant. The default
// fixture account is 3h old — inside the window — so the matrix rows below keep
// asserting what they were written to assert.
const CREATED_RECENT = new Date("2026-05-01T09:00:00Z")   // NOW_REF - 3h

type SubFixture = {
  status: SubscriptionStatus
  currentPeriodEnd: Date
  cancelAtPeriodEnd: boolean
}

function makeUserRow(opts: {
  role?: "USER" | "ADMIN"
  userSettings?: { onboardingCompleted: boolean } | null
  subscription?: SubFixture | null
  complimentaryAccessUntil?: Date | null
  createdAt?: Date
} = {}) {
  return {
    id: "user_123",
    email: "test@example.com",
    role: opts.role ?? "USER",
    createdAt: opts.createdAt ?? CREATED_RECENT,
    userSettings: opts.userSettings ?? { onboardingCompleted: true },
    subscription: opts.subscription ?? null,
    complimentaryAccessUntil: opts.complimentaryAccessUntil ?? null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW_REF)
})

// ---------------------------------------------------------------------------
// ADMIN bypass — never touches the DB
// ---------------------------------------------------------------------------

describe("requireActiveSubscription — ADMIN bypass", () => {
  it("returns null for ADMIN role and never queries the DB", async () => {
    const result = await requireActiveSubscription("user_123", "ADMIN")

    expect(result).toBeNull()
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it("returns null for ADMIN even if the DB would have thrown", async () => {
    vi.mocked(db.user.findUnique).mockRejectedValue(new Error("connection refused"))

    const result = await requireActiveSubscription("user_123", "ADMIN")

    expect(result).toBeNull()
    expect(db.user.findUnique).not.toHaveBeenCalled()
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DB query shape
// ---------------------------------------------------------------------------

describe("requireActiveSubscription — DB query", () => {
  it("queries user with userSettings + subscription includes", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(makeUserRow() as never)

    await requireActiveSubscription("user_123", "USER")

    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user_123" },
        include: { userSettings: true, subscription: true },
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Allow / block matrix (parametrized)
// ---------------------------------------------------------------------------

type MatrixCase = {
  label: string
  userSettings: { onboardingCompleted: boolean } | null
  subscription: SubFixture | null
  complimentaryAccessUntil?: Date | null
  expected: "allow" | "block"
}

const matrix: MatrixCase[] = [
  // Onboarding grace
  {
    label: "onboarding-not-complete + no sub → allow (grace)",
    userSettings: { onboardingCompleted: false },
    subscription: null,
    expected: "allow",
  },
  {
    label: "onboarding-not-complete + CANCELED expired sub → allow (grace)",
    userSettings: { onboardingCompleted: false },
    subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    expected: "allow",
  },
  // Active sub paths
  {
    label: "ACTIVE future → allow",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "allow",
  },
  {
    label: "ACTIVE future + cancelAtPeriodEnd → allow until period end",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: true },
    expected: "allow",
  },
  {
    label: "TRIALING future → allow",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.TRIALING, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "allow",
  },
  {
    label: "PAST_DUE future → allow (grace window)",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "allow",
  },
  // Block paths
  {
    label: "no sub + onboarding complete → block",
    userSettings: { onboardingCompleted: true },
    subscription: null,
    expected: "block",
  },
  {
    label: "ACTIVE expired (missed renewal webhook) → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "TRIALING expired → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.TRIALING, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "PAST_DUE expired → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.PAST_DUE, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "CANCELED → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "UNPAID → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.UNPAID, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "INCOMPLETE → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.INCOMPLETE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "INCOMPLETE_EXPIRED → block",
    userSettings: { onboardingCompleted: true },
    subscription: {
      status: SubscriptionStatus.INCOMPLETE_EXPIRED,
      currentPeriodEnd: FUTURE,
      cancelAtPeriodEnd: false,
    },
    expected: "block",
  },
  {
    label: "PAUSED → block",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.PAUSED, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "block",
  },
  {
    label: "UNKNOWN → block (fail-closed)",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.UNKNOWN, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "block",
  },
  // Missing-userSettings paths — wrapper defaults onboardingCompleted to true
  {
    label: "userSettings null + no sub → block (defaults onboarding to complete)",
    userSettings: null,
    subscription: null,
    expected: "block",
  },
  {
    label: "userSettings null + ACTIVE future → allow (sub still wins)",
    userSettings: null,
    subscription: { status: SubscriptionStatus.ACTIVE, currentPeriodEnd: FUTURE, cancelAtPeriodEnd: false },
    expected: "allow",
  },
  // Complimentary access — the gate honors a future comp date with no sub, and
  // stops honoring it once expired. This proves the field is threaded end-to-end
  // through the real requireActiveSubscription 402 gate (not just the pure fn).
  {
    label: "comp future + no sub → allow (complimentary grant)",
    userSettings: { onboardingCompleted: true },
    subscription: null,
    complimentaryAccessUntil: FUTURE,
    expected: "allow",
  },
  {
    label: "comp past + no sub → block (complimentary grant expired)",
    userSettings: { onboardingCompleted: true },
    subscription: null,
    complimentaryAccessUntil: PAST,
    expected: "block",
  },
  {
    label: "comp future rescues a CANCELED sub → allow",
    userSettings: { onboardingCompleted: true },
    subscription: { status: SubscriptionStatus.CANCELED, currentPeriodEnd: PAST, cancelAtPeriodEnd: false },
    complimentaryAccessUntil: FUTURE,
    expected: "allow",
  },
]

describe.each(matrix)("requireActiveSubscription — matrix: $label", (caseRow) => {
  it(`USER role → ${caseRow.expected}`, async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(
      makeUserRow({
        userSettings: caseRow.userSettings,
        subscription: caseRow.subscription,
        complimentaryAccessUntil: caseRow.complimentaryAccessUntil ?? null,
      }) as never,
    )

    const result = await requireActiveSubscription("user_123", "USER")

    if (caseRow.expected === "allow") {
      expect(result).toBeNull()
    } else {
      expect(result).not.toBeNull()
      expect(result!.status).toBe(402)
      const body = await result!.json()
      expect(body).toEqual({
        error: "Subscription required",
        code: "SUBSCRIPTION_REQUIRED",
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Missing user row — defaults to onboardingCompleted=true, no sub → block
// ---------------------------------------------------------------------------

describe("requireActiveSubscription — missing user row", () => {
  it("returns 402 when findUnique returns null (treats as no sub + onboarding complete)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null)

    const result = await requireActiveSubscription("ghost_user", "USER")

    expect(result).not.toBeNull()
    expect(result!.status).toBe(402)
    expect(Sentry.captureException).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// DB error path — fail-closed for USER, captures Sentry
// ---------------------------------------------------------------------------

describe("requireActiveSubscription — DB error", () => {
  it("returns 503 with SUBSCRIPTION_CHECK_FAILED and reports to Sentry with gate tag", async () => {
    const dbErr = new Error("connection refused")
    vi.mocked(db.user.findUnique).mockRejectedValue(dbErr)

    const result = await requireActiveSubscription("user_123", "USER")

    expect(result).not.toBeNull()
    expect(result!.status).toBe(503)
    const body = await result!.json()
    expect(body).toEqual({
      error: "Subscription check failed",
      code: "SUBSCRIPTION_CHECK_FAILED",
    })
    expect(Sentry.captureException).toHaveBeenCalledWith(
      dbErr,
      expect.objectContaining({
        tags: expect.objectContaining({ gate: "requireActiveSubscription" }),
      }),
    )
  })
})
