// @vitest-environment node

/**
 * Outbound mail identity and the public base URL (D3).
 *
 * Both helpers sit under every reset/verification link and every mail sender,
 * so the fallback chain and the "blank counts as unset" rule are pinned here
 * rather than only through their callers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  DEFAULT_EMAIL_FROM,
  getAppBaseUrl,
  getEmailFrom,
} from "@/lib/email-sender"

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("getEmailFrom", () => {
  it("is the hosted default when EMAIL_FROM is unset — prod behaviour unchanged", () => {
    expect(DEFAULT_EMAIL_FROM).toBe("Radaric <noreply@radaric.pro>")
    expect(getEmailFrom()).toBe("Radaric <noreply@radaric.pro>")
  })

  it("treats an empty or whitespace-only EMAIL_FROM as unset (the .env.example shape)", () => {
    vi.stubEnv("EMAIL_FROM", "")
    expect(getEmailFrom()).toBe(DEFAULT_EMAIL_FROM)
    vi.stubEnv("EMAIL_FROM", "   ")
    expect(getEmailFrom()).toBe(DEFAULT_EMAIL_FROM)
  })

  it("honours a configured sender, trimmed", () => {
    vi.stubEnv("EMAIL_FROM", "  Curator Digest <mail@curator.example>  ")
    expect(getEmailFrom()).toBe("Curator Digest <mail@curator.example>")
  })
})

describe("getAppBaseUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://curator.example")
    vi.stubEnv("NEXTAUTH_URL", "https://other.example")
    expect(getAppBaseUrl()).toBe("https://curator.example")
  })

  it("falls back to NEXTAUTH_URL when the app URL is unset", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example")
    expect(getAppBaseUrl()).toBe("https://curator.example")
  })

  it("falls back to localhost when neither is set", () => {
    expect(getAppBaseUrl()).toBe("http://localhost:3000")
  })

  it("treats a blank NEXT_PUBLIC_APP_URL as unset instead of building a relative link", () => {
    // `.env.example` ships empty assignments; `??` alone would yield "" and the
    // reset mail would link to "/reset-password?token=…".
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example")
    expect(getAppBaseUrl()).toBe("https://curator.example")
  })

  it("strips trailing slashes and surrounding whitespace", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://curator.example/// ")
    expect(getAppBaseUrl()).toBe("https://curator.example")
  })
})

describe("the missing EMAIL_FROM warning", () => {
  /** A fresh module instance: the once-per-process latch is module state. */
  async function freshModule() {
    vi.resetModules()
    return import("@/lib/email-sender")
  }

  it("warns once when RESEND_API_KEY is set and EMAIL_FROM is not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("RESEND_API_KEY", "re_test_key")
    vi.stubEnv("EMAIL_FROM", "")

    const { getEmailFrom, DEFAULT_EMAIL_FROM: defaultFrom } = await freshModule()
    expect(getEmailFrom()).toBe(defaultFrom)
    getEmailFrom()
    getEmailFrom()

    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0] as string
    expect(message).toContain("RESEND_API_KEY")
    expect(message).toContain("EMAIL_FROM")
    expect(message).toContain(defaultFrom)
    warn.mockRestore()
  })

  it("stays quiet when EMAIL_FROM is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("RESEND_API_KEY", "re_test_key")
    vi.stubEnv("EMAIL_FROM", "Curator <mail@curator.example>")

    const { getEmailFrom } = await freshModule()
    expect(getEmailFrom()).toBe("Curator <mail@curator.example>")
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("stays quiet without RESEND_API_KEY — no transport, nothing to reject", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("RESEND_API_KEY", "")
    vi.stubEnv("EMAIL_FROM", "")

    const { getEmailFrom } = await freshModule()
    expect(getEmailFrom()).toBe(DEFAULT_EMAIL_FROM)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
