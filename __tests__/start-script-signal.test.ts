import { spawn } from "node:child_process"
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test, expect } from "vitest"

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe("scripts/start.sh signal propagation", () => {
  test("forwards SIGTERM to backgrounded worker so shutdown() can run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "radaric-start-"))
    const workerReady = join(dir, "worker-ready")
    const nextReady = join(dir, "next-ready")
    const workerMarker = join(dir, "worker-shutdown-ran")
    const nextMarker = join(dir, "next-shutdown-ran")

    // Stub `node scripts/migrate-safe.js` — succeed immediately.
    writeFileSync(join(dir, "node"), `#!/bin/sh\nexit 0\n`, { mode: 0o755 })

    // Stub `npx tsx lib/story-aggregator/worker.ts` — install a SIGTERM trap,
    // write a readiness marker, then idle. The trap stands in for the real
    // worker's shutdown() → destroy() path. If start.sh doesn't forward the
    // signal, the stub is SIGKILLed by the kernel and the shutdown marker is
    // never written.
    writeFileSync(
      join(dir, "npx"),
      `#!/bin/sh
trap "printf ok > '${workerMarker}'; exit 0" TERM INT
printf ok > '${workerReady}'
while :; do sleep 0.1; done
`,
      { mode: 0o755 },
    )

    writeFileSync(
      join(dir, "next"),
      `#!/bin/sh
trap "printf ok > '${nextMarker}'; exit 0" TERM INT
printf ok > '${nextReady}'
while :; do sleep 0.1; done
`,
      { mode: 0o755 },
    )

    const startScript = join(process.cwd(), "scripts", "start.sh")
    const child = spawn("sh", [startScript], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    let stdout = ""
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString() })

    // Wait for BOTH stub children to signal they've installed their traps.
    // This eliminates the race where SIGTERM is sent before the shell has
    // spawned and/or `trap` has registered.
    const bothReady = await waitFor(
      () => existsSync(workerReady) && existsSync(nextReady),
      10_000,
    )
    expect(
      bothReady,
      `stubs never signaled ready (stdout: ${stdout}, stderr: ${stderr})`,
    ).toBe(true)

    child.kill("SIGTERM")

    await new Promise<void>((resolve) => child.on("exit", () => resolve()))
    // Brief wait for any straggler file writes to flush.
    await new Promise((r) => setTimeout(r, 150))

    expect(
      existsSync(workerMarker),
      `worker did not receive SIGTERM (stdout: ${stdout}, stderr: ${stderr})`,
    ).toBe(true)
    expect(readFileSync(workerMarker, "utf8")).toBe("ok")

    expect(existsSync(nextMarker)).toBe(true)
  }, 30_000)
})
