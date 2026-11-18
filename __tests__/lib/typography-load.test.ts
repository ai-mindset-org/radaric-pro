/**
 * RAD-363 slice 6 — `loadTypography` (server read of UserSettings.typography)
 * and the dashboard layout wiring. Spec: .tdd/spec-typography-provider.md
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

vi.mock("@/lib/db", () => ({ db: { userSettings: { findUnique: vi.fn() } } }))

import { db } from "@/lib/db"
import { loadTypography } from "@/lib/typography/load"
import { DEFAULT_TYPOGRAPHY } from "@/lib/typography/prefs"

const ALL_INTER = { heading: "inter", text: "inter", counter: "inter", tag: "inter" }

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("loadTypography", () => {
  it("AC-1: no user resolves to a fresh copy of the default without a DB read", async () => {
    const result = await loadTypography(undefined)

    expect(result).toEqual(ALL_INTER)
    expect(result).not.toBe(DEFAULT_TYPOGRAPHY)
    expect(Object.isFrozen(result)).toBe(false)
    expect(vi.mocked(db.userSettings.findUnique)).toHaveBeenCalledTimes(0)
  })

  it("AC-2: reads the row with a narrow select and returns the stored prefs", async () => {
    const stored = { heading: "martian-grotesk", text: "inter", counter: "martian-mono", tag: "pt-root-ui" }
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ typography: stored } as never)

    const result = await loadTypography("u1")

    expect(vi.mocked(db.userSettings.findUnique)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(db.userSettings.findUnique)).toHaveBeenCalledWith({
      where: { userId: "u1" },
      select: { typography: true },
    })
    expect(result).toEqual(stored)
  })

  it("AC-3: no row, a null column and a malformed value all resolve to the default", async () => {
    vi.mocked(db.userSettings.findUnique).mockResolvedValueOnce(null as never)
    expect(await loadTypography("u1")).toEqual(ALL_INTER)

    vi.mocked(db.userSettings.findUnique).mockResolvedValueOnce({ typography: null } as never)
    expect(await loadTypography("u1")).toEqual(ALL_INTER)

    vi.mocked(db.userSettings.findUnique).mockResolvedValueOnce({
      typography: { heading: "comic-sans", text: 5 },
    } as never)
    expect(await loadTypography("u1")).toEqual(ALL_INTER)

    expect(vi.mocked(db.userSettings.findUnique)).toHaveBeenCalledTimes(3)
  })

  it("ERR-1: a rejected DB read resolves to the default instead of rejecting", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.mocked(db.userSettings.findUnique).mockRejectedValue(new Error("connection refused"))

    await expect(loadTypography("u1")).resolves.toEqual(ALL_INTER)
    expect(vi.mocked(db.userSettings.findUnique)).toHaveBeenCalledTimes(1)
  })
})

describe("dashboard layout wiring (source guard)", () => {
  const source = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/layout.tsx"), "utf8")

  it("Constraint: layout imports loadTypography and TypographyProvider, calls it and wraps DashboardShell", () => {
    expect(source).toMatch(/import\s*\{[^}]*\bloadTypography\b[^}]*\}\s*from\s*["']@\/lib\/typography\/load["']/)
    expect(source).toMatch(
      /import\s*\{[^}]*\bTypographyProvider\b[^}]*\}\s*from\s*["']@\/components\/providers\/typography-provider["']/,
    )
    expect(source).toContain("loadTypography(")

    const providerAt = source.indexOf("<TypographyProvider")
    const shellAt = source.indexOf("<DashboardShell")
    const shellCloseAt = source.indexOf("</DashboardShell>")
    const providerCloseAt = source.indexOf("</TypographyProvider>")
    expect(providerAt).toBeGreaterThan(-1)
    expect(shellAt).toBeGreaterThan(providerAt)
    expect(providerCloseAt).toBeGreaterThan(shellCloseAt)
    expect(source).toMatch(/<TypographyProvider\s+initialPrefs=\{/)
  })
})
