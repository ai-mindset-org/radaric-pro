// @vitest-environment node

/**
 * RAD-377 — the app's auth config run through the REAL Auth.js library.
 *
 * Every other auth test mocks `next-auth` and calls a captured callback, so a
 * library bump that renames the session cookie, changes the credentials flow or
 * the proxy wrapper would pass the whole suite. This file imports `lib/auth.ts`
 * and `proxy.ts` unmocked (only the database is in memory) and drives them with
 * real requests:
 *
 *   AC-1  signup route → credentials callback → session cookie `authjs.session-token` → /api/auth/session
 *   AC-2  wrong password → redirect to /signup?error=CredentialsSignin, no session cookie
 *   AC-3  the proxy lets the signed-in request through and redirects a signed-out one to /signup
 *   AC-4  a malformed `Authorization: Bearer %` header never throws: getToken() → null,
 *         /api/auth/session → 200 null, proxy → 307 /signup
 *   AC-5  a configuration error (AUTH_SECRET unset) fails CLOSED in the proxy: next-auth
 *         ≤ beta.31 put the 500 error body on `req.auth`, so `!!req.auth` let every
 *         signed-out request into protected pages
 *
 * Not covered here: Google/Apple OAuth round-trips (they need the providers' discovery
 * and token endpoints). The RAD-325 link guard is pinned in oauth-onboarding-redirect
 * and email-verification tests.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest"
import { NextRequest } from "next/server"

type Row = {
  id: string
  username: string
  email: string | null
  name: string | null
  role: string
  passwordHash: string | null
  isActive: boolean
  emailVerified: Date | null
}

const rows: Row[] = []

vi.mock("@/lib/db", () => {
  const match = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof Row] === v)
  const user = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => match(r, where)) ?? null),
    count: vi.fn(async () => rows.length),
    create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: `u${rows.length + 1}`,
        username: data.username ?? "",
        email: data.email ?? null,
        name: data.name ?? null,
        role: data.role ?? "USER",
        passwordHash: data.passwordHash ?? null,
        isActive: true,
        emailVerified: null,
      }
      rows.push(row)
      return row
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.find((r) => r.id === where.id)
      if (!row) throw new Error("no row")
      Object.assign(row, data)
      return row
    }),
  }
  const $executeRaw = vi.fn(async () => 1)
  return {
    db: {
      user,
      $executeRaw,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ user, $executeRaw })),
    },
  }
})

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }))

const SECRET = "rad-377-test-secret-0123456789abcdef0123456789"
const BASE = "http://localhost:3000"
const ENV_KEYS = ["AUTH_SECRET", "NEXTAUTH_SECRET", "AUTH_URL", "NEXTAUTH_URL", "GOOGLE_CLIENT_ID", "APPLE_ID", "RESEND_API_KEY", "SELF_HOSTED", "ALLOW_UNVERIFIED_SIGNUP"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

function setAuthEnv(secret: string | undefined) {
  for (const k of ENV_KEYS) delete process.env[k]
  if (secret) process.env.AUTH_SECRET = secret
  // No mail transport: the signup route creates a verified account.
  process.env.ALLOW_UNVERIFIED_SIGNUP = "1"
}

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

// lib/auth.ts calls NextAuth() at import time, which reads AUTH_SECRET then, so
// each configuration gets a fresh module graph.
async function loadApp(secret: string | undefined) {
  vi.resetModules()
  setAuthEnv(secret)
  const { handlers } = await import("@/lib/auth")
  const proxy = (await import("@/proxy")).default as unknown as (req: NextRequest, ctx?: unknown) => Promise<Response>
  const signup = (await import("@/app/api/auth/signup/route")).POST
  return { handlers, proxy, signup }
}

function cookiePairs(res: Response): string[] {
  return res.headers.getSetCookie().map((c) => c.split(";")[0])
}

async function credentialsSignIn(handlers: { GET: (r: NextRequest) => Promise<Response>; POST: (r: NextRequest) => Promise<Response> }, email: string, password: string) {
  const csrfRes = await handlers.GET(new NextRequest(`${BASE}/api/auth/csrf`))
  expect(csrfRes.status).toBe(200)
  const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }
  const body = new URLSearchParams({ csrfToken, email, password, callbackUrl: `${BASE}/posts` })
  return handlers.POST(
    new NextRequest(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { cookie: cookiePairs(csrfRes).join("; "), "content-type": "application/x-www-form-urlencoded" },
      body,
    })
  )
}

// What Next's server hands the proxy: the session lookup inside the wrapper
// builds its URL (and so the cookie's Secure prefix) from these headers.
function pageRequest(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${BASE}${path}`, { headers: { host: "localhost:3000", "x-forwarded-proto": "http", "sec-fetch-mode": "navigate", ...headers } })
}

function sessionCookie(res: Response): string | undefined {
  return cookiePairs(res).find((c) => c.startsWith("authjs.session-token=") && c.length > "authjs.session-token=".length)
}

describe("real Auth.js with the app's config", () => {
  beforeEach(() => {
    rows.length = 0
  })

  it("AC-1: signup → credentials sign-in → session cookie → session carries id and role", async () => {
    const { handlers, signup } = await loadApp(SECRET)

    const signupRes = await signup(
      new Request(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7" },
        body: JSON.stringify({ email: "New.User@Example.com", password: "correct-horse-1" }),
      })
    )
    expect(signupRes.status).toBe(200)
    expect(await signupRes.json()).toMatchObject({ action: "signup" })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: "new.user@example.com", role: "ADMIN" })

    const signInRes = await credentialsSignIn(handlers, "New.User@Example.com", "correct-horse-1")
    expect(signInRes.status).toBe(302)
    expect(signInRes.headers.get("location")).toBe(`${BASE}/posts`)
    const cookie = sessionCookie(signInRes)
    // The cookie name is the contract every signed-in browser holds: a rename
    // signs every user out on deploy.
    expect(cookie).toBeDefined()

    const sessionRes = await handlers.GET(new NextRequest(`${BASE}/api/auth/session`, { headers: { cookie: cookie as string } }))
    expect(sessionRes.status).toBe(200)
    const session = (await sessionRes.json()) as { user: { id: string; role: string; email: string; username: string } }
    expect(session.user).toMatchObject({ id: rows[0].id, role: "ADMIN", email: "new.user@example.com", username: rows[0].username })
  })

  it("AC-2: a wrong password redirects with CredentialsSignin and sets no session", async () => {
    const { handlers, signup } = await loadApp(SECRET)
    await signup(
      new Request(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.8" },
        body: JSON.stringify({ email: "owner@example.com", password: "correct-horse-1" }),
      })
    )

    const res = await credentialsSignIn(handlers, "owner@example.com", "wrong-password")

    expect(res.status).toBe(302)
    const location = new URL(res.headers.get("location") as string)
    expect(location.pathname).toBe("/signup")
    expect(location.searchParams.get("error")).toBe("CredentialsSignin")
    expect(sessionCookie(res)).toBeUndefined()
  })

  it("AC-3: the proxy passes a signed-in request and redirects a signed-out one to /signup", async () => {
    const { handlers, proxy, signup } = await loadApp(SECRET)
    await signup(
      new Request(`${BASE}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9" },
        body: JSON.stringify({ email: "reader@example.com", password: "correct-horse-1" }),
      })
    )
    const cookie = sessionCookie(await credentialsSignIn(handlers, "reader@example.com", "correct-horse-1")) as string

    const signedIn = await proxy(pageRequest("/posts", { cookie }))
    expect(signedIn.headers.get("location")).toBe(null)
    expect(signedIn.status).toBe(200)

    const signedOut = await proxy(pageRequest("/posts"))
    expect(signedOut.status).toBe(307)
    expect(new URL(signedOut.headers.get("location") as string).pathname).toBe("/signup")
  })

  it("AC-4: a malformed Bearer header is an invalid token, never an exception", async () => {
    const { handlers, proxy } = await loadApp(SECRET)
    const { getToken } = await import("next-auth/jwt")
    const malformed = { authorization: "Bearer %" }

    await expect(getToken({ req: new Request(`${BASE}/api/feeds`, { headers: malformed }), secret: SECRET })).resolves.toBe(null)

    const sessionRes = await handlers.GET(new NextRequest(`${BASE}/api/auth/session`, { headers: malformed }))
    expect(sessionRes.status).toBe(200)
    expect(await sessionRes.json()).toBe(null)

    const proxied = await proxy(pageRequest("/posts", malformed))
    expect(proxied.status).toBe(307)
    expect(new URL(proxied.headers.get("location") as string).pathname).toBe("/signup")
  })

  it("AC-5: with AUTH_SECRET unset the proxy fails closed — a protected page redirects to /signup", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { proxy } = await loadApp(undefined)

      const res = await proxy(pageRequest("/posts"))

      expect(res.status).toBe(307)
      expect(new URL(res.headers.get("location") as string).pathname).toBe("/signup")
    } finally {
      errorSpy.mockRestore()
    }
  })
})
