/**
 * RAD-168 — offer onboarding again on a new visit while the account has zero sources.
 *
 * `redirectToOnboardingOnNewVisit` is the page-side half of the rule. The proxy
 * decides whether the request starts a new visit (no visit marker for this user)
 * and forwards that verdict as a request header; the helper reads it and, only
 * then, counts the user's non-hidden feeds.
 *
 *   AC-1  new visit + 0 non-hidden feeds → redirect /onboarding/feeds?revisit=1; the count is exactly
 *         { userId, hidden: false } — hidden monitor feeds are excluded, paused feeds are not
 *   AC-2  continuing visit → no redirect and NO feed count
 *   AC-3  new visit + ≥1 non-hidden feed → no redirect
 *   AC-5  never writes settings — `onboardingCompleted` is a one-way latch
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const headerValues = new Map<string, string>()

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: (name: string) => headerValues.get(name.toLowerCase()) ?? null })),
}))

vi.mock("@/lib/db", () => ({
  db: {
    feed: { count: vi.fn() },
    userSettings: { upsert: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

import { db } from "@/lib/db"
import { redirect } from "next/navigation"
import { redirectToOnboardingOnNewVisit } from "@/lib/onboarding-revisit"
import { NEW_VISIT_HEADER } from "@/lib/visit-marker"

const USER_ID = "user-revisit"

beforeEach(() => {
  vi.clearAllMocks()
  headerValues.clear()
})

function newVisit() {
  headerValues.set(NEW_VISIT_HEADER, "1")
}

describe("redirectToOnboardingOnNewVisit — RAD-168", () => {
  it("AC-1: new visit with zero non-hidden feeds redirects to /onboarding/feeds?revisit=1", async () => {
    newVisit()
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(redirectToOnboardingOnNewVisit(USER_ID)).rejects.toThrow(/^NEXT_REDIRECT:\/onboarding\/feeds\?revisit=1$/)
    // Exactly this scope: no isActive filter (a paused feed is still a source
    // the user has), and hidden collection monitors never count.
    expect(db.feed.count).toHaveBeenCalledWith({ where: { userId: USER_ID, hidden: false } })
  })

  it("AC-2: a continuing visit neither redirects nor counts feeds", async () => {
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(redirectToOnboardingOnNewVisit(USER_ID)).resolves.toBeUndefined()
    expect(db.feed.count).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it("AC-2: only the exact verdict the proxy writes starts a new visit", async () => {
    headerValues.set(NEW_VISIT_HEADER, "0")
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await expect(redirectToOnboardingOnNewVisit(USER_ID)).resolves.toBeUndefined()
    expect(db.feed.count).not.toHaveBeenCalled()
  })

  it("AC-3: new visit with a non-hidden feed does not redirect", async () => {
    newVisit()
    vi.mocked(db.feed.count).mockResolvedValue(1)

    await expect(redirectToOnboardingOnNewVisit(USER_ID)).resolves.toBeUndefined()
    expect(redirect).not.toHaveBeenCalled()
  })

  it("AC-5: never writes settings", async () => {
    newVisit()
    vi.mocked(db.feed.count).mockResolvedValue(0)

    await redirectToOnboardingOnNewVisit(USER_ID).catch(() => {})
    newVisit()
    vi.mocked(db.feed.count).mockResolvedValue(3)
    await redirectToOnboardingOnNewVisit(USER_ID)

    expect(db.userSettings.upsert).not.toHaveBeenCalled()
    expect(db.userSettings.update).not.toHaveBeenCalled()
    expect(db.userSettings.create).not.toHaveBeenCalled()
  })
})
