# Authentication System

**Identifier:** FEAT-AUTH-SYSTEM
**Status:** ✅ Implemented (Multi-user system with RBAC)
**Last updated:** 2026-09-16

---

## Vision (How it should work)

### User Stories

**As a** Radaric administrator,
**I want** to manage multiple users with different access levels,
**So that** the team can work with content together while preserving data isolation and security.

**As a** Radaric user,
**I want** my own isolated space with sources and materials,
**So that** I can curate content independently of other users of the system.

**As an** administrator,
**I want** exclusive access to global settings (AI API keys, Telegram credentials),
**So that** critical infrastructure is managed centrally.

### Acceptance Criteria

**Functional requirements:**
- ✅ A user can sign up or sign in with an email and a password (`/signup`)
- ✅ A user can also sign in with a username and a password (legacy credentials flow)
- ✅ All application pages except the public routes are protected by authentication
- ✅ Unauthenticated users are automatically redirected to `/signup`
- ✅ Authenticated users can sign out
- ✅ The session persists between visits (JWT token with userId and role)
- ✅ The password is stored hashed (bcryptjs)
- ✅ Multi-user system with data isolation
- ✅ Role-based access control (ADMIN/USER)
- ✅ Public registration with email verification (RAD-297)
- ✅ OAuth sign-in with Google and Apple, env-gated (a provider is registered only when its client credentials are set)
- ✅ Password reset by email (RAD-324)
- ✅ Additional accounts and the operator account can also be created via CLI scripts
- ✅ Existing installations are migrated to the multi-user system

**Security:**
- ✅ Passwords are NEVER stored in plain text (bcryptjs with 10 rounds)
- ✅ JWT tokens are signed with a secret key
- ✅ Cryptographically secure password generation (128 bits of entropy)
- ✅ HTTPS MUST be used in production (terminated by the hosting platform)
- ✅ Public registration is email-verified before AI spend (RAD-297); `ALLOW_UNVERIFIED_SIGNUP=1` is the self-host opt-out
- ✅ Sign-in and signup are rate-limited (`lib/rate-limit.ts`; 10 sign-ins / 15 min per IP+email)
- ✅ Strict data isolation at the database level (`WHERE userId = ...`)
- ✅ Role-based middleware for admin-only endpoints

**UX principles:**
- ✅ A simple sign-in form with no distractions
- ✅ Clear error messages ("Invalid email or password")
- ✅ Automatic redirect after a successful sign-in
- ✅ The logout button lives in the sidebar for quick access
- ✅ Loading states during sign-in

**Platform constraints:**
- Next.js 16 with the new `proxy.ts` convention (instead of `middleware.ts`)
- NextAuth.js v5 (latest beta) for compatibility with Next.js 16
- Cookies store JWT tokens

### Out of Scope

The following features are **not part of** the current implementation:
- ❌ Two-factor authentication (2FA)
- ❌ Login history (audit log)
- ❌ A change-password form in Settings (password reset by email exists — RAD-324)
- ❌ User management UI (create/edit/delete)

---

## Implementation (How it works now)

### Architecture

The authentication system is built on **NextAuth.js v5** (Auth.js), using the Credentials Provider for a multi-user system with role-based access control.

**System components:**

```
Authentication Flow (Multi-user):
┌─────────────────────────────────────────────────────────────┐
│ 1. User visits protected route                             │
│    ↓                                                        │
│ 2. Proxy (proxy.ts) checks session                         │
│    ↓                                                        │
│ 3. If no session → redirect to /signup                     │
│    If session exists → extract userId and role             │
│    ↓                                                        │
│ 4. User signs up or signs in on /signup                    │
│    ↓                                                        │
│ 5. POST /api/auth/signup, then signIn(credentials)         │
│    ↓                                                        │
│ 6. lib/auth.ts validates credentials                       │
│    - Find user by email (or username) in database          │
│    - bcrypt.compare password with user.passwordHash        │
│    - Check user.isActive = true                            │
│    ↓                                                        │
│ 7. If valid → create JWT session with userId and role      │
│    If invalid → return error                               │
│    ↓                                                        │
│ 8. Set session cookie                                      │
│    ↓                                                        │
│ 9. Redirect to /posts (new account → /onboarding/feeds)    │
│    ↓                                                        │
│10. All API requests use session.user.id for data isolation │
│11. Admin endpoints check session.user.role = "ADMIN"       │
└─────────────────────────────────────────────────────────────┘
```

