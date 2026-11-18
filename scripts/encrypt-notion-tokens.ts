/**
 * RAD-221 data migration: seal the Notion tokens already stored in plaintext.
 * Logic and modes: lib/notion-token-backfill.ts. Scheme and rotation:
 * docs/SECURITY.md.
 *
 * Usage (DATABASE_URL and TOKEN_ENC_KEY in env — the same key the app runs with):
 *   npx tsx scripts/encrypt-notion-tokens.ts              # dry run: counts only
 *   npx tsx scripts/encrypt-notion-tokens.ts --apply      # seal plaintext rows
 *   npx tsx scripts/encrypt-notion-tokens.ts --rotate     # also re-seal rows of TOKEN_ENC_KEY_PREVIOUS
 *   npx tsx scripts/encrypt-notion-tokens.ts --decrypt    # rollback: back to plaintext
 *
 * Prints counts, never a token or a user id. Exit 1 when any row failed.
 */

import { db } from "@/lib/db"
import {
  type BackfillMode,
  formatBackfillReport,
  notionTokenTables,
  runNotionTokenBackfill,
} from "@/lib/notion-token-backfill"

function parseMode(argv: string[]): BackfillMode {
  const flags = argv.filter((a) => a.startsWith("--"))
  const known: Record<string, BackfillMode> = { "--apply": "apply", "--rotate": "rotate", "--decrypt": "decrypt" }
  const modes = flags.map((f) => known[f])
  if (modes.some((m) => m === undefined) || modes.length > 1) {
    console.error("Usage: npx tsx scripts/encrypt-notion-tokens.ts [--apply | --rotate | --decrypt]")
    process.exit(2)
  }
  return modes[0] ?? "dry-run"
}

async function main() {
  const mode = parseMode(process.argv.slice(2))
  const report = await runNotionTokenBackfill(notionTokenTables(db as never), mode)
  console.log(formatBackfillReport(report))
  process.exitCode = report.ok ? 0 : 1
}

main()
  .catch((error) => {
    console.error("encrypt-notion-tokens:", (error as Error).message)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
