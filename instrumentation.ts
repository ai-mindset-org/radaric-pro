import * as Sentry from "@sentry/nextjs"

export async function register() {
  // RAD-285: the AUTH_USER / AUTH_PASSWORD_HASH virtual-admin fallback was
  // removed — it authenticated a user id with no User row, so every DB lookup
  // treated the "admin" as anonymous. Warn loudly if a deployment still sets it.
  // (Next.js process only; the tsx worker never loads this hook — Next's logs
  // are what an operator reads at boot.)
  if (process.env.AUTH_USER || process.env.AUTH_PASSWORD_HASH) {
    console.error(
      "[deprecation] AUTH_USER/AUTH_PASSWORD_HASH are IGNORED since RAD-285. " +
        "Bootstrap an operator account with: node scripts/create-user.js <username> <password> --admin"
    )
  }

  // Server and edge runtimes share one Sentry config. Off outside production
  // and while SENTRY_DSN is unset, so a self-hosted build reports nowhere.
  // There is no browser-side Sentry: under Turbopack it would need an
  // instrumentation-client.ts, and the privacy policy does not name Sentry.
  if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      enabled: process.env.NODE_ENV === "production",
    })
  }
}
