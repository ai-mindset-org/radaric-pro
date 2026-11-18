/**
 * RAD-419 — the referral trial (#210) can be closed on a date, and a
 * referral-trial comp is recognizable from the account row alone (no migration).
 *
 *   AC-1  TRIAL_REF_ENDS_AT unset, empty or unparseable → the offer is open
 *         (the #210 behavior, so nothing changes until the variable is set)
 *   AC-2  before the end → open; at or after it → closed
 *   AC-3  closed → trialCompUntil is null even for the exact ref, so a cookie
 *         set while the offer was open grants nothing afterwards
 *   AC-4  closed → credential and OAuth sign-ups carrying the ref write no comp
 *   AC-5  closed → the proxy sets no radaric_ref cookie
 *   AC-6  isLaunchTrialComp: complimentaryAccessUntil − createdAt within
 *         ±10 minutes of TRIAL_DAYS days; anything else (manual comps) is not
 *   AC-7  TRIAL_REF unset → the trial is off: no cookie, no grant, no line;
 *         already-granted trials still read as trials (isLaunchTrialComp)
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

// proxy.ts wraps its handler in auth(); the identity keeps the handler callable.
vi.mock("@/lib/auth", () => ({ auth: (handler: unknown) => handler }))

import { db } from "@/lib/db"
import { POST as signup } from "@/app/api/auth/signup/route"
import { findOrCreateOAuthUser } from "@/lib/oauth-user"
import { trialCompUntil } from "@/lib/comp-access"
import proxyDefault from "@/proxy"
import { isLaunchTrialComp, isTrialOfferOpen, isTrialRef, TRIAL_DAYS, TRIAL_REF_COOKIE } from "@/lib/trial-ref"

const DAY_MS = 86_400_000
const MIN_MS = 60_000
const END = "2026-10-29T12:00:00Z"
const END_MS = Date.parse(END)
const mockUser = vi.mocked(db.user)

beforeEach(() => {
  vi.clearAllMocks()
  // Every test states the configured referral value; the fixture is neutral.
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

describe("isTrialOfferOpen (AC-1, AC-2)", () => {
  it("is open when TRIAL_REF_ENDS_AT is unset", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", undefined)
    expect(isTrialOfferOpen(END_MS + 365 * DAY_MS)).toBe(true)
  })

  it.each(["", "   "])("is open when TRIAL_REF_ENDS_AT is empty (%j)", (value) => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", value)
    expect(isTrialOfferOpen(END_MS + 365 * DAY_MS)).toBe(true)
  })

  // "1" and "2026" are not ISO dates even though Date.parse reads them as years.
  it.each(["soon", "next week", "1", "2026", "2026-13-45", "29/10/2026", "Oct 29 2026"])(
    "is open when TRIAL_REF_ENDS_AT is unparseable (%j)",
    (value) => {
      vi.stubEnv("TRIAL_REF_ENDS_AT", value)
      expect(isTrialOfferOpen(END_MS + 365 * DAY_MS)).toBe(true)
    }
  )

  // Calendar-impossible dates match the ISO shape but V8 rolls them forward.
  it.each(["2026-02-30", "2026-11-31", "2026-11-31T12:00:00Z"])(
    "is open when TRIAL_REF_ENDS_AT is not a real calendar date (%j)",
    (value) => {
      vi.stubEnv("TRIAL_REF_ENDS_AT", value)
      expect(isTrialOfferOpen(END_MS + 365 * DAY_MS)).toBe(true)
    }
  )

  // The likely operator slips: a value pasted with its quotes, a lowercase t/z.
  it.each([`"${END}"`, `'${END}'`, END.toLowerCase()])("still closes for %j", (value) => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", value)
    expect(isTrialOfferOpen(END_MS - 1)).toBe(true)
    expect(isTrialOfferOpen(END_MS)).toBe(false)
  })

  it("warns once per unreadable value that the offer stays open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("TRIAL_REF_ENDS_AT", "next friday")
    isTrialOfferOpen()
    isTrialOfferOpen()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/TRIAL_REF_ENDS_AT.*OPEN/)
    warn.mockRestore()
  })

  it("is open before the end and closed at and after it", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", END)
    expect(isTrialOfferOpen(END_MS - 1)).toBe(true)
    expect(isTrialOfferOpen(END_MS)).toBe(false)
    expect(isTrialOfferOpen(END_MS + DAY_MS)).toBe(false)
  })

  it("honours an explicit offset and a date-only value (UTC midnight)", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", "2026-10-29T12:00:00+02:00")
    expect(isTrialOfferOpen(Date.parse("2026-10-29T09:59:59Z"))).toBe(true)
    expect(isTrialOfferOpen(Date.parse("2026-10-29T10:00:00Z"))).toBe(false)

    vi.stubEnv("TRIAL_REF_ENDS_AT", "2026-10-29")
    expect(isTrialOfferOpen(Date.parse("2026-10-28T23:59:59Z"))).toBe(true)
    expect(isTrialOfferOpen(Date.parse("2026-10-29T00:00:00Z"))).toBe(false)
  })

  it("reads the variable on every call, not once at import", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", END)
    expect(isTrialOfferOpen(END_MS)).toBe(false)
    vi.stubEnv("TRIAL_REF_ENDS_AT", "")
    expect(isTrialOfferOpen(END_MS)).toBe(true)
  })
})

describe("trialCompUntil after the offer ends (AC-3)", () => {
  it("is null for the exact ref once the offer is closed", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", END)
    expect(trialCompUntil("launch", END_MS)).toBeNull()
    expect(trialCompUntil("launch", END_MS + DAY_MS)).toBeNull()
  })

  it("still grants exactly TRIAL_DAYS while the offer is open", () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", END)
    const now = END_MS - MIN_MS
    expect(trialCompUntil("launch", now)?.getTime()).toBe(now + TRIAL_DAYS * DAY_MS)
  })
})

describe("sign-up after the offer ends (AC-4)", () => {
  let ip = 0
  function signupRequest(cookie: string) {
    return new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-real-ip": `10.19.0.${++ip}`, cookie },
      body: JSON.stringify({ email: `late${ip}@example.com`, password: "password123" }),
    })
  }

  function createdComp(): Date | null {
    expect(mockUser.create).toHaveBeenCalledTimes(1)
    const data = (mockUser.create.mock.calls[0][0] as { data: { complimentaryAccessUntil?: Date | null } }).data
    return data.complimentaryAccessUntil ?? null
  }

  it("a credential sign-up with an old ref cookie gets no comp", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", new Date(Date.now() - MIN_MS).toISOString())
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    const res = await signup(signupRequest(`${TRIAL_REF_COOKIE}=launch`))
    expect(await res.json()).toMatchObject({ action: "signup" })
    expect(createdComp()).toBeNull()
  })

  it("the same sign-up before the end still gets the trial (control)", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", new Date(Date.now() + DAY_MS).toISOString())
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    await signup(signupRequest(`${TRIAL_REF_COOKIE}=launch`))
    expect(createdComp()).toBeInstanceOf(Date)
  })

  it("a new OAuth account carrying the ref gets no comp once the offer is closed", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", new Date(Date.now() - MIN_MS).toISOString())
    mockUser.findFirst.mockResolvedValue(null as never)
    const result = await findOrCreateOAuthUser({ email: "late@example.com" }, { ref: "launch" })
    expect(result).toMatchObject({ status: "ok", account: { created: true } })
    expect(createdComp()).toBeNull()
  })
})

describe("proxy after the offer ends (AC-5)", () => {
  type Proxy = (req: NextRequest) => Promise<Response> | Response
  const proxy = proxyDefault as unknown as Proxy

  async function refCookie(url: string) {
    const req = new NextRequest(url)
    Object.assign(req, { auth: null })
    const res = await proxy(req)
    return res.headers.getSetCookie().find((c) => c.startsWith(`${TRIAL_REF_COOKIE}=`)) ?? null
  }

  it.each(["https://radaric.pro/?ref=launch", "https://radaric.pro/signup?ref=launch"])(
    "sets no ref cookie on %s once the offer is closed",
    async (url) => {
      vi.stubEnv("TRIAL_REF_ENDS_AT", new Date(Date.now() - MIN_MS).toISOString())
      expect(await refCookie(url)).toBeNull()
    }
  )

  it("still sets it before the end (control)", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", new Date(Date.now() + DAY_MS).toISOString())
    expect(await refCookie("https://radaric.pro/?ref=launch")).toMatch(
      new RegExp(`^${TRIAL_REF_COOKIE}=launch;`)
    )
  })

  it("still sets it with an unparseable end (open-ended)", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", "end of launch week")
    expect(await refCookie("https://radaric.pro/signup?ref=launch")).not.toBeNull()
  })
})

describe("TRIAL_REF unset — the trial is off (AC-7)", () => {
  type Proxy = (req: NextRequest) => Promise<Response> | Response
  const proxy = proxyDefault as unknown as Proxy

  async function refCookie(url: string) {
    const req = new NextRequest(url)
    Object.assign(req, { auth: null })
    const res = await proxy(req)
    return res.headers.getSetCookie().find((c) => c.startsWith(`${TRIAL_REF_COOKIE}=`)) ?? null
  }

  let ip = 0
  function signupRequest(cookie: string) {
    return new Request("http://localhost/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-real-ip": `10.20.0.${++ip}`, cookie },
      body: JSON.stringify({ email: `off${ip}@example.com`, password: "password123" }),
    })
  }

  it.each([undefined, "", "   "])("matches no ref when TRIAL_REF is %j", (value) => {
    vi.stubEnv("TRIAL_REF", value)
    expect(isTrialRef("launch")).toBe(false)
    expect(isTrialRef("")).toBe(false)
    expect(isTrialRef(null)).toBe(false)
  })

  it("grants nothing for the ref the operator would have configured", () => {
    vi.stubEnv("TRIAL_REF", undefined)
    expect(trialCompUntil("launch", END_MS - MIN_MS)).toBeNull()
  })

  it("a credential sign-up with the ref cookie gets no comp", async () => {
    vi.stubEnv("TRIAL_REF", undefined)
    mockUser.findUnique.mockResolvedValueOnce(null as never)
    const res = await signup(signupRequest(`${TRIAL_REF_COOKIE}=launch`))
    expect(await res.json()).toMatchObject({ action: "signup" })
    const data = (mockUser.create.mock.calls[0][0] as { data: { complimentaryAccessUntil?: Date | null } }).data
    expect(data.complimentaryAccessUntil ?? null).toBeNull()
  })

  it("the proxy sets no ref cookie", async () => {
    vi.stubEnv("TRIAL_REF", undefined)
    expect(await refCookie("https://radaric.pro/?ref=launch")).toBeNull()
    expect(await refCookie("https://radaric.pro/signup?ref=launch")).toBeNull()
  })

  it("already-granted trials still read as trials (isLaunchTrialComp is grant-length based)", () => {
    vi.stubEnv("TRIAL_REF", undefined)
    const created = new Date("2026-10-22T12:00:00Z")
    expect(
      isLaunchTrialComp({
        createdAt: created,
        complimentaryAccessUntil: new Date(created.getTime() + TRIAL_DAYS * DAY_MS),
      })
    ).toBe(true)
  })

  it("setting TRIAL_REF brings the current behaviour back (control)", async () => {
    vi.stubEnv("TRIAL_REF", "launch")
    expect(isTrialRef("launch")).toBe(true)
    expect(await refCookie("https://radaric.pro/?ref=launch")).toMatch(
      new RegExp(`^${TRIAL_REF_COOKIE}=launch;`)
    )
  })
})

describe("isLaunchTrialComp (AC-6)", () => {
  const CREATED = new Date("2026-10-22T12:00:00Z")
  const TRIAL_MS = TRIAL_DAYS * DAY_MS
  const after = (ms: number) => new Date(CREATED.getTime() + ms)
  const check = (until: Date | null) => isLaunchTrialComp({ createdAt: CREATED, complimentaryAccessUntil: until })

  it("matches the grant account creation writes", () => {
    expect(check(after(TRIAL_MS))).toBe(true)
    // Round trip through the real writer, for an account created at the same instant.
    vi.stubEnv("TRIAL_REF_ENDS_AT", undefined)
    expect(check(trialCompUntil("launch", CREATED.getTime()))).toBe(true)
  })

  it("is inclusive at ±10 minutes and false one millisecond beyond", () => {
    expect(check(after(TRIAL_MS + 10 * MIN_MS))).toBe(true)
    expect(check(after(TRIAL_MS - 10 * MIN_MS))).toBe(true)
    expect(check(after(TRIAL_MS + 10 * MIN_MS + 1))).toBe(false)
    expect(check(after(TRIAL_MS - 10 * MIN_MS - 1))).toBe(false)
  })

  it("is false without a comp", () => {
    expect(check(null)).toBe(false)
  })

  it("is false for manual comps: a longer grant, or 7 days granted later", () => {
    expect(check(after(30 * DAY_MS))).toBe(false)
    expect(check(after(14 * DAY_MS))).toBe(false)
    // An admin extend (+7 days) on a running trial makes it a manual comp.
    expect(check(after(2 * TRIAL_MS))).toBe(false)
  })
})
