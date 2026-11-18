import { execSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, test, expect } from "vitest"

// scripts/migrate-safe.js runs at every container boot (scripts/start.sh).
// These tests drive its decision logic with a fake exec, so no real prisma or
// database is involved. The module is required lazily: requiring it must not
// start a migration run.
const requireCjs = createRequire(import.meta.url)
const SCRIPT = resolve(__dirname, "../scripts/migrate-safe.js")

type ExecOptions = { stdio?: string; encoding?: string }

const DEPLOY = "npx prisma migrate deploy"
const isResolveQuery = (cmd: string) => cmd.includes("_prisma_migrations")
const isEnumStep = (cmd: string) => cmd.includes("EVENT_TRIGGER")

/**
 * A stand-in for child_process.execSync with the same return contract: with
 * `stdio: "inherit"` it returns null on success (there is no captured output),
 * with `encoding` it returns the captured string, and a failing command throws.
 */
function fakeExec(opts: { deploys: boolean[]; failedRows?: string[] }) {
  const deploys = [...opts.deploys]
  const calls: string[] = []
  const exec = (cmd: string, options: ExecOptions = {}) => {
    calls.push(cmd)
    let ok = true
    let output = ""
    if (cmd === DEPLOY) {
      const next = deploys.shift()
      if (next === undefined) throw new Error(`unexpected extra deploy call`)
      ok = next
    } else if (isResolveQuery(cmd)) {
      output = JSON.stringify((opts.failedRows ?? []).map((migration_name) => ({ migration_name })))
    }
    if (!ok) throw new Error(`Command failed: ${cmd}`)
    return options.stdio === "inherit" ? null : output
  }
  return { exec, calls }
}

function runMain(opts: { deploys: boolean[]; failedRows?: string[] }) {
  const { main } = requireCjs(SCRIPT) as {
    main: (deps: {
      exec: (cmd: string, options?: ExecOptions) => unknown
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    }) => number
  }
  const { exec, calls } = fakeExec(opts)
  const lines: string[] = []
  const code = main({
    exec,
    log: (...args) => lines.push(args.join(" ")),
    error: (...args) => lines.push(args.join(" ")),
  })
  return { code, calls, output: lines.join("\n") }
}

describe("scripts/migrate-safe.js", () => {
  test("premise: execSync with inherited stdio returns null even on success", () => {
    expect(execSync("true", { stdio: "inherit" })).toBeNull()
  })

  test("a successful deploy exits 0 with the success line and never takes the failure path", () => {
    const { code, calls, output } = runMain({ deploys: [true] })

    expect(code).toBe(0)
    expect(output).toContain("[migrate-safe] Migrations applied successfully")
    expect(output).not.toMatch(/failed/i)
    expect(output).not.toContain("WARNING")
    expect(calls).toEqual([DEPLOY])
    expect(calls.some(isResolveQuery)).toBe(false)
    expect(calls.some(isEnumStep)).toBe(false)
  })

  test("a failed deploy resolves the failed row, retries, and exits 0 after a successful retry", () => {
    const { code, calls, output } = runMain({ deploys: [false, true], failedRows: ["20260316100000_add_event_trigger_type"] })

    expect(code).toBe(0)
    expect(output).toContain("prisma migrate deploy failed, attempting to resolve failed migrations")
    expect(output).toContain("Resolving failed migration: 20260316100000_add_event_trigger_type")
    expect(output).toContain("[migrate-safe] Migrations applied successfully after resolve")
    expect(output).not.toContain("WARNING")
    expect(calls).toEqual([
      DEPLOY,
      expect.stringContaining("_prisma_migrations"),
      'npx prisma migrate resolve --applied "20260316100000_add_event_trigger_type"',
      DEPLOY,
    ])
    expect(calls.some(isEnumStep)).toBe(false)
  })

  test("a failed deploy and a failed retry fall through to the enum step and the warning", () => {
    const { code, calls, output } = runMain({ deploys: [false, false], failedRows: ["20260316100000_add_event_trigger_type"] })

    expect(code).toBe(0)
    expect(output).toContain("Resolving failed migration: 20260316100000_add_event_trigger_type")
    expect(output).not.toContain("Migrations applied successfully")
    expect(output).toContain("[migrate-safe] Checking for missing enum values...")
    expect(output).toContain("[migrate-safe] WARNING: Migration issues detected but continuing startup")
    expect(calls.filter((c) => c === DEPLOY)).toHaveLength(2)
    expect(calls.some(isEnumStep)).toBe(true)
  })

  test("node scripts/migrate-safe.js (as start.sh runs it) exits 0 on a successful deploy with no failure lines", () => {
    // Stub `npx` on PATH: `npx prisma migrate deploy` succeeds; anything else
    // fails loudly. DATABASE_URL points at a dead port, and Prisma's dotenv
    // loading never overrides a variable that is already set, so a checkout
    // with a .env still cannot reach a real database on the resolve path.
    const dir = mkdtempSync(join(tmpdir(), "radaric-migrate-safe-"))
    writeFileSync(
      join(dir, "npx"),
      `#!/bin/sh\nif [ "$*" = "prisma migrate deploy" ]; then echo "No pending migrations to apply."; exit 0; fi\necho "unexpected npx $*" >&2\nexit 1\n`,
      { mode: 0o755 },
    )
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }
    env.DATABASE_URL = "postgresql://invalid@127.0.0.1:1/none"
    delete env.DATABASE_PUBLIC_URL

    const res = spawnSync(process.execPath, [SCRIPT], { cwd: resolve(__dirname, ".."), env, encoding: "utf-8" })
    const output = `${res.stdout}\n${res.stderr}`

    expect(res.status).toBe(0)
    expect(output).toContain("[migrate-safe] Migrations applied successfully")
    expect(output).not.toMatch(/deploy failed/i)
    expect(output).not.toContain("WARNING")
    expect(output).not.toContain("unexpected npx")
  })
})
