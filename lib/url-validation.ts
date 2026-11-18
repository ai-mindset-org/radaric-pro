export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (!["http:", "https:"].includes(parsed.protocol)) return false
    const host = parsed.hostname.toLowerCase()
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::]") return false
    if (host.startsWith("169.254.") || host.startsWith("10.") || host.startsWith("192.168.")) return false
    if (host.startsWith("172.") && parseInt(host.split(".")[1]) >= 16 && parseInt(host.split(".")[1]) <= 31) return false
    if (host.endsWith(".internal") || host.endsWith(".local")) return false
    return true
  } catch { return false }
}

/**
 * SSRF-safe fetch: validates the URL AND every redirect hop against isAllowedUrl
 * (default `fetch` follows redirects, so an allowed public URL that 302s to an
 * internal/metadata address would otherwise be fetched). Returns the final
 * Response, or null if any hop is disallowed / too many redirects.
 *
 * Credential headers (`Cookie`, `Authorization`, `Proxy-Authorization`) are
 * dropped from the first hop that leaves the current origin and stay dropped
 * for the rest of the chain: plain fetch strips them on a cross-origin
 * redirect, so manual hop-following must too, or a public page could redirect
 * a caller's credentials to a host they were never issued for. (RAD-392)
 *
 * NOTE: isAllowedUrl is a hostname/range allowlist; it does not yet cover
 * encoded-IP forms or DNS-rebinding — see the SSRF-hardening follow-up.
 */
export async function safeFetch(
  url: string,
  opts: {
    timeoutMs?: number
    headers?: Record<string, string>
    maxRedirects?: number
    /**
     * Overall deadline across ALL hops. `timeoutMs` is per-hop by construction
     * (each hop gets a fresh AbortSignal.timeout), so with maxRedirects=3 a
     * `timeoutMs: 8_000` call can legitimately run ~32s. Callers that need a
     * real wall-clock bound must pass a signal — arithmetic over `timeoutMs`
     * alone will understate the worst case.
     */
    signal?: AbortSignal
  } = {}
): Promise<Response | null> {
  const { timeoutMs = 10_000, maxRedirects = 3, signal } = opts
  let headers = opts.headers
  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedUrl(current)) return null
    const hopSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs)
    const res = await fetch(current, { signal: hopSignal, headers, redirect: "manual" })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) return res
      const next = new URL(loc, current)
      void res.body?.cancel().catch(() => {}) // release the socket; a redirect's body is never read
      if (headers && next.origin !== new URL(current).origin) headers = withoutCredentials(headers)
      current = next.href // re-validated at the top of the next iteration
      continue
    }
    return res
  }
  return null // redirect loop / too many hops
}

const CREDENTIAL_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"])

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())))
}
