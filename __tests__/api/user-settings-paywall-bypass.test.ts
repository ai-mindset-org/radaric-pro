/**
 * RAD-294 — paywall bypass V1: onboarding-flag reset via /api/user-settings
 *
 * BOTH writable handlers on this route are guarded by requireAuth() only, and
 * BOTH accept `onboardingCompleted` from the request body unconditionally:
 * PATCH (the allowlist) and PUT (its update AND create branches).
 * lib/paywall.ts:41-50 auto-completes onboarding the moment a user has >0
 * feeds, but nothing stops the user from immediately sending
 * `{"onboardingCompleted": false}` back to either handler and re-granting
 * themselves the unbounded full-access demo grant (lib/subscription.ts:22,
 * lib/entitlements.ts:59) — repeatable forever.
 *
 * Latching PATCH alone leaves PUT wide open, so both are covered here.
 *
 * Follows the mocking/request conventions of
 * __tests__/api/user-settings-onboarding.test.ts (RAD-178).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))


import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PATCH, PUT } from "@/app/api/user-settings/route"

const USER_ID = "user-settings-paywall-294"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function makeRequest(body: unknown, method: "PATCH" | "PUT" = "PATCH") {
  return new Request("http://localhost/api/user-settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

// `existing` decides which PUT branch runs: update (settings row present) or
// create (first save). Both spread `onboardingCompleted` from the body, so both
// need covering.
function setupPut({ existing }: { existing: boolean }) {
  setupAuth()
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(
    existing ? ({ userId: USER_ID } as never) : (null as never)
  )
  vi.mocked(db.userSettings.update).mockResolvedValue({} as never)
  vi.mocked(db.userSettings.create).mockResolvedValue({} as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.userSettings.upsert).mockResolvedValue({} as never)
})

describe("PATCH /api/user-settings — RAD-294 V1: onboarding-flag reset", () => {
  it("(3) PATCH {onboardingCompleted: false} must NOT persist false", async () => {
    setupAuth()
    const res = await PATCH(makeRequest({ onboardingCompleted: false }))
    expect(res.status).toBe(200)

    const call = vi.mocked(db.userSettings.upsert).mock.calls[0][0]
    // Today the route writes `onboardingCompleted: false` verbatim from the
    // request body (route.ts:184), so this assertion fails right now — the
    // route must never let the client re-open the demo grant once onboarding
    // is complete.
    expect((call.update as never as { onboardingCompleted?: boolean }).onboardingCompleted).toBeUndefined()
  })

  it("(4) PATCH {onboardingCompleted: true} must still work — the real onboarding-completion path (app/onboarding/preferences/page.tsx:42,66)", async () => {
    setupAuth()
    const res = await PATCH(makeRequest({ onboardingCompleted: true }))
    expect(res.status).toBe(200)

    expect(db.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: expect.objectContaining({ onboardingCompleted: true }),
      create: expect.objectContaining({ userId: USER_ID, onboardingCompleted: true }),
    })
  })
})

describe("PUT /api/user-settings — RAD-294 V1: the same reset, second handler", () => {
  it("(3b) PUT {onboardingCompleted: false} on an existing settings row must NOT persist false", async () => {
    setupPut({ existing: true })
    const res = await PUT(makeRequest({ onboardingCompleted: false }, "PUT"))
    expect(res.status).toBe(200)

    const call = vi.mocked(db.userSettings.update).mock.calls[0][0]
    expect(
      (call.data as never as { onboardingCompleted?: boolean }).onboardingCompleted
    ).toBeUndefined()
  })

  it("(3c) PUT {onboardingCompleted: false} on a first save must NOT persist false", async () => {
    setupPut({ existing: false })
    const res = await PUT(makeRequest({ onboardingCompleted: false }, "PUT"))
    expect(res.status).toBe(200)

    const call = vi.mocked(db.userSettings.create).mock.calls[0][0]
    expect(
      (call.data as never as { onboardingCompleted?: boolean }).onboardingCompleted
    ).toBeUndefined()
  })

  it("(4b) PUT {onboardingCompleted: true} must still persist true", async () => {
    setupPut({ existing: true })
    const res = await PUT(makeRequest({ onboardingCompleted: true }, "PUT"))
    expect(res.status).toBe(200)

    const call = vi.mocked(db.userSettings.update).mock.calls[0][0]
    expect(
      (call.data as never as { onboardingCompleted?: boolean }).onboardingCompleted
    ).toBe(true)
  })

  it("(4c) PUT that omits onboardingCompleted must not touch the flag at all", async () => {
    setupPut({ existing: true })
    const res = await PUT(makeRequest({ globalPrompt: "hello" }, "PUT"))
    expect(res.status).toBe(200)

    const call = vi.mocked(db.userSettings.update).mock.calls[0][0]
    expect(
      (call.data as never as { onboardingCompleted?: boolean }).onboardingCompleted
    ).toBeUndefined()
  })
})