**Public routes (`proxy.ts`):** `/`, `/login`, `/signup`, `/terms`, `/privacy`, `/forgot-password`, `/verify-email`, `/auth-error`, `/reset-password/*`, `/api/auth/*`, `/api/webhooks/*`, `/api/health`, and the secret-authenticated `/api/collections/regenerate-due`. Every other route requires a session; unauthenticated requests are redirected to `/signup`. A signed-in user visiting `/`, `/login` or `/signup` is redirected to `/posts`, and `/materials/*` redirects to `/posts/*`.

**Data Isolation Flow:**

```
API Request → Extract session.user.id → Filter by userId
                                      ↓
┌─────────────────────────────────────────────────────┐
│ GET /api/feeds                                      │
│   WHERE userId = session.user.id                   │
│                                                     │
│ GET /api/posts                                      │
│   JOIN feed WHERE feed.userId = session.user.id     │
│                                                     │
│ GET /api/blacklist                                  │
│   WHERE userId = session.user.id                   │
│                                                     │
│ GET /api/feedback                                   │
│   WHERE userId = session.user.id                   │
└─────────────────────────────────────────────────────┘
```

**File structure:**

- `lib/auth.ts` - NextAuth configuration (providers, callbacks, sessions)
- `app/api/auth/[...nextauth]/route.ts` - NextAuth API route handlers
- `app/signup/page.tsx` + `components/auth/signup-form.tsx` - Sign-up / sign-in page UI
- `app/login/page.tsx` - Legacy `/login` route (redirects to `/signup`)
- `app/api/auth/signup/route.ts` - Unified signup/signin endpoint
- `app/api/auth/forgot-password/route.ts` - Password reset request (RAD-324)
- `app/api/auth/reset-password/route.ts` - Password reset completion
- `app/api/auth/verify-email/route.ts` + `app/api/auth/resend-verification/route.ts` - Email verification (RAD-297)
- `lib/email-verification.ts` - Verification tokens and email transport
- `lib/first-user.ts` - First-account-becomes-ADMIN bootstrap
- `lib/oauth-user.ts` - Google/Apple account linking
- `lib/rate-limit.ts` - In-process rate limiting
- `components/auth/logout-button.tsx` - Logout button component
- `components/providers/session-provider.tsx` - Client-side session provider
- `proxy.ts` - Route-protection middleware
- `app/layout.tsx` - Root layout with AuthSessionProvider
- `scripts/create-user.js` - Creates new users
- `scripts/generate-password.js` - Generates secure passwords
- `prisma/schema.prisma` - User and UserSettings models

### Data Contracts

**Environment Variables:**

```bash
# NextAuth secret key for JWT signing (32+ characters)
NEXTAUTH_SECRET="<openssl rand -hex 32>"

# Application URL (used for callbacks). Local example; on a server leave it
# unset so NextAuth derives the host from the request, or set the public URL.
NEXTAUTH_URL="http://localhost:3000"

# OAuth providers (optional; each provider is registered only when its
# variables are set, so the sign-in buttons appear only when configured)
# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
# APPLE_ID / APPLE_SECRET

# Email transport for verification and password-reset mail (RAD-297, RAD-324)
# RESEND_API_KEY

# Database URL (stores users)
DATABASE_URL="postgresql://user:password@host:5432/radaric"

# Removed (RAD-285): AUTH_USER / AUTH_PASSWORD_HASH are ignored.
# Bootstrap: the first account in an empty database becomes ADMIN automatically
# (advisory-locked against concurrent signups); additional accounts are created
# with node scripts/create-user.js <username> <password> [name] [--admin]
```

**Database Models:**

