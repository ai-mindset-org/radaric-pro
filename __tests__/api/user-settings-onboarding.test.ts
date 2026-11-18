/**
 * PATCH /api/user-settings — onboarding state transitions
 *
 * Tests onboardingCompleted, onboardingState persistence,
 * global preferences, and category sanitization.
 * RAD-178
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      upsert: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))


import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PATCH } from "@/app/api/user-settings/route"

const USER_ID = "user-settings-123"

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupUnauth() {
  const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  vi.mocked(requireAuth).mockResolvedValue(res as never)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/user-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.userSettings.upsert).mockResolvedValue({} as never)
})

describe("PATCH /api/user-settings (onboarding)", () => {
  it("returns 401 when not authenticated", async () => {
    setupUnauth()
    const res = await PATCH(makeRequest({ onboardingCompleted: true }))
    expect(res.status).toBe(401)
  })

  it("sets onboardingCompleted to true", async () => {
    setupAuth()
    const res = await PATCH(makeRequest({ onboardingCompleted: true }))
    expect(res.status).toBe(200)

    expect(db.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: expect.objectContaining({ onboardingCompleted: true }),
      create: expect.objectContaining({ userId: USER_ID, onboardingCompleted: true }),
    })
  })

  it("persists globalPrompt", async () => {
    setupAuth()
    await PATCH(makeRequest({ globalPrompt: "Product design, UX research" }))

    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ globalPrompt: "Product design, UX research" }),
      })
    )
  })

  it("persists global liked and disliked categories", async () => {
    setupAuth()
    await PATCH(makeRequest({
      globalLikedCategories: ["Articles", "Tutorials"],
      globalDislikedCategories: ["Ads", "Sponsored"],
    }))

    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          globalLikedCategories: ["Articles", "Tutorials"],
          globalDislikedCategories: ["Ads", "Sponsored"],
        }),
      })
    )
  })

  it("sanitizes categories: trims, caps at 50 chars, max 30 items", async () => {
    setupAuth()
    const longCategory = "A".repeat(60)
    const manyCategories = Array.from({ length: 35 }, (_, i) => `cat-${i}`)

    await PATCH(makeRequest({
      globalLikedCategories: [" padded ", longCategory, ...manyCategories],
    }))

    const call = vi.mocked(db.userSettings.upsert).mock.calls[0][0]
    const cats = (call.update as never).globalLikedCategories as string[]
    expect(cats[0]).toBe("padded") // trimmed
    expect(cats[1]).toBe("A".repeat(50)) // capped at 50
    expect(cats.length).toBeLessThanOrEqual(30) // max 30
  })

  it("filters non-string values from categories", async () => {
    setupAuth()
    await PATCH(makeRequest({
      globalLikedCategories: ["Valid", 123, null, "Also Valid"],
    }))

    const call = vi.mocked(db.userSettings.upsert).mock.calls[0][0]
    const cats = (call.update as never).globalLikedCategories as string[]
    expect(cats).toEqual(["Valid", "Also Valid"])
  })

  it("persists onboardingState JSON", async () => {
    setupAuth()
    const state = {
      version: 1,
      step: "review",
      extractedFeeds: [
        { url: "https://example.com/feed", name: "Example", type: "RSS", status: "found" },
      ],
    }

    await PATCH(makeRequest({ onboardingState: state }))

    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ onboardingState: state }),
      })
    )
  })

  it("clears onboardingState with null (RAD-168) — a Json column needs Prisma.DbNull, not a bare null", async () => {
    setupAuth()
    const res = await PATCH(makeRequest({ onboardingState: null }))
    expect(res.status).toBe(200)
    const call = vi.mocked(db.userSettings.upsert).mock.calls[0][0] as { update: Record<string, unknown>; create: Record<string, unknown> }
    expect(call.update.onboardingState).toBe(Prisma.DbNull)
    expect(call.create.onboardingState).toBe(Prisma.DbNull)
  })

  it("sets onboardingBannerDismissed", async () => {
    setupAuth()
    await PATCH(makeRequest({ onboardingBannerDismissed: true }))

    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ onboardingBannerDismissed: true }),
      })
    )
  })

  it("ignores non-boolean onboardingCompleted", async () => {
    setupAuth()
    await PATCH(makeRequest({ onboardingCompleted: "yes" }))

    const call = vi.mocked(db.userSettings.upsert).mock.calls[0][0]
    expect((call.update as never).onboardingCompleted).toBeUndefined()
  })

  it("handles empty body gracefully", async () => {
    setupAuth()
    const res = await PATCH(makeRequest({}))
    expect(res.status).toBe(200)

    expect(db.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: {},
      create: { userId: USER_ID },
    })
  })

  it("combines multiple onboarding fields in one call", async () => {
    setupAuth()
    await PATCH(makeRequest({
      globalLikedCategories: ["Design"],
      globalDislikedCategories: ["Ads"],
      globalPrompt: "UX research only",
      onboardingCompleted: true,
    }))

    expect(db.userSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          globalLikedCategories: ["Design"],
          globalDislikedCategories: ["Ads"],
          globalPrompt: "UX research only",
          onboardingCompleted: true,
        }),
      })
    )
  })

  it("returns 500 on database error", async () => {
    setupAuth()
    vi.mocked(db.userSettings.upsert).mockRejectedValue(new Error("DB error"))

    const res = await PATCH(makeRequest({ onboardingCompleted: true }))
    expect(res.status).toBe(500)
  })
})
