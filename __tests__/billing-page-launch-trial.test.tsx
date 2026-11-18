// @vitest-environment node

/**
 * RAD-419 — the billing page tells BillingSection whether the comp is a
 * referral trial, judged on the server from the account row (createdAt and the
 * comp expiry written in the same create), so a manual comp keeps its copy.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const captured = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`)
  }),
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", role: "USER" } })),
}))

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: vi.fn() } },
}))

vi.mock("@/components/settings/billing-section", () => ({
  BillingSection: (props: Record<string, unknown>) => {
    captured.props = props
    return null
  },
}))

import { db } from "@/lib/db"
import BillingPage from "@/app/(dashboard)/settings/billing/page"

const DAY_MS = 86_400_000
const CREATED = new Date(Date.now() - 2 * DAY_MS)

function account(complimentaryAccessUntil: Date | null) {
  return {
    id: "u1",
    createdAt: CREATED,
    complimentaryAccessUntil,
    userSettings: { onboardingCompleted: true },
    subscription: null,
  }
}

async function render() {
  renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }))
  return captured.props
}

beforeEach(() => {
  captured.props = null
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("billing page — referral trial flag", () => {
  it("passes launchTrial for a comp written at sign-up for TRIAL_DAYS", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(account(new Date(CREATED.getTime() + 7 * DAY_MS)) as never)
    expect(await render()).toMatchObject({ launchTrial: true })
  })

  it("passes launchTrial=false for a manual comp", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(account(new Date(Date.now() + 30 * DAY_MS)) as never)
    expect(await render()).toMatchObject({ launchTrial: false })
  })

  it("passes launchTrial=false without a comp", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(account(null) as never)
    expect(await render()).toMatchObject({ launchTrial: false })
  })
})

describe("billing page — contact address (RAD-438)", () => {
  it("passes the hosted address when CONTACT_EMAIL is unset", async () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    vi.stubEnv("CONTACT_EMAIL", undefined)
    vi.mocked(db.user.findUnique).mockResolvedValue(account(null) as never)
    expect(await render()).toMatchObject({ contactEmail: "kirill@radaric.pro" })
  })

  it("passes CONTACT_EMAIL when set", async () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    vi.stubEnv("CONTACT_EMAIL", "ops@example.org")
    vi.mocked(db.user.findUnique).mockResolvedValue(account(null) as never)
    expect(await render()).toMatchObject({ contactEmail: "ops@example.org" })
  })
})
