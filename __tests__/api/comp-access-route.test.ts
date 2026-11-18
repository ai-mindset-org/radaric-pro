/**
 * POST /api/admin/comp-access — grant / extend / revoke complimentary access.
 *
 * Tests the auth guard + body validation + error mapping end-to-end against the
 * real lib/comp-access (only the DB + auth + Sentry are mocked). Confirms the
 * expiry is computed server-side and any client-sent date is ignored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}))

vi.mock("@/lib/auth-utils", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: vi.fn(),
}))

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}))

import { db } from "@/lib/db"
import { requireAdmin, isErrorResponse } from "@/lib/auth-utils"
import { POST } from "@/app/api/admin/comp-access/route"

const NOW = new Date("2026-05-01T12:00:00Z")
const DAY_MS = 86_400_000

function setupAdmin() {
  vi.mocked(requireAdmin).mockResolvedValue({ userId: "admin-1", role: "ADMIN" })
  vi.mocked(isErrorResponse).mockReturnValue(false)
}

function setupForbidden(status = 403) {
  const res = NextResponse.json({ error: "Forbidden" }, { status })
  vi.mocked(requireAdmin).mockResolvedValue(res)
  vi.mocked(isErrorResponse).mockReturnValue(true)
}

function req(body: unknown, raw = false) {
  return new Request("http://test/api/admin/comp-access", {
    method: "POST",
    body: raw ? (body as string) : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(db.user.update).mockResolvedValue({} as never)
})

describe("POST /api/admin/comp-access — auth", () => {
  it("rejects a non-admin with the guard's response (403)", async () => {
    setupForbidden(403)
    const res = await POST(req({ userId: "u1", days: 30 }))
    expect(res.status).toBe(403)
    expect(db.user.update).not.toHaveBeenCalled()
  })

  it("rejects an unauthenticated caller (401)", async () => {
    setupForbidden(401)
    const res = await POST(req({ userId: "u1", days: 30 }))
    expect(res.status).toBe(401)
  })
})

describe("POST /api/admin/comp-access — validation", () => {
  beforeEach(setupAdmin)

  it("400 on invalid JSON", async () => {
    const res = await POST(req("{not json", true))
    expect(res.status).toBe(400)
  })

  it("400 when userId is missing", async () => {
    const res = await POST(req({ days: 30 }))
    expect(res.status).toBe(400)
  })

  it("400 when days is a string (not number|null)", async () => {
    const res = await POST(req({ userId: "u1", days: "30" }))
    expect(res.status).toBe(400)
  })

  it("400 when days is out of range (via the lib cap)", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: null } as never)
    const res = await POST(req({ userId: "u1", days: 100000 }))
    expect(res.status).toBe(400)
  })
})

describe("POST /api/admin/comp-access — grant / revoke", () => {
  beforeEach(setupAdmin)

  it("grants now + days and returns the server-computed ISO expiry", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: null } as never)

    const res = await POST(req({ userId: "u1", days: 30 }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.complimentaryAccessUntil).toBe(
      new Date(NOW.getTime() + 30 * DAY_MS).toISOString()
    )
  })

  it("ignores any client-sent date and computes from days server-side", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue({ complimentaryAccessUntil: null } as never)

    const res = await POST(
      req({ userId: "u1", days: 7, complimentaryAccessUntil: "2099-01-01T00:00:00Z", until: "2099-01-01" })
    )
    const json = await res.json()

    expect(json.complimentaryAccessUntil).toBe(
      new Date(NOW.getTime() + 7 * DAY_MS).toISOString()
    )
  })

  it("revokes when days is null", async () => {
    const res = await POST(req({ userId: "u1", days: null }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.complimentaryAccessUntil).toBeNull()
    expect(db.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { complimentaryAccessUntil: null },
    })
  })

  it("404 when the target user does not exist", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null as never)
    const res = await POST(req({ userId: "ghost", days: 30 }))
    expect(res.status).toBe(404)
  })
})
