// @vitest-environment node

/**
 * RAD-284 — the billing page under SELF_HOSTED renders the explanatory panel
 * instead of Stripe Checkout buttons wired to keys that do not exist.
 */

import { describe, it, expect, vi, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`)
  }),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "USER" } })),
}))

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: vi.fn(async () => null) } },
}))

vi.mock("@/components/settings/billing-section", () => ({
  BillingSection: () => <div>STRIPE_BILLING_SECTION</div>,
}))

import { db } from "@/lib/db"
import BillingPage from "@/app/(dashboard)/settings/billing/page"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("billing page — SELF_HOSTED", () => {
  it("renders the self-hosted panel, not the Stripe section", async () => {
    vi.stubEnv("SELF_HOSTED", "true")

    const html = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("Self-hosted — all features unlocked")
    expect(html).toContain("SELF_HOSTED=true")
    expect(html).toContain("Usage caps")
    // The branch must return BEFORE the Stripe-backed data load.
    expect(vi.mocked(db.user.findUnique)).not.toHaveBeenCalled()
  })

  it("renders the Stripe billing section when the flag is off", async () => {
    const html = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }))

    expect(html).toContain("STRIPE_BILLING_SECTION")
    expect(vi.mocked(db.user.findUnique)).toHaveBeenCalled()
  })
})