```prisma
model User {
  id            String    @id @default(cuid())
  username      String    @unique
  email         String?   @unique
  emailVerified DateTime? @map("email_verified")
  passwordHash  String?   @map("password_hash")  // bcryptjs hash (10 rounds); null for OAuth-only accounts
  name          String?
  role          UserRole  @default(USER)
  isActive      Boolean   @default(true)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  userSettings            UserSettings?
  accounts                Account[]
  feeds                   Feed[]
  emailVerificationTokens EmailVerificationToken[]
  passwordResetTokens     PasswordResetToken[]

  // Unrelated columns and relations are omitted — see prisma/schema.prisma
  // for the full model
}

enum UserRole {
  ADMIN
  USER
}

model UserSettings {
  id               String   @id @default(cuid())
  userId           String   @unique
  globalPrompt     String?  @db.Text
  notionToken      String?
  notionDatabaseId String?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  // Story Aggregator, category and onboarding fields are omitted here —
  // see prisma/schema.prisma for the full model

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

**Session Structure (JWT):**

```typescript
{
  user: {
    id: "clxxxx",           // User ID from database
    name: "username",
    email: "admin@example.com",
    role: "ADMIN" | "USER", // User role for RBAC
    username: "username"    // Username for display in UI (sidebar, profile)
  },
  expires: "2026-10-16T00:00:00.000Z"  // 30 days from login
}
```

**Login Request:**

```typescript
POST /api/auth/callback/credentials
Content-Type: application/json

{
  "username": "admin",
  "password": "secret_password"
}
```

**Login Response (Success):**

```typescript
{
  "url": "/posts",  // redirect URL (a brand-new account goes to /onboarding/feeds)
  "ok": true
}

// + Set-Cookie: next-auth.session-token=...
```

**Login Response (Error):**

```typescript
{
  "error": "CredentialsSignin",
  "status": 401,
  "ok": false
}
```

### Non-functional Characteristics

**Performance:**
- Login time: ~200-500ms (depends on bcryptjs rounds)
- JWT token size: ~400 bytes
- Session validation: <10ms (JWT signature check)

**Security:**
- bcryptjs work factor: 10 rounds (a balance between security and speed)
- JWT signing: HS256 (symmetric encryption with NEXTAUTH_SECRET)
- Password minimum entropy: a generated password has 128 bits of entropy
- Cookie flags: HttpOnly, Secure (in production), SameSite=Lax

**Compatibility:**
- Next.js: 16.0.1+
- NextAuth.js: 5.0.0-beta.32+ (beta.32 fails closed on configuration errors; older betas put the error body on `req.auth`)
- Node.js: 18+
- Browsers: all modern browsers with cookie support

**Scalability:**
- Multi-user system: users are stored in PostgreSQL
- Stateless JWT: no database load for session validation
- Data isolation: strict data isolation at the SQL query level (WHERE userId = ...)
- User count: not limited by the schema, but the app runs a single instance (see DEPLOYMENT.md — the in-process rate limiter does not coordinate across replicas)
- SSR pages: data is filtered by userId at the Server Components level
- API endpoints: automatic userId check from the session for every request

### Test Coverage

**Automated tests (`npm test` — Vitest):**
- ✅ `__tests__/rate-limit.test.ts` — limiter semantics, ADMIN exemption, client-IP derivation
- ✅ `__tests__/password-reset.test.ts` — single-use reset tokens and invalidation (RAD-324)
- ✅ `__tests__/email-verification.test.ts` — verification primitives (RAD-297)
- ✅ `__tests__/signup-oauth-buttons.test.tsx` — OAuth buttons only when the provider is configured
- ✅ `__tests__/oauth-onboarding-redirect.test.ts` — OAuth sign-in callback and routing
- ✅ `__tests__/proxy-rsc-redirect.test.ts` — proxy redirect tagging (RAD-304)

### User Management

**CLI scripts:**

#### Creating a New User

```bash
node scripts/create-user.js <username> <password> [name] [--admin]
```

**Examples:**
```bash
# Create a regular user
node scripts/create-user.js john secretpass123 "John Doe"

