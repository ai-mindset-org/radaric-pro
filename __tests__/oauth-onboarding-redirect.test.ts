// @vitest-environment node

/**
 * OAuth signIn callback — always returns true
 *
 * The signIn callback must always return `true` so NextAuth properly sets the
 * session cookie. Onboarding redirect is handled by the /posts page server
 * component (checks onboardingCompleted + feed count).
 *
 * Returning a URL string from signIn causes the session cookie to not be set
 * before the redirect, resulting in the user landing on the login page.
 *
 * Spec criteria:
 *   AC-1: New Google OAuth user → true (user created, session set, /posts handles redirect)
 *   AC-2: Returning Google OAuth user → true
 *   AC-3: New Apple OAuth user → true (user created, session set, /posts handles redirect)
 *   EC-1: Credentials-based signIn → true
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must precede any import that pulls in the mocked modules
// ---------------------------------------------------------------------------

const mockFindFirst = vi.fn()
const mockCreate = vi.fn()
const mockUserSettingsCreate = vi.fn()
const txExecuteRaw = vi.fn(async () => 1)

vi.mock("@/lib/db", () => {
  const user = {
    findFirst: mockFindFirst,
    create: mockCreate,
    findUnique: vi.fn(),
    count: vi.fn(async () => 1),
  }
  return {
    db: {
      user,
      $executeRaw: txExecuteRaw,
      userSettings: {
        create: mockUserSettingsCreate,
        findUnique: vi.fn(),
      },
      // RAD-285: user creation runs inside an interactive transaction; tx.user
      // is the same object so existing mockCreate assertions hold.
      $transaction: vi.fn(async (arg: unknown) =>
        typeof arg === "function" ? await (arg as (tx: unknown) => unknown)({ user, $executeRaw: txExecuteRaw }) : arg
      ),
    },
  }
})

vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn().mockResolvedValue(false),
    hash: vi.fn(),
  },
}))

// The referral-trial ref cookie the signIn callback reads (lib/trial-ref.ts).
const cookieJar = new Map<string, string>()
const cookieDelete = vi.fn((name: string) => cookieJar.delete(name))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name) } : undefined),
    delete: cookieDelete,
  }),
}))

// Capture the config NextAuth receives, so we can extract the signIn callback
// and call it directly in tests without spinning up the full auth server.
let capturedSignInCallback: ((...args: never[]) => unknown) | null = null

vi.mock("next-auth", () => ({
  default: (config: { callbacks?: { signIn?: (...args: never[]) => unknown } }) => {
    capturedSignInCallback = config.callbacks?.signIn ?? null
    return { handlers: {}, signIn: vi.fn(), signOut: vi.fn(), auth: vi.fn() }
  },
}))

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn(() => ({ id: "credentials", type: "credentials" })),
}))

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({ id: "google", type: "oauth" })),
}))

vi.mock("next-auth/providers/apple", () => ({
  default: vi.fn(() => ({ id: "apple", type: "oauth" })),
}))

// ---------------------------------------------------------------------------
// Import auth — triggers NextAuth() which populates capturedSignInCallback
// ---------------------------------------------------------------------------

// Ensure env vars are set so Google + Apple providers are included
process.env.GOOGLE_CLIENT_ID = "test-google-client-id"
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret"
process.env.APPLE_ID = "test-apple-id"
process.env.APPLE_SECRET = "test-apple-secret"

await import("@/lib/auth")

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SignInCallbackArgs = {
  user: { id?: string; email?: string; name?: string; role?: string; username?: string }
  account: { provider: string } | null
  profile?: Record<string, unknown>
}

async function callSignIn(args: SignInCallbackArgs): Promise<unknown> {
  if (!capturedSignInCallback) {
    throw new Error("signIn callback was not captured — check NextAuth mock setup")
  }
  return capturedSignInCallback(args as never)
}

const EXISTING_USER = {
  id: "existing-user-id",
  email: "user@example.com",
  username: "existing_user",
  name: "Existing User",
  role: "USER",
  isActive: true,
}

const NEW_USER_CREATED = {
  id: "new-user-id",
  email: "newuser@example.com",
  username: "newuser_abc1",
  name: "New User",
  role: "USER",
  isActive: true,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("signIn callback: OAuth always returns true (onboarding via /posts gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreate.mockResolvedValue(NEW_USER_CREATED)
    mockUserSettingsCreate.mockResolvedValue({})
  })

  it("AC-1: returns true for new Google OAuth user (creates user, lets /posts handle onboarding redirect)", async () => {
    mockFindFirst.mockResolvedValue(null)

    const result = await callSignIn({
      user: { email: "newuser@example.com", name: "New User" },
      account: { provider: "google" },
    })

    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
    // Settings are nested inside the create (atomic account creation) and the
    // first-user promotion runs under the advisory lock.
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userSettings: { create: { onboardingCompleted: false } } }) })
    )
    expect(txExecuteRaw).toHaveBeenCalled()
    expect(String(txExecuteRaw.mock.calls[0][0])).toContain("pg_advisory_xact_lock")
  })

  it("AC-2: returns true for returning Google OAuth user (findFirst returns existing user)", async () => {
    // Returning user — already exists in DB
    mockFindFirst.mockResolvedValue(EXISTING_USER)

    const result = await callSignIn({
      user: { email: "user@example.com", name: "Existing User" },
      account: { provider: "google" },
    })

    // Existing users proceed to the default callback URL (no onboarding redirect)
    expect(result).toBe(true)
  })

  it("AC-4 (RAD-325): refuses to link a never-verified credential account", async () => {
    mockFindFirst.mockResolvedValue({
      ...EXISTING_USER,
      passwordHash: "$2a$10$hash",
      emailVerified: null,
    })

    const result = await callSignIn({
      user: { email: "victim@example.com" },
      account: { provider: "google" },
    })

    expect(result).toBe(false)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("AC-5 (RAD-325): links the same account once the email is verified", async () => {
    mockFindFirst.mockResolvedValue({
      ...EXISTING_USER,
      passwordHash: "$2a$10$hash",
      emailVerified: new Date(),
    })

    const result = await callSignIn({
      user: { email: "user@example.com", name: "Existing User" },
      account: { provider: "google" },
    })

    expect(result).toBe(true)
  })

  it("AC-3: returns true for new Apple OAuth user (creates user, lets /posts handle onboarding redirect)", async () => {
    mockFindFirst.mockResolvedValue(null)

    const result = await callSignIn({
      user: { email: "appleuser@icloud.com", name: "Apple User" },
      account: { provider: "apple" },
    })

    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalled()
  })

  it("EC-1: returns true for credentials-based signIn (onboarding redirect must not apply)", async () => {
    // Credentials provider — findFirst may or may not be called, doesn't matter
    mockFindFirst.mockResolvedValue(null)

    const result = await callSignIn({
      user: { email: "creds@example.com" },
      account: { provider: "credentials" },
    })

    expect(result).toBe(true)
  })
})

describe("signIn callback: referral trial ref", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("TRIAL_REF", "launch")
    cookieJar.clear()
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ ...EXISTING_USER, id: "new-trial-user" })
  })

  it("grants the trial to a NEW OAuth account carrying the referral cookie, then clears the cookie", async () => {
    cookieJar.set("radaric_ref", "launch")

    const result = await callSignIn({ user: { email: "new@example.com", name: "New" }, account: { provider: "google" } })

    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ complimentaryAccessUntil: expect.any(Date) }) })
    )
    expect(cookieDelete).toHaveBeenCalledWith("radaric_ref")
  })

  it("leaves an existing account and its cookie alone", async () => {
    cookieJar.set("radaric_ref", "launch")
    mockFindFirst.mockResolvedValue({ ...EXISTING_USER, passwordHash: null, emailVerified: new Date() })

    const result = await callSignIn({ user: { email: EXISTING_USER.email }, account: { provider: "apple" } })

    expect(result).toBe(true)
    expect(mockCreate).not.toHaveBeenCalled()
    expect(cookieDelete).not.toHaveBeenCalled()
  })
})

describe("signIn callback: sign-up attribution ref (lib/signup-ref.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cookieJar.clear()
    mockFindFirst.mockResolvedValue(null)
    mockCreate.mockResolvedValue({ ...EXISTING_USER, id: "new-ref-user" })
  })

  it.each(["google", "apple"])("a NEW %s account gets the sanitized ref from the cookie", async (provider) => {
    cookieJar.set("radaric_src", "Site-D")

    const result = await callSignIn({ user: { email: "new@example.com" }, account: { provider } })

    expect(result).toBe(true)
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ signupRef: "site-d" }) }))
  })

  it("a NEW account without the cookie gets null", async () => {
    await callSignIn({ user: { email: "new@example.com" }, account: { provider: "google" } })

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ signupRef: null }) }))
  })

  it("clears the cookie once the ref is written to a NEW account", async () => {
    cookieJar.set("radaric_src", "site-d")

    await callSignIn({ user: { email: "new@example.com" }, account: { provider: "google" } })

    expect(cookieDelete).toHaveBeenCalledWith("radaric_src")
  })

  it("a failing cookie delete does not fail the sign-up", async () => {
    cookieJar.set("radaric_src", "site-d")
    cookieDelete.mockImplementationOnce(() => {
      throw new Error("cookies are read-only here")
    })

    expect(await callSignIn({ user: { email: "new@example.com" }, account: { provider: "google" } })).toBe(true)
  })

  it("leaves the cookie alone on sign-in to an existing account", async () => {
    cookieJar.set("radaric_src", "site-d")
    mockFindFirst.mockResolvedValue({ ...EXISTING_USER, passwordHash: null, emailVerified: new Date() })

    await callSignIn({ user: { email: EXISTING_USER.email }, account: { provider: "google" } })

    expect(cookieDelete).not.toHaveBeenCalled()
  })
})
