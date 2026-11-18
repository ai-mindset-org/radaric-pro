/**
 * PATCH /api/user-settings — typography preference persistence (RAD-363, slice 5)
 *
 * Contract: .tdd/spec-typography-patch.md
 *   - `UserSettings.typography Json?` column + additive migration
 *   - PATCH validates `typography` through the real `validateTypographyInput`
 *     (lib/typography/prefs.ts — deliberately NOT mocked): a valid four-role
 *     object stores the validator's copy, `null` stores Prisma.DbNull, anything
 *     else refuses the whole request (400, nothing written)
 *   - PUT never writes `typography`
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { Prisma } from "@prisma/client"

vi.mock("@/lib/db", () => ({
  db: {
    userSettings: {
      upsert: vi.fn(),
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

import { db } from "@/lib/db"
import { requireAuth, isErrorResponse } from "@/lib/auth-utils"
import { PATCH, PUT } from "@/app/api/user-settings/route"

const USER_ID = "user-typography-1"
const ROOT = join(__dirname, "..", "..")

const VALID_TYPOGRAPHY = {
  heading: "martian-grotesk",
  text: "inter",
  counter: "martian-mono",
  tag: "pt-root-ui",
}

function setupAuth() {
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupUnauth() {
  const res = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  vi.mocked(requireAuth).mockResolvedValue(res as never)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/user-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function patchRawRequest(text: string) {
  return new Request("http://localhost/api/user-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: text,
  })
}

function putRequest(body: unknown) {
  return new Request("http://localhost/api/user-settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function upsertArg(): any {
  return vi.mocked(db.userSettings.upsert).mock.calls[0][0]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(db.userSettings.upsert).mockResolvedValue({} as never)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("UserSettings.typography — schema and migration", () => {
  it('AC-1: schema declares typography Json? @map("typography") and an additive migration adds the JSONB column', () => {
    const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")
    const model = schema.match(/^model UserSettings \{[\s\S]*?^\}/m)
    expect(model).not.toBeNull()
    expect(/^\s*typography\s+Json\?\s+@map\("typography"\)\s*$/m.test(model![0])).toBe(true)

    const migrationsDir = join(ROOT, "prisma", "migrations")
    const baseline = readdirSync(migrationsDir, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith("_public_baseline"))
    if (baseline) {
      // The source-available tree squashes the migration history into one
      // baseline, so there the column is created with the table itself.
      const sql = readFileSync(join(migrationsDir, baseline.name, "migration.sql"), "utf8")
      const table = sql.match(/CREATE TABLE "user_settings" \(([\s\S]*?)\n\);/)
      expect(table).not.toBeNull()
      expect(/^\s*"typography" JSONB,?$/m.test(table![1])).toBe(true)
      return
    }
    const expected = 'ALTER TABLE "user_settings" ADD COLUMN "typography" JSONB;'
    const matching = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(migrationsDir, entry.name, "migration.sql"))
      .filter((file) => existsSync(file))
      .filter((file) => {
        const content = readFileSync(file, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("--"))
          .join("\n")
        return content === expected
      })
    expect(matching.length).toBe(1)
  })
})

describe("PATCH /api/user-settings — typography", () => {
  it("AC-2: a valid four-role object returns 200 and upserts it in update and create", async () => {
    setupAuth()
    const res = await PATCH(patchRequest({ typography: VALID_TYPOGRAPHY }))

    expect(res.status).toBe(200)
    expect(db.userSettings.upsert).toHaveBeenCalledTimes(1)
    const arg = upsertArg()
    expect(arg.where).toEqual({ userId: USER_ID })
    expect(arg.update.typography).toEqual(VALID_TYPOGRAPHY)
    expect(arg.create.typography).toEqual(VALID_TYPOGRAPHY)
    expect(arg.create.userId).toBe(USER_ID)
  })

  it("AC-2b: the four new registry ids are accepted and stored", async () => {
    setupAuth()
    const body = {
      heading: "golos-text",
      text: "ibm-plex-sans",
      counter: "jetbrains-mono",
      tag: "ibm-plex-mono",
    }
    const res = await PATCH(patchRequest({ typography: body }))

    expect(res.status).toBe(200)
    const arg = upsertArg()
    expect(arg.update.typography).toEqual(body)
    expect(arg.create.typography).toEqual(body)
  })

  it("AC-3: the stored typography is the validator's copy, not the parsed body object", async () => {
    setupAuth()
    const bodyTypography = { ...VALID_TYPOGRAPHY }
    const body = { typography: bodyTypography }
    // A request whose json() hands the route this exact object, so the
    // reference the route receives is the one we hold.
    const request = { json: async () => body } as unknown as Request

    const res = await PATCH(request)

    expect(res.status).toBe(200)
    const arg = upsertArg()
    expect(arg.update.typography).toEqual(VALID_TYPOGRAPHY)
    expect(arg.update.typography).not.toBe(bodyTypography)
    expect(arg.create.typography).toEqual(VALID_TYPOGRAPHY)
    expect(arg.create.typography).not.toBe(bodyTypography)
  })

  it("AC-4: typography null returns 200 and upserts Prisma.DbNull in update and create", async () => {
    setupAuth()
    const res = await PATCH(patchRequest({ typography: null }))

    expect(res.status).toBe(200)
    expect(db.userSettings.upsert).toHaveBeenCalledTimes(1)
    const arg = upsertArg()
    expect(arg.update.typography).toBe(Prisma.DbNull)
    expect(arg.create.typography).toBe(Prisma.DbNull)
  })

  it("AC-5: an unknown font id returns 400 with an error string and writes nothing", async () => {
    setupAuth()
    const res = await PATCH(
      patchRequest({ typography: { heading: "inter", text: "comic-sans", counter: "inter", tag: "inter" } }),
    )

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(typeof json.error).toBe("string")
    expect(json.error.length).toBeGreaterThan(0)
    expect(json.error.includes("comic-sans")).toBe(false)
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })

  it("AC-6: a bad typography value refuses the whole request — globalPrompt is not saved either", async () => {
    setupAuth()
    const res = await PATCH(patchRequest({ globalPrompt: "hello", typography: ["inter"] }))

    expect(res.status).toBe(400)
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })

  it("AC-7: without a typography key the upsert data has no typography key (unchanged behavior)", async () => {
    setupAuth()
    const res = await PATCH(patchRequest({ globalPrompt: "hello" }))

    expect(res.status).toBe(200)
    expect(db.userSettings.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: { globalPrompt: "hello" },
      create: { userId: USER_ID, globalPrompt: "hello" },
    })
  })

  it("EC-1: an extra key or an own __proto__ key returns 400 and writes nothing", async () => {
    setupAuth()
    const extra = await PATCH(
      patchRequest({
        typography: { heading: "inter", text: "inter", counter: "inter", tag: "inter", extra: "inter" },
      }),
    )
    expect(extra.status).toBe(400)

    const proto = await PATCH(
      patchRawRequest(
        '{"typography":{"__proto__":{"x":1},"heading":"inter","text":"inter","counter":"inter","tag":"inter"}}',
      ),
    )
    expect(proto.status).toBe(400)

    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })

  it("ERR-1: an unauthenticated PATCH with a valid typography body returns 401 and writes nothing", async () => {
    setupUnauth()
    const res = await PATCH(patchRequest({ typography: VALID_TYPOGRAPHY }))

    expect(res.status).toBe(401)
    expect(db.userSettings.upsert).not.toHaveBeenCalled()
  })
})

describe("PUT /api/user-settings — never writes typography", () => {
  const putBody = {
    globalPrompt: "prompt",
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
    globalLikedCategories: ["Articles"],
    globalDislikedCategories: ["Ads"],
    typography: { heading: "sf-pro", text: "sf-pro", counter: "sf-mono", tag: "sf-pro" },
  }

  it("AC-8: neither the update branch nor the create branch writes a typography key", async () => {
    setupAuth()

    // Existing row → update branch
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ id: "s-1", userId: USER_ID } as never)
    vi.mocked(db.userSettings.update).mockResolvedValue({ id: "s-1", userId: USER_ID } as never)
    const updated = await PUT(putRequest(putBody))
    expect(updated.status).toBe(200)
    expect(db.userSettings.update).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateArg = vi.mocked(db.userSettings.update).mock.calls[0][0] as any
    expect(updateArg.data.globalPrompt).toBe("prompt")
    expect(Object.hasOwn(updateArg.data, "typography")).toBe(false)

    // No row → create branch
    vi.mocked(db.userSettings.findUnique).mockResolvedValue(null as never)
    vi.mocked(db.userSettings.create).mockResolvedValue({ id: "s-2", userId: USER_ID } as never)
    const created = await PUT(putRequest(putBody))
    expect(created.status).toBe(200)
    expect(db.userSettings.create).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const createArg = vi.mocked(db.userSettings.create).mock.calls[0][0] as any
    expect(createArg.data.userId).toBe(USER_ID)
    expect(Object.hasOwn(createArg.data, "typography")).toBe(false)
  })
})
