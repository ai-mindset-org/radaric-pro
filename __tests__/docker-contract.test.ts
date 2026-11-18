// @vitest-environment node

/**
 * RAD-286 — container contract.
 *
 * These files encode production-shaping decisions that cannot be exercised on a
 * machine without Docker, so they are pinned by assertions instead: the signal
 * trap (start.sh as PID 1), the deliberate no-standalone choice (the tsx
 * worker + Prisma CLI need the full dependency graph), and the 15s stop grace
 * (the worker's 8s + 3s drain must not be SIGKILLed).
 */

import { readFileSync, statSync } from "node:fs"
import { describe, it, expect } from "vitest"

const dockerfile = readFileSync("Dockerfile", "utf8")
// Comments can satisfy a substring check without the instruction existing;
// assert against executable lines only.
const dockerfileCode = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n")
const compose = readFileSync("docker-compose.yml", "utf8")
const nextConfig = readFileSync("next.config.ts", "utf8")
const selfHosting = readFileSync("SELF_HOSTING.md", "utf8")
const readme = readFileSync("README.md", "utf8")
const envExample = readFileSync(".env.example", "utf8")
const generatorScript = readFileSync("scripts/generate-env.sh", "utf8")

/** The value compose assigns to KEY in `environment:` (quotes and padding stripped). */
function composeEnvValue(key: string): string | null {
  const match = compose.match(new RegExp(`^\\s+${key}:\\s*(.+?)\\s*$`, "m"))
  return match ? match[1].replace(/^["']|["']$/g, "") : null
}

const dockerignoreLines = readFileSync(".dockerignore", "utf8")
  .split("\n")
  .map((line) => line.trim())
const startScript = readFileSync("scripts/start.sh", "utf8")
const startScriptCode = startScript
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n")

/**
 * Dotted key paths of the YAML with their inline values, e.g.
 * `services.app.healthcheck.start_period` → `90s`. Indentation is all this
 * needs: only `key:` lines are read, so comments and list items never match.
 */
function composeKeyPaths(yaml: string): { path: string; value: string }[] {
  const stack: { indent: number; key: string }[] = []
  const keys: { path: string; value: string }[] = []
  for (const line of yaml.split("\n")) {
    const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*):(\s|$)/)
    if (!match) continue
    const indent = match[1].length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key: match[2] })
    keys.push({ path: stack.map((entry) => entry.key).join("."), value: line.slice(match[0].length).trim() })
  }
  return keys
}

// Names the schema lets you choose rather than schema keys: a declared
// service/volume/network/secret/config name is skipped at its own level, and
// `x-*` fields are compose's extension escape hatch. Everything else is a
// schema key and must be snake_case — `start_period`, `stop_grace_period`,
// `security_opt`. A dotted service name (`services.my-app.web`) is out of scope.
const USER_NAMED = /^(services|volumes|networks|secrets|configs)\.[^.]+$/
const EXTENSION_FIELD = /^x-/
// Pass-through maps: these keys are strings for Docker, not schema keys.
const PASS_THROUGH_MAP = /\.(environment|labels|annotations|sysctls|args|additional_contexts|driver_opts|options)$/

/** Compose keys whose hyphen the schema would reject. */
function hyphenatedComposeKeys(yaml: string): string[] {
  return composeKeyPaths(yaml)
    .map((entry) => entry.path)
    .filter((path) => {
      if (USER_NAMED.test(path)) return false
      if (path.split(".").some((key) => EXTENSION_FIELD.test(key))) return false
      const parent = path.includes(".") ? `.${path.slice(0, path.lastIndexOf("."))}` : ""
      if (PASS_THROUGH_MAP.test(parent)) return false
      return path.split(".").some((key) => key.includes("-"))
    })
}

