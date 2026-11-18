// @vitest-environment node

/**
 * RAD-292 — the self-host end-to-end check.
 *
 * The full run needs Docker, so it happens in CI. What these assertions pin is
 * the part that rots silently: the script runs the commands the guide tells a
 * stranger to run, every compose call stays on the `radaric-e2e` project, a
 * failed precondition never touches the checkout's `.env`, and the fixture feed
 * stays synthetic.
 *
 * The ownership tests execute the real script against a logging `docker` stub,
 * so they need no daemon and no containers.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, it, expect } from "vitest"

const script = readFileSync("scripts/selfhost-e2e.sh", "utf8")
// A `# docker compose …` comment must not satisfy a check for a call.
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n")
const guide = readFileSync("SELF_HOSTING.md", "utf8")
const feed = readFileSync("scripts/selfhost-e2e/feed.xml", "utf8")
// The private tree carries this file as its own workflow; the published tree
// ships the public copy at the same path. Both run the check at the repo root.
const workflow = readFileSync(".github/workflows/selfhost-e2e.yml", "utf8")

/** No `docker` daemon here: the stub logs its argv and answers from env vars. */
const DOCKER_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_STUB_LOG"
case "$1" in
  info) exit "\${DOCKER_STUB_INFO:-0}" ;;
  ps|inspect|volume) exit 0 ;;
  compose)
    shift
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p|--project-name|-f|--file) shift; [ "$#" -gt 0 ] && shift ;;
        -*) shift ;;
        *) sub="$1"; break ;;
      esac
    done
    case "\${sub:-}" in
      up) exit "\${DOCKER_STUB_UP:-0}" ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 0 ;;
