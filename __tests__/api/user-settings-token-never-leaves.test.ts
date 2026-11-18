/**
 * RAD-380 — the Notion token never leaves the server.
 * RAD-221 — and it is sealed before it reaches the database.
 *
 * Before: GET, PUT and PATCH /api/user-settings answered with the whole
 * `user_settings` row, `notionToken` included, on every call.
 *
 * Contract:
 *  - no response of GET / PUT / PATCH carries `notionToken`, its plaintext or
 *    its sealed form; a `hasNotionToken` boolean says whether one is stored;
 *  - the fields the callers read (onboarding pages, typography provider,
 *    settings form, rules page) are still there;
 *  - PUT treats the token as write-only: absent = keep, null/"" = clear,
 *    a non-empty string = replace, sealed with TOKEN_ENC_KEY;
 *  - without TOKEN_ENC_KEY a new token is refused (503), never stored in clear;
 *  - every scalar column of UserSettings is classified as public or secret, so
 *    a new column cannot reach the browser unreviewed.
 */

import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { GET, PATCH, PUT } from "@/app/api/user-settings/route"
import { PUBLIC_USER_SETTINGS_FIELDS, SECRET_USER_SETTINGS_FIELDS } from "@/lib/user-settings-public"
import { TOKEN_PURPOSE, decryptToken, encryptToken, isEncryptedToken } from "@/lib/token-crypto"

const USER_ID = "user-token-leak"
const TOKEN = "ntn_LEAKCANARY_9f8e7d6c5b4a39281706f5e4d3c2b1a0"
const savedKey = process.env.TOKEN_ENC_KEY

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "settings-1",
    userId: USER_ID,
    globalPrompt: "only design",
    notionToken: null as string | null,
    notionDatabaseId: "db-123",
    storyInboxChannelId: null,
    storyNotionDatabaseId: null,
    storyLastMessageId: null,
    storySystemPrompt: null,
    storyPromptVersion: 1,
    storyWriterModel: null,
    storyMatcherModel: null,
    materialStoryModel: null,
    storyLanguage: "en",
    autoDeleteTelegramMessages: false,
    globalLikedCategories: ["Design"],
    globalDislikedCategories: [],
    onboardingCompleted: true,
    onboardingBannerDismissed: false,
    onboardingState: { extractedFeeds: [{ url: "https://example.com/feed" }] },
    typography: { heading: "inter" },
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    ...overrides,
  }
}

function req(method: string, body?: unknown) {
  return new NextRequest("http://localhost/api/user-settings", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function readBody(res: Response) {
  const text = await res.text()
  return { text, json: JSON.parse(text) as Record<string, unknown> }
}

function expectNoToken(text: string, json: Record<string, unknown>, sealed?: string) {
  expect(json).not.toHaveProperty("notionToken")
  expect(text).not.toContain(TOKEN)
  expect(text).not.toContain("notionToken")
  if (sealed) expect(text).not.toContain(sealed)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString("hex")
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = savedKey
})

describe("GET /api/user-settings", () => {
  it("hides a sealed token and reports hasNotionToken, keeping the callers' fields", async () => {
    const sealed = encryptToken(TOKEN, TOKEN_PURPOSE.userNotionToken, USER_ID)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(row({ notionToken: sealed }) as never)

    const res = await GET()
    expect(res.status).toBe(200)
    const { text, json } = await readBody(res)
    expectNoToken(text, json, sealed)
    expect(json.hasNotionToken).toBe(true)
    expect(json.notionDatabaseId).toBe("db-123")
    expect(json.onboardingCompleted).toBe(true)
    expect(json.onboardingState).toEqual({ extractedFeeds: [{ url: "https://example.com/feed" }] })
    expect(json.typography).toEqual({ heading: "inter" })
    expect(json.globalPrompt).toBe("only design")
    expect(json.globalLikedCategories).toEqual(["Design"])
  })

  it("hides a legacy plaintext token too", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(row({ notionToken: TOKEN }) as never)
    const { text, json } = await readBody(await GET())
    expectNoToken(text, json)
    expect(json.hasNotionToken).toBe(true)
  })

  it("reports hasNotionToken false for a freshly created row", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null)
    vi.mocked(db.userSettings.create).mockResolvedValue(row() as never)
    const { text, json } = await readBody(await GET())
    expectNoToken(text, json)
    expect(json.hasNotionToken).toBe(false)
  })
})