# Create an administrator
node scripts/create-user.js admin adminpass123 "Admin" --admin
```

**Validation:**
- Password: minimum 8 characters
- Username: letters, digits, underscores and dashes only
- The username MUST be unique — the script errors and exits when it already exists; it never overwrites an account

**What the script does:**
1. Checks that the username is unique
2. Hashes the password with bcryptjs (10 rounds)
3. Creates a record in the `User` table
4. Creates empty `UserSettings` for the user
5. Prints the credentials

**Bootstrap note:** the first account in an empty database becomes ADMIN automatically (RAD-285); running the script without `--admin` on an empty database warns that the first account normally should be the operator account.

### Related Commits

- **Commit:** `360eb1a` - "Add authentication with NextAuth.js"
  - Date: 2025-11-10
  - Description: Initial authentication implementation

- **Commit:** (current) - "Multi-user system with RBAC"
  - Date: 2025-12-09
  - Description: Complete multi-user system with data isolation

**Key changes (multi-user):**
- Added the `User` and `UserSettings` models to the Prisma schema
- Added the `userId` field to `Source`, `BlacklistItem`, `AIFeedback`
- The global `Settings` table now holds admin parameters only
- Added the `create-user.js` script
- Updated `lib/auth.ts` to work with the database instead of environment variables
- Added role-based middleware for admin endpoints
- Unique constraints: `source_user_url_unique`, `blacklist_user_term_unique`
- Cascading deletes when a user is deleted

---

## Development Plan (Future evolution)

### Phase 2: Security Enhancements

**Planned improvements:**

1. **Audit Log**
   - History of all logins
   - Logging of IP addresses and user agents
   - Notifications about suspicious activity

2. **Password Change via the UI**
   - A secure password-change form in Settings
   - Validation of the new password's complexity
   - Updating `passwordHash` in the database

**Already implemented:** rate limiting on sign-up/sign-in (`lib/rate-limit.ts`), email verification (RAD-297), and password reset by email (RAD-324).

### Phase 3: Advanced Features

**Potential extensions:**

1. **User Management UI**
   - An admin panel for creating/editing/deleting users
   - A list of all users (ADMIN only)
   - Role changes via the UI
   - User deactivation (soft delete)

2. **Additional OAuth Providers**
   - Google and Apple are already supported (env-gated)
   - GitHub OAuth and other providers could be added the same way

3. **Two-Factor Authentication (2FA)**
   - TOTP (Google Authenticator, Authy)
   - Optional setup for stronger security

---

## Known Issues

### Issue 1: Password Change Is Not Available in the UI

**Priority:** Low
**Type:** Enhancement
**Status:** Accepted (password reset by email exists — RAD-324)

**Description:**
Passwords are stored in the database (`User.passwordHash`). There is no change-password form in Settings, and `scripts/create-user.js` refuses to touch an existing account — it exits with an error when the username already exists, so it cannot rotate a password.

**Current solution:**
- A user resets their own password through the email flow ("Forgot password" → `/reset-password?token=…`, RAD-324).
- An operator with database access can update `passwordHash` directly; there is no supported script for it.

**Expected behavior (Phase 3):**
A user can change their password through the UI.

**Proposed solution:**
- **Phase 3:** Add a password-change UI in Settings
  - A form with the current password and the new password
  - Validation of the new password's complexity (minimum 8 characters)
  - An API endpoint `POST /api/auth/change-password`
  - Updating `passwordHash` in the database
  - Sign-out and redirect to the sign-in page after a successful change

**Risk assessment:** Low (the email reset flow covers the common case; this is a rare operation)

---

### Issue 2: Rate Limiting Is In-Process Only

**Priority:** Medium
**Type:** Security
**Status:** Addressed (RAD-296); scaling limitation accepted

**Description:**
Sign-up and sign-in rate limiting ships in `lib/rate-limit.ts` — a module-level Map of fixed-window counters. It is an abuse floor, not an authorization control.

**What is in place:**
- Sign-in: 10 attempts / 15 min per (IP, email)
- Signup: 60 requests / 15 min per IP in front of account creation, which itself is capped at 20 / hour per IP
- Authenticated routes key on the user id (ADMIN is exempt); the client IP is used only where there is no session yet (`getClientIp` prefers `X-Real-IP`, the end-user address a fronting CDN sets)
- 429 responses carry `Retry-After` and `Cache-Control: no-store`

**Known limitation:**
The store is in-process and per-instance: counters reset on every deploy and do not coordinate across replicas. The app runs as a single long-lived container (`scripts/start.sh`), so this is honest today. **Replace the store** (a shared backend) if the app scales out — callers keep their shape.

**Risk assessment:** Low while the app runs a single instance; the limitation is documented and the replacement point is localized.

---

### Issue 3: Session Expiry Is Not Configurable

**Priority:** Low
**Type:** Enhancement
**Status:** Accepted

**Description:**
The session lifetime is hardcoded in the NextAuth configuration (30 days by default). There is no way to configure it via the UI.

**Expected behavior:**
An administrator can configure the session lifetime in Settings.

**Actual behavior:**
The lifetime is fixed and requires a code change to adjust.

**Proposed solution:**
- Add a `sessionMaxAge` field to the Settings model
- Use that value in the NextAuth configuration
- Default: 30 days

**Risk assessment:** Low (acceptable for the MVP)

---

## Additional Materials

### Deployment Checklist

Whoever deploys the app works through these steps:

- [ ] Set `NEXTAUTH_SECRET` — random, at least 32 characters (`openssl rand -hex 32`)
- [ ] Set `DATABASE_URL`
- [ ] Optionally set `NEXTAUTH_URL`; on a non-Docker install behind a proxy leave it unset so NextAuth derives the host, while the compose stack defaults it to `http://localhost:3000` and needs the public origin (see DEPLOYMENT.md)
- [ ] Deploy with `sh scripts/start.sh` as the container entrypoint (Railway or Docker) — it runs migrations, then starts the worker and Next.js under one signal-forwarding process
- [ ] Verify HTTPS at the platform or proxy level
- [ ] First account in an empty database becomes ADMIN automatically (advisory-locked against concurrent signups)
- [ ] Additional accounts: `node scripts/create-user.js <username> <password> [name] [--admin]`
- [ ] To open public signup, configure the email transport (`RESEND_API_KEY`); `ALLOW_UNVERIFIED_SIGNUP=1` is the self-host opt-out when no mail is available
- [ ] Generate a password with `node scripts/generate-password.js` when creating CLI accounts
- [ ] Sign in on the deployed instance and open one dashboard page