esac
`

/** A throwaway checkout the script can run in, on a port nothing listens to. */
function fixtureTree(): { dir: string; bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "radaric-e2e-fixture-"))
  mkdirSync(join(dir, "scripts"), { recursive: true })
  mkdirSync(join(dir, "prisma", "migrations", "20261022180001_public_baseline"), { recursive: true })
  writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n")
  writeFileSync(join(dir, "scripts", "generate-env.sh"), readFileSync("scripts/generate-env.sh", "utf8"))
  writeFileSync(
    join(dir, "scripts", "selfhost-e2e.sh"),
    script.replace(/^PORT=3000$/m, `PORT=${freePort()}`)
  )

  const bin = join(dir, "bin")
  mkdirSync(bin)
  const log = join(dir, "docker.log")
  writeFileSync(join(bin, "docker"), DOCKER_STUB)
  chmodSync(join(bin, "docker"), 0o755)
  return { dir, bin, log }
}

/** A port in 39000–39099 with nothing listening on it. */
function freePort(): number {
  for (let port = 39000; port < 39100; port++) {
    const busy = spawnSync("bash", ["-c", `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null`]).status === 0
    if (!busy) return port
  }
  throw new Error("no free port in 39000-39099")
}

function runScript(dir: string, bin: string, log: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [join(dir, "scripts", "selfhost-e2e.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      DOCKER_STUB_LOG: log,
      SELFHOST_E2E_KEEP: "0",
      SELFHOST_E2E_USE_EXISTING_ENV: "",
      ...extraEnv,
    },
  })
}

const dockerCalls = (log: string): string[] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []

/** Every docker call is either read-only or pinned to the throwaway project. */
function expectSafeDockerCalls(log: string): void {
  for (const call of dockerCalls(log)) {
    const readOnly = /^(info|ps|inspect|volume|version)\b/.test(call)
    expect(readOnly || call.includes("-p radaric-e2e"), `unpinned docker call: ${call}`).toBe(true)
  }
}

describe("scripts/selfhost-e2e.sh", () => {
  it("runs the quick start from SELF_HOSTING.md, so the guide and the check cannot drift", () => {
    expect(code).toContain("sh scripts/generate-env.sh")
    expect(guide).toContain("sh scripts/generate-env.sh")
    expect(code).toContain("dc up -d --build")
    expect(guide).toContain("docker compose up -d --build")
  })

  it("pins every compose call to the radaric-e2e project", () => {
    // The project name is what keeps the check off a real install's containers
    // and its db-data volume. A call without it is a regression, not a style
    // choice, so the assertion runs per line.
    const composeLines = code.split("\n").filter((line) => line.includes("docker compose"))
    expect(composeLines.length).toBeGreaterThan(0)
    for (const line of composeLines) {
      expect(line, `compose call without -p radaric-e2e: ${line}`).toContain("-p radaric-e2e")
    }
    expect(code).toContain("-f scripts/selfhost-e2e/compose.fixture.yml")
  })

  it("removes its volumes on the way out and reports a single verdict line", () => {
    expect(code).toContain("down -v --remove-orphans")
    expect(code).toContain("SELFHOST-E2E: PASS")
    expect(code).toContain("SELFHOST-E2E: FAIL")
  })

  it("refuses the private migration chain instead of building a database it cannot", () => {
    expect(code).toContain("20261022180001_public_baseline")
    expect(code).toContain("exported public tree")
  })

  it("leaves an existing .env untouched when a precondition fails", () => {
    const { dir, bin, log } = fixtureTree()
    const envPath = join(dir, ".env")
    const before = "NEXTAUTH_SECRET=keep-me\nPOSTGRES_PASSWORD=and-me\n"
    writeFileSync(envPath, before)

    const run = runScript(dir, bin, log, { SELFHOST_E2E_USE_EXISTING_ENV: "1", DOCKER_STUB_INFO: "1" })

    expect(run.status).toBe(1)
    expect(readFileSync(envPath, "utf8")).toBe(before)
    expect(`${run.stdout}${run.stderr}`).toContain("SELFHOST-E2E: FAIL preconditions")
    expectSafeDockerCalls(log)
  })

  it("refuses an existing .env unless the opt-in is set", () => {
    const { dir, bin, log } = fixtureTree()
    const envPath = join(dir, ".env")
    const before = "NEXTAUTH_SECRET=keep-me\n"
    writeFileSync(envPath, before)

    const run = runScript(dir, bin, log)

    expect(run.status).toBe(1)
    expect(readFileSync(envPath, "utf8")).toBe(before)
    expect(`${run.stdout}${run.stderr}`).toContain("fresh clone")
    // The trap may query the project for diagnostics; it must never start or
    // stop anything before the stack step.
    expectSafeDockerCalls(log)
    expect(dockerCalls(log).some((call) => call.includes(" up ") || call.includes(" down "))).toBe(false)
  })

  it("removes a generated .env when the stack fails to start", () => {
    const { dir, bin, log } = fixtureTree()

    const run = runScript(dir, bin, log, { DOCKER_STUB_UP: "1" })

    expect(run.status).toBe(1)
    expect(existsSync(join(dir, ".env"))).toBe(false)
    expect(`${run.stdout}${run.stderr}`).toContain("SELFHOST-E2E: FAIL stack")
    const up = dockerCalls(log).find((call) => call.startsWith("compose ") && call.includes(" up "))
    expect(up, "the stub never saw a compose up").toBeDefined()
    expect(up).toContain("-p radaric-e2e")
  })
})

describe("the self-host workflow", () => {
  it("runs the check in CI with read-only permissions and a bounded job", () => {
    expect(workflow).toContain("bash scripts/selfhost-e2e.sh")
    expect(workflow).toContain("workflow_dispatch")
    expect(workflow).toContain("permissions:\n  contents: read")
    expect(workflow).toContain("timeout-minutes: 30")
  })
})

describe("scripts/selfhost-e2e/feed.xml", () => {
  it("carries exactly three items", () => {
    expect(feed.match(/<item>/g) ?? []).toHaveLength(3)
  })

  it("points every link and guid at example.test", () => {
    const targets = [...feed.matchAll(/<(?:link|guid)>([^<]+)<\/(?:link|guid)>/g)].map((m) => m[1])
    // channel link + three items with a link and a guid each
    expect(targets).toHaveLength(7)
    for (const target of targets) {
      expect(new URL(target).hostname).toBe("example.test")
    }
  })
})
