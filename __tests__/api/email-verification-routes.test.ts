// @vitest-environment node

/**
 * RAD-297 — route-level email verification.
 *
 *  - signup sends the verification email when a mail transport is configured,
 *    and fails OPEN (account verified, loud log) when it is not;
 *  - the emailed link consumes a single-use token and redirects to the status page;
 *  - resend is rate-limited and refuses already-verified accounts;
 *  - an unverified account is stopped at an AI-spend route boundary.
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

vi.mock("@/lib/db", () => {
  const emailVerificationToken = { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() }
  const user = { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), count: vi.fn(async () => 1) }
  return {
    db: {
      user,
      userSettings: { create: vi.fn() },
      emailVerificationToken,
      inboxItem: { findUnique: vi.fn() },
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function"
          ? await (arg as (tx: unknown) => unknown)({ emailVerificationToken, user, $executeRaw: vi.fn(async () => 1) })
          : arg
      ),
    },
  }
})

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn(() => false),
}))

vi.mock("@/lib/subscription", () => ({
  requireActiveSubscription: vi.fn(async () => null),
}))

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(async () => true),
    hash: vi.fn(async () => "hashed"),
  },
}))

import { db } from "@/lib/db"
import { requireAuth } from "@/lib/auth-utils"
import { POST as signupPOST } from "@/app/api/auth/signup/route"
import { GET as verifyGET } from "@/app/api/auth/verify-email/route"
import { POST as resendPOST } from "@/app/api/auth/resend-verification/route"
import { POST as retryPOST } from "@/app/api/inbox-items/[id]/retry/route"
import { RATE_LIMITS, rateLimit, resetRateLimits } from "@/lib/rate-limit"

const mockDb = db as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  userSettings: { create: ReturnType<typeof vi.fn> }
  emailVerificationToken: {
    create: ReturnType<typeof vi.fn>
    findUnique: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
    updateMany: ReturnType<typeof vi.fn>
    deleteMany: ReturnType<typeof vi.fn>
  }
}

function signupRequest(email: string, password = "long-enough"): Request {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "198.51.100.10" },
    body: JSON.stringify({ email, password }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  resetRateLimits()
  mockDb.user.findUnique.mockResolvedValue(null)
  mockDb.user.create.mockResolvedValue({ id: "u-new" })
  mockDb.user.update.mockResolvedValue({})
  mockDb.emailVerificationToken.create.mockResolvedValue({})
  mockDb.emailVerificationToken.deleteMany.mockResolvedValue({ count: 0 })
  mockDb.emailVerificationToken.updateMany.mockResolvedValue({ count: 1 })
})

describe("POST /api/auth/signup — verification email (RAD-297)", () => {
  it("issues a token and sends the email when RESEND_API_KEY is configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    const res = await signupPOST(signupRequest("new@example.com"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: "signup", verificationSent: true })
    expect(mockDb.emailVerificationToken.create).toHaveBeenCalled()
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "new@example.com" }))
  })

  it("fails CLOSED when verification is enforced but no mail transport exists (prod misconfig)", async () => {
    vi.stubEnv("NODE_ENV", "production")
    const res = await signupPOST(signupRequest("misconfig@example.com"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: "signup", verificationSent: false })
    expect(mockDb.emailVerificationToken.create).not.toHaveBeenCalled()
    // Account exists UNVERIFIED — it activates when mail returns.
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("auto-verifies only under the explicit ALLOW_UNVERIFIED_SIGNUP opt-out", async () => {
    vi.stubEnv("ALLOW_UNVERIFIED_SIGNUP", "1")
    const res = await signupPOST(signupRequest("selfhost@example.com"))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ action: "signup", verificationSent: false })
    expect(mockDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u-new" }, data: { emailVerified: expect.any(Date) } })
    )
  })
})

describe("GET /api/auth/verify-email", () => {
  it("redirects to status=verified for a valid token", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue({
      id: "tok-1",
      userId: "u-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const res = await verifyGET(new Request("https://radaric.pro/api/auth/verify-email?token=raw") as never)

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/verify-email?status=verified")
  })

  it("redirects to status=invalid for an unknown token", async () => {
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(null)

    const res = await verifyGET(new Request("https://radaric.pro/api/auth/verify-email?token=nope") as never)

    expect(res.headers.get("location")).toContain("/verify-email?status=invalid")
  })

  it("redirects to the configured base URL, not the request host", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://curator.example")
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(null)

    const res = await verifyGET(new Request("https://radaric.pro/api/auth/verify-email?token=nope") as never)

    expect(res.headers.get("location")).toBe("https://curator.example/verify-email?status=invalid")
  })

  it("uses NEXTAUTH_URL when NEXT_PUBLIC_APP_URL is blank, so the redirect is never relative", async () => {
    // A relative target makes NextResponse.redirect throw; the old `??` chain
    // turned a blank value into exactly that.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example")
    mockDb.emailVerificationToken.findUnique.mockResolvedValue(null)

    const res = await verifyGET(new Request("https://radaric.pro/api/auth/verify-email?token=nope") as never)

    expect(res.headers.get("location")).toBe("https://curator.example/verify-email?status=invalid")
  })
})

describe("POST /api/auth/resend-verification (RAD-297)", () => {
  function authedUser(emailVerified: Date | null, email: string | null = "u@example.com") {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "u-1", role: "USER" })
    mockDb.user.findUnique.mockResolvedValue({ email, emailVerified })
  }

  it("sends a fresh link for an unverified account", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    authedUser(null)

    const res = await resendPOST(new Request("http://localhost/api/auth/resend-verification", { method: "POST" }) as never)
    expect(res.status).toBe(200)
    expect(sendEmailMock).toHaveBeenCalled()
  })

  it("refuses an already-verified account", async () => {
    authedUser(new Date())
    const res = await resendPOST(new Request("http://localhost/api/auth/resend-verification", { method: "POST" }) as never)
    expect(res.status).toBe(400)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("answers 503 when no mail transport is configured", async () => {
    authedUser(null)
    const res = await resendPOST(new Request("http://localhost/api/auth/resend-verification", { method: "POST" }) as never)
    expect(res.status).toBe(503)
  })

  it("is rate-limited per user", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test")
    authedUser(null)
    for (let i = 0; i < RATE_LIMITS.resendVerification.limit; i++) {
      rateLimit("resend-verification", "u-1", RATE_LIMITS.resendVerification.limit, RATE_LIMITS.resendVerification.windowMs)
    }
    const res = await resendPOST(new Request("http://localhost/api/auth/resend-verification", { method: "POST" }) as never)
    expect(res.status).toBe(429)
  })
})

describe("AI-spend route boundary (RAD-297)", () => {
  it("blocks an unverified account with EMAIL_NOT_VERIFIED, before any pipeline work", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ userId: "u-unverified", role: "USER" })
    mockDb.user.findUnique.mockResolvedValue({ emailVerified: null })

    const res = await retryPOST(new Request("http://localhost/api/inbox-items/i1/retry", { method: "POST" }) as never, {
      params: Promise.resolve({ id: "i1" }),
    })

    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe("EMAIL_NOT_VERIFIED")
    expect(mockDb.inboxItem.findUnique).not.toHaveBeenCalled()
  })
})
