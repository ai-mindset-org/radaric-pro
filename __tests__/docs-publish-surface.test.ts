// @vitest-environment node

/**
 * RAD-299 + RAD-283 — the publishable surface.
 *
 * A stranger's first five minutes: LICENSE, NOTICE, SECURITY.md, CONTRIBUTING,
 * README. README once claimed MIT while the repo had no LICENSE at all, so the
 * properties that matter are pinned, not just the files' existence:
 *
 *  - LICENSE is the verbatim GNU AGPL-3.0 text (hash-pinned) — a deleted or
 *    edited clause fails CI;
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

// shasum -a 256 LICENSE — the file is https://www.gnu.org/licenses/agpl-3.0.txt, byte for byte
const CANONICAL_LICENSE_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"

const license = read("LICENSE")
const notice = read("NOTICE")
const security = read(".github/SECURITY.md")
const contributing = read(".github/CONTRIBUTING.md")
const readme = read("README.md")
const selfHosting = read("SELF_HOSTING.md")

describe("LICENSE", () => {
  it("is the verbatim GNU AGPL-3.0 text", () => {
    expect(createHash("sha256").update(license).digest("hex")).toBe(CANONICAL_LICENSE_SHA256)
  })
})

describe("NOTICE", () => {
  it("reserves the brand where the license cannot", () => {
    expect(notice).toContain("## Trademarks")
    expect(notice).toContain("must not present itself as")
    expect(notice).toContain("radaric.pro")
  })

  it("names the license, its SPDX id and the copyright holder", () => {
    expect(notice).toContain("GNU Affero General Public License")
    expect(notice).toContain("AGPL-3.0-only")
    expect(notice).toContain("Copyright 2026 Kirill Oleinichenko")
  })

  it("keeps the grant of both releases published under FSL, and only there", () => {
    const [head, earlier] = notice.split("## Earlier releases")
    expect(earlier).toBeDefined()
    for (const s of ["FSL-1.1-ALv2", "`cb3ac6a`", "Change Date is 2028-11-18", "`222c337`", "Change Date is 2028-11-19"]) {
      expect(earlier).toContain(s)
    }
    expect(head).not.toMatch(/FSL|source-available|Change Date/i)
  })

  it("frames the brand terms as section 7 additional terms and excludes the brand images", () => {
    expect(notice).toContain("section 7(e)")
    expect(notice).toContain("section 7(c)")
    for (const f of ["app/icon.png", "app/apple-icon.png", "public/og-image.png"]) expect(notice).toContain(f)
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
  it("README labels the project open source under AGPL-3.0, links the surfaces, and claims no other license", () => {
    expect(readme).toContain("AGPL-3.0")
    expect(readme.toLowerCase()).toContain("open source")
    expect(readme.toLowerCase()).not.toContain("source-available")
    expect(readme).not.toContain("FSL")
    expect(readme).not.toMatch(/\bMIT\b/)
    for (const f of ["NOTICE", "SECURITY.md", "CONTRIBUTING.md", "SELF_HOSTING.md"]) {
      expect(readme).toContain(f)
    }
  })

  it("package.json carries the license field", () => {
    const pkg = JSON.parse(read("package.json"))
    expect(pkg.license).toBe("AGPL-3.0-only")
  })

  it("CONTRIBUTING describes the CLA, links it, and includes the env step", () => {
    expect(contributing).toContain("CLA.md")
    expect(contributing).toContain("cp .env.example .env")
    expect(contributing).toContain("npm test")
    expect(contributing).toContain("SECURITY.md")
  })

  it("no published surface still names the FSL as the current license", () => {
    for (const f of ["README.md", ".github/CONTRIBUTING.md", ".github/CLA.md", "SELF_HOSTING.md", "app/page.tsx", "docs/INDEX.md"]) {
      expect(read(f), f).not.toMatch(/FSL|Functional Source|source-available/i)
    }
  })

  it("SELF_HOSTING tells a modified network instance to offer its source", () => {
    expect(selfHosting.replace(/\s+/g, " ")).toMatch(/section 13 of the license requires you to offer/i)
  })

  it("SELF_HOSTING tells operators not to present as Radaric", () => {
    expect(selfHosting.replace(/\s+/g, " ")).toContain("present it as the Radaric service")
  })

  it("the surface files exist where GitHub and a reader look for them", () => {
    for (const f of ["LICENSE", "NOTICE", ".github/SECURITY.md", ".github/CONTRIBUTING.md", ".github/CLA.md", "SELF_HOSTING.md"]) {
      expect(existsSync(path.join(root, f)), `${f} must exist`).toBe(true)
    }
  })
})
