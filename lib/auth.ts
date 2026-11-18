import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import Google from "next-auth/providers/google"
import Apple from "next-auth/providers/apple"
import * as Sentry from "@sentry/nextjs"
import bcrypt from "bcryptjs"
import { db } from "./db"
import { findOrCreateOAuthUser } from "./oauth-user"
import { TRIAL_REF_COOKIE } from "./trial-ref"
import { sanitizeRef, SIGNUP_REF_COOKIE } from "./signup-ref"
import { cookies } from "next/headers"

// The referral-trial ref the proxy remembered (lib/trial-ref.ts). Reading it
// must never fail a sign-in: outside a request scope there is simply no ref.
async function readTrialRefCookie(): Promise<string | null> {
  try {
    return (await cookies()).get(TRIAL_REF_COOKIE)?.value ?? null
  } catch {
    return null
  }
}

// The first-touch attribution ref (lib/signup-ref.ts); same best-effort read.
async function readSignupRefCookie(): Promise<string | null> {
  try {
    return sanitizeRef((await cookies()).get(SIGNUP_REF_COOKIE)?.value)
  } catch {
    return null
  }
}

async function clearRefCookie(name: string): Promise<void> {
  try {
    ;(await cookies()).delete(name)
  } catch {
    // Best-effort, same as the read.
  }
}

// Extend NextAuth types
declare module "next-auth" {
  interface User {
    role?: string
    username?: string
  }
  interface Session {
    user: {
      id: string
      name?: string | null
      email?: string | null
      role?: string
      username?: string
    }
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id?: string
    role?: string
    username?: string
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  providers: [
    ...(process.env.GOOGLE_CLIENT_ID
      ? [Google({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET! })]
      : []),
    ...(process.env.APPLE_ID
      ? [Apple({ clientId: process.env.APPLE_ID, clientSecret: process.env.APPLE_SECRET! })]
      : []),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.password) return null
        const password = credentials.password as string

        // Email-based login (new unified flow)
        if (credentials.email) {
          const email = (credentials.email as string).toLowerCase()
          const dbUser = await db.user.findUnique({ where: { email, isActive: true } })
          if (dbUser?.passwordHash) {
            const isValid = await bcrypt.compare(password, dbUser.passwordHash)
            if (isValid) {
              return { id: dbUser.id, name: dbUser.name || dbUser.username, email: dbUser.email || `${dbUser.username}@radaric.local`, role: dbUser.role, username: dbUser.username }
            }
          }
          return null
        }

        // Username-based login (legacy)
        if (credentials.username) {
          const username = credentials.username as string
          const dbUser = await db.user.findUnique({ where: { username, isActive: true } })
          if (dbUser?.passwordHash) {
            const isValid = await bcrypt.compare(password, dbUser.passwordHash)
            if (isValid) {
              return { id: dbUser.id, name: dbUser.name || dbUser.username, email: dbUser.email || `${dbUser.username}@radaric.local`, role: dbUser.role, username: dbUser.username }
            }
            return null
          }
        }

        return null
      },
    }),
  ],
  pages: {
    signIn: "/signup",
    error: "/auth-error",
  },
  session: {
    strategy: "jwt",
  },
  cookies: {
    pkceCodeVerifier: {
      name: "next-auth.pkce.code_verifier",
      options: { httpOnly: true, sameSite: "none", path: "/", secure: true },
    },
    state: {
      name: "next-auth.state",
      options: { httpOnly: true, sameSite: "none", path: "/", secure: true },
    },
  },
  callbacks: {
    async signIn({ user, account }) {
      if ((account?.provider === "google" || account?.provider === "apple") && user.email) {
        const ref = await readTrialRefCookie()
        const signupRef = await readSignupRefCookie()
        const result = await findOrCreateOAuthUser({ email: user.email, name: user.name }, { ref, signupRef })
        // RAD-325: refuse to silently join a never-verified credential account
        // (pre-hijacking). NextAuth surfaces this as AccessDenied on the
        // project's own /auth-error page, which explains the recovery path.
        if (result.status === "link_blocked") {
          Sentry.captureMessage("oauth link refused: unverified credential account", {
            level: "warning",
            tags: { route: "signIn", provider: account.provider },
          })
          return false
        }
        // One grant per referral visit: a second account from this browser
        // starts without the ref.
        if (result.account.created && ref) await clearRefCookie(TRIAL_REF_COOKIE)
        // The source is written once; nothing reads the cookie after that.
        if (result.account.created && signupRef) await clearRefCookie(SIGNUP_REF_COOKIE)
        user.id = result.account.id
        user.role = result.account.role
        user.username = result.account.username
        return true
      }
      return true
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.role = user.role
        token.username = user.username
      }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string
        session.user.role = token.role as string
        session.user.username = token.username as string
      }
      return session
    },
  },
})
