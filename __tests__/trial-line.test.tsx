/**
 * @vitest-environment jsdom
 *
 * Referral trial line — "7 days free, no card required" shows near the
 * primary CTA on `/` and on `/signup` only for `?ref=<TRIAL_REF>`, and only
 * while the trial is on and the offer is open (TRIAL_REF, TRIAL_REF_ENDS_AT,
 * RAD-419).
 */
import "@testing-library/jest-dom/vitest"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

// The ref cookie the proxy set, as /signup's server component reads it.
const refCookie = vi.hoisted(() => ({ value: undefined as string | undefined }))

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "radaric_ref" && refCookie.value !== undefined ? { name, value: refCookie.value } : undefined,
  }),
}))

import { SignupForm } from "@/components/auth/signup-form"
import LandingPage from "@/app/page"
import SignupPage from "@/app/signup/page"

const LINE = /7 days free, no card required/i
const ENDED = () => new Date(Date.now() - 60_000).toISOString()
const LATER = () => new Date(Date.now() + 86_400_000).toISOString()

beforeEach(() => {
  // Every test states the configured referral value; the fixture is neutral.
  vi.stubEnv("TRIAL_REF", "launch")
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  refCookie.value = undefined
})

describe("signup form trial line", () => {
  it("shows the line when the server resolved a trial ref", () => {
    render(<SignupForm oauth={{ google: false, apple: false }} trial />)
    expect(screen.getByText(LINE)).toBeInTheDocument()
  })

  it("shows nothing by default", () => {
    render(<SignupForm oauth={{ google: false, apple: false }} />)
    expect(screen.queryByText(LINE)).toBeNull()
  })
})

describe("landing trial line", () => {
  async function renderLanding(ref?: string | string[]) {
    render(await LandingPage({ searchParams: Promise.resolve(ref === undefined ? {} : { ref }) }))
  }

  it("shows the line for ref=launch", async () => {
    await renderLanding("launch")
    expect(screen.getByText(LINE)).toBeInTheDocument()
  })

  it.each([undefined, "twitter", "Launch", ["launch", "launch"]])(
    "shows nothing for ref %j",
    async (ref) => {
      await renderLanding(ref)
      expect(screen.queryByText(LINE)).toBeNull()
    }
  )
})

describe("offer end date (RAD-419)", () => {
  async function renderLanding(ref: string) {
    render(await LandingPage({ searchParams: Promise.resolve({ ref }) }))
  }

  async function renderSignup(ref?: string) {
    render(await SignupPage({ searchParams: Promise.resolve(ref === undefined ? {} : { ref }) }))
  }

  it("hides the landing line for ref=launch once the offer has ended", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", ENDED())
    await renderLanding("launch")
    expect(screen.queryByText(LINE)).toBeNull()
  })

  it("keeps the landing line before the end (control)", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", LATER())
    await renderLanding("launch")
    expect(screen.getByText(LINE)).toBeInTheDocument()
  })

  it("hides the /signup line for a ref cookie set before the end", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", ENDED())
    refCookie.value = "launch"
    await renderSignup()
    expect(screen.queryByText(LINE)).toBeNull()
  })

  it("hides the /signup line for ?ref=launch once the offer has ended", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", ENDED())
    await renderSignup("launch")
    expect(screen.queryByText(LINE)).toBeNull()
  })

  it("shows the /signup line from the cookie while the offer is open (control)", async () => {
    vi.stubEnv("TRIAL_REF_ENDS_AT", LATER())
    refCookie.value = "launch"
    await renderSignup()
    expect(screen.getByText(LINE)).toBeInTheDocument()
  })
})

describe("trial off — TRIAL_REF unset", () => {
  it.each([undefined, "", "   "])("never shows the landing line for TRIAL_REF=%j", async (value) => {
    vi.stubEnv("TRIAL_REF", value)
    render(await LandingPage({ searchParams: Promise.resolve({ ref: "launch" }) }))
    expect(screen.queryByText(LINE)).toBeNull()
  })

  it("never shows the /signup line, even with a ref cookie", async () => {
    vi.stubEnv("TRIAL_REF", undefined)
    refCookie.value = "launch"
    render(await SignupPage({ searchParams: Promise.resolve({ ref: "launch" }) }))
    expect(screen.queryByText(LINE)).toBeNull()
  })
})
