// @vitest-environment node

/**
 * RAD-288 — docs truth.
 *
 * `.env.example` is the self-host contract; it can be wrong in both
 * directions (vars that don't exist, missing vars that do). These assertions
 * keep it honest against the code rather than against older docs:
 *
 *  - every uncommented KEY in `.env.example` is actually read via
 *    `process.env` somewhere, or is on the small library/platform allowlist;
 *  - the dead vars never come back (Telegram/Parallel/Notion env lies, the
 *    removed AUTH_USER);
 *  - SELF_HOSTING.md carries the compose quick start and the first-admin truth.
 */

import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it, expect } from "vitest"

// Read by libraries/platform/tooling rather than this repo's source.
const LIBRARY_PROVIDED = new Set([
  "NEXTAUTH_SECRET", // next-auth reads AUTH_SECRET ?? NEXTAUTH_SECRET
  "OPENAI_API_KEY", // the OpenAI SDK ctor reads it implicitly (pipeline-deps.ts)
  "PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING", // Prisma CLI
])

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git" || entry === "coverage") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) collectSourceFiles(path, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(entry)) out.push(path)
  }
  return out
}

const sourceCorpus = [
  ...collectSourceFiles("app"),
  ...collectSourceFiles("lib"),
  ...collectSourceFiles("components"),
  ...collectSourceFiles("scripts"),
  ...["instrumentation.ts", "proxy.ts", "next.config.ts", "vitest.config.ts", "worker.ts"]
    .filter((f) => { try { return statSync(f).isFile() } catch { return false } })
    .map((f) => f),
]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n")

const envExample = readFileSync(".env.example", "utf8")
const assignedKeys = envExample
  .split("\n")
  .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
  .map((line) => line.split("=")[0])

// Wrap-tolerant: prose assertions must not depend on line breaks.
const selfHosting = readFileSync("SELF_HOSTING.md", "utf8").replace(/\s+/g, " ")

/** Parse `KEY=value` lines of a dotenv file into a map. */
function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** Count `KEY=` lines (a duplicate append would otherwise pass silently). */
function countKey(content: string, key: string): number {
  return content.split("\n").filter((line) => line.startsWith(`${key}=`)).length
}

const HEX_64 = /^[0-9a-f]{64}$/
const HEX_48 = /^[0-9a-f]{48}$/

const GENERATOR_SCRIPT = join(process.cwd(), "scripts", "generate-env.sh")

