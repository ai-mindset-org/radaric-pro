// The public origin of this install, without a trailing slash.
//
// One implementation for every place that states the site's own address: the
// root metadata (`metadataBase`), the landing page's canonical, Open Graph and
// JSON-LD URLs, `robots.txt`, the sitemap and the links in outbound mail
// (`lib/email-sender.ts` re-exports this as `getAppBaseUrl`).
//
// `NEXT_PUBLIC_APP_URL` is the documented value; `NEXTAUTH_URL` is the legacy
// fallback the reset links already honoured. A blank value counts as unset:
// `.env.example` ships this one as `http://localhost:3000`, so an operator who
// sets only `NEXTAUTH_URL` still needs the blank case to fall through rather
// than stop the chain.
//
// Read by name rather than as `process.env.NEXT_PUBLIC_APP_URL`: Next inlines
// literal `NEXT_PUBLIC_*` references at build time, and an image built without
// the variable (the Dockerfile has no such env) must still follow the value the
// container is started with.
function readEnv(name: string): string | undefined {
  return process.env[name]
}

export function getSiteUrl(): string {
  const configured = [readEnv("NEXT_PUBLIC_APP_URL"), readEnv("NEXTAUTH_URL")]
    .map((value) => value?.trim())
    .find((value) => Boolean(value))
  const raw = (configured ?? "http://localhost:3000").replace(/\/+$/, "")
  // A bare host is accepted elsewhere in the app (`buildWebhookUrl` in
  // `lib/parsers/interest.ts` prepends `https://`), and `new URL()` in the root
  // layout would otherwise throw at module load and take every route down.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
}
