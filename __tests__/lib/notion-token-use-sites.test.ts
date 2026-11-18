// @vitest-environment node

/**
 * RAD-221 — every path that hands the stored Notion token to Notion opens it
 * first. A sealed value passed straight to the SDK would fail every export
 * with "API token is invalid" once the backfill runs.
 *
 *  - openNotionTokenOrEmpty: optional-Notion paths degrade to "no export",
 *    logging the reason and never the value;
 *  - sendMaterialToNotion builds its client from the opened token;
 *  - a source guard: no file passes a raw `.notionToken` read into the Notion
 *    SDK or a pipeline-deps factory.
 */

import { randomBytes } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { userSettingsFindUnique, materialFindUnique, materialUpdate, clientAuth } = vi.hoisted(() => ({
  userSettingsFindUnique: vi.fn(),
  materialFindUnique: vi.fn(),
  materialUpdate: vi.fn(),
  clientAuth: vi.fn(),
}))

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: { findUnique: userSettingsFindUnique },
    material: { findUnique: materialFindUnique, update: materialUpdate },
  },
}))

vi.mock("@notionhq/client", () => {
  class Client {
    databases = { retrieve: vi.fn().mockResolvedValue({ id: "db_1", properties: {} }) }
    pages = { create: vi.fn().mockResolvedValue({ id: "page-1", url: "https://notion.so/page-1" }) }
    blocks = { children: { append: vi.fn() } }
    constructor(opts: { auth: string }) {
      clientAuth(opts.auth)
    }
  }
  return { Client }
})

import { sendMaterialToNotion } from "@/lib/notion"
import { openNotionTokenOrEmpty, sealNotionToken } from "@/lib/notion-token"

const USER_ID = "user_1"
const TOKEN = "ntn_USESITE_aabbccddeeff00112233"
const savedKey = process.env.TOKEN_ENC_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TOKEN_ENC_KEY = randomBytes(32).toString("hex")
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = savedKey
  vi.restoreAllMocks()
})

describe("openNotionTokenOrEmpty", () => {
  it("opens a sealed token and passes legacy plaintext through", () => {
    expect(openNotionTokenOrEmpty(sealNotionToken(TOKEN, USER_ID), USER_ID, "t")).toBe(TOKEN)
    expect(openNotionTokenOrEmpty(TOKEN, USER_ID, "t")).toBe(TOKEN)
    expect(openNotionTokenOrEmpty(null, USER_ID, "t")).toBe("")
  })

  it("returns '' when the token does not open, logging the reason without the value", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const sealed = sealNotionToken(TOKEN, USER_ID)
    delete process.env.TOKEN_ENC_KEY
    expect(openNotionTokenOrEmpty(sealed, USER_ID, "poll")).toBe("")
    expect(err).toHaveBeenCalled()
    const logged = JSON.stringify(err.mock.calls)
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain(sealed)
  })
})

describe("sendMaterialToNotion", () => {
  it("builds the Notion client from the opened token, never the sealed value", async () => {
    userSettingsFindUnique.mockResolvedValue({
      userId: USER_ID,
      notionToken: sealNotionToken(TOKEN, USER_ID),
      notionDatabaseId: "db_1",
    })
    materialFindUnique.mockResolvedValue({
      id: "mat_1",
      title: "T",
      content: "Body",
      contentEntities: null,
      url: "https://example.com/p",
      publishedAt: new Date("2026-10-10T10:00:00Z"),
      sourceId: "feed_1",
      thumbnailUrl: null,
      mediaUrls: [],
      feed: { id: "feed_1", name: "Feed", type: "RSS", userId: USER_ID },
    })
    materialUpdate.mockResolvedValue({})

    await sendMaterialToNotion("mat_1", USER_ID)
    expect(clientAuth).toHaveBeenCalledWith(TOKEN)
  })
})

describe("sendMaterialToNotion — a token that does not open", () => {
  it("throws a message fit for the browser, without env names or key ids", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const sealed = sealNotionToken(TOKEN, USER_ID)
    delete process.env.TOKEN_ENC_KEY
    userSettingsFindUnique.mockResolvedValue({ userId: USER_ID, notionToken: sealed, notionDatabaseId: "db_1" })
    materialFindUnique.mockResolvedValue({
      id: "mat_1", title: "T", content: "Body", contentEntities: null, url: "https://example.com/p",
      publishedAt: new Date(), sourceId: "feed_1", thumbnailUrl: null, mediaUrls: [],
      feed: { id: "feed_1", name: "Feed", type: "RSS", userId: USER_ID },
    })
    const error = await sendMaterialToNotion("mat_1", USER_ID).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("The saved Notion token cannot be read. Save it again in Settings.")
    expect(clientAuth).not.toHaveBeenCalled()
  })
})

describe("source guard", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }

  it("no file passes a raw stored token into the Notion SDK or buildPipelineDeps", () => {
    const root = process.cwd()
    const offenders: string[] = []
    const raw = /(new Client\(\{\s*auth:\s*[\w?.]*\.notionToken\b|buildPipelineDeps\([^)]*\.notionToken\b|\.notionToken\s*\?\?\s*"")/
    for (const file of [...walk(join(root, "app")), ...walk(join(root, "lib"))]) {
      const src = readFileSync(file, "utf8")
      if (raw.test(src)) offenders.push(file.slice(root.length + 1))
    }
    expect(offenders).toEqual([])
  })
})