describe("scripts/generate-env.sh (B1/B3)", () => {
  // The quick start runs this committed script, so the test executes the same
  // file the operator does — not a copy pasted into the document.
  function runGenerator(initialEnv?: string) {
    const dir = mkdtempSync(join(tmpdir(), "radaric-env-"))
    if (initialEnv !== undefined) writeFileSync(join(dir, ".env"), initialEnv)
    const run = spawnSync("sh", [GENERATOR_SCRIPT], { cwd: dir, encoding: "utf8" })
    const envPath = join(dir, ".env")
    const content = existsSync(envPath) ? readFileSync(envPath, "utf8") : ""
    return { status: run.status, stderr: run.stderr, dir, content, vars: parseEnvFile(content) }
  }

  it("creates both secrets in a fresh directory, hex and URL-safe", () => {
    const { status, vars, content } = runGenerator()
    expect(status).toBe(0)
    expect(vars.NEXTAUTH_SECRET).toMatch(HEX_64)
    expect(vars.POSTGRES_PASSWORD).toMatch(HEX_48)
    // POSTGRES_PASSWORD goes into a postgresql:// URL verbatim.
    expect(vars.POSTGRES_PASSWORD).not.toMatch(/[+/=]/)
    expect(countKey(content, "NEXTAUTH_SECRET")).toBe(1)
    expect(countKey(content, "POSTGRES_PASSWORD")).toBe(1)
    // RAD-221: the token-sealing key is generated alongside, 32 bytes as hex.
    expect(vars.TOKEN_ENC_KEY).toMatch(HEX_64)
    expect(vars.TOKEN_ENC_KEY).not.toBe(vars.NEXTAUTH_SECRET)
    expect(countKey(content, "TOKEN_ENC_KEY")).toBe(1)
  })

  it('fills empty values — the .env.example shape (`KEY=""`, `KEY=`) — without duplicating them', () => {
    const { status, vars, content } = runGenerator('NEXTAUTH_SECRET=""\nPOSTGRES_PASSWORD=\nSELF_HOSTED=\n')
    expect(status).toBe(0)
    expect(vars.NEXTAUTH_SECRET).toMatch(HEX_64)
    expect(vars.POSTGRES_PASSWORD).toMatch(HEX_48)
    expect(countKey(content, "NEXTAUTH_SECRET")).toBe(1)
    expect(countKey(content, "POSTGRES_PASSWORD")).toBe(1)
    // Everything else is preserved untouched.
    expect(vars.SELF_HOSTED).toBe("")
  })

  it("never overwrites values the operator already set", () => {
    const initial = 'NEXTAUTH_SECRET="already-set"\nPOSTGRES_PASSWORD=deadbeef\nTOKEN_ENC_KEY=keep-me\nKEEP=1\n'
    const { status, content } = runGenerator(initial)
    expect(status).toBe(0)
    expect(content).toBe(initial)
  })

  it("RAD-221: adds TOKEN_ENC_KEY to an install that predates it, leaving every other line alone", () => {
    const initial = 'NEXTAUTH_SECRET="already-set"\nPOSTGRES_PASSWORD=deadbeef\nKEEP=1\n'
    const { status, vars, content } = runGenerator(initial)
    expect(status).toBe(0)
    expect(content.startsWith(initial)).toBe(true)
    expect(vars.TOKEN_ENC_KEY).toMatch(HEX_64)
    expect(countKey(content, "TOKEN_ENC_KEY")).toBe(1)
  })

  it("rewrites in place: the inode and the file mode survive", () => {
    // An empty key forces the rewrite path (temp file + `cat > .env`).
    const dir = mkdtempSync(join(tmpdir(), "radaric-env-"))
    const envPath = join(dir, ".env")
    writeFileSync(envPath, 'NEXTAUTH_SECRET=""\n')
    chmodSync(envPath, 0o640)
    const before = statSync(envPath)

    const run = spawnSync("sh", [GENERATOR_SCRIPT], { cwd: dir, encoding: "utf8" })

    expect(run.status).toBe(0)
    const after = statSync(envPath)
    expect(after.mode & 0o777).toBe(0o640)
    expect(after.ino).toBe(before.ino)
    expect(parseEnvFile(readFileSync(envPath, "utf8")).NEXTAUTH_SECRET).toMatch(HEX_64)
  })

  it("keeps a symlinked .env a symlink and writes through to its target", () => {
    const dir = mkdtempSync(join(tmpdir(), "radaric-env-link-"))
    writeFileSync(join(dir, "real.env"), 'NEXTAUTH_SECRET=""\n')
    symlinkSync("real.env", join(dir, ".env"))

    const run = spawnSync("sh", [GENERATOR_SCRIPT], { cwd: dir, encoding: "utf8" })

    expect(run.status).toBe(0)
    expect(lstatSync(join(dir, ".env")).isSymbolicLink()).toBe(true)
    expect(parseEnvFile(readFileSync(join(dir, "real.env"), "utf8")).NEXTAUTH_SECRET).toMatch(HEX_64)
  })

  it("recognises the other dotenv shapes compose accepts — `export KEY=` and `KEY = value`", () => {
    const keep = 'export NEXTAUTH_SECRET="already-set"\nPOSTGRES_PASSWORD = "deadbeef"\nTOKEN_ENC_KEY="set"\n'
    expect(runGenerator(keep).content).toBe(keep)

    // Empty in those shapes is filled and the empty assignment is replaced,
    // never duplicated: compose reads the LAST value, so a duplicate would
    // silently rotate a secret the database volume still expects.
    const empty = "export NEXTAUTH_SECRET=\nPOSTGRES_PASSWORD = ''\n"
    const { status, vars, content } = runGenerator(empty)
    expect(status).toBe(0)
    expect(vars.NEXTAUTH_SECRET).toMatch(HEX_64)
    expect(vars.POSTGRES_PASSWORD).toMatch(HEX_48)
    expect(countKey(content, "NEXTAUTH_SECRET")).toBe(1)
    expect(countKey(content, "POSTGRES_PASSWORD")).toBe(1)
    expect(content).not.toContain("export NEXTAUTH_SECRET")
  })

  it("stops with 'edit by hand' instead of appending a second assignment for a shape it cannot rewrite", () => {
    const colon = runGenerator("NEXTAUTH_SECRET: abc\n")
    expect(colon.status).not.toBe(0)
    expect(colon.stderr).toContain("edit NEXTAUTH_SECRET by hand in .env")
    // The file is untouched: no second assignment was appended.
    expect(colon.content).toBe("NEXTAUTH_SECRET: abc\n")

    const comment = runGenerator("NEXTAUTH_SECRET= # set me\n")
    expect(comment.status).not.toBe(0)
    expect(comment.stderr).toContain("edit NEXTAUTH_SECRET by hand in .env")
    expect(comment.content).toBe("NEXTAUTH_SECRET= # set me\n")
  })

  it("runs against the real .env.example: fills both secrets, preserves every other key", () => {
    const initial = readFileSync(".env.example", "utf8")
    const { status, vars, content } = runGenerator(initial)

    expect(status).toBe(0)
    expect(vars.NEXTAUTH_SECRET).toMatch(HEX_64)
    expect(vars.POSTGRES_PASSWORD).toMatch(HEX_48)
    expect(countKey(content, "NEXTAUTH_SECRET")).toBe(1)
    expect(countKey(content, "POSTGRES_PASSWORD")).toBe(1)
    // Keys the file already sets are untouched.
    expect(vars.DATABASE_URL).toBe('"postgresql://user:password@host:5432/radaric"')
    expect(vars.OPENROUTER_API_KEY).toBe('""')
  })
})

