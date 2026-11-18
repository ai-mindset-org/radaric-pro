// @vitest-environment node

/**
 * RAD-324 — DB-backed single-use password-reset tokens.
 *
 * Replaced the old `jwt.sign({userId}, NEXTAUTH_SECRET)` scheme: the token must
 * exist server-side (hash only), be unexpired and unused; a successful reset
 * invalidates every other outstanding link for the user, and the email send is
 * never reported as success when Resend rejected it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const { sendEmailMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ data: { id: "e1" }, error: null })),
}))

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmailMock }
  },
}))

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }))

vi.mock("@/lib/db", () => {
  const passwordResetToken = {
    create: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  }
  const user = { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() }
  return {
    db: {
      passwordResetToken,
      user,
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function"
          ? await (arg as (tx: unknown) => unknown)({ passwordResetToken, user })
          : arg
      ),
    },
  }
})

import { db } from "@/lib/db"
import * as Sentry from "@sentry/nextjs"
import {
  issuePasswordResetToken,
  consumePasswordResetToken,
  sendPasswordResetEmail,
  sendOAuthAccountEmail,
  PASSWORD_RESET_TTL_MS,
} from "@/lib/password-reset"
import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route"
import { POST as resetPOST } from "@/app/api/auth/reset-password/route"
import { RATE_LIMITS, resetRateLimits } from "@/lib/rate-limit"

const mockDb = db as unknown as {
  passwordResetToken: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
  user: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> }
}

function tokenRow(over: Record<string, unknown> = {}) {
  return {
    id: "prt-1",
    userId: "u-1",
    usedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  resetRateLimits()
  mockDb.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 })
  mockDb.passwordResetToken.updateMany.mockResolvedValue({ count: 1 })
  mockDb.user.update.mockResolvedValue({})
  sendEmailMock.mockResolvedValue({ data: { id: "e1" }, error: null })
})

describe("issuePasswordResetToken", () => {
  it("stores only the hash, with a 1h TTL, and prunes this user's stale rows", async () => {
    const token = await issuePasswordResetToken("u-1")
    expect(mockDb.passwordResetToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "u-1", tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    })
    const { expiresAt } = mockDb.passwordResetToken.create.mock.calls[0][0].data
    const ttl = expiresAt.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(PASSWORD_RESET_TTL_MS - 60_000)
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  })
})

describe("consumePasswordResetToken", () => {
  it("claims the token, sets the password and invalidates the user's other links, atomically", async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow())

    expect(await consumePasswordResetToken("raw", "hash-new")).toBe("ok")
    expect(mockDb.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { id: "prt-1", usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    })
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      // RAD-324/325: reset proves mailbox control, so the address is verified too.
      data: { passwordHash: "hash-new", emailVerified: expect.any(Date) },
    })
    expect(mockDb.passwordResetToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "u-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    })
  })

  it("returns 'used' when the concurrent claim loses", async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow())
    mockDb.passwordResetToken.updateMany.mockResolvedValue({ count: 0 })
    expect(await consumePasswordResetToken("raw", "hash-new")).toBe("used")
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("rejects used, expired and unknown tokens", async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow({ usedAt: new Date() }))
    expect(await consumePasswordResetToken("raw", "h")).toBe("used")

    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1) }))
    expect(await consumePasswordResetToken("raw", "h")).toBe("expired")

    mockDb.passwordResetToken.findUnique.mockResolvedValue(null)
    expect(await consumePasswordResetToken("raw", "h")).toBe("invalid")
  })
})

describe("outbound mail identity (D3)", () => {
  it("sends from the hosted default when EMAIL_FROM is unset — prod behaviour unchanged", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")

    await sendPasswordResetEmail("user@example.com", "tok-1")

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Radaric <noreply@radaric.pro>" })
    )
  })

  it("honours EMAIL_FROM for a self-host on its own verified domain", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("EMAIL_FROM", "Curator Digest <mail@curator.example>")

    await sendPasswordResetEmail("user@example.com", "tok-1")

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Curator Digest <mail@curator.example>" })
    )
  })

  it("points an OAuth account at the configured base URL, never radaric.pro elsewhere", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://curator.example")

    await sendOAuthAccountEmail("user@example.com")

    const { text } = sendEmailMock.mock.calls[0][0]
    expect(text).toContain("https://curator.example/signup")
    expect(text).not.toContain("radaric.pro")
  })

  it("keeps the hosted sign-in link when the base URL is radaric.pro", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://radaric.pro")

    await sendOAuthAccountEmail("user@example.com")

    const { text } = sendEmailMock.mock.calls[0][0]
    expect(text).toContain("https://radaric.pro/signup")
  })
})

describe("POST /api/auth/forgot-password", () => {
  function req(email: string): Request {
    return new Request("http://localhost/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "198.51.100.20" },
      body: JSON.stringify({ email }),
    })
  }

  it("answers 503 when no mail transport is configured", async () => {
    const res = await forgotPOST(req("user@example.com"))
    expect(res.status).toBe(503)
  })

  it("sends a reset link for a credential account and stays enumeration-safe for unknown addresses", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    mockDb.user.findFirst.mockResolvedValue({ id: "u-1", passwordHash: "hash", isActive: true })

    const res = await forgotPOST(req("user@example.com"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "If an account exists, we sent a reset link." })
    expect(mockDb.passwordResetToken.create).toHaveBeenCalled()
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "user@example.com" }))

    mockDb.user.findFirst.mockResolvedValue(null)
    const unknown = await forgotPOST(req("ghost@example.com"))
    expect(await unknown.json()).toEqual({ message: "If an account exists, we sent a reset link." })
    vi.unstubAllEnvs()
  })

  it("keeps the enumeration-safe response but reports a rejected send to Sentry", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    mockDb.user.findFirst.mockResolvedValue({ id: "u-1", passwordHash: "hash", isActive: true })
    sendEmailMock.mockResolvedValue({ data: null, error: { name: "validation_error", message: "bad domain" } })

    const res = await forgotPOST(req("user@example.com"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ message: "If an account exists, we sent a reset link." })
    expect(Sentry.captureException).toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it("rate-limits per address", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    mockDb.user.findFirst.mockResolvedValue(null)
    const limit = RATE_LIMITS.passwordResetEmail.limit
    for (let i = 0; i < limit; i++) {
      const res = await forgotPOST(req("same@example.com"))
      expect(res.status).not.toBe(429)
    }
    const res = await forgotPOST(req("same@example.com"))
    expect(res.status).toBe(429)
    vi.unstubAllEnvs()
  })
})

describe("POST /api/auth/reset-password", () => {
  function req(body: Record<string, unknown>): Request {
    return new Request("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("consumes a valid token and rejects a replay", async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow())

    const ok = await resetPOST(req({ token: "raw", password: "new-password-1" }))
    expect(ok.status).toBe(200)

    // Replay: the row is now used.
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow({ usedAt: new Date() }))
    const replay = await resetPOST(req({ token: "raw", password: "new-password-2" }))
    expect(replay.status).toBe(400)
  })

  it("rejects an expired token with a distinct message", async () => {
    mockDb.passwordResetToken.findUnique.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1) }))
    const res = await resetPOST(req({ token: "raw", password: "new-password-1" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("expired")
  })
})