### Security Best Practices

**Already implemented:**
- ✅ Passwords are stored hashed (bcryptjs)
- ✅ JWT tokens are signed with a secret key
- ✅ HttpOnly cookies (XSS protection)
- ✅ Secure cookies in production (HTTPS only)
- ✅ SameSite=Lax (CSRF protection)
- ✅ Rate limiting on signup and sign-in (`lib/rate-limit.ts`)
- ✅ Email verification for credential signups (RAD-297)
- ✅ The Parallel webhook resolves the owner's access before processing; events for inactive sources and lapsed owners are skipped (RAD-323)

---

## Links

**Documentation:**
- [NextAuth.js v5 Docs](https://authjs.dev/)
- [NextAuth Credentials Provider](https://authjs.dev/getting-started/providers/credentials)
- [Next.js Authentication](https://nextjs.org/docs/app/building-your-application/authentication)

**Related documents:**
- [FEATURES.md](FEATURES.md) - Full feature reference
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment instructions
- [CHANGELOG.md](CHANGELOG.md) - Change history

**Code:**
- `/lib/auth.ts` - NextAuth configuration
- `/app/signup/page.tsx` - Sign-up / sign-in page UI
- `/proxy.ts` - Route protection
- `/components/auth/logout-button.tsx` - Logout button

---

_Last updated: 2026-09-16_
_Status: Implemented and Production Ready_
