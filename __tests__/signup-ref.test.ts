/**
 * Sign-up attribution — the directory or launch site a new account came from.
 * Links carry `?ref=<slug>`; the proxy keeps the FIRST one in a first-party
 * cookie, and account creation writes it once to `User.signupRef`.
 *
 *   AC-1  a ref is sanitized to a short lowercase slug; junk becomes no ref
 *   AC-2  first touch wins: an existing ref cookie is never overwritten
 *   AC-3  the proxy sets the cookie on public page loads (30 days,
 *         SameSite=None+Secure over https, Lax over http), never on /api
 *   AC-4  credential sign-up writes the cookie's ref in the create; no cookie → null
 *   AC-5  OAuth (Google/Apple) sign-up writes it on a NEW account only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const txMocks = vi.hoisted(() => ({ executeRaw: vi.fn(async () => 1) }))

vi.mock("@/lib/db", () => {
  const user = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(async () => 1),
  }
  const $executeRaw = txMocks.executeRaw
  return {
    db: {
      user,
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function" ? await (arg as (tx: unknown) => unknown)({ user, $executeRaw }) : arg
      ),
    },
  }
})

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$2a$10$hashed"), compare: vi.fn().mockResolvedValue(true) },
}))

vi.mock("@/lib/auth", () => ({ auth: Object.assign(vi.fn(), {}) }))

import { db } from "@/lib/db"
import { POST as signup } from "@/app/api/auth/signup/route"
import { findOrCreateOAuthUser } from "@/lib/oauth-user"
import {
  SIGNUP_REF_COOKIE,
  SIGNUP_REF_COOKIE_MAX_AGE,
  SIGNUP_REF_MAX_LENGTH,
  firstTouchRef,
  sanitizeRef,
  signupRefFromCookieHeader,
} from "@/lib/signup-ref"

const mockUser = vi.mocked(db.user)

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("TRIAL_REF", "launch")
  mockUser.findUnique.mockReset()
  mockUser.findFirst.mockReset()
  mockUser.create.mockResolvedValue({ id: "u-new", role: "USER", username: "new-abcd" } as never)
  mockUser.update.mockResolvedValue({} as never)
  mockUser.count.mockResolvedValue(1 as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("sanitizeRef (AC-1)", () => {
  it.each([
    ["site-a", "site-a"],
    ["Site-A", "site-a"],
    ["  site-b  ", "site-b"],
    ["launching next", "launching-next"],
    ["product_hunt", "product-hunt"],
    ["a//b??c", "a-b-c"],
    ["--site-c--", "site-c"],
  ])("%j → %j", (raw, slug) => {
    expect(sanitizeRef(raw)).toBe(slug)
  })

  it.each([null, undefined, "", "   ", "---", "<>%!", "ёжик"])("%j → null", (raw) => {
    expect(sanitizeRef(raw)).toBeNull()
  })

  it("caps the length", () => {
    const slug = sanitizeRef("x".repeat(500))
    expect(slug).toBe("x".repeat(SIGNUP_REF_MAX_LENGTH))
  })

  it("never ends on a dash after the cap", () => {
    const slug = sanitizeRef("a".repeat(SIGNUP_REF_MAX_LENGTH - 1) + "-bbbb")
    expect(slug).toBe("a".repeat(SIGNUP_REF_MAX_LENGTH - 1))
  })
})

describe("firstTouchRef (AC-2)", () => {
  it("takes the query ref when no ref is stored", () => {
    expect(firstTouchRef(null, "Site-B")).toBe("site-b")
  })

  it("keeps the stored ref: a later ref never overwrites it", () => {
    expect(firstTouchRef("site-a", "site-b")).toBeNull()
  })

  it("treats a stored value that sanitizes to nothing as no ref", () => {
    expect(firstTouchRef("%%%", "site-d")).toBe("site-d")
  })

  it("sets nothing without a usable query ref", () => {
    expect(firstTouchRef(null, null)).toBeNull()
    expect(firstTouchRef(null, "!!!")).toBeNull()
  })
})

describe("signupRefFromCookieHeader", () => {
  it("reads and sanitizes the cookie among others", () => {
    expect(signupRefFromCookieHeader(`a=1; ${SIGNUP_REF_COOKIE}=Site-C; b=2`)).toBe("site-c")
  })

  it("is null without the cookie or with junk", () => {
    expect(signupRefFromCookieHeader(null)).toBeNull()
    expect(signupRefFromCookieHeader("a=1")).toBeNull()
    expect(signupRefFromCookieHeader(`${SIGNUP_REF_COOKIE}=%%%`)).toBeNull()
  })
})

describe("proxy keeps the first ref (AC-3)", () => {
  type Proxy = (req: NextRequest) => Promise<Response> | Response

  async function run(url: string, cookie?: string) {
    vi.resetModules()
    vi.doMock("@/lib/auth", () => ({ auth: (handler: unknown) => handler }))
    const proxy = (await import("@/proxy")).default as unknown as Proxy
    const req = new NextRequest(url, cookie ? { headers: { cookie } } : undefined)
    Object.assign(req, { auth: null })
    return await proxy(req)
  }

  function refCookie(res: Response) {
    return res.headers.getSetCookie().find((c) => c.startsWith(`${SIGNUP_REF_COOKIE}=`)) ?? null
  }

  it.each([
    "https://radaric.pro/?ref=site-a",
    "https://radaric.pro/signup?ref=site-a",
    "https://radaric.pro/privacy?ref=site-a",
    "https://radaric.pro/terms?ref=Site-A",
  ])("sets a 30-day SameSite=None Secure HttpOnly cookie on %s", async (url) => {
    const cookie = refCookie(await run(url))
    expect(cookie).toMatch(new RegExp(`^${SIGNUP_REF_COOKIE}=site-a;`))
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/Secure/i)
    expect(cookie).toMatch(/SameSite=none/i)
    expect(cookie).toMatch(new RegExp(`Max-Age=${SIGNUP_REF_COOKIE_MAX_AGE}`, "i"))
    expect(SIGNUP_REF_COOKIE_MAX_AGE).toBe(30 * 24 * 60 * 60)
  })

  it("falls back to SameSite=Lax without Secure over plain http", async () => {
    const cookie = refCookie(await run("http://localhost:3000/?ref=site-b"))
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).not.toMatch(/Secure/i)
  })

  it("keeps the ref when a signed-out deep link redirects to /signup", async () => {
    const res = await run("https://radaric.pro/posts?ref=site-b")
    expect(res.status).toBe(307)
    expect(refCookie(res)).toMatch(new RegExp(`^${SIGNUP_REF_COOKIE}=site-b;`))
  })

  it("does not overwrite a stored ref", async () => {
    expect(refCookie(await run("https://radaric.pro/?ref=site-b", `${SIGNUP_REF_COOKIE}=site-a`))).toBeNull()
  })

  it.each([
    "https://radaric.pro/",
    "https://radaric.pro/?ref=%25%25",
    "https://radaric.pro/api/health?ref=site-a",
    "https://radaric.pro/api/auth/csrf?ref=site-a",
  ])("sets nothing for %s", async (url) => {
    expect(refCookie(await run(url))).toBeNull()
  })

  it("still sets the referral-trial cookie alongside it", async () => {
    const res = await run("https://radaric.pro/?ref=launch")
    const names = res.headers.getSetCookie().map((c) => c.split("=")[0])
    expect(names).toContain(SIGNUP_REF_COOKIE)
    expect(names).toContain("radaric_ref")
  })
})

describe("credential sign-up writes the ref once (AC-4)", () => {
  let ip = 0
  function request(cookie?: string) {
    const headers: Record<string, string> = { "Content-Type": "application/json", "x-real-ip": `10.8.0.${++ip}` }
    if (cookie) headers.cookie = cookie
    return new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: `ref${ip}@example.com`, password: "password123" }),
    })
  }

  function createdRef() {
    expect(mockUser.create).toHaveBeenCalledTimes(1)
    return (mockUser.create.mock.calls[0][0] as { data: { signupRef?: string | null } }).data.signupRef
  }

  it("a new account created with the cookie gets the ref", async () => {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    const res = await signup(request(`${SIGNUP_REF_COOKIE}=site-d`))
    expect((await res.json()).action).toBe("signup")
    expect(createdRef()).toBe("site-d")
  })

  it("a new account created without the cookie gets null", async () => {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    await signup(request())
    expect(createdRef() ?? null).toBeNull()
  })

  it("never writes the ref in a later update", async () => {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    await signup(request(`${SIGNUP_REF_COOKIE}=site-d`))
    expect(mockUser.update.mock.calls.some(([a]) => "signupRef" in ((a as { data?: object }).data ?? {}))).toBe(false)
    expect(createdRef()).toBe("site-d")
  })

  function refCleared(res: Response) {
    return res.headers.getSetCookie().some((c) => c.startsWith(`${SIGNUP_REF_COOKIE}=;`) && /Max-Age=0/i.test(c))
  }

  it("clears the cookie once the ref is written", async () => {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    expect(refCleared(await signup(request(`${SIGNUP_REF_COOKIE}=site-d`)))).toBe(true)
  })

  it("sets no clearing cookie when there was no ref", async () => {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    expect(refCleared(await signup(request()))).toBe(false)
  })
})

describe("OAuth sign-up writes the ref on a new account only (AC-5)", () => {
  function createdRef() {
    expect(mockUser.create).toHaveBeenCalledTimes(1)
    return (mockUser.create.mock.calls[0][0] as { data: { signupRef?: string | null } }).data.signupRef
  }

  it("a new account gets the ref", async () => {
    mockUser.findFirst.mockResolvedValueOnce(null as never)
    const r = await findOrCreateOAuthUser({ email: "new@example.com" }, { signupRef: "futuretools" })
    expect(r.status).toBe("ok")
    expect(createdRef()).toBe("futuretools")
  })

  it("a new account without a ref gets null", async () => {
    mockUser.findFirst.mockResolvedValueOnce(null as never)
    await findOrCreateOAuthUser({ email: "new@example.com" })
    expect(createdRef() ?? null).toBeNull()
  })

  it("an existing account is not touched", async () => {
    mockUser.findFirst.mockResolvedValueOnce({ id: "u1", role: "USER", username: "old", passwordHash: null, emailVerified: new Date() } as never)
    await findOrCreateOAuthUser({ email: "old@example.com" }, { signupRef: "futuretools" })
    expect(mockUser.create).not.toHaveBeenCalled()
    expect(mockUser.update).not.toHaveBeenCalled()
  })
})
