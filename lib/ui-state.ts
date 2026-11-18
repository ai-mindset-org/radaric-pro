import { z } from "zod"

/**
 * Sidebar UI preferences persisted in cookies (RAD-209, RAD-393, RAD-408).
 *
 * The dashboard layout reads both cookies server-side, so the first paint
 * already has the right sidebar and folder state — no flicker. They are
 * httpOnly on purpose: the client never reads them, it only asks the server to
 * write them through `POST /api/ui-state`.
 *
 * That write used to be a server action. A server action that sets a cookie
 * makes Next refresh the current route, and on /posts the refresh re-rendered
 * the grid after the sidebar's width transition and re-prefetched every
 * sidebar link (RAD-408). A plain route handler sets the same cookies without
 * touching the router.
 */

export const SIDEBAR_OPEN_COOKIE = "sidebar-open"
export const FOLDERS_COLLAPSED_COOKIE = "folders-collapsed"
const UI_STATE_ENDPOINT = "/api/ui-state"

// httpOnly is intentional: the client never reads these cookies. Do not change
// it to false — the layout resolves them server-side and passes props down.
export const UI_STATE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
} as const

/**
 * Bounds keep the folders cookie under the 4 KB a browser stores per cookie:
 * 100 ids of at most 32 characters serialise to about 3.5 KB of JSON. Folder
 * ids are cuids (25 characters).
 */
export const MAX_COLLAPSED_FOLDERS = 100
const FOLDER_ID = /^[A-Za-z0-9_-]{1,32}$/

const uiStatePatchSchema = z
  .strictObject({
    sidebarOpen: z.boolean().optional(),
    collapsedFolders: z.array(z.string().regex(FOLDER_ID)).max(MAX_COLLAPSED_FOLDERS).optional(),
  })
  .refine((patch) => patch.sidebarOpen !== undefined || patch.collapsedFolders !== undefined)

type UiStatePatch = z.infer<typeof uiStatePatchSchema>

/** The validated patch, or null for anything else. */
export function parseUiStatePatch(body: unknown): UiStatePatch | null {
  const result = uiStatePatchSchema.safeParse(body)
  return result.success ? result.data : null
}

/**
 * Fire-and-forget write. `keepalive` lets the request finish when the toggle
 * is the last thing before a reload or navigation; a failed write costs one
 * preference, never correctness, so errors are swallowed. Unlike the server
 * actions this replaced, writes are not queued: two rapid toggles can land out
 * of order, and a reload then paints the earlier state. Each write carries the
 * full value, so the next toggle corrects it — accepted for a UI preference.
 */
export function persistUiState(patch: UiStatePatch): void {
  void fetch(UI_STATE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
    keepalive: true,
  }).catch(() => {})
}
