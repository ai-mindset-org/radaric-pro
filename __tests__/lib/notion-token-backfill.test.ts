// @vitest-environment node

/**
 * RAD-221 — the data migration that seals existing Notion tokens, and its
 * rollback. Runs against an in-memory stand-in for the two Prisma tables.
 *
 * Contract:
 *  - dry-run writes nothing;
 *  - apply seals every plaintext token for its own row, leaves sealed and empty
 *    rows alone, and is idempotent;
 *  - decrypt restores the exact original plaintext (the rollback path);
 *  - rotate re-seals rows of the previous key under the current one;
 *  - a row changed by a user mid-run is skipped, never overwritten;
 *  - a row that cannot be opened is counted as failed, report.ok = false;
 *  - the formatted report carries counts only — no token, no user id.
 */

import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  formatBackfillReport,
  notionTokenTables,
  runNotionTokenBackfill,
} from "@/lib/notion-token-backfill"
import { TOKEN_PURPOSE, decryptToken, encryptToken, isEncryptedToken, tokenKeyId, currentTokenKeyId } from "@/lib/token-crypto"

const KEY_A = randomBytes(32).toString("hex")
const KEY_B = randomBytes(32).toString("hex")
const saved = { cur: process.env.TOKEN_ENC_KEY, prev: process.env.TOKEN_ENC_KEY_PREVIOUS }

type UserRow = { userId: string; notionToken: string | null }
type GlobalRow = { id: string; notionToken: string | null }

const calls: { op: string; args: unknown }[] = []

function fakeClient(users: UserRow[], globals: GlobalRow[], beforeSwap?: (key: string) => void) {
  return {
    userSettings: {
      findMany: async (args: unknown) => {
        calls.push({ op: "userSettings.findMany", args })
        return users.filter((r) => r.notionToken !== null).map((r) => ({ ...r }))
      },
      updateMany: async ({ where, data }: any) => {
        calls.push({ op: "userSettings.updateMany", args: { where, data } })
        beforeSwap?.(where.userId)
        const row = users.find((r) => r.userId === where.userId && r.notionToken === where.notionToken)
        if (!row) return { count: 0 }
        row.notionToken = data.notionToken
        return { count: 1 }
      },
    },
    settings: {
      findMany: async (args: unknown) => {
        calls.push({ op: "settings.findMany", args })
        return globals.filter((r) => r.notionToken !== null).map((r) => ({ ...r }))
      },
      updateMany: async ({ where, data }: any) => {
        calls.push({ op: "settings.updateMany", args: { where, data } })
        const row = globals.find((r) => r.id === where.id && r.notionToken === where.notionToken)
        if (!row) return { count: 0 }
        row.notionToken = data.notionToken
        return { count: 1 }
      },
    },
  }
}

const U = TOKEN_PURPOSE.userNotionToken

beforeEach(() => {
  calls.length = 0
  process.env.TOKEN_ENC_KEY = KEY_A
  delete process.env.TOKEN_ENC_KEY_PREVIOUS
})

