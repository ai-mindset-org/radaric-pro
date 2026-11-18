import { NextResponse } from "next/server"
import {
  FOLDERS_COLLAPSED_COOKIE,
  SIDEBAR_OPEN_COOKIE,
  UI_STATE_COOKIE_OPTIONS,
  parseUiStatePatch,
} from "@/lib/ui-state"

// POST /api/ui-state — persist the sidebar preferences (RAD-408).
// Signed-in only: proxy.ts sends any other request to /signup before it gets
// here. No rate limit: the handler writes two cookies on the caller's own
// response and touches nothing else.
export async function POST(request: Request) {
  // Same-site callers only. The SameSite=Lax session already sends a
  // cross-site POST to /signup in proxy.ts; this holds even if that changes.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  // JSON only, by media-type essence: `text/plain; charset=application/json`
  // is still a CORS-safelisted "simple" request and must not pass.
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
  if (type !== "application/json") {
    return NextResponse.json({ error: "Expected application/json" }, { status: 400 })
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const patch = parseUiStatePatch(body)
  if (!patch) return NextResponse.json({ error: "Invalid UI state" }, { status: 400 })

  const res = new NextResponse(null, { status: 204 })
  if (patch.sidebarOpen !== undefined) {
    res.cookies.set(SIDEBAR_OPEN_COOKIE, patch.sidebarOpen ? "1" : "0", UI_STATE_COOKIE_OPTIONS)
  }
  if (patch.collapsedFolders !== undefined) {
    // The default is expanded, so an empty list needs no cookie at all. The
    // path must be explicit: a delete without one would be scoped to /api.
    if (patch.collapsedFolders.length === 0) {
      res.cookies.delete({ name: FOLDERS_COLLAPSED_COOKIE, path: "/" })
    } else {
      res.cookies.set(FOLDERS_COLLAPSED_COOKIE, JSON.stringify(patch.collapsedFolders), UI_STATE_COOKIE_OPTIONS)
    }
  }
  return res
}
