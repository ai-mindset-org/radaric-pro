/**
 * Referral trial — a NEW account that arrives with `?ref=<TRIAL_REF>`
 * (the `launch` fixture here) gets 7 days of complimentary (Lite, no X) access
 * through the same write path an admin's manual comp uses.
 *
 *   AC-1  exact configured ref on credential sign-up → comp = now + 7 days
 *   AC-2  no ref, a different value, or a different case → no grant
 *   AC-3  an existing account signing in with the ref → no grant
 *   AC-4  a new OAuth account with the ref → grant; an existing one → none
 *   AC-5  the trial is written in the same create as the account, never after
 *   AC-6  a comped user who completed onboarding is not sent to billing, and
 *         the comp carries no X entitlement (Lite)
 *   AC-7  the proxy remembers the ref in a cookie on `/` and `/signup` only,
 *         SameSite=None+Secure over https (Apple's form POST), Lax over http
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
      userSettings: { findUnique: vi.fn(), upsert: vi.fn() },
      feed: { count: vi.fn() },
      subscription: { findUnique: vi.fn() },
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function" ? await (arg as (tx: unknown) => unknown)({ user, $executeRaw }) : arg
      ),
    },
  }
})

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("$2a$10$hashed"), compare: vi.fn().mockResolvedValue(true) },
}))

vi.mock("@/lib/auth", () => ({
  auth: Object.assign(vi.fn(), {}),
}))

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`)
  }),
}))

import { db } from "@/lib/db"
import { auth } from "@/lib/auth"
import { POST as signup } from "@/app/api/auth/signup/route"
import { findOrCreateOAuthUser } from "@/lib/oauth-user"
import { trialCompUntil } from "@/lib/comp-access"
import { requirePaidDashboardAccess } from "@/lib/paywall"
import { getTwitterEntitlement } from "@/lib/entitlements"
import { requireActiveSubscription } from "@/lib/subscription"
import { TRIAL_DAYS, TRIAL_REF_COOKIE, trialRefFromCookieHeader } from "@/lib/trial-ref"

const DAY_MS = 86_400_000
const mockUser = vi.mocked(db.user)

let ipCounter = 0
function signupRequest(cookie?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // A fresh IP per request keeps the in-process rate limiter out of the way.
    "x-real-ip": `10.9.0.${++ipCounter}`,
  }
  if (cookie) headers.cookie = cookie
  return new Request("http://localhost/api/auth/signup", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: `new${ipCounter}@example.com`, password: "password123" }),
  })
}

function createdComp(): Date | null | undefined {
  expect(mockUser.create).toHaveBeenCalledTimes(1)
  return (mockUser.create.mock.calls[0][0] as { data: { complimentaryAccessUntil?: Date | null } }).data
    .complimentaryAccessUntil
}

function expectSevenDayComp() {
  // Written in the same create as the account — never a second write.
  const until = createdComp()
  expect(until).toBeInstanceOf(Date)
  const delta = (until as Date).getTime() - Date.now()
  expect(delta).toBeGreaterThan(TRIAL_DAYS * DAY_MS - 60_000)
  expect(delta).toBeLessThanOrEqual(TRIAL_DAYS * DAY_MS)
  expect(mockUser.update.mock.calls.some(([a]) => "complimentaryAccessUntil" in (a as { data: object }).data)).toBe(false)
}

function expectNoComp() {
  expect(createdComp() ?? null).toBeNull()
}

beforeEach(() => {
  vi.clearAllMocks()
  // Every test states the configured referral value; the fixture is neutral.
  vi.stubEnv("TRIAL_REF", "launch")
  // clearAllMocks keeps queued Once values; a leftover would leak across tests.
  mockUser.findUnique.mockReset()
  mockUser.findFirst.mockReset()
  mockUser.create.mockResolvedValue({ id: "u-new", role: "USER", username: "new-abcd" } as never)
  mockUser.update.mockResolvedValue({} as never)
  mockUser.count.mockResolvedValue(1 as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("credential sign-up (AC-1, AC-2, AC-3)", () => {
  function newEmail() {
    mockUser.findUnique.mockResolvedValueOnce(null as never)
  }

  it("grants 7 days of comp when the referral ref cookie is present", async () => {
    newEmail()
    const res = await signup(signupRequest(`other=1; ${TRIAL_REF_COOKIE}=launch`))
    expect(await res.json()).toMatchObject({ action: "signup" })
    expectSevenDayComp()
    // One grant per referral visit: the cookie is cleared on the way out.
    expect(res.headers.getSetCookie().join("\n")).toMatch(new RegExp(`${TRIAL_REF_COOKIE}=;.*Max-Age=0`, "i"))
  })

  it("grants nothing without the cookie", async () => {
    newEmail()
    const res = await signup(signupRequest())
    expect(await res.json()).toMatchObject({ action: "signup" })
    expectNoComp()
  })

  it.each(["Launch", "launch2", "", "launch%00", "x"])(
    "grants nothing for a forged or other ref value %j",
    async (value) => {
      newEmail()
      const res = await signup(signupRequest(`${TRIAL_REF_COOKIE}=${value}`))
      expect(await res.json()).toMatchObject({ action: "signup" })
      expectNoComp()
    }
  )

  it("grants nothing to an existing account signing in with the ref", async () => {
    mockUser.findUnique.mockResolvedValueOnce({ id: "u-old", passwordHash: "$2a$10$x" } as never)
    const res = await signup(signupRequest(`${TRIAL_REF_COOKIE}=launch`))
    expect(await res.json()).toEqual({ action: "signin" })
    expect(mockUser.create).not.toHaveBeenCalled()
    expect(mockUser.update).not.toHaveBeenCalled()
    expect(res.headers.getSetCookie().join("\n")).not.toMatch(TRIAL_REF_COOKIE)
  })
})

describe("OAuth sign-up (AC-4)", () => {
  it("grants the trial to a NEW OAuth account carrying the ref", async () => {
    mockUser.findFirst.mockResolvedValue(null as never)
    const result = await findOrCreateOAuthUser({ email: "g@example.com", name: "G" }, { ref: "launch" })
    expect(result).toMatchObject({ status: "ok", account: { id: "u-new", created: true } })
    expectSevenDayComp()
  })

  it("grants nothing to a new OAuth account without the ref", async () => {
    mockUser.findFirst.mockResolvedValue(null as never)
    await findOrCreateOAuthUser({ email: "g@example.com", name: "G" })
    expectNoComp()
  })

  it("grants nothing to an EXISTING OAuth account carrying the ref", async () => {
    mockUser.findFirst.mockResolvedValue({
      id: "u-old", role: "USER", username: "old", passwordHash: null, emailVerified: new Date(),
    } as never)
    const result = await findOrCreateOAuthUser({ email: "g@example.com" }, { ref: "launch" })
    expect(result).toMatchObject({ status: "ok", account: { id: "u-old", created: false } })
    expect(mockUser.create).not.toHaveBeenCalled()
    expect(mockUser.update).not.toHaveBeenCalled()
  })
})

describe("trialCompUntil", () => {
  it("is exactly 7 days for the configured ref and null for anything else", () => {
    const now = Date.UTC(2026, 9, 22, 12)
    expect(trialCompUntil("launch", now)?.getTime()).toBe(now + 7 * DAY_MS)
    for (const ref of ["LAUNCH", "launch ", "", null, undefined]) {
      expect(trialCompUntil(ref, now)).toBeNull()
    }
  })

  it("reads the cookie value exactly, never a prefix-named cookie", () => {
    expect(trialRefFromCookieHeader(`x${TRIAL_REF_COOKIE}=launch`)).toBeNull()
    expect(trialRefFromCookieHeader(`a=b;  ${TRIAL_REF_COOKIE}=launch `)).toBe("launch")
    expect(trialRefFromCookieHeader(null)).toBeNull()
  })
})

describe("a configured ref that is not a plain token", () => {
  it("round-trips through the percent-encoded cookie on both sign-up paths", async () => {
    vi.stubEnv("TRIAL_REF", "Product Hunt")
    const created = Date.UTC(2026, 9, 22, 12)

    // The proxy writes it encoded (Next encodes a non-octet value); the raw
    // header reader must decode it like the OAuth `cookies()` path does.
    expect(trialRefFromCookieHeader(`${TRIAL_REF_COOKIE}=Product%20Hunt`)).toBe("Product Hunt")
    expect(trialCompUntil("Product Hunt", created)).toBeInstanceOf(Date)

    mockUser.findUnique.mockResolvedValueOnce(null as never)
    const res = await signup(signupRequest(`other=1; ${TRIAL_REF_COOKIE}=Product%20Hunt`))
    expect(await res.json()).toMatchObject({ action: "signup" })
    expect(createdComp()).toBeInstanceOf(Date)

    mockUser.findFirst.mockResolvedValue(null as never)
    const oauth = await findOrCreateOAuthUser({ email: "spaced@example.com" }, { ref: "Product Hunt" })
    expect(oauth).toMatchObject({ status: "ok", account: { created: true } })
    const data = (mockUser.create.mock.calls[1][0] as { data: { complimentaryAccessUntil?: Date | null } }).data
    expect(data.complimentaryAccessUntil).toBeInstanceOf(Date)
  })

  it("keeps an undecodable value as it arrived", () => {
    expect(trialRefFromCookieHeader(`${TRIAL_REF_COOKIE}=100%`)).toBe("100%")
  })
})

describe("paywall for a comped user (AC-6)", () => {
  const NOW = Date.now()

  function setup(compUntil: Date | null) {
    vi.mocked(auth).mockResolvedValue({ user: { id: "u-new", role: "USER" } } as never)
    vi.mocked(db.userSettings.findUnique).mockResolvedValue({ onboardingCompleted: false } as never)
    vi.mocked(db.feed.count).mockResolvedValue(3 as never)
    vi.mocked(db.subscription.findUnique).mockResolvedValue(null as never)
    mockUser.findUnique.mockResolvedValue({
      complimentaryAccessUntil: compUntil,
      createdAt: new Date(NOW - 60_000),
    } as never)
  }

  it("lets a trial user who just completed onboarding through, not to billing", async () => {
    setup(new Date(NOW + TRIAL_DAYS * DAY_MS))
    await expect(requirePaidDashboardAccess()).resolves.toEqual({ userId: "u-new", role: "USER" })
  })

  it("sends the same user without the comp to billing (control)", async () => {
    setup(null)
    await expect(requirePaidDashboardAccess()).rejects.toThrow("NEXT_REDIRECT:/settings/billing")
  })

  function compedUserRow() {
    return {
      id: "u-new",
      complimentaryAccessUntil: new Date(NOW + TRIAL_DAYS * DAY_MS),
      createdAt: new Date(NOW - 60_000),
      userSettings: { onboardingCompleted: true },
      subscription: null,
    }
  }

  it("passes the API gate that guards the AI routes", async () => {
    mockUser.findUnique.mockResolvedValue(compedUserRow() as never)
    await expect(requireActiveSubscription("u-new", "USER")).resolves.toBeNull()
  })

  it("carries no X entitlement — the comp is Lite", async () => {
    mockUser.findUnique.mockResolvedValue(compedUserRow() as never)
    await expect(getTwitterEntitlement("u-new", "USER")).resolves.toMatchObject({ includesTwitter: false })
  })
})

describe("proxy remembers the ref (AC-7)", () => {
  type Proxy = (req: NextRequest) => Promise<Response> | Response

  async function run(url: string) {
    vi.resetModules()
    vi.doMock("@/lib/auth", () => ({ auth: (handler: unknown) => handler }))
    const proxy = (await import("@/proxy")).default as unknown as Proxy
    const req = new NextRequest(url)
    Object.assign(req, { auth: null })
    return await proxy(req)
  }

  function refCookie(res: Response) {
    return res.headers.getSetCookie().find((c) => c.startsWith(`${TRIAL_REF_COOKIE}=`)) ?? null
  }

  it.each(["https://radaric.pro/?ref=launch", "https://radaric.pro/signup?ref=launch"])(
    "sets a SameSite=None Secure HttpOnly cookie on %s",
    async (url) => {
      const cookie = refCookie(await run(url))
      expect(cookie).toMatch(new RegExp(`^${TRIAL_REF_COOKIE}=launch;`))
      expect(cookie).toMatch(/HttpOnly/i)
      expect(cookie).toMatch(/Secure/i)
      expect(cookie).toMatch(/SameSite=none/i)
      expect(cookie).toMatch(/Max-Age=604800/i)
    }
  )

  it("falls back to SameSite=Lax without Secure over plain http", async () => {
    const cookie = refCookie(await run("http://localhost:3000/?ref=launch"))
    expect(cookie).toMatch(/SameSite=lax/i)
    expect(cookie).not.toMatch(/Secure/i)
  })

  it.each([
    "https://radaric.pro/",
    "https://radaric.pro/?ref=Launch",
    "https://radaric.pro/?ref=twitter",
    "https://radaric.pro/terms?ref=launch",
    "https://radaric.pro/posts?ref=launch",
  ])("sets nothing for %s", async (url) => {
    expect(refCookie(await run(url))).toBeNull()
  })
})
