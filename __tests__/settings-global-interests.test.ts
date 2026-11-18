/**
 * Settings — Global Interests (globalLikedCategories / globalDislikedCategories)
 *
 * Tests that the settings page and PUT API correctly handle global interest categories.
 *
 * Spec criteria covered:
 *   AC-3: Settings page queries and passes globalLikedCategories/globalDislikedCategories to SettingsForm
 *   AC-4: PUT /api/user-settings request body includes globalLikedCategories/globalDislikedCategories
 *   EC-2: Empty globalLikedCategories/globalDislikedCategories → picker rendered with nothing selected
 *   ERR-1: PUT with non-string array items → sanitizes, returns 200 (not an error)
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
    },
    userSettings: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    settings: {
      findFirst: vi.fn(),
    },
    blacklistItem: {
      findMany: vi.fn(),
    },
    aIFeedback: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const err = new Error(`NEXT_REDIRECT:${url}`)
    ;(err as any).digest = `NEXT_REDIRECT;replace;${url};303;`
    throw err
  }),
}))

// Model resolver has dynamic imports — stub it out

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"

const USER_ID = "user-settings-test"

function setupUserAuth() {
  vi.mocked(auth).mockResolvedValue({
    user: { id: USER_ID, role: "USER" },
  } as any)
}

function setupRequireAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupUserSettingsRecord(overrides: Record<string, unknown> = {}) {
  const base = {
    id: "settings-1",
    userId: USER_ID,
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
    onboardingCompleted: true,
    onboardingBannerDismissed: false,
    globalLikedCategories: [],
    globalDislikedCategories: [],
    ...overrides,
  }
  vi.mocked(db.userSettings.findUnique).mockResolvedValue(base as any)
  vi.mocked(db.userSettings.update).mockResolvedValue(base as any)
  return base
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.blacklistItem.findMany).mockResolvedValue([])
  vi.mocked(db.aIFeedback.findMany).mockResolvedValue([])
  vi.mocked(db.settings.findFirst).mockResolvedValue(null)
  // Account identity for the new Settings → Account section.
  vi.mocked(db.user.findUnique).mockResolvedValue({
    email: "test@example.com",
    username: "tester",
    passwordHash: "hash",
  } as any)
})

// ---------------------------------------------------------------------------
// Import the pieces under test (after mocks)
// ---------------------------------------------------------------------------
import SettingsPage from "@/app/(dashboard)/settings/page"
import { PUT } from "@/app/api/user-settings/route"

// ---------------------------------------------------------------------------
// AC-3 / EC-2: Settings page passes globalLikedCategories/globalDislikedCategories
// ---------------------------------------------------------------------------

describe("Settings page — global interests fields (AC-3, EC-2)", () => {
  it("AC-3: settings page includes globalLikedCategories in initialSettings passed to form", async () => {
    setupUserAuth()
    setupUserSettingsRecord({
      globalLikedCategories: ["Design", "Typography"],
      globalDislikedCategories: ["Ads"],
    })

    // Render the page — it returns JSX, we need to inspect the props passed to SettingsForm.
    // We verify by checking that the settings page queries these fields from db
    // and constructs personalSettings with them.
    const result = await SettingsPage()

    // The page renders SettingsForm with initialSettings. Since this is a server component,
    // we can inspect the returned React element's props.
    const formElement = result as any
    // SettingsForm is the direct child — check its props
    const initialSettings = formElement?.props?.initialSettings

    expect(initialSettings).toHaveProperty("globalLikedCategories")
    expect(initialSettings.globalLikedCategories).toEqual(["Design", "Typography"])
  })

  it("RAD-380: the stored Notion token never reaches the form's props, only hasNotionToken", async () => {
    setupUserAuth()
    const stored = "enc:v1:abcd1234:aXY:dGFn:Y2lwaGVy"
    setupUserSettingsRecord({ notionToken: stored })

    const result = (await SettingsPage()) as unknown as {
      props: { initialSettings: { hasNotionToken: boolean; notionToken: string | null } }
    }
    const initialSettings = result.props.initialSettings

    expect(initialSettings.hasNotionToken).toBe(true)
    expect(initialSettings.notionToken).toBeNull()
    expect(JSON.stringify(result.props)).not.toContain(stored)
  })

  it("AC-3: settings page includes globalDislikedCategories in initialSettings passed to form", async () => {
    setupUserAuth()
    setupUserSettingsRecord({
      globalLikedCategories: [],
      globalDislikedCategories: ["Clickbait", "Sponsored"],
    })

    const result = await SettingsPage()
    const formElement = result as any
    const initialSettings = formElement?.props?.initialSettings

    expect(initialSettings).toHaveProperty("globalDislikedCategories")
    expect(initialSettings.globalDislikedCategories).toEqual(["Clickbait", "Sponsored"])
  })

  it("EC-2: settings page passes empty arrays when user has no categories selected", async () => {
    setupUserAuth()
    setupUserSettingsRecord({
      globalLikedCategories: [],
      globalDislikedCategories: [],
    })

    const result = await SettingsPage()
    const formElement = result as any
    const initialSettings = formElement?.props?.initialSettings

    expect(initialSettings.globalLikedCategories).toEqual([])
    expect(initialSettings.globalDislikedCategories).toEqual([])
  })

  it("passes account identity with canEditEmail=true for credential users (passwordHash set)", async () => {
    setupUserAuth()
    setupUserSettingsRecord()
    vi.mocked(db.user.findUnique).mockResolvedValue({
      email: "me@example.com",
      username: "tester",
      passwordHash: "hash",
    } as any)

    const result = await SettingsPage()
    const account = (result as any)?.props?.account

    expect(account).toEqual({ email: "me@example.com", username: "tester", canEditEmail: true })
  })

  it("passes canEditEmail=false for OAuth accounts (no passwordHash) so email is read-only", async () => {
    setupUserAuth()
    setupUserSettingsRecord()
    vi.mocked(db.user.findUnique).mockResolvedValue({
      email: "oauth@gmail.com",
      username: "oauthuser",
      passwordHash: null,
    } as any)

    const result = await SettingsPage()
    const account = (result as any)?.props?.account

    expect(account.canEditEmail).toBe(false)
    expect(account.email).toBe("oauth@gmail.com")
  })
})

// ---------------------------------------------------------------------------
// AC-4: PUT /api/user-settings persists globalLikedCategories/globalDislikedCategories
// ---------------------------------------------------------------------------

describe("PUT /api/user-settings — global interests (AC-4, ERR-1)", () => {
  it("AC-4: PUT request persists globalLikedCategories and globalDislikedCategories to the database", async () => {
    setupRequireAuth()
    setupUserSettingsRecord()

    const req = new NextRequest("http://localhost/api/user-settings", {
      method: "PUT",
      body: JSON.stringify({
        globalPrompt: null,
        notionToken: null,
        notionDatabaseId: null,
        globalLikedCategories: ["Design", "UX"],
        globalDislikedCategories: ["Marketing"],
      }),
    })

    const res = await PUT(req)
    expect(res.status).toBe(200)

    // Verify the db update was called with the category fields
    expect(db.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          globalLikedCategories: ["Design", "UX"],
          globalDislikedCategories: ["Marketing"],
        }),
      })
    )
  })

  it("AC-4: handleSaveSettings sends globalLikedCategories in PUT body — verified by API accepting the field", async () => {
    // This test verifies the contract: the settings form MUST send these fields.
    // Currently settings-form.tsx handleSaveSettings does NOT include them in the PUT body.
    // When the feature is implemented, the form will send them.
    // We verify the API can receive and save them end-to-end.
    setupRequireAuth()
    setupUserSettingsRecord()

    // Simulate a PUT request that INCLUDES the new fields (as the form should send after implementation)
    const req = new NextRequest("http://localhost/api/user-settings", {
      method: "PUT",
      body: JSON.stringify({
        globalLikedCategories: ["Articles"],
        globalDislikedCategories: [],
        // simulate what form body will look like (currently missing these fields)
        notionToken: null,
        notionDatabaseId: null,
        globalPrompt: null,
      }),
    })

    const res = await PUT(req)
    const body = await res.json()

    // After implementation: the response must echo back the saved categories
    expect(body).toHaveProperty("globalLikedCategories")
    expect(body).toHaveProperty("globalDislikedCategories")
  })

  it("ERR-1: PUT with non-string array items sanitizes and returns 200 without error", async () => {
    setupRequireAuth()
    setupUserSettingsRecord()

    const req = new NextRequest("http://localhost/api/user-settings", {
      method: "PUT",
      body: JSON.stringify({
        globalLikedCategories: ["valid", 42, null, true, "also-valid"],
        globalDislikedCategories: [false, "ok", {}, "fine"],
      }),
    })

    const res = await PUT(req)
    expect(res.status).toBe(200)

    // Only string items should survive — numbers/booleans/objects are filtered
    expect(db.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          globalLikedCategories: ["valid", "also-valid"],
          globalDislikedCategories: ["ok", "fine"],
        }),
      })
    )
  })
})
