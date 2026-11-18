// The address the UI shows for support, refunds and privacy questions.
//
// `CONTACT_EMAIL` overrides the hosted service's address; a blank value counts
// as unset. The name lookup (the same pattern as lib/site-url.ts) keeps the
// optional variable visible and read per request, so an image built without it
// (the Dockerfile sets none) still follows the value the container is started
// with.
//
// Server-only. A client component receives the address as a prop from its
// server parent instead of importing this module, so no address is inlined into
// the client bundle.
const DEFAULT_CONTACT_EMAIL = "kirill@radaric.pro"

function readEnv(name: string): string | undefined {
  return process.env[name]
}

export function getContactEmail(): string {
  return readEnv("CONTACT_EMAIL")?.trim() || DEFAULT_CONTACT_EMAIL
}