describe("Dockerfile", () => {
  it("uses start.sh as the entrypoint — the signal trap must stay PID 1", () => {
    // Exact CMD on comment-stripped source: a shell wrapper ("sh","-c",…) would
    // defeat the SIGTERM forwarding and must fail this test.
    expect(dockerfileCode.match(/^CMD (.*)$/m)?.[1]).toBe('["sh", "scripts/start.sh"]')
  })

  it("pins a patched Node 22 (CI's exact version) and installs with scripts for prisma generate", () => {
    // A floating `node:22-slim` runs whatever the builder last pulled; Stripe
    // flagged an RCE in Node < 22.23.4 on 23.10.2026.
    // Every stage, not just the first: a later `FROM node:22-slim AS runtime`
    // would ship the floating tag.
    const froms = [...dockerfileCode.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1])
    expect(froms.length).toBeGreaterThan(0)
    const versions = froms.map((image) => {
      const m = image.match(/^node:22\.(\d+)\.(\d+)-slim$/)
      expect(m, `${image} must be node:22.<minor>.<patch>-slim`).not.toBeNull()
      const [minor, patch] = m!.slice(1).map(Number)
      expect(minor * 1000 + patch).toBeGreaterThanOrEqual(23 * 1000 + 4)
      return `22.${minor}.${patch}`
    })
    // CI's real setup-node line, ignoring comments; one version everywhere.
    const ci = readFileSync(".github/workflows/ci.yml", "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n")
    const ciVersions = [...ci.matchAll(/^\s+node-version:\s*'([^']+)'\s*$/gm)].map((m) => m[1])
    expect(ciVersions.length).toBeGreaterThan(0)
    expect(new Set([...versions, ...ciVersions])).toEqual(new Set([versions[0]]))
    expect(dockerfile).toContain("RUN npm ci")
    // schema must exist before npm ci (postinstall runs prisma generate)
    const schemaCopy = dockerfile.indexOf("COPY prisma ./prisma")
    const npmCi = dockerfile.indexOf("RUN npm ci")
    expect(schemaCopy).toBeGreaterThan(-1)
    expect(schemaCopy).toBeLessThan(npmCi)
  })

  it("installs a native build toolchain before npm ci — arm64 has no bufferutil prebuild (RAD-439)", () => {
    // On linux/arm64 (Apple Silicon, ARM servers) `bufferutil` compiles from
    // source through node-gyp; node:22-slim ships neither Python nor a compiler,
    // so without these `npm ci` fails there while amd64 CI stays green.
    const apt = dockerfileCode.match(/apt-get install[^\n]*/)?.[0] ?? ""
    for (const pkg of ["python3", "make", "g++"]) {
      expect(apt.split(/\s+/), `${pkg} must be in the apt-get install line`).toContain(pkg)
    }
    expect(dockerfileCode.indexOf("apt-get install")).toBeLessThan(dockerfileCode.indexOf("RUN npm ci"))
  })

  it("exposes web + worker-health ports and ships a healthcheck", () => {
    expect(dockerfile).toContain("EXPOSE 3000 3001")
    expect(dockerfile).toContain("HEALTHCHECK")
    expect(dockerfile).toContain("/api/health")
  })

  it("documents and keeps the deliberate no-standalone decision", () => {
    expect(dockerfile).toMatch(/NOT `output: "standalone"`/)
    expect(nextConfig).not.toContain("standalone")
  })

  it("keeps the docker context clean, including the real .env", () => {
    for (const entry of ["node_modules", ".next", ".git", ".env", ".env.*", "*.dump"]) {
      expect(dockerignoreLines).toContain(entry)
    }
  })
})

