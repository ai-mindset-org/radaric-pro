/**
 * Data migration for RAD-221: seal (or unseal) the Notion tokens already in the
 * database. Driven by `scripts/encrypt-notion-tokens.ts`; the logic lives here
 * so it can be tested against a fake client.
 *
 * Modes:
 *   dry-run  — count rows by state, write nothing (default)
 *   apply    — seal every plaintext token with TOKEN_ENC_KEY
 *   rotate   — apply, and re-seal tokens sealed with another key
 *              (TOKEN_ENC_KEY_PREVIOUS must still be set to open them)
 *   decrypt  — the rollback: write every sealed token back as plaintext
 *
 * Every write is conditional on the value read (`updateMany where token = old`),
 * so a user saving a new token mid-run is never overwritten; the row is
 * reported as skipped and the next run picks it up. Re-running is safe: a
 * sealed row is left alone by `apply`, a plaintext row by `decrypt`.
 *
 * Output is counts only. No token, sealed or not, and no user id is printed.
 */

import {
  TOKEN_PURPOSE,
  type TokenPurpose,
  currentTokenKeyId,
  decryptToken,
  encryptToken,
  isEncryptedToken,
  tokenKeyId,
} from "@/lib/token-crypto"

export type BackfillMode = "dry-run" | "apply" | "rotate" | "decrypt"

type Row = { key: string; token: string | null }

/** One table's access, narrowed to what the backfill needs. */
export type BackfillTable = {
  name: string
  purpose: TokenPurpose
  list(): Promise<Row[]>
  /** Write `next` only where the stored value is still `prev`. Returns rows changed. */
  swap(key: string, prev: string, next: string): Promise<number>
}

export type TableReport = {
  table: string
  rows: number
  plaintext: number
  sealedCurrent: number
  sealedOther: number
  empty: number
  changed: number
  skippedConcurrent: number
  failed: number
}

export type BackfillReport = { mode: BackfillMode; tables: TableReport[]; ok: boolean }

function classify(token: string | null, currentId: string | null): "empty" | "plaintext" | "sealedCurrent" | "sealedOther" {
  if (!token) return "empty"
  if (!isEncryptedToken(token)) return "plaintext"
  return currentId !== null && tokenKeyId(token) === currentId ? "sealedCurrent" : "sealedOther"
}

async function runTable(table: BackfillTable, mode: BackfillMode, currentId: string | null): Promise<TableReport> {
  const report: TableReport = {
    table: table.name,
    rows: 0,
    plaintext: 0,
    sealedCurrent: 0,
    sealedOther: 0,
    empty: 0,
    changed: 0,
    skippedConcurrent: 0,
    failed: 0,
  }
  const rows = await table.list()
  report.rows = rows.length

  for (const row of rows) {
    const state = classify(row.token, currentId)
    report[state] += 1
    if (mode === "dry-run" || state === "empty" || row.token === null) continue

    let next: string | null = null
    try {
      if (mode === "apply" && state === "plaintext") {
        next = encryptToken(row.token, table.purpose, row.key)
      } else if (mode === "rotate" && state !== "sealedCurrent") {
        next = encryptToken(decryptToken(row.token, table.purpose, row.key), table.purpose, row.key)
      } else if (mode === "decrypt" && state !== "plaintext") {
        next = decryptToken(row.token, table.purpose, row.key)
      }
    } catch {
      // The reason may name a key id but never the value; still, keep the
      // output to counts so nothing row-specific lands in a terminal log.
      report.failed += 1
      continue
    }
    if (next === null) continue

    const changed = await table.swap(row.key, row.token, next)
    if (changed === 1) report.changed += 1
    else report.skippedConcurrent += 1
  }
  return report
}

export async function runNotionTokenBackfill(tables: BackfillTable[], mode: BackfillMode): Promise<BackfillReport> {
  // Throws on a malformed key before anything is written.
  const currentId = currentTokenKeyId()
  if ((mode === "apply" || mode === "rotate") && currentId === null) {
    throw new Error("TOKEN_ENC_KEY is not set: nothing can be sealed")
  }
  const reports: TableReport[] = []
  for (const table of tables) reports.push(await runTable(table, mode, currentId))
  return { mode, tables: reports, ok: reports.every((r) => r.failed === 0) }
}

/** The two columns that hold a Notion token, over a Prisma-like client. */
export function notionTokenTables(client: {
  userSettings: {
    findMany(args: unknown): Promise<{ userId: string; notionToken: string | null }[]>
    updateMany(args: unknown): Promise<{ count: number }>
  }
  settings: {
    findMany(args: unknown): Promise<{ id: string; notionToken: string | null }[]>
    updateMany(args: unknown): Promise<{ count: number }>
  }
}): BackfillTable[] {
  return [
    {
      name: "user_settings.notion_token",
      purpose: TOKEN_PURPOSE.userNotionToken,
      list: async () =>
        (
          await client.userSettings.findMany({
            where: { notionToken: { not: null } },
            select: { userId: true, notionToken: true },
          })
        ).map((r) => ({ key: r.userId, token: r.notionToken })),
      swap: async (key, prev, next) =>
        (await client.userSettings.updateMany({ where: { userId: key, notionToken: prev }, data: { notionToken: next } }))
          .count,
    },
    {
      name: "settings.notion_token (deprecated)",
      purpose: TOKEN_PURPOSE.globalNotionToken,
      list: async () =>
        (
          await client.settings.findMany({
            where: { notionToken: { not: null } },
            select: { id: true, notionToken: true },
          })
        ).map((r) => ({ key: r.id, token: r.notionToken })),
      swap: async (key, prev, next) =>
        (await client.settings.updateMany({ where: { id: key, notionToken: prev }, data: { notionToken: next } })).count,
    },
  ]
}

export function formatBackfillReport(report: BackfillReport): string {
  const lines = [`mode: ${report.mode}`]
  for (const t of report.tables) {
    lines.push(
      `${t.table}: rows=${t.rows} plaintext=${t.plaintext} sealed(current key)=${t.sealedCurrent} ` +
        `sealed(other key)=${t.sealedOther} empty=${t.empty} | changed=${t.changed} ` +
        `skipped(concurrent write)=${t.skippedConcurrent} failed=${t.failed}`,
    )
  }
  lines.push(report.ok ? "result: ok" : "result: FAILED rows — see counts above; nothing else was changed for them")
  return lines.join("\n")
}
