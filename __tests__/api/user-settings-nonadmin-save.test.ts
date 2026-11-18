/**
 * PUT /api/user-settings — non-admin save must not be rejected by the
 * admin-only-field guard when those fields are merely present as null/false.
 *
 * BUG (reproduced on production, demo non-admin account 2026-06-03):
 *   The Settings form ALWAYS includes the three admin-only fields
 *   (storyInboxChannelId, storyNotionDatabaseId, autoDeleteTelegramMessages)
 *   in the PUT body — as null/false for non-admins. The route's guard rejected
 *   a non-admin whenever those keys were merely *present* (`!== undefined`), so
 *   every non-admin save returned 403 and NOTHING persisted — Global Content
 *   Interests included.
 *
 * Contract after fix:
 *   - A non-admin sending the form's default body (admin fields null/false) →
 *     200, and globalLiked/DislikedCategories persist.
 *   - A non-admin actually trying to SET an admin-only field (non-null / true) →
 *     still 403 (security contract preserved).
 *   - A non-admin must never WRITE admin-only fields.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
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

// Model resolver has dynamic imports — stub it out

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PUT } from "@/app/api/user-settings/route"

const USER_ID = "non-admin-user"

function setupAuth(role: "USER" | "ADMIN") {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupExistingRecord() {
  const base = {
    id: "settings-1",
    userId: USER_ID,
    globalLikedCategories: [],
    globalDislikedCategories: [],
    storyInboxChannelId: null,
    storyNotionDatabaseId: null,
    autoDeleteTelegramMessages: false,
    storyLanguage: "en",
  }
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(base as any)
  vi.mocked(db.userSettings.update).mockImplementation(
    async ({ data }: any) => ({ ...base, ...data }) as any
  )
}

/** The exact body the Settings form sends — admin-only fields default to null/false. */
function formBody(overrides: Record<string, unknown> = {}) {
  return {
    globalPrompt: null,
    notionToken: null,
    notionDatabaseId: null,
    storyInboxChannelId: null,
    storyNotionDatabaseId: null,
    storySystemPrompt: null,
    storyWriterModel: null,
    storyMatcherModel: null,
    materialStoryModel: null,
    storyLanguage: "en",
    autoDeleteTelegramMessages: false,
    globalLikedCategories: ["Articles", "Tutorials"],
    globalDislikedCategories: ["Ads"],
    ...overrides,
  }
}

function put(body: unknown) {
  return PUT(
    new NextRequest("http://localhost/api/user-settings", {
      method: "PUT",
      body: JSON.stringify(body),
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("PUT /api/user-settings — non-admin save (admin-field guard)", () => {
  it("saves a non-admin's interests when the form sends admin-only fields as null/false (200, not 403)", async () => {
    setupAuth("USER")
    setupExistingRecord()

    const res = await put(formBody())

    expect(res.status).toBe(200)
    expect(db.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          globalLikedCategories: ["Articles", "Tutorials"],
          globalDislikedCategories: ["Ads"],
        }),
      })
    )
  })

  it("never writes admin-only fields for a non-admin, even though they appear in the body", async () => {
    setupAuth("USER")
    setupExistingRecord()

    await put(formBody())

    const updateArg = vi.mocked(db.userSettings.update).mock.calls[0][0] as any
    expect(updateArg.data).not.toHaveProperty("storyInboxChannelId")
    expect(updateArg.data).not.toHaveProperty("storyNotionDatabaseId")
    expect(updateArg.data).not.toHaveProperty("autoDeleteTelegramMessages")
  })

  it("still rejects a non-admin that actually sets an admin-only string field (403)", async () => {
    setupAuth("USER")
    setupExistingRecord()

    const res = await put({ storyInboxChannelId: "-1001234567890" })

    expect(res.status).toBe(403)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })

  it("still rejects a non-admin that tries to enable auto-delete (403)", async () => {
    setupAuth("USER")
    setupExistingRecord()

    const res = await put({ autoDeleteTelegramMessages: true })

    expect(res.status).toBe(403)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })

  it("rejects a non-admin that sends a truthy non-boolean for auto-delete (403)", async () => {
    setupAuth("USER")
    setupExistingRecord()

    const res = await put({ autoDeleteTelegramMessages: "true" })

    expect(res.status).toBe(403)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })

  it("creates a brand-new non-admin record without any admin-only field, but with the interests", async () => {
    setupAuth("USER")
    // No existing record → the route takes the create branch.
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null as any)
    vi.mocked(db.userSettings.create).mockImplementation(
      async ({ data }: any) => ({ id: "new", ...data }) as any
    )

    const res = await put(formBody())
    expect(res.status).toBe(200)

    const createArg = vi.mocked(db.userSettings.create).mock.calls[0][0] as any
    expect(createArg.data).not.toHaveProperty("storyInboxChannelId")
    expect(createArg.data).not.toHaveProperty("storyNotionDatabaseId")
    expect(createArg.data).not.toHaveProperty("autoDeleteTelegramMessages")
    expect(createArg.data.globalLikedCategories).toEqual(["Articles", "Tutorials"])
    expect(createArg.data.globalDislikedCategories).toEqual(["Ads"])
  })

  it("lets an admin set admin-only fields through the same body (200)", async () => {
    setupAuth("ADMIN")
    setupExistingRecord()

    const res = await put(formBody({ storyInboxChannelId: "-1009999999999" }))

    expect(res.status).toBe(200)
  })
})
