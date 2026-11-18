import { NextResponse } from "next/server"; import { db } from "@/lib/db"; import bcrypt from "bcryptjs"; import crypto from "crypto"; import { checkKeyRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit"; import { isEmailVerificationEnabled, isVerificationEnforced, issueEmailVerificationToken, reportVerificationMisconfig, sendVerificationEmail } from "@/lib/email-verification"; import { FIRST_USER_LOCK_KEY } from "@/lib/first-user"; import { trialCompUntil } from "@/lib/comp-access"; import { TRIAL_REF_COOKIE, trialRefFromCookieHeader } from "@/lib/trial-ref"; import { SIGNUP_REF_COOKIE, signupRefFromCookieHeader } from "@/lib/signup-ref"
function genUsername(email: string): string { return `${email.split("@")[0].slice(0, 20)}-${crypto.randomBytes(2).toString("hex")}` }
export async function POST(request: Request) {
  try {
    // Malformed JSON counts as an attempt — the aggregate budget below is taken
    // before any validation, so a script cannot probe for free.
    const body = await request.json().catch(() => ({})) as { email?: unknown; password?: unknown }
    const { email, password } = body
    const ip = getClientIp(request.headers)

    // RAD-296: this route backs BOTH sign-up and sign-in (the /signup page uses
    // it for both). order: aggregate per-IP → identity budget. Account creation
    // is the farming risk (per-IP creation budget); a returning user's sign-in
    // gets a looser per-(IP,email) budget so mistyped passwords cannot lock out
    // an office/CGNAT IP; the aggregate caps the total work per IP either way.
    const aggregate = checkKeyRateLimit("signup-all", ip, RATE_LIMITS.signupAll)
    if (aggregate) return aggregate

    const emailOk = typeof email === "string" && email.includes("@")
    const passwordOk = typeof password === "string" && password.length >= 8

    if (!email || !password) return NextResponse.json({ error: "Email and password are required" }, { status: 400 })
    if (!emailOk) return NextResponse.json({ error: "Invalid email format" }, { status: 400 })
    if (!passwordOk) return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 })

    const existing = await db.user.findUnique({ where: { email: (email as string).toLowerCase() } })
    const limited = existing
      ? checkKeyRateLimit("signup-signin", `${ip}:${(email as string).toLowerCase()}`, RATE_LIMITS.signupSignin)
      : checkKeyRateLimit("signup-ip", ip, RATE_LIMITS.signupIp)
    if (limited) return limited

    if (existing) {
      if (!existing.passwordHash) { await bcrypt.hash("dummy", 10); return NextResponse.json({ error: "Invalid email or password" }, { status: 400 }) }
      const isValid = await bcrypt.compare(password, existing.passwordHash)
      if (!isValid) return NextResponse.json({ error: "Invalid email or password" }, { status: 400 })
      return NextResponse.json({ action: "signin" })
    }
    const passwordHash = await bcrypt.hash(password, 10)
    // Referral trial (`?ref=<TRIAL_REF>`, carried in a cookie by proxy.ts).
    const trialRef = trialRefFromCookieHeader(request.headers.get("cookie"))
    // First-touch attribution ref (lib/signup-ref.ts), written once in the create.
    const signupRef = signupRefFromCookieHeader(request.headers.get("cookie"))
    // RAD-285: the first account in an empty database is the operator (ADMIN).
    // The advisory lock serializes concurrent first signups so exactly one wins.
    const created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${FIRST_USER_LOCK_KEY}))`
      const userCount = await tx.user.count()
      return tx.user.create({
        data: {
          username: genUsername(email),
          passwordHash,
          email: email.toLowerCase(),
          name: email.split("@")[0],
          role: userCount === 0 ? "ADMIN" : "USER",
          complimentaryAccessUntil: trialCompUntil(trialRef),
          signupRef,
          userSettings: { create: { onboardingCompleted: false } },
        },
      })
    })

    // RAD-297: verification email. The account is usable (browse + manage feeds)
    // either way; only AI-spend routes require `emailVerified`.
    let verificationSent = false
    if (isVerificationEnforced()) {
      if (isEmailVerificationEnabled()) {
        try {
          const token = await issueEmailVerificationToken(created.id)
          await sendVerificationEmail(email, token)
          verificationSent = true
        } catch (err) {
          console.error("[signup] verification email failed — account stays unverified, resend available:", err)
        }
      } else {
        // Enforced but no transport (production misconfig): fail CLOSED — the
        // account exists unverified and activates when mail returns. Reported
        // loudly, because the alternative disables the control invisibly.
        reportVerificationMisconfig("signup: RESEND_API_KEY missing while verification is enforced — account created UNVERIFIED")
      }
    } else {
      reportVerificationMisconfig("signup: verification not enforced (ALLOW_UNVERIFIED_SIGNUP=1 or non-production) — creating a verified account")
      await db.user.update({ where: { id: created.id }, data: { emailVerified: new Date() } })
    }

    const res = NextResponse.json({ action: "signup", verificationSent })
    // One grant per referral visit: a second account from this browser starts without the ref.
    if (trialRef !== null) res.cookies.set(TRIAL_REF_COOKIE, "", { maxAge: 0, path: "/" })
    // The source is written once; nothing reads the cookie after that.
    if (signupRef !== null) res.cookies.set(SIGNUP_REF_COOKIE, "", { maxAge: 0, path: "/" })
    return res
  } catch (e) {
    // Concurrent same-email signup: the loser's create trips the unique index.
    // The user exists, so answer like the successful retry would.
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "P2002") {
      return NextResponse.json({ action: "signin" })
    }
    console.error("Signup error:", e)
    return NextResponse.json({ error: "An error occurred" }, { status: 500 })
  }
}
