/**
 * POST /api/auth/signup — signup and sign-in flow
 *
 * Tests email/password validation, user creation with bcrypt hash,
 * existing user sign-in, OAuth user timing-safe rejection.
 * RAD-178
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoisted so the db mock factory can share the transaction's executeRaw spy.
const txMocks = vi.hoisted(() => ({ executeRaw: vi.fn(async () => 1) }))

vi.mock("@/lib/db", () => {
  const user = {
    findUnique: vi.fn(),
    create: vi.fn(),
    // RAD-297: with no RESEND_API_KEY in tests, signup takes the fail-open
    // path and stamps the account verified via user.update.
    update: vi.fn(),
    // RAD-285: first-user bootstrap reads the user count inside the transaction.
    count: vi.fn(async () => 1),
  }
  const $executeRaw = txMocks.executeRaw
  return {
    db: {
      user,
      // Interactive form: tx.user === db.user so existing assertions hold.
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function" ? await (arg as (tx: unknown) => unknown)({ user, $executeRaw }) : arg
      ),
    },
  }
})

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("$2a$10$hashedpassword"),
    compare: vi.fn(),
  },
}))

import { db } from "@/lib/db"
import bcrypt from "bcryptjs"
import { POST } from "@/app/api/auth/signup/route"

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => vi.clearAllMocks())

describe("POST /api/auth/signup", () => {
  describe("Validation", () => {
    it("rejects missing email", async () => {
      const res = await POST(makeRequest({ password: "password123" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Email and password are required")
    })

    it("rejects missing password", async () => {
      const res = await POST(makeRequest({ email: "test@example.com" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Email and password are required")
    })

    it("rejects empty body", async () => {
      const res = await POST(makeRequest({}))
      expect(res.status).toBe(400)
    })

    it("rejects email without @", async () => {
      const res = await POST(makeRequest({ email: "notanemail", password: "password123" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Invalid email format")
    })

    it("rejects non-string email", async () => {
      const res = await POST(makeRequest({ email: 123, password: "password123" }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe("Invalid email format")
    })

    it("rejects password shorter than 8 characters", async () => {
      const res = await POST(makeRequest({ email: "a@b.com", password: "short" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Password must be at least 8 characters")
    })

    it("rejects non-string password", async () => {
      const res = await POST(makeRequest({ email: "a@b.com", password: 12345678 }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe("Password must be at least 8 characters")
    })
  })

  describe("New user signup", () => {
    it("creates user with bcrypt hash and UserSettings", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null)
      vi.mocked(db.user.create).mockResolvedValue({} as never)

      const res = await POST(makeRequest({ email: "new@example.com", password: "password123" }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.action).toBe("signup")

      expect(bcrypt.hash).toHaveBeenCalledWith("password123", 10)
      expect(db.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: "new@example.com",
          passwordHash: "$2a$10$hashedpassword",
          userSettings: { create: { onboardingCompleted: false } },
        }),
      })
    })

    it("normalizes email to lowercase", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null)
      vi.mocked(db.user.create).mockResolvedValue({} as never)

      await POST(makeRequest({ email: "Test@UPPER.com", password: "password123" }))

      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { email: "test@upper.com" },
      })
      expect(db.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: "test@upper.com" }),
      })
    })

    it("generates a username from email prefix", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue(null)
      vi.mocked(db.user.create).mockResolvedValue({} as never)

      await POST(makeRequest({ email: "myuser@domain.com", password: "password123" }))

      const createCall = vi.mocked(db.user.create).mock.calls[0][0]
      const username = (createCall.data as never).username as string
      expect(username).toMatch(/^myuser-[a-f0-9]{4}$/)
    })
  })

  describe("Existing user sign-in", () => {
    it("returns signin action for correct password", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user-1",
        passwordHash: "$2a$10$existinghash",
      } as never)
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never)

      const res = await POST(makeRequest({ email: "existing@test.com", password: "correctpassword" }))
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.action).toBe("signin")
      expect(db.user.create).not.toHaveBeenCalled()
    })

    it("rejects wrong password with generic error", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user-1",
        passwordHash: "$2a$10$existinghash",
      } as never)
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never)

      const res = await POST(makeRequest({ email: "existing@test.com", password: "wrongpassword" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Invalid email or password")
    })

    it("rejects OAuth user (no passwordHash) with timing-safe dummy hash", async () => {
      vi.mocked(db.user.findUnique).mockResolvedValue({
        id: "user-1",
        passwordHash: null,
      } as never)

      const res = await POST(makeRequest({ email: "oauth@test.com", password: "anypassword" }))
      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data.error).toBe("Invalid email or password")
      // Timing-safe: bcrypt.hash was still called to prevent timing attacks
      expect(bcrypt.hash).toHaveBeenCalledWith("dummy", 10)
    })
  })

  describe("Edge cases", () => {
    it("email with just @ is accepted (known limitation)", async () => {
      // Bug: email.includes("@") passes for "@"
      // This test documents current behavior
      vi.mocked(db.user.findUnique).mockResolvedValue(null)
      vi.mocked(db.user.create).mockResolvedValue({} as never)

      const res = await POST(makeRequest({ email: "@", password: "password123" }))
      // Currently returns 200 — this is a bug (name would be empty)
      expect(res.status).toBe(200)
    })

    it("returns 500 on database error", async () => {
      vi.mocked(db.user.findUnique).mockRejectedValue(new Error("DB connection failed"))

      const res = await POST(makeRequest({ email: "test@test.com", password: "password123" }))
      expect(res.status).toBe(500)
      const data = await res.json()
      expect(data.error).toBe("An error occurred")
    })
  })
})

describe("first-user bootstrap (RAD-285)", () => {
  it("creates the first account in an empty database as ADMIN", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null)
    vi.mocked(db.user.count).mockResolvedValue(0)
    vi.mocked(db.user.create).mockResolvedValue({ id: "u-first" } as never)

    const res = await POST(makeRequest({ email: "owner@example.com", password: "password123" }))

    expect(res.status).toBe(200)
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "ADMIN" }) })
    )
    // The promotion is serialized by the advisory lock.
    expect(db.$transaction).toHaveBeenCalled()
    expect(txMocks.executeRaw).toHaveBeenCalled()
    expect(String(txMocks.executeRaw.mock.calls[0][0])).toContain("pg_advisory_xact_lock")
  })

  it("creates subsequent accounts as USER", async () => {
    vi.mocked(db.user.findUnique).mockResolvedValue(null)
    vi.mocked(db.user.count).mockResolvedValue(3)
    vi.mocked(db.user.create).mockResolvedValue({ id: "u-next" } as never)

    const res = await POST(makeRequest({ email: "second@example.com", password: "password123" }))

    expect(res.status).toBe(200)
    expect(db.user.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "USER" }) })
    )
  })
})
