// @vitest-environment node

/**
 * RAD-297 — email verification primitives.
 *
 * The email link is a single-use bearer token: only its SHA-256 hash is stored,
 * consumption is transactional, and expiry/used/invalid are distinct outcomes
 * the UI renders differently. OAuth accounts skip the flow entirely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "crypto"

const { sendEmailMock, txExecuteRaw } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(async () => ({ data: { id: "e1" }, error: null })),
  txExecuteRaw: vi.fn(async () => 1),
}))

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmailMock }
  },
}))

vi.mock("@/lib/db", () => {
  const emailVerificationToken = { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() }
  const user = { findUnique: vi.fn(), update: vi.fn(), findFirst: vi.fn(), create: vi.fn(), count: vi.fn(async () => 1) }
  return {
    db: {
      emailVerificationToken,
      user,
      userSettings: { create: vi.fn() },
      // Supports the interactive form used by the token consume.
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function"
          ? await (arg as (tx: unknown) => unknown)({ emailVerificationToken, user, $executeRaw: txExecuteRaw })
          : arg
      ),
    },
  }
})

import { db } from "@/lib/db"
import {
  issueEmailVerificationToken,
  consumeEmailVerificationToken,
  isEmailVerified,
  requireVerifiedEmail,
  sendVerificationEmail,
  buildEmailVerificationUrl,
  EMAIL_VERIFICATION_TTL_MS,
} from "@/lib/email-verification"
import { findOrCreateOAuthUser } from "@/lib/oauth-user"

const mockDb = db as unknown as {
  emailVerificationToken: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
  user: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
  }
  userSettings: { create: ReturnType<typeof vi.fn> }
  $transaction: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mockDb.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 })
  mockDb.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 })
})

describe("issueEmailVerificationToken", () => {
  it("stores only the hash of a fresh token, with a 24h expiry, and prunes this user's stale rows", async () => {
    const token = await issueEmailVerificationToken("user-1")

    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
    expect(mockDb.emailVerificationToken.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "user-1" }) })
    )
    const expectedHash = crypto.createHash("sha256").update(token).digest("hex")
    expect(mockDb.emailVerificationToken.create).toHaveBeenCalledWith({
      data: {
        tokenHash: expectedHash,
        userId: "user-1",
        expiresAt: expect.any(Date),
      },
    })
    const { expiresAt } = mockDb.emailVerificationToken.create.mock.calls[0][0].data
    const ttl = expiresAt.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(EMAIL_VERIFICATION_TTL_MS - 60_000)
    expect(ttl).toBeLessThanOrEqual(EMAIL_VERIFICATION_TTL_MS)
  })
})

describe("consumeEmailVerificationToken", () => {
  function tokenRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "tok-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    }
  }

  it("consumes a valid token: atomically claims it used, then verifies the user", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(tokenRow())

    const result = await consumeEmailVerificationToken("raw-token")

    expect(result).toBe("ok")
    expect(mockDb.emailVerificationToken.updateMany).toHaveBeenCalledWith({
      where: { id: "tok-1", usedAt: null, expiresAt: { gt: expect.any(Date) } },
      data: { usedAt: expect.any(Date) },
    })
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" }, data: { emailVerified: expect.any(Date) } })
    )
  })

  it("loses the race gracefully: a token claimed concurrently reports 'used'", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(tokenRow())
    mockDb.emailVerificationToken.updateMany.mockResolvedValue({ count: 0 })

    expect(await consumeEmailVerificationToken("raw-token")).toBe("used")
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("rejects a used token", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(tokenRow({ usedAt: new Date() }))
    expect(await consumeEmailVerificationToken("raw-token")).toBe("used")
    expect(mockDb.emailVerificationToken.updateMany).not.toHaveBeenCalled()
  })

  it("rejects an expired token", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(tokenRow({ expiresAt: new Date(Date.now() - 1) }))
    expect(await consumeEmailVerificationToken("raw-token")).toBe("expired")
    expect(mockDb.emailVerificationToken.updateMany).not.toHaveBeenCalled()
  })

  it("rejects an unknown token and an empty one", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(null)
    expect(await consumeEmailVerificationToken("nope")).toBe("invalid")
    expect(await consumeEmailVerificationToken("")).toBe("invalid")
  })
})

describe("isEmailVerified / requireVerifiedEmail", () => {
  it("exempts ADMIN without any lookup", async () => {
    expect(await isEmailVerified("admin-1", "ADMIN")).toBe(true)
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
    expect(await requireVerifiedEmail("admin-1", "ADMIN")).toBeNull()
  })

  it("passes a verified user and blocks an unverified one with EMAIL_NOT_VERIFIED", async () => {
    mockDb.user.findUnique.mockResolvedValue({ emailVerified: new Date() })
    expect(await requireVerifiedEmail("user-1", "USER")).toBeNull()

    mockDb.user.findUnique.mockResolvedValue({ emailVerified: null })
    const blocked = await requireVerifiedEmail("user-1", "USER")
    expect(blocked?.status).toBe(403)
    const body = await blocked?.json()
    expect(body.code).toBe("EMAIL_NOT_VERIFIED")
  })

  it("fails closed for a missing user row", async () => {
    mockDb.user.findUnique.mockResolvedValue(null)
    expect(await isEmailVerified("ghost", "USER")).toBe(false)
  })
})

describe("buildEmailVerificationUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://curator.example")
    expect(buildEmailVerificationUrl("tok-1")).toBe(
      "https://curator.example/api/auth/verify-email?token=tok-1"
    )
  })

  it("falls back to NEXTAUTH_URL when the app URL is blank — same rule as reset links", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example/")
    expect(buildEmailVerificationUrl("tok-1")).toBe(
      "https://curator.example/api/auth/verify-email?token=tok-1"
    )
  })

  it("falls back to localhost when neither is set, never a relative link", () => {
    expect(buildEmailVerificationUrl("tok-1")).toBe(
      "http://localhost:3000/api/auth/verify-email?token=tok-1"
    )
  })
})

describe("sendVerificationEmail", () => {
  it("emails the verification URL built from NEXT_PUBLIC_APP_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://radaric.pro")
    vi.stubEnv("RESEND_API_KEY", "re_test")

    await sendVerificationEmail("user@example.com", "tok-123")

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Verify your email",
        text: expect.stringContaining("https://radaric.pro/api/auth/verify-email?token=tok-123"),
      })
    )
  })

  it("sends from the hosted default when EMAIL_FROM is unset — prod behaviour unchanged", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")

    await sendVerificationEmail("user@example.com", "tok-123")

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Radaric <noreply@radaric.pro>" })
    )
  })

  it("honours EMAIL_FROM on a domain the self-hoster's Resend account verified", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    vi.stubEnv("EMAIL_FROM", "Curator Digest <verify@curator.example>")

    await sendVerificationEmail("user@example.com", "tok-123")

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "Curator Digest <verify@curator.example>" })
    )
  })
})

describe("findOrCreateOAuthUser", () => {
  it("creates a NEW OAuth account already verified", async () => {
    mockDb.user.findFirst.mockResolvedValue(null)
    mockDb.user.create.mockResolvedValue({ id: "u-new", role: "USER", username: "alice_abcd" })
    mockDb.userSettings.create.mockResolvedValue({})

    const result = await findOrCreateOAuthUser({ email: "alice@example.com", name: "Alice" })

    expect(result).toEqual({
      status: "ok",
      account: { id: "u-new", role: "USER", username: "alice_abcd", created: true },
    })
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailVerified: expect.any(Date),
          // Settings nested inside the transaction — never a half-created account.
          userSettings: { create: { onboardingCompleted: false } },
        }),
      })
    )
    // The first-user promotion is serialized by an advisory lock; assert the SQL.
    expect(db.$transaction).toHaveBeenCalled()
    expect(txExecuteRaw).toHaveBeenCalled()
    expect(String(txExecuteRaw.mock.calls[0][0])).toContain("pg_advisory_xact_lock")
  })

  it("makes the first account in an empty database ADMIN (RAD-285)", async () => {
    mockDb.user.findFirst.mockResolvedValue(null)
    mockDb.user.count.mockResolvedValue(0)
    mockDb.user.create.mockResolvedValue({ id: "u-first", role: "ADMIN", username: "owner_abcd" })
    mockDb.userSettings.create.mockResolvedValue({})

    const result = await findOrCreateOAuthUser({ email: "owner@example.com", name: "Owner" })

    expect(result.status).toBe("ok")
    expect(mockDb.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ADMIN" }) })
    )
  })

  it("returns an existing VERIFIED account untouched", async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: "u-old",
      role: "USER",
      username: "alice",
      passwordHash: "$2a$10$hash",
      emailVerified: new Date(),
    })

    const result = await findOrCreateOAuthUser({ email: "alice@example.com" })

    expect(result).toEqual({
      status: "ok",
      account: { id: "u-old", role: "USER", username: "alice", created: false },
    })
    expect(mockDb.user.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("REFUSES to link a never-verified credential account (RAD-325 pre-hijacking)", async () => {
    mockDb.user.findFirst.mockResolvedValue({
      id: "u-attacker",
      role: "USER",
      username: "victim_1234",
      passwordHash: "$2a$10$hash",
      emailVerified: null,
    })

    const result = await findOrCreateOAuthUser({ email: "victim@example.com" })

    expect(result).toEqual({ status: "link_blocked" })
    expect(mockDb.user.create).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("recovers a legacy mixed-case row on P2002 without linking an unverified credential account", async () => {
    mockDb.user.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "u-legacy",
      role: "USER",
      username: "legacy",
      passwordHash: "$2a$10$hash",
      emailVerified: null,
    })
    mockDb.user.create.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }))

    const result = await findOrCreateOAuthUser({ email: "legacy@example.com" })

    expect(result).toEqual({ status: "link_blocked" })
  })
})
