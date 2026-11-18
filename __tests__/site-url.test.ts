// @vitest-environment node

/**
 * The site's own origin — one helper behind metadata, the crawler files and the
 * links in outbound mail.
 *
 * `__tests__/email-sender.test.ts` pins the same chain through `getAppBaseUrl`,
 * the name its callers still use; these tests pin the helper both read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { getSiteUrl } from "@/lib/site-url"

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("getSiteUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://curator.example")
    vi.stubEnv("NEXTAUTH_URL", "https://other.example")
    expect(getSiteUrl()).toBe("https://curator.example")
  })

  it("falls back to NEXTAUTH_URL when the app URL is unset", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example")
    expect(getSiteUrl()).toBe("https://curator.example")
  })

  it("falls back to localhost when neither is set", () => {
    expect(getSiteUrl()).toBe("http://localhost:3000")
  })

  it("treats a blank NEXT_PUBLIC_APP_URL as unset", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    vi.stubEnv("NEXTAUTH_URL", "https://curator.example")
    expect(getSiteUrl()).toBe("https://curator.example")
  })

  it("strips trailing slashes and surrounding whitespace", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " https://curator.example/// ")
    expect(getSiteUrl()).toBe("https://curator.example")
  })

  it("gives a bare host an https scheme instead of letting new URL() throw", () => {
    // `metadataBase: new URL(getSiteUrl())` runs at root-layout module load: a
    // scheme-less value here would take every route down, not just the links.
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "feeds.example.org")
    expect(getSiteUrl()).toBe("https://feeds.example.org")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "localhost:3000")
    expect(getSiteUrl()).toBe("https://localhost:3000")
  })

  it("follows the environment on every call, not once at import", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://first.example")
    expect(getSiteUrl()).toBe("https://first.example")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://second.example")
    expect(getSiteUrl()).toBe("https://second.example")
  })
})