describe(".env.example truth", () => {
  it("has assignments to check", () => {
    expect(assignedKeys.length).toBeGreaterThan(5)
  })

  it("documents only variables that are actually read", () => {
    const unread = assignedKeys.filter(
      (key) => !LIBRARY_PROVIDED.has(key) && !sourceCorpus.includes(`process.env.${key}`)
    )
    expect(unread, `env vars in .env.example with no process.env read: ${unread.join(", ")}`).toEqual([])
  })

  it("never re-introduces dead variables", () => {
    for (const dead of ["AUTH_USER", "AUTH_PASSWORD_HASH", "PARALLEL_API_KEY", "PARALLEL_WEBHOOK_SECRET", "NOTION_TOKEN", "TELEGRAM_API_ID", "TELEGRAM_API_HASH"]) {
      expect(assignedKeys, `${dead} must not be an env assignment`).not.toContain(dead)
    }
    // …but they are named as NOT-env-vars so the next reader isn't tempted.
    expect(envExample).toContain("NOT ENV VARS")
  })
})

describe("SELF_HOSTING.md", () => {
  it("gives the compose quick start and the first-admin truth", () => {
    expect(selfHosting).toContain("sh scripts/generate-env.sh")
    expect(selfHosting).toContain("docker compose up -d --build")
    expect(selfHosting.toLowerCase()).toContain("first account you create becomes the administrator")
    expect(selfHosting).toContain("stop_grace_period")
  })

  it("states that Telegram/Parallel/Notion are not env vars", () => {
    expect(selfHosting).toContain("NOT environment variables")
  })
})

describe("SELF_HOSTING.md — the traps a stranger hits (D2–D7, D9)", () => {
  it("documents EMAIL_FROM on a domain verified in the hoster's Resend account", () => {
    expect(envExample).toContain("EMAIL_FROM=")
    expect(selfHosting).toContain("EMAIL_FROM")
    expect(selfHosting.toLowerCase()).toContain("verified in your resend account")
  })

  it("says a domain deployment must set both public URLs", () => {
    expect(selfHosting).toContain("NEXT_PUBLIC_APP_URL")
    expect(selfHosting).toContain("NEXTAUTH_URL")
    expect(selfHosting).toMatch(/on a real domain/i)
  })

  it("says an Anthropic-only key needs the switchable stages, including the two Telegram ones", () => {
    expect(selfHosting).toContain("Settings → AI Settings")
    expect(selfHosting).toMatch(/filtering, synthesis,\s*discovery/i)
    expect(selfHosting).toMatch(/Telegram story writer/i)
    expect(selfHosting).toMatch(/deduplication/i)
    expect(selfHosting).toContain("OpenRouter-only")
  })

  it("names the story inbox channel as the second Telegram requirement, with its symptom", () => {
    expect(selfHosting).toContain("story inbox channel")
    expect(selfHosting).toContain("GramJS client not available")
  })

  it("warns that POSTGRES_PASSWORD must not be regenerated once the volume exists", () => {
    expect(selfHosting).toMatch(/never regenerate `?POSTGRES_PASSWORD/i)
    expect(selfHosting).toContain("ALTER USER radaric PASSWORD")
  })

  it("says requiring email verification needs ALLOW_UNVERIFIED_SIGNUP=0", () => {
    expect(selfHosting).toContain("ALLOW_UNVERIFIED_SIGNUP=0")
  })

  it("puts the AI key before the first feed and says a feed parse stores nothing without it", () => {
    expect(selfHosting).toMatch(/before your first feed/i)
    expect(selfHosting).toMatch(/parse of a feed[^.]*stores nothing/i)
  })

  it("warns a bare-metal install to keep port 3001 private", () => {
    expect(selfHosting).toMatch(/keep port 3001 private/i)
  })

  it("requires a direct Postgres connection, not a transaction pooler", () => {
    expect(selfHosting.toLowerCase()).toContain("transaction-mode pooler")
    expect(selfHosting).toMatch(/session-level advisory locks/i)
  })

  it("says selling subscriptions needs SELF_HOSTED=false, not just Stripe keys", () => {
    expect(selfHosting).toMatch(/SELF_HOSTED.*`?false/i)
  })
})
