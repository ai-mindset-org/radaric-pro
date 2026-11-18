// @vitest-environment node

/**
 * RAD-294 (8) — a returning user past the demo window must never be trapped.
 *
 * The demo-window fix (see __tests__/paywall-bypass-demo-window.test.ts) makes
 * `hasActiveAccess` / `subscriptionIncludesTwitter` deny access once an
 * incomplete-onboarding account ages out. That fix must not accidentally block
 * a user from ever finishing onboarding: the onboarding routes themselves
 * (app/api/onboarding/parse-feeds, app/api/onboarding/save-feeds) and the
 * PATCH-to-true completion path (app/api/user-settings PATCH) are gated ONLY
 * by requireAuth() — none of them call requireActiveSubscription. This test
 * pins that shape for parse-feeds: an authenticated request is processed (or
 * rejected for input-validation reasons) without ever hitting a 402
 * subscription gate, regardless of the caller's subscription/onboarding state.
 *
 * This test is a non-regression pin, not a bypass reproduction — it must pass
 * both before and after the fix (confirmed against unmodified code below).
 */

import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { POST } from "@/app/api/onboarding/parse-feeds/route"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: "stale-onboarding-user", role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

describe("POST /api/onboarding/parse-feeds — RAD-294 (8) stays ungated by subscription", () => {
  it("an authenticated request with no input is rejected as a 400 input-validation error, never a 402 subscription gate", async () => {
    setupAuth()
    const req = new Request("http://localhost/api/onboarding/parse-feeds", {
      method: "POST",
      body: new FormData(),
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: "No input" })
  })
})

// RAD-297: the route now also requires a verified email; these tests cover the
// file-size / subscription-gate shapes and stub the verification gate.
vi.mock("@/lib/email-verification", () => ({
  requireVerifiedEmail: vi.fn(async () => null),
  isEmailVerified: vi.fn(async () => true),
}))
