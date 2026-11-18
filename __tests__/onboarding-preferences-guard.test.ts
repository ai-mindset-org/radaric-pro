/**
 * RAD-168 — server guard on /onboarding/preferences.
 *
 * The preferences step starts from default categories, so a user who already
 * finished onboarding would overwrite their filters there. The client routes a
 * returning user past it when it knows; this layout makes that safe when the
 * client does not know (settings fetch failed, back button, a typed URL).
 *
 *   AC-1  onboardingCompleted=true → redirect /posts
 *   AC-2  onboardingCompleted=false, or no settings row → the step renders
 *   AC-3  no session → renders (proxy.ts already sends signed-out users to /signup)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { userSettings: { findUnique: vi.fn() } } }))
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import PreferencesLayout from "@/app/onboarding/preferences/layout"

const CHILD = "preferences-step"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(auth).mockResolvedValue({ user: { id: "u1" } } as never)
})

describe("/onboarding/preferences guard — RAD-168", () => {
  it("AC-1: a user who finished onboarding is sent to /posts", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ onboardingCompleted: true } as never)

    await expect(PreferencesLayout({ children: CHILD })).rejects.toThrow("NEXT_REDIRECT:/posts")
    expect(db.userSettings.findUnique).toHaveBeenCalledWith({ where: { userId: "u1" }, select: { onboardingCompleted: true } })
  })

  it.each([[{ onboardingCompleted: false }], [null]])("AC-2: a first-time user sees the step (%o)", async (row) => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(row as never)

    await expect(PreferencesLayout({ children: CHILD })).resolves.toBe(CHILD)
  })

  it("AC-3: no session renders without a lookup", async () => {
    vi.mocked(auth).mockResolvedValue(null as never)

    await expect(PreferencesLayout({ children: CHILD })).resolves.toBe(CHILD)
    expect(db.userSettings.findUnique).not.toHaveBeenCalled()
  })
})
