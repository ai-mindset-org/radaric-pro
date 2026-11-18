/**
 * POST /api/auth/forgot-password — honest 503 when the mail transport is
 * unconfigured. A fake "we sent a reset link" with no RESEND_API_KEY hides
 * the misconfig from both the user and the operator (found the hard way:
 * the flow shipped code-complete but unprovisioned). RAD-268 follow-up.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const sendMock = vi.fn(() => Promise.resolve({ id: "email_1" }))
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock }
  },
}))
vi.mock("@/lib/db", () => ({
  db: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    // RAD-324: the reset link is now backed by a DB token, not a signed JWT.
    passwordResetToken: {
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}))

import { db } from "@/lib/db"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function importRoute() {
  vi.resetModules()
  return import("@/app/api/auth/forgot-password/route")
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/auth/forgot-password — transport guard", () => {
  it("returns 503 (not fake success) when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "")
    const { POST } = await importRoute()

    const res = await POST(makeRequest({ email: "user@example.com" }))
    expect(res.status).toBe(503)
    const data = await res.json()
    expect(data.error).toMatch(/unavailable/i)
    expect(db.user.findUnique).not.toHaveBeenCalled()
  })

  it("returns the neutral success message when configured and user not found", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key")
    vi.mocked(db.user.findFirst).mockResolvedValue(null as never)
    const { POST } = await importRoute()

    const res = await POST(makeRequest({ email: "ghost@example.com" }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.message).toMatch(/if an account exists/i)
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("sends the reset email when configured and user exists", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test_key")
    vi.mocked(db.user.findFirst).mockResolvedValue({
      id: "u1",
      passwordHash: "$2a$10$hash",
      isActive: true,
    } as never)
    const { POST } = await importRoute()

    const res = await POST(makeRequest({ email: "real@example.com" }))
    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
    const call = sendMock.mock.calls[0][0] as { to: string; subject: string; text: string }
    expect(call.to).toBe("real@example.com")
    expect(call.text).toContain("/reset-password?token=")
  })
})
