// @vitest-environment node

/**
 * PATCH /api/user/email — set or change the current user's email
 *
 * RAD-233: users who signed up with a username have no email and are blocked
 * from subscribing (checkout returns 400 "Email required"). This route lets
 * credential users set/change their email; OAuth accounts are read-only.
 *
 * Spec coverage:
 *   AC-1: unauthenticated → 401, no DB/Stripe touched
 *   AC-2: invalid email format → 400, no update
 *   AC-3: OAuth account (passwordHash == null) → 403, no update
 *   AC-4: email already owned by another user → 409, no update
 *   AC-5: Prisma P2002 on update → 409 (uniqueness race safety net)
 *   AC-6: success → 200, db.user.update called with lowercased email + emailVerified:null
 *   AC-7: no-op when new email equals current → 200, update NOT called
 *   AC-8: Stripe customer email synced when stripeCustomerId present; a Stripe
 *         failure does not fail the request
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/auth-utils", () => ({
  requireAuth: vi.fn(),
  isErrorResponse: vi.fn((x) => x instanceof Response),
}))

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))

const stripeMock = {
  customers: {
    update: vi.fn(),
  },
}

vi.mock("@/lib/stripe", () => ({
  getStripe: () => stripeMock,
}))

import { requireAuth } from "@/lib/auth-utils"
import { db } from "@/lib/db"
import { PATCH } from "@/app/api/user/email/route"

const USER_ID = "user_123"

type DbUser = {
  id: string
  email: string | null
  passwordHash: string | null
  stripeCustomerId: string | null
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/user/email", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

/**
 * Configure db.user.findUnique to answer both lookups the route performs:
 * by `id` (current user) and by `email` (uniqueness check).
 */
function setupDb(current: DbUser | null, emailOwner: DbUser | null = null) {
  vi.mocked(db.user.findUnique).mockImplementation((args: never) => {
    const where = (args as { where: { id?: string; email?: string } }).where
    if (where.id) return Promise.resolve(current as never)
    if (where.email) return Promise.resolve(emailOwner as never)
    return Promise.resolve(null as never)
  })
}

const credentialUser: DbUser = {
  id: USER_ID,
  email: null,
  passwordHash: "$2a$10$hash",
  stripeCustomerId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireAuth).mockResolvedValue({ userId: USER_ID, role: "USER" })
  setupDb(credentialUser)
  vi.mocked(db.user.update).mockResolvedValue({} as never)
  stripeMock.customers.update.mockResolvedValue({} as never)
})

describe("PATCH /api/user/email", () => {
  describe("Auth guard (AC-1)", () => {
    it("returns the error response and touches neither DB nor Stripe when unauthenticated", async () => {
      const errorResponse = new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
      vi.mocked(requireAuth).mockResolvedValue(errorResponse as never)

      const res = await PATCH(makeRequest({ email: "new@example.com" }))

      expect(res.status).toBe(401)
      expect(db.user.findUnique).not.toHaveBeenCalled()
      expect(db.user.update).not.toHaveBeenCalled()
      expect(stripeMock.customers.update).not.toHaveBeenCalled()
    })
  })

  describe("Validation (AC-2)", () => {
    it("rejects a malformed email with 400 and does not update", async () => {
      const res = await PATCH(makeRequest({ email: "notanemail" }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe("Enter a valid email.")
      expect(db.user.update).not.toHaveBeenCalled()
    })

    it("rejects a non-string email with 400", async () => {
      const res = await PATCH(makeRequest({ email: 123 }))
      expect(res.status).toBe(400)
      expect(db.user.update).not.toHaveBeenCalled()
    })

    it("rejects a bare @ with 400 (stricter than signup)", async () => {
      const res = await PATCH(makeRequest({ email: "@" }))
      expect(res.status).toBe(400)
      expect(db.user.update).not.toHaveBeenCalled()
    })
  })

  describe("OAuth read-only enforcement (AC-3)", () => {
    it("returns 403 when the account has no passwordHash (provider-managed)", async () => {
      setupDb({ ...credentialUser, passwordHash: null, email: "oauth@gmail.com" })

      const res = await PATCH(makeRequest({ email: "new@example.com" }))

      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe("Email is managed by your sign-in provider.")
      expect(db.user.update).not.toHaveBeenCalled()
    })
  })

  describe("Uniqueness (AC-4, AC-5)", () => {
    it("returns 409 when the email belongs to another user", async () => {
      const other: DbUser = { id: "user_other", email: "taken@example.com", passwordHash: "x", stripeCustomerId: null }
      setupDb(credentialUser, other)

      const res = await PATCH(makeRequest({ email: "taken@example.com" }))

      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe("This email is already in use.")
      expect(db.user.update).not.toHaveBeenCalled()
    })

    it("returns 409 when the update hits a Prisma P2002 unique-constraint race", async () => {
      setupDb(credentialUser, null)
      vi.mocked(db.user.update).mockRejectedValue({ code: "P2002" } as never)

      const res = await PATCH(makeRequest({ email: "race@example.com" }))

      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe("This email is already in use.")
    })
  })

  describe("Success (AC-6, AC-7)", () => {
    it("lowercases the email and updates the user, clearing emailVerified", async () => {
      const res = await PATCH(makeRequest({ email: "New@Example.COM" }))

      expect(res.status).toBe(200)
      expect((await res.json()).email).toBe("new@example.com")
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { email: "new@example.com", emailVerified: null },
      })
    })

    it("is a no-op (200) when the new email equals the current one", async () => {
      setupDb({ ...credentialUser, email: "me@example.com" })

      const res = await PATCH(makeRequest({ email: "ME@example.com" }))

      expect(res.status).toBe(200)
      expect((await res.json()).email).toBe("me@example.com")
      expect(db.user.update).not.toHaveBeenCalled()
    })
  })

  describe("Stripe sync (AC-8)", () => {
    it("syncs the new email to the existing Stripe customer", async () => {
      setupDb({ ...credentialUser, stripeCustomerId: "cus_existing" })

      const res = await PATCH(makeRequest({ email: "billing@example.com" }))

      expect(res.status).toBe(200)
      expect(stripeMock.customers.update).toHaveBeenCalledWith("cus_existing", { email: "billing@example.com" })
    })

    it("does not call Stripe when the user has no stripeCustomerId", async () => {
      const res = await PATCH(makeRequest({ email: "billing@example.com" }))

      expect(res.status).toBe(200)
      expect(stripeMock.customers.update).not.toHaveBeenCalled()
    })

    it("still returns 200 when the Stripe sync throws", async () => {
      setupDb({ ...credentialUser, stripeCustomerId: "cus_existing" })
      stripeMock.customers.update.mockRejectedValue(new Error("stripe down"))

      const res = await PATCH(makeRequest({ email: "billing@example.com" }))

      expect(res.status).toBe(200)
      expect(db.user.update).toHaveBeenCalled()
    })
  })
})