describe("docker compose", () => {
  it("starts the app only after Postgres is healthy", () => {
    expect(compose).toContain("condition: service_healthy")
    expect(compose).toContain("pg_isready")
  })

  it("spells the healthcheck start period as the compose schema does — `start_period`, never `start-period`", () => {
    // `--start-period` is the Dockerfile/`docker run` flag; the compose key is
    // snake_case, and the schema rejects anything else (`additionalProperties:
    // false`), which stops `docker compose up` before it builds a single layer.
    const startPeriod = composeKeyPaths(compose).find(
      (entry) => entry.path === "services.app.healthcheck.start_period"
    )
    expect(startPeriod?.value).toBe("90s")

    // Every compose file the check boots, not just the base one.
    for (const file of ["docker-compose.yml", "scripts/selfhost-e2e/compose.fixture.yml"]) {
      const hyphenated = hyphenatedComposeKeys(readFileSync(file, "utf8"))
      expect(hyphenated, `hyphenated compose key(s) in ${file}: ${hyphenated.join(", ")}`).toEqual([])
    }
  })

  it("gives the worker its full drain: stop_grace_period >= 15s", () => {
    const match = compose.match(/stop_grace_period:\s*(\d+)s/)
    expect(match).not.toBeNull()
    expect(Number(match![1])).toBeGreaterThanOrEqual(15)
  })

  it("injects the operator's .env into the container (feature keys must reach it)", () => {
    expect(compose).toContain("env_file:")
  })

  it("boots straight into a usable self-host: gates unlocked, no mail transport needed", () => {
    // Defaults live in the interpolation, so .env can override them (D9).
    expect(composeEnvValue("SELF_HOSTED")).toBe("${SELF_HOSTED:-true}")
    expect(composeEnvValue("ALLOW_UNVERIFIED_SIGNUP")).toBe("${ALLOW_UNVERIFIED_SIGNUP:-1}")
  })

  it("keeps the public URL and auth URL overridable — a domain must not point at localhost", () => {
    // D2: a pinned `NEXT_PUBLIC_APP_URL: http://localhost:3000` beats env_file,
    // and on a real domain every reset/verification link and webhook URL would
    // silently name the operator's laptop.
    expect(composeEnvValue("NEXT_PUBLIC_APP_URL")).toBe("${NEXT_PUBLIC_APP_URL:-http://localhost:3000}")
    expect(composeEnvValue("NEXTAUTH_URL")).toBe("${NEXTAUTH_URL:-http://localhost:3000}")
  })

  it("keeps the documented tuning caps overridable too — .env is injected, so a pin would lie", () => {
    expect(composeEnvValue("TWITTER_RATE_LIMIT_MS")).toBe("${TWITTER_RATE_LIMIT_MS:-5500}")
  })

  it("generates the required secrets in hex — base64 breaks DATABASE_URL", () => {
    // B1: `openssl rand -base64` emits `+` and `/`; POSTGRES_PASSWORD is
    // interpolated raw into a postgresql:// URL, so the container boots into 500s.
    for (const doc of [compose, selfHosting, readme, envExample, generatorScript]) {
      expect(doc).not.toContain("rand -base64")
    }
    expect(generatorScript).toContain("ensure_secret NEXTAUTH_SECRET 32")
    expect(generatorScript).toContain("ensure_secret POSTGRES_PASSWORD 24")
    expect(generatorScript).toContain("openssl rand -hex")
  })

  it("ships the env generator as an executable POSIX script the docs and compose run", () => {
    // B3: the quick start runs this file, not a block pasted into a shell.
    expect(generatorScript.startsWith("#!/bin/sh")).toBe(true)
    expect(statSync("scripts/generate-env.sh").mode & 0o111).not.toBe(0)
    expect(compose).toContain("sh scripts/generate-env.sh")
    expect(selfHosting).toContain("sh scripts/generate-env.sh")
  })

  it("runs migrations at boot BEFORE either process starts (start.sh)", () => {
    const migrate = startScriptCode.indexOf("node scripts/migrate-safe.js")
    const worker = startScriptCode.indexOf("npx tsx lib/story-aggregator/worker.ts")
    const next = startScriptCode.indexOf("next start")
    expect(migrate).toBeGreaterThan(-1)
    expect(migrate).toBeLessThan(worker)
    expect(migrate).toBeLessThan(next)
  })

  it("PID 1 waits for its children before exiting, so the worker drain is not SIGKILLed", () => {
    const trap = startScript.slice(startScript.indexOf("term()"))
    expect(trap).toContain("wait \"$WORKER_PID\" \"$NEXT_PID\"")
  })

  it("requires real secrets — no shipped signing key", () => {
    expect(compose).toContain("NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:")
    expect(compose).toContain("POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:")
    expect(compose).not.toContain("change-me-openssl-rand-base64-32")
  })
})
