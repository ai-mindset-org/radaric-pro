/**
 * RAD-380 — "Test Connection" works without the browser holding the token.
 *
 * The settings form no longer has the saved token, so POST
 * /api/settings/test-notion without `token` tests the token saved for this
 * user, opened server-side (RAD-221). A typed token still wins.
 */

import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/db", () => ({
  db: { userSettings: { findUnique: vi.fn() } },
}))
vi.mock("@/lib/auth-utils", () => ({ requireAuth: vi.fn(), isErrorResponse: vi.fn() }))
vi.mock("@/lib/subscription", () => ({ requireActiveSubscription: vi.fn() }))
vi.mock("@/lib/notion", () => ({ testNotionConnection: vi.fn() }))

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { requireActiveSubscription } from "@/lib/subscription"
import { testNotionConnection } from "@/lib/notion"
import { POST } from "@/app/api/settings/test-notion/route"
import { sealNotionToken } from "@/lib/notion-token"

const USER_ID = "user-test-notion"
const TOKEN = "ntn_SAVEDTOKEN_00112233445566778899"
const savedKey = process.env.TOKEN_ENC_KEY

function req(body: unknown) {
  return new NextRequest("http://localhost/api/settings/test-notion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString("hex")
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
  vi.mocked(requireActiveSubscription).mockResolvedValue(null as never)
  vi.mocked(testNotionConnection).mockResolvedValue({ databaseName: "Digest" } as never)
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = savedKey
})

describe("POST /api/settings/test-notion", () => {
  it("tests the saved token, opened server-side, when the body has none", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ notionToken: sealNotionToken(TOKEN, USER_ID) } as never)
    const res = await POST(req({ databaseId: "db-1" }))
    expect(res.status).toBe(200)
    expect(testNotionConnection).toHaveBeenCalledWith(TOKEN, "db-1")
    expect(await res.text()).not.toContain(TOKEN)
  })

  it("prefers a typed token over the saved one", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ notionToken: sealNotionToken(TOKEN, USER_ID) } as never)
    await POST(req({ token: "ntn_TYPED", databaseId: "db-1" }))
    expect(testNotionConnection).toHaveBeenCalledWith("ntn_TYPED", "db-1")
  })

  it("answers 400 when there is neither a typed nor a saved token", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ notionToken: null } as never)
    const res = await POST(req({ databaseId: "db-1" }))
    expect(res.status).toBe(400)
    expect(testNotionConnection).not.toHaveBeenCalled()
  })
})
