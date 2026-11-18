/**
 * Terminology Rename Verification — RED Phase
 *
 * These tests verify that the rename from "Materials → Posts" and
 * "Monitor/INTEREST → Event Trigger/EVENT_TRIGGER" has been applied
 * correctly across the codebase. They use source-code content assertions
 * (reading files and asserting presence/absence of strings) since the
 * rename has NOT happened yet — all tests must FAIL.
 *
 * Spec coverage:
 *   AC-1: Root layout metadata template and default title
 *   AC-2: /materials page has metadata title "Posts"  (page to be at /posts)
 *   AC-3: /posts/[id] uses generateMetadata returning post title
 *   AC-4: /sources pages use new titles
 *   AC-5: /settings, /stories, /login page titles
 *   AC-6: Sidebar navigation shows "Posts" label linking to /posts
 *   AC-7: Fetch calls use /api/posts/... instead of /api/materials/...
 *   AC-8: Toast messages use "post" terminology
 *   AC-9: Search placeholder says posts, not materials
 *   AC-10: Delete dialog says "Delete post and provide AI feedback"
 *   AC-11: Settings page says "Delete all posts"
 *   AC-12: /materials/* redirect → /posts/*
 *   EC-2: Source card shows "N posts" count
 *   EC-3: Root / and dashboard / redirect to /posts
 *   AC-13: Prisma schema has EVENT_TRIGGER in SourceType enum
 *   AC-14: Source type card shows "Add Event Trigger" linking to /sources/new?type=EVENT_TRIGGER
 *   AC-15: Source form dropdown shows "Event Trigger", field label "What to track?"
 *   AC-16: Source filter chip shows "Event Triggers"
 *   AC-17: Source card badge shows "Event Trigger" for EVENT_TRIGGER type
 *   AC-18: Settings shows "Event Trigger API"
 *   EC-4: Display code handles both INTEREST and EVENT_TRIGGER types
 *   EC-5: localStorage migration from "INTEREST" to "EVENT_TRIGGER"
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"

const ROOT = path.resolve(__dirname, "..")

function read(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf-8")
}

// ─── Feature 1: Page Titles ───────────────────────────────────────────────────

describe("Feature 1: Page Titles", () => {
  it('AC-1: root layout metadata uses template "%s — Radaric" with default "Radaric"', () => {
    const layout = read("app/layout.tsx")
    expect(layout).toContain('template: "%s — Radaric"')
    expect(layout).toContain('default: "Radaric"')
  })

  it('AC-2: /posts page exports metadata with title "Posts"', () => {
    // After the rename, the page lives at app/(dashboard)/posts/page.tsx
    const page = read("app/(dashboard)/posts/page.tsx")
    expect(page).toMatch(/export\s+const\s+metadata/)
    expect(page).toContain('"Posts"')
  })

  it("AC-3: /posts/[id] page uses generateMetadata returning post title, falling back to \"Post\"", () => {
    const page = read("app/(dashboard)/posts/[id]/page.tsx")
    expect(page).toMatch(/generateMetadata/)
    // Falls back to "Post" when title is empty
    expect(page).toContain('"Post"')
  })

  it('AC-4: /feeds page title is "Feeds", /feeds/new is "Add Feed", /feeds/[id]/edit is "Edit Feed"', () => {
    const feedsPage = read("app/(dashboard)/feeds/page.tsx")
    expect(feedsPage).toContain('"Feeds"')

    const newPage = read("app/(dashboard)/feeds/new/page.tsx")
    expect(newPage).toContain('"Add Feed"')

    // Edit page is a client component — metadata is in layout.tsx
    const editLayout = read("app/(dashboard)/feeds/[id]/edit/layout.tsx")
    expect(editLayout).toContain('"Edit Feed"')
  })

  it('AC-5: /settings title is "Settings", /stories is "Stories", /login is "Login"', () => {
    const settingsPage = read("app/(dashboard)/settings/page.tsx")
    expect(settingsPage).toContain('"Settings"')

    const storiesPage = read("app/(dashboard)/stories/page.tsx")
    expect(storiesPage).toContain('"Stories"')

    // Login is a client component — metadata is in layout.tsx
    const loginLayout = read("app/login/layout.tsx")
    expect(loginLayout).toContain('"Login"')
  })
})

// ─── Feature 2: Materials → Posts ────────────────────────────────────────────

describe("Feature 2: Materials → Posts rename", () => {
  it("AC-6: sidebar navigation shows Posts label and links to /posts (desktop NavLink)", () => {
    // After RAD-209, the dashboard top bar + nav lives in components/layout/dashboard-shell.tsx;
    // (dashboard)/layout.tsx is now a thin server component that reads the sidebar cookie.
    const shell = read("components/layout/dashboard-shell.tsx")
    // Desktop NavLink
    expect(shell).toContain('href="/posts"')
    expect(shell).toMatch(/label="Posts"/)
    // Must NOT still say /materials in nav
    expect(shell).not.toContain('href="/materials"')
    // Must also have Feeds nav link
    expect(shell).toContain('href="/feeds"')
  })

  it("AC-6: sidebar mobile nav shows Posts label and links to /posts", () => {
    const shell = read("components/layout/dashboard-shell.tsx")
    // Nav text (TopNavLink takes an explicit label prop — icon-only below sm,
    // the label doubles as the aria-label)
    expect(shell).toMatch(/label="Posts"/)
    // Should not reference old /materials path
    expect(shell).not.toContain('href="/materials"')
  })

  it("AC-7: API fetch calls use /api/posts/... not /api/materials/...", () => {
    const materialsList = read("components/materials/materials-list.tsx")
    expect(materialsList).not.toMatch(/\/api\/materials\//)
    expect(materialsList).toMatch(/\/api\/posts\//)
  })

  it('AC-8: toast message on delete says "Post deleted"', () => {
    const materialsList = read("components/materials/materials-list.tsx")
    expect(materialsList).not.toContain('"Material deleted"')
    expect(materialsList).toContain('"Post deleted"')
  })

  it("AC-9: the search placeholder says posts, not materials", () => {
    // The field moved into the toolbar in RAD-318; the terminology contract is
    // the word, not the file it lives in.
    const toolbar = read("components/materials/posts-toolbar.tsx")
    expect(toolbar).not.toContain("Search materials")
    expect(toolbar).toMatch(/placeholder="Search posts(\.\.\.|…)"/)
  })

  it('AC-10: delete dialog says "Delete post and provide AI feedback"', () => {
    const dialog = read("components/materials/delete-material-dialog.tsx")
    expect(dialog).not.toContain("Delete material and provide AI feedback")
    expect(dialog).toContain("Delete post and provide AI feedback")
  })

  it('AC-11: settings danger zone says "Delete all posts"', () => {
    const settings = read("components/settings/settings-form.tsx")
    expect(settings).not.toContain("Delete all materials")
    expect(settings).toContain("Delete all posts")
  })

  it("AC-12: next.config has redirect from /materials/:path* to /posts/:path*", () => {
    const config = read("next.config.ts")
    expect(config).toMatch(/\/materials/)
    expect(config).toMatch(/\/posts/)
    // Should be a redirects() function
    expect(config).toMatch(/redirects/)
  })

  it('EC-2: feed card shows "N posts" count badge instead of "N materials"', () => {
    const feedCard = read("components/feeds/feed-card.tsx")
    // User-facing string should say "posts" not "materials"
    expect(feedCard).toContain("posts")
    // The _count.materials is Prisma's field name (internal), so we only check user-facing text
    expect(feedCard).not.toMatch(/\d*\s*materials"/)
  })

  it("EC-3: root / redirects logged-in users to /posts not /materials", () => {
    const proxy = read("proxy.ts")
    expect(proxy).not.toContain('redirect(new URL("/materials"')
    expect(proxy).toContain('redirectTo(req, "/posts")')
  })

  it("EC-3: logged-in users at / are redirected to /posts via middleware", () => {
    const proxy = read("proxy.ts")
    expect(proxy).toContain('pathname === "/"')
    expect(proxy).toContain('redirectTo(req, "/posts")')
  })
})

// ─── Feature 3: Monitor → Event Trigger ──────────────────────────────────────

describe("Feature 3: Monitor → Event Trigger rename", () => {
  it("AC-13: Prisma schema has EVENT_TRIGGER in SourceType enum", () => {
    const schema = read("prisma/schema.prisma")
    expect(schema).toContain("EVENT_TRIGGER")
  })

  it("AC-13: Prisma schema retains INTEREST (marked deprecated) for backwards compat", () => {
    const schema = read("prisma/schema.prisma")
    // INTEREST should still be present to maintain DB compat
    expect(schema).toContain("INTEREST")
  })

  it('AC-14: feed type cards include "Add Event Trigger" entry with type EVENT_TRIGGER', () => {
    const cards = read("components/feeds/feed-type-cards.tsx")
    expect(cards).not.toContain('"Add Monitor"')
    expect(cards).toContain('"Add Event Trigger"')
    // The type value is used in the dynamic link href
    expect(cards).toContain('"EVENT_TRIGGER"')
  })

  it('AC-15: feed form dropdown shows "Event Trigger" option instead of "Monitor (Web)"', () => {
    const form = read("components/feeds/feed-form.tsx")
    expect(form).not.toContain("Monitor (Web)")
    expect(form).toContain(">Event Trigger<")
  })

  it('AC-15: feed form field label for event trigger query says "What to track?"', () => {
    const form = read("components/feeds/feed-form.tsx")
    expect(form).not.toContain("What to monitor?")
    expect(form).toContain("What to track?")
  })

  it('AC-16: feed type filter chip shows "Event Triggers" not "Monitors"', () => {
    const filter = read("components/shared/feed-type-filter.tsx")
    expect(filter).not.toContain("Monitors")
    expect(filter).toContain("Event Triggers")
  })

  it('AC-17: feed card badge displays "Event Trigger" for EVENT_TRIGGER type', () => {
    const card = read("components/feeds/feed-card.tsx")
    expect(card).toContain('"Event Trigger"')
    expect(card).not.toContain('"Monitor"')
  })

  it('AC-18: settings page "Parallel Monitor API" section is now labelled "Event Trigger API"', () => {
    const settings = read("components/settings/settings-form.tsx")
    expect(settings).not.toContain('"Parallel Monitor API"')
    expect(settings).toContain('"Event Trigger API"')
  })

  it("EC-4: feed card badge handles both INTEREST and EVENT_TRIGGER display values", () => {
    const card = read("components/feeds/feed-card.tsx")
    // Both enum values should be handled in the display code
    expect(card).toContain("INTEREST")
    expect(card).toContain("EVENT_TRIGGER")
  })

  it("EC-5: feed form migrates cached localStorage INTEREST value to EVENT_TRIGGER on mount", () => {
    const form = read("components/feeds/feed-form.tsx")
    // Should contain migration logic: if stored value is "INTEREST", treat as "EVENT_TRIGGER"
    expect(form).toContain("EVENT_TRIGGER")
    // The migration check should reference "INTEREST"
    expect(form).toMatch(/INTEREST.*EVENT_TRIGGER|EVENT_TRIGGER.*INTEREST/)
  })
})
