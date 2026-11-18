// @vitest-environment jsdom

/**
 * SELF_HOSTED follow-up (RAD-438) — `/terms` and `/privacy` must not present a
 * self-hosted install as the hosted service.
 *
 * The same built module renders both variants: hosted text with the flag off
 * (byte-identical to today), a short neutral page with it on. Both routes are
 * `force-dynamic` because the image is built without SELF_HOSTED — a build-time
 * branch would bake the hosted text into every self-hosted install.
 */

import "@testing-library/jest-dom/vitest"
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import TermsPage, {
  dynamic as termsDynamic,
  metadata as termsMetadata,
} from "@/app/(landing)/terms/page"
import PrivacyPage, {
  dynamic as privacyDynamic,
  metadata as privacyMetadata,
} from "@/app/(landing)/privacy/page"

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe("/terms", () => {
  it("keeps the hosted terms with SELF_HOSTED off", () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    render(<TermsPage />)

    expect(screen.getByText("1. Service")).toBeInTheDocument()
    expect(screen.getByText(/operated by Kirill Oleinichenko/)).toBeInTheDocument()
    expect(screen.getByText(/\$59\/month/)).toBeInTheDocument()
  })

  it("renders the neutral page with SELF_HOSTED on", () => {
    vi.stubEnv("SELF_HOSTED", "true")
    render(<TermsPage />)

    expect(screen.getByRole("heading", { name: "Terms of Service" })).toBeInTheDocument()
    expect(screen.getByText(/self-hosted Radaric instance/)).toBeInTheDocument()
    expect(screen.getByText(/operator is responsible/)).toBeInTheDocument()
    expect(screen.getByText("SELF_HOSTING.md")).toBeInTheDocument()
    // No hosted operator, address or prices.
    expect(screen.queryByText(/Kirill Oleinichenko/)).toBeNull()
    expect(screen.queryByText(/radaric\.pro/)).toBeNull()
    expect(screen.queryByText(/\$59/)).toBeNull()
  })

  it("is force-dynamic and keeps its hosted metadata", () => {
    expect(termsDynamic).toBe("force-dynamic")
    expect(termsMetadata).toEqual({ title: "Terms of Service" })
  })
})

describe("/privacy", () => {
  it("keeps the hosted policy with SELF_HOSTED off", () => {
    vi.stubEnv("SELF_HOSTED", undefined)
    render(<PrivacyPage />)

    expect(screen.getByText("What we collect")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "kirill@radaric.pro" })).toHaveAttribute(
      "href",
      "mailto:kirill@radaric.pro"
    )
  })

  it("renders the neutral page with SELF_HOSTED on, and shows no address", () => {
    vi.stubEnv("SELF_HOSTED", "true")
    vi.stubEnv("CONTACT_EMAIL", "ops@example.org")
    render(<PrivacyPage />)

    expect(screen.getByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument()
    expect(screen.getByText(/self-hosted Radaric instance/)).toBeInTheDocument()
    expect(screen.getByText(/operator is responsible/)).toBeInTheDocument()
    expect(screen.getByText("SELF_HOSTING.md")).toBeInTheDocument()
    expect(screen.queryByText(/kirill@radaric\.pro/)).toBeNull()
    expect(screen.queryByText(/ops@example\.org/)).toBeNull()
    expect(screen.queryByRole("link", { name: /@/ })).toBeNull()
  })

  it("is force-dynamic and keeps its hosted metadata", () => {
    expect(privacyDynamic).toBe("force-dynamic")
    expect(privacyMetadata).toEqual({ title: "Privacy Policy" })
  })
})