afterEach(() => {
  if (saved.cur === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = saved.cur
  if (saved.prev === undefined) delete process.env.TOKEN_ENC_KEY_PREVIOUS
  else process.env.TOKEN_ENC_KEY_PREVIOUS = saved.prev
})

function seed() {
  const users: UserRow[] = [
    { userId: "u1", notionToken: "ntn_PLAIN_ONE_111111" },
    { userId: "u2", notionToken: "secret_PLAIN_TWO_222222" },
    { userId: "u3", notionToken: "" },
    { userId: "u4", notionToken: null },
  ]
  users.push({ userId: "u5", notionToken: encryptToken("ntn_ALREADY_SEALED_555", U, "u5") })
  const globals: GlobalRow[] = [{ id: "g1", notionToken: "secret_GLOBAL_LEGACY_999" }]
  return { users, globals }
}

describe("runNotionTokenBackfill", () => {
  it("dry-run counts states and writes nothing", async () => {
    const { users, globals } = seed()
    const before = JSON.stringify({ users, globals })
    const report = await runNotionTokenBackfill(notionTokenTables(fakeClient(users, globals)), "dry-run")
    expect(JSON.stringify({ users, globals })).toBe(before)
    expect(report.tables[0]).toMatchObject({ rows: 4, plaintext: 2, sealedCurrent: 1, empty: 1, changed: 0 })
    expect(report.tables[1]).toMatchObject({ rows: 1, plaintext: 1, changed: 0 })
  })

  it("apply seals plaintext rows for their own row, is idempotent, and decrypt restores the originals", async () => {
    const { users, globals } = seed()
    const original = JSON.parse(JSON.stringify({ users, globals }))
    const tables = notionTokenTables(fakeClient(users, globals))

    const applied = await runNotionTokenBackfill(tables, "apply")
    expect(applied.ok).toBe(true)
    expect(applied.tables[0].changed).toBe(2)
    expect(applied.tables[1].changed).toBe(1)
    for (const r of users.filter((r) => r.notionToken)) {
      expect(isEncryptedToken(r.notionToken)).toBe(true)
    }
    expect(decryptToken(users[0].notionToken!, U, "u1")).toBe("ntn_PLAIN_ONE_111111")
    expect(decryptToken(globals[0].notionToken!, TOKEN_PURPOSE.globalNotionToken, "g1")).toBe("secret_GLOBAL_LEGACY_999")
    expect(users[2].notionToken).toBe("")
    expect(users[3].notionToken).toBeNull()

    const again = await runNotionTokenBackfill(tables, "apply")
    expect(again.tables[0].changed).toBe(0)
    expect(again.tables[1].changed).toBe(0)

    const rolledBack = await runNotionTokenBackfill(tables, "decrypt")
    expect(rolledBack.ok).toBe(true)
    expect({ users, globals }).toEqual({
      ...original,
      users: original.users.map((r: UserRow) =>
        r.userId === "u5" ? { ...r, notionToken: "ntn_ALREADY_SEALED_555" } : r,
      ),
    })
  })

  it("rotate re-seals rows of the previous key under the current one", async () => {
    const { users, globals } = seed()
    const tables = notionTokenTables(fakeClient(users, globals))
    await runNotionTokenBackfill(tables, "apply")
    const oldId = currentTokenKeyId()

    process.env.TOKEN_ENC_KEY = KEY_B
    process.env.TOKEN_ENC_KEY_PREVIOUS = KEY_A
    const dry = await runNotionTokenBackfill(tables, "dry-run")
    expect(dry.tables[0].sealedOther).toBe(3)

    const rotated = await runNotionTokenBackfill(tables, "rotate")
    expect(rotated.ok).toBe(true)
    expect(rotated.tables[0].changed).toBe(3)
    for (const r of users.filter((r) => r.notionToken)) {
      expect(tokenKeyId(r.notionToken!)).not.toBe(oldId)
    }
    delete process.env.TOKEN_ENC_KEY_PREVIOUS
    expect(decryptToken(users[1].notionToken!, U, "u2")).toBe("secret_PLAIN_TWO_222222")
  })

  it("skips a row a user changed mid-run instead of overwriting it", async () => {
    const { users, globals } = seed()
    const client = fakeClient(users, globals, (key) => {
      if (key === "u1") users[0].notionToken = "ntn_USER_SAVED_NEW_TOKEN"
    })
    const report = await runNotionTokenBackfill(notionTokenTables(client), "apply")
    expect(report.tables[0].skippedConcurrent).toBe(1)
    expect(users[0].notionToken).toBe("ntn_USER_SAVED_NEW_TOKEN")
  })

  it("counts a row it cannot open as failed and marks the run not ok", async () => {
    const { users, globals } = seed()
    const tables = notionTokenTables(fakeClient(users, globals))
    process.env.TOKEN_ENC_KEY = KEY_B // u5 was sealed with KEY_A, which is now gone
    const report = await runNotionTokenBackfill(tables, "decrypt")
    expect(report.tables[0].failed).toBe(1)
    expect(report.ok).toBe(false)
  })

  it("refuses apply without TOKEN_ENC_KEY before writing anything", async () => {
    const { users, globals } = seed()
    delete process.env.TOKEN_ENC_KEY
    await expect(runNotionTokenBackfill(notionTokenTables(fakeClient(users, globals)), "apply")).rejects.toThrow(
      /TOKEN_ENC_KEY/,
    )
    expect(users[0].notionToken).toBe("ntn_PLAIN_ONE_111111")
  })

  it("queries Prisma with the schema's field names and conditional, per-row writes", async () => {
    const { users, globals } = seed()
    await runNotionTokenBackfill(notionTokenTables(fakeClient(users, globals)), "apply")
    expect(calls.find((c) => c.op === "userSettings.findMany")?.args).toEqual({
      where: { notionToken: { not: null } },
      select: { userId: true, notionToken: true },
    })
    expect(calls.find((c) => c.op === "settings.findMany")?.args).toEqual({
      where: { notionToken: { not: null } },
      select: { id: true, notionToken: true },
    })
    const write = calls.find((c) => c.op === "userSettings.updateMany")?.args as any
    expect(write.where).toEqual({ userId: "u1", notionToken: "ntn_PLAIN_ONE_111111" })
    expect(isEncryptedToken(write.data.notionToken)).toBe(true)
    const globalWrite = calls.find((c) => c.op === "settings.updateMany")?.args as any
    expect(globalWrite.where).toEqual({ id: "g1", notionToken: "secret_GLOBAL_LEGACY_999" })
  })

  it("prints counts only: no token, sealed value or user id in the report", async () => {
    const { users, globals } = seed()
    const report = await runNotionTokenBackfill(notionTokenTables(fakeClient(users, globals)), "apply")
    const text = formatBackfillReport(report)
    for (const r of [...users, ...globals]) {
      if (r.notionToken) expect(text).not.toContain(r.notionToken)
    }
    for (const needle of ["PLAIN", "GLOBAL_LEGACY", "enc:v1:", "u1", "u2", "g1"]) {
      expect(text).not.toContain(needle)
    }
    expect(text).toContain("changed=2")
  })
})
