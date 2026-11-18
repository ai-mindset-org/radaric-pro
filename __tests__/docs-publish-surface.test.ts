// @vitest-environment node

/**
 * RAD-299 + RAD-283 — the publishable surface.
 *
 * A stranger's first five minutes: LICENSE, NOTICE, SECURITY.md, CONTRIBUTING,
 * README. README once claimed MIT while the repo had no LICENSE at all, so the
 * properties that matter are pinned, not just the files' existence:
 *
 *  - LICENSE is the canonical FSL-1.1-ALv2 text (hash-pinned) with the licensor
 *    line as the only edit — a deleted clause fails CI;
 *  - NOTICE's Trademarks section carries the brand boundary the code license
 *    does not;
 *  - SECURITY.md names an address on a domain that actually receives mail, plus
 *    an email-independent fallback;
 *  - no surface re-claims MIT, and package.json carries the license field;
 *  - self-hosters are told not to present as Radaric.
 */

import { readFileSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (f: string) => readFileSync(path.join(root, f), "utf8")

// sed -E 's/^Copyright [0-9]{4} .+$/Copyright <year> <licensor name>/' LICENSE | shasum -a 256
const CANONICAL_LICENSE_SHA256 = "67a3409bc733d05713499d75aad69cc6a43d2e0123936f2fb00eec70703b1896"

const license = read("LICENSE")
const notice = read("NOTICE")
const security = read("SECURITY.md")
const contributing = read("CONTRIBUTING.md")
const readme = read("README.md")
const selfHosting = read("SELF_HOSTING.md")

describe("LICENSE", () => {
  it("is the canonical FSL-1.1-ALv2 text, licensor line the only edit", () => {
    const normalized = license.replace(/^Copyright \d{4} .+$/m, "Copyright <year> <licensor name>")
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(CANONICAL_LICENSE_SHA256)
    expect(license).toMatch(/^Copyright \d{4} .+$/m)
    expect(license).not.toContain("${")
  })
})

describe("NOTICE", () => {
  it("reserves the brand where the license cannot", () => {
    expect(notice).toContain("## Trademarks")
    expect(notice).toContain("must not present itself as")
    expect(notice).toContain("radaric.pro")
  })

  it("records the per-version Change Date policy", () => {
    expect(notice).toContain("Change Date")
    expect(notice.toLowerCase()).toContain("source-available")
  })

  it("records the first public release date and its Change Date", () => {
    expect(notice).toContain("First public release: **2026-11-18**")
    expect(notice).toContain("Change Date is **2028-11-18**")
    expect(notice).not.toContain("to be recorded")
  })

  it("says the landing screenshots show publishers' content", () => {
    expect(notice).toContain("## Screenshots")
    expect(notice).toContain("public/landing/")
  })

  it("attributes the IDS port under the MIT license it came with", () => {
    expect(notice).toContain("## Third-party code")
    expect(notice).toContain("intuition-tech/ids")
    expect(notice).toContain("MIT License")
    expect(notice).toContain("Copyright (c) 2025, Intuition Team, https://intuition.team/")
  })
})

describe("SECURITY.md", () => {
  it("names an address on a domain with working mail, plus a fallback", () => {
    expect(security).toContain("inbox@kirillgreen.ru")
    expect(security).toMatch(/private vulnerability reporting/i)
  })

  it("keeps the response expectations honest", () => {
    expect(security.toLowerCase()).toContain("business days")
    expect(security.toLowerCase()).toContain("best-effort")
    expect(security).toContain("self-host")
  })
})

describe("README + CONTRIBUTING + SELF_HOSTING + package metadata", () => {
  it("README labels the project source-available, links the surfaces, and claims no other license", () => {
    expect(readme.toLowerCase()).toContain("source-available")
    expect(readme).not.toMatch(/\bMIT\b/)
    for (const f of ["NOTICE", "SECURITY.md", "CONTRIBUTING.md", "SELF_HOSTING.md"]) {
      expect(readme).toContain(f)
    }
  })

  it("package.json carries the license field", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.license).toMatch(/FSL-1\.1-ALv2|SEE LICENSE/)
  })

  it("CONTRIBUTING describes the CLA, links it, and includes the env step", () => {
    expect(contributing).toContain("CLA.md")
    expect(contributing).toContain("cp .env.example .env")
    expect(contributing).toContain("npm test")
    expect(contributing).toContain("SECURITY.md")
  })

  it("SELF_HOSTING tells operators not to present as Radaric", () => {
    expect(selfHosting.replace(/\s+/g, " ")).toContain("present it as the Radaric service")
  })

  it("the surface files exist at the repo root", () => {
    for (const f of ["LICENSE", "NOTICE", "SECURITY.md", "CONTRIBUTING.md", "CLA.md", "SELF_HOSTING.md"]) {
      expect(existsSync(path.join(root, f)), `${f} must exist`).toBe(true)
    }
  })
})
