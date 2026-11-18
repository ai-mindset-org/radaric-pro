// @vitest-environment jsdom

/**
 * RAD-438 — the support / refund / privacy address comes from `CONTACT_EMAIL`,
 * resolved on the server and shown at every UI site. Unset, it stays the hosted
 * address, so radaric.pro renders and behaves exactly as before.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`)
  }),
}))

import { getContactEmail } from "@/lib/contact"
import LandingPage from "@/app/page"
import PrivacyPage from "@/app/(landing)/privacy/page"
import { BillingSection } from "@/components/settings/billing-section"

const DEFAULT = "kirill@radaric.pro"

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe("getContactEmail", () => {
  it("defaults to the hosted address", () => {
    vi.stubEnv("CONTACT_EMAIL", undefined)
    expect(getContactEmail()).toBe(DEFAULT)
  })

  it("reads CONTACT_EMAIL, trimmed", () => {
    vi.stubEnv("CONTACT_EMAIL", "  ops@example.org  ")
    expect(getContactEmail()).toBe("ops@example.org")
  })

  it.each(["", "   "])("treats a blank value (%j) as unset", (value) => {
    vi.stubEnv("CONTACT_EMAIL", value)
    expect(getContactEmail()).toBe(DEFAULT)
  })

  it("reads the variable on every call, not once at import", () => {
    vi.stubEnv("CONTACT_EMAIL", "ops@example.org")
    expect(getContactEmail()).toBe("ops@example.org")
    vi.stubEnv("CONTACT_EMAIL", "")
    expect(getContactEmail()).toBe(DEFAULT)
  })
})

describe("landing page", () => {
  async function renderLanding() {
    vi.stubEnv("SELF_HOSTED", undefined)
    render(await LandingPage({ searchParams: Promise.resolve({}) }))
    return screen.getByRole("link", { name: "Contact" })
  }

  it("links the hosted contact address by default", async () => {
    vi.stubEnv("CONTACT_EMAIL", undefined)
    expect(await renderLanding()).toHaveAttribute("href", `mailto:${DEFAULT}`)
  })

  it("links CONTACT_EMAIL when set", async () => {
    vi.stubEnv("CONTACT_EMAIL", "ops@example.org")
    expect(await renderLanding()).toHaveAttribute("href", "mailto:ops@example.org")
  })

  it("redirects to /login on a self-hosted install instead of rendering", async () => {
    vi.stubEnv("SELF_HOSTED", "true")
    await expect(LandingPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      "redirect:/login"
    )
  })
})

describe("privacy page", () => {
  it("shows the hosted address by default", () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    vi.stubEnv("CONTACT_EMAIL", undefined)
    render(<PrivacyPage />)

    expect(screen.getByRole("link", { name: DEFAULT })).toHaveAttribute("href", `mailto:${DEFAULT}`)
  })

  it("shows CONTACT_EMAIL when set", () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    vi.stubEnv("CONTACT_EMAIL", "ops@example.org")
    render(<PrivacyPage />)

    expect(screen.getByRole("link", { name: "ops@example.org" })).toHaveAttribute(
      "href",
      "mailto:ops@example.org"
    )
  })
})

describe("billing section", () => {
  function renderBilling(contactEmail: string) {
    render(
      <BillingSection
        contactEmail={contactEmail}
        hasActiveAccess={false}
        subscriptionActive={false}
        subscription={null}
        complimentaryAccessUntil={null}
        nowMs={Date.now()}
        successState={false}
        canceledState={false}
      />
    )
  }

  it("prints the address the server passed in", () => {
    renderBilling("ops@example.org")
    expect(screen.getAllByText(/email ops@example\.org within 30 days/).length).toBeGreaterThan(0)
  })

  it("prints the hosted address by default", () => {
    renderBilling(DEFAULT)
    expect(screen.getAllByText(new RegExp(`email ${DEFAULT.replace(/\./g, "\\.")} within 30 days`)).length).toBeGreaterThan(0)
  })
})
