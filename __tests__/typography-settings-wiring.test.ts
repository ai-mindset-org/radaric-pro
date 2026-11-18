/**
 * RAD-363 slice 7 — source-text guards: the Appearance section in Settings and
 * the "Roles" sub-section on /design-system.
 * Spec: .tdd/spec-typography-settings.md (AC-13, AC-14)
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "..")
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8")

/** The `[ … ]` literal assigned to `const <name> =`. */
function arrayLiteral(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = [`)
  expect(start, `${name} declaration`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf("\n]", start)
  expect(end, `${name} closing bracket`).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** Nav item ids in declaration order. */
function navIds(block: string): string[] {
  return [...block.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1])
}

/** Body of the component's `<name>` handler — `function <name>(` or `const <name> = …` — by brace matching. */
function functionBody(src: string, name: string): string {
  const decl = new RegExp(`(?:function ${name}\\(|const ${name}\\s*=)`).exec(src)
  expect(decl, `${name} declaration`).not.toBeNull()
  const arrow = src.indexOf("=>", decl!.index)
  const paren = src.indexOf(")", decl!.index)
  const open = src.indexOf("{", Math.max(paren, decl![0].startsWith("const") ? arrow : paren))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1)
  }
  return src.slice(open)
}

describe("Settings → Appearance wiring (settings-form.tsx)", () => {
  const src = read("components/settings/settings-form.tsx")

  it("AC-13: nav items, the appearance block after account, TypographySection inside it, and a typography-free page Save", () => {
    for (const name of ["ADMIN_NAV_ITEMS", "USER_NAV_ITEMS"]) {
      const block = arrayLiteral(src, name)
      const ids = navIds(block)
      const accountAt = ids.indexOf("account")
      expect(accountAt, `${name} has account`).toBeGreaterThanOrEqual(0)
      expect(ids[accountAt + 1], `${name}: appearance directly after account`).toBe("appearance")
      expect(block).toMatch(/\{\s*id:\s*"appearance",\s*label:\s*"Appearance",/)
    }

    const sections = [...src.matchAll(/data-section="([^"]+)"/g)].map((m) => ({ id: m[1], at: m.index! }))
    const ids = sections.map((s) => s.id)
    const accountIdx = ids.indexOf("account")
    expect(accountIdx).toBeGreaterThanOrEqual(0)
    expect(ids[accountIdx + 1]).toBe("appearance")

    const appearanceStart = sections[accountIdx + 1].at
    const nextStart = sections[accountIdx + 2]?.at ?? src.length
    const appearanceBlock = src.slice(appearanceStart, nextStart)
    expect(appearanceBlock).toMatch(/<TypographySection[\s/>]/)
    expect(src).toMatch(/import\s*\{[^}]*\bTypographySection\b[^}]*\}\s*from\s*"@\/components\/settings\/typography-section"/)

    const save = functionBody(src, "handleSaveSettings")
    expect(save).toContain('method: "PUT"')
    expect(save).not.toMatch(/typography/i)
  })
})

describe("/design-system Roles sub-section (design-system/page.tsx)", () => {
  const src = read("app/(dashboard)/design-system/page.tsx")

  it("AC-14: imports TypographySpecimen and renders it under a \"Roles\" SubSection inside the typography Section", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bTypographySpecimen\b[^}]*\}\s*from\s*"@\/components\/settings\/typography-specimen"/,
    )

    const sectionStart = src.indexOf('<Section id="typography"')
    expect(sectionStart).toBeGreaterThanOrEqual(0)
    const sectionEnd = src.indexOf("</Section>", sectionStart)
    expect(sectionEnd).toBeGreaterThan(sectionStart)
    const section = src.slice(sectionStart, sectionEnd)

    const rolesStart = section.indexOf('<SubSection title="Roles"')
    expect(rolesStart, 'SubSection title="Roles" inside the typography Section').toBeGreaterThanOrEqual(0)
    const rolesEnd = section.indexOf("</SubSection>", rolesStart)
    expect(rolesEnd).toBeGreaterThan(rolesStart)
    const roles = section.slice(rolesStart, rolesEnd)
    expect(roles).toMatch(/<TypographySpecimen[\s/>]/)
  })
})