describe("PUT /api/user-settings — write-only token", () => {
  function setupExisting(stored: string | null) {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(row({ notionToken: stored }) as never)
    vi.mocked(db.userSettings.update).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => row({ notionToken: stored, ...data }) as never,
    )
  }

  it("seals a new token for this user before writing it, and does not echo it", async () => {
    setupExisting(null)
    const res = await PUT(req("PUT", { notionToken: TOKEN, notionDatabaseId: "db-123" }))
    expect(res.status).toBe(200)

    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    const written = data.notionToken as string
    expect(isEncryptedToken(written)).toBe(true)
    expect(written).not.toContain(TOKEN)
    expect(decryptToken(written, TOKEN_PURPOSE.userNotionToken, USER_ID)).toBe(TOKEN)

    const { text, json } = await readBody(res)
    expectNoToken(text, json, written)
    expect(json.hasNotionToken).toBe(true)
  })

  it("keeps the stored token when the body has no notionToken key", async () => {
    const sealed = encryptToken(TOKEN, TOKEN_PURPOSE.userNotionToken, USER_ID)
    setupExisting(sealed)
    const res = await PUT(req("PUT", { globalPrompt: "x" }))
    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data).not.toHaveProperty("notionToken")
    const { text, json } = await readBody(res)
    expectNoToken(text, json, sealed)
    expect(json.hasNotionToken).toBe(true)
  })

  it.each([null, ""])("clears the token when notionToken is %j", async (value) => {
    setupExisting(encryptToken(TOKEN, TOKEN_PURPOSE.userNotionToken, USER_ID))
    const res = await PUT(req("PUT", { notionToken: value }))
    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.update).mock.calls[0][0].data as Record<string, unknown>
    expect(data.notionToken).toBeNull()
    expect((await readBody(res)).json.hasNotionToken).toBe(false)
  })

  it("seals the token on the create branch too", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null)
    vi.mocked(db.userSettings.create).mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => row(data) as never,
    )
    const res = await PUT(req("PUT", { notionToken: TOKEN }))
    expect(res.status).toBe(200)
    const data = vi.mocked(db.userSettings.create).mock.calls[0][0].data as Record<string, unknown>
    expect(isEncryptedToken(data.notionToken as string)).toBe(true)
    const { text, json } = await readBody(res)
    expectNoToken(text, json, data.notionToken as string)
  })

  it("refuses a new token with 503 when TOKEN_ENC_KEY is unset, writing nothing", async () => {
    delete process.env.TOKEN_ENC_KEY
    setupExisting(null)
    const res = await PUT(req("PUT", { notionToken: TOKEN }))
    expect(res.status).toBe(503)
    expect(db.userSettings.update).not.toHaveBeenCalled()
    expect(db.userSettings.create).not.toHaveBeenCalled()
    expect(await res.text()).not.toContain(TOKEN)
  })

  it("still saves other fields without TOKEN_ENC_KEY when no token is sent", async () => {
    delete process.env.TOKEN_ENC_KEY
    setupExisting(null)
    const res = await PUT(req("PUT", { globalPrompt: "x" }))
    expect(res.status).toBe(200)
  })

  it("rejects a value that is already in sealed form with 400, not 500", async () => {
    setupExisting(null)
    const res = await PUT(req("PUT", { notionToken: encryptToken(TOKEN, TOKEN_PURPOSE.userNotionToken, "someone-else") }))
    expect(res.status).toBe(400)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })

  it("rejects a non-string token", async () => {
    setupExisting(null)
    const res = await PUT(req("PUT", { notionToken: { evil: true } }))
    expect(res.status).toBe(400)
    expect(db.userSettings.update).not.toHaveBeenCalled()
  })

  it("never logs the token", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    setupExisting(null)
    await PUT(req("PUT", { notionToken: TOKEN }))
    const logged = JSON.stringify([...log.mock.calls, ...err.mock.calls])
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain("enc:v1:")
    log.mockRestore()
    err.mockRestore()
  })
})

describe("PATCH /api/user-settings", () => {
  it("answers without the token", async () => {
    const sealed = encryptToken(TOKEN, TOKEN_PURPOSE.userNotionToken, USER_ID)
    vi.mocked(db.userSettings.upsert).mockResolvedValue(row({ notionToken: sealed, onboardingState: null }) as never)
    const res = await PATCH(req("PATCH", { onboardingState: null }))
    expect(res.status).toBe(200)
    const { text, json } = await readBody(res)
    expectNoToken(text, json, sealed)
    expect(json.hasNotionToken).toBe(true)
    expect(json.onboardingCompleted).toBe(true)
  })
})

describe("UserSettings column classification", () => {
  it("classifies every scalar column as public or secret, and notionToken as secret", () => {
    const columns = Object.values(Prisma.UserSettingsScalarFieldEnum).sort()
    const classified = [...PUBLIC_USER_SETTINGS_FIELDS, ...SECRET_USER_SETTINGS_FIELDS].sort()
    expect(classified).toEqual(columns)
    expect(SECRET_USER_SETTINGS_FIELDS).toContain("notionToken")
    expect(PUBLIC_USER_SETTINGS_FIELDS).not.toContain("notionToken")
  })
})
