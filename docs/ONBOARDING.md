# Onboarding System

**Status:** Implemented
**Last Updated:** 2026-10-13

---

## Overview

New users with zero feeds see a guided 3-phase onboarding flow on every login until they either complete it or explicitly skip. The flow solves two problems: (1) a cold-start where the posts page is empty and useless, and (2) no AI filtering rules — so content arrives but nothing is filtered.

User journey: paste feed sources → confirm discovered feeds → set content preferences → land on `/posts` with feeds already parsing.

**OAuth entry point:** New OAuth users are redirected to `/onboarding/feeds` by the `/posts` server component (via `onboardingCompleted` check), not by the `signIn` callback. This ensures the JWT cookie is set before the redirect fires. Previously the `signIn` callback returned `"/onboarding/feeds"` which caused users to land on the login page in NextAuth v5.

---

## Flow

### Step 1: `/onboarding/feeds` — Feed Import

User pastes URLs, channel names, Twitter handles, or any free-form text. File upload accepts `.txt`, `.json`, `.md`, `.opml` (max 5 MB).

On submit, the page calls `POST /api/onboarding/parse-feeds` and switches to a live discovery view (`FeedDiscoveryProgress`). Feeds stream in via SSE as they are resolved. After a 1.5 s celebration pause the page auto-navigates:

- 3+ unresolved WEBSITE feeds → `/onboarding/unresolved`
- Otherwise → `/onboarding/review`

Intermediate state is persisted to `userSettings.onboardingState` (version 1, step `review`) and mirrored in `sessionStorage` as a fallback.

**Skip:** "Skip, I'll add later →" goes directly to `/onboarding/preferences`. On `?revisit=1` (see [Revisit rule](#revisit-rule-rad-168)) the button reads "Not now — go to dashboard". Where it goes is decided by `onboardingCompleted`, not by the param: a known returning user goes to `/posts`, anyone else to preferences. The button is disabled while that is pending.

### Step 2 (conditional): `/onboarding/unresolved` — Manual Feed Resolution

Shown only when 3 or more sites could not be auto-detected. User manually enters direct RSS feed URLs. Each URL is validated on blur via `POST /api/onboarding/validate-feed`. Resolved feeds are written back to `sessionStorage` before navigating to review.

**Skip:** "Skip these feeds →" proceeds to review without saving the unresolved items.

### Step 3: `/onboarding/review` — Review Discovered Feeds

Feeds are grouped by type (RSS / Telegram / Twitter/X) with color-coded type dots. Users can remove individual feeds (with undo toast) or deselect all of a type. A sticky save bar appears when 20+ feeds are selected.

Limits: warn at 200, block at 300. Fewer than 3 unresolved WEBSITE feeds are shown inline with manual URL inputs instead of routing to `/onboarding/unresolved`.

On save, feeds are written via `POST /api/onboarding/save-feeds`, then the page navigates to `/onboarding/preferences` — or to `/posts` for a known returning user. When the save created nothing and nothing already existed (every feed was dropped — X on a Lite plan, an invalid Telegram or YouTube input), the page stays put and says why ("X feeds need Radaric Pro — N skipped" or "No new feeds were added"). When some X feeds were skipped alongside created ones, a toast says so before navigating.

### Step 4: `/onboarding/preferences` — Content Preferences

User selects liked and disliked content categories from predefined lists (`LIKED_CATEGORIES`, `DISLIKED_CATEGORIES` from `lib/content-categories.ts`). Four disliked categories are pre-checked by default: Ads, Self-promotion, Sponsored, Clickbait. Custom categories (up to 30 chars) can be added to either list.

An optional advanced textarea lets users describe interests in free text — this becomes the `globalPrompt`.

On "Start Radaric", `PATCH /api/user-settings` saves `globalPrompt`, `globalLikedCategories`, `globalDislikedCategories`, and sets `onboardingCompleted: true`. The user lands on `/posts`.

**Skip:** saves only the default disliked categories and sets `onboardingCompleted: true`.

---

## API Routes

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/onboarding/parse-feeds` | SSE stream: extract + resolve feeds from free-form input or OPML file. **Also called by dashboard `BulkAddFeedsDialog`** — changes here affect both flows. |
| `POST` | `/api/onboarding/save-feeds` | Bulk-create feeds in DB (deduplicates by URL, max 300). Does **not** flip `onboardingCompleted`. **Also called by dashboard `BulkAddFeedsDialog`**. |
| `POST` | `/api/onboarding/validate-feed` | Check whether a URL is a valid RSS/Atom feed |
| `PATCH` | `/api/user-settings` | Persist onboarding state, preferences, and `onboardingCompleted` flag |

---

## Components

| Component | File | Role |
|-----------|------|------|
| `PhaseIndicator` | `components/onboarding/phase-indicator.tsx` | 3-step progress nav (Import → Review → Preferences) with checkmarks for completed phases |
| `FeedDiscoveryProgress` | `components/onboarding/feed-discovery-progress.tsx` | Live SSE feed list with per-feed status icons, progress bar, compact dot-grid for 50+ feeds. **Reused by `BulkAddFeedsDialog`** — changes here affect both the onboarding flow and the dashboard bulk-add dialog. |
| — (the first parse) | `lib/materials/first-run.ts` | Not a component. `app/(dashboard)/posts/page.tsx` passes `firstRunSourceCount` to `MaterialsList`, which hands `startFirstParse` to the processing controller; the run then appears on the same processing card as a manual one. `POST /api/parse` is fired once and awaited server-side with **no `AbortSignal`**, so navigating away cannot cancel the ingestion. `reportFirstResults()` polls `/api/stats` every 10 s for up to 5 min and says so when nothing ever arrives. **The onboarding-dismissal flag is written only once the server has answered** — a run that never completed leaves the user eligible for the retry rather than stranding them on an empty Posts screen. Replaced the invisible `FirstParseTrigger` component. |

---

## Feed Detection

`POST /api/onboarding/parse-feeds` uses a two-stage pipeline:

1. **OPML** — if the file has `.opml` extension, `lib/opml-parser.ts` extracts `xmlUrl` entries directly; no LLM needed.
2. **LLM extraction** — `lib/feed-extraction.ts` (`extractFeedsWithLLM`) parses free-form text and classifies each entry as `RSS`, `TELEGRAM`, `TWITTER`, or `WEBSITE` (ambiguous). Already-typed feeds (Telegram `t.me/…`, Twitter `@handle` or `x.com/…`) are returned immediately as `found`.
3. **RSS auto-detection** — WEBSITE entries are resolved in batches of 3 (10 s timeout each) via `lib/parsers/rss.ts` (`detectRSSFeed`). A found feed URL is fetched with `rss-parser` to capture the most recent headline for display in the review list.
4. **Unresolved** — WEBSITE entries where auto-detection fails get `status: "not_found"` and surface in the unresolved or review UI for manual resolution, validated by `POST /api/onboarding/validate-feed`.

All URLs pass through `lib/url-validation.ts` (`isAllowedUrl`) before any network request.

---

## Revisit rule (RAD-168)

A user who finished onboarding and still has zero sources is offered onboarding again on every new visit: **a new visit is the first full page load of `/posts` or `/feeds` after an hour with no Radaric activity.**

- **Visit marker:** an `HttpOnly`, `SameSite=Lax` cookie `radaric_visit`, `Max-Age` 1 hour (`VISIT_IDLE_SECONDS` in `lib/visit-marker.ts`), `Secure` when the request is https (as Auth.js decides it — a Secure cookie is never stored over plain http, which would make every self-hosted page load a new visit). Its value is the first 16 hex chars of SHA-256 of the user id, so another account on the same browser does not inherit it.
- **What starts a visit:** only a document navigation (`Sec-Fetch-Mode: navigate`, or absent) to a non-/api path. `proxy.ts` creates the marker (or replaces another user's) on that request only, and only that request carries the verdict. Every other signed-in request — /api polls, the session refresh on window focus, RSC fetches and Link prefetches — only extends a marker that is already there and belongs to this user; it never creates one. Background traffic in an open tab therefore keeps a visit alive but cannot start or spend one. The proxy's own redirects never set the marker, so `/` → `/posts` still reaches `/posts` as a new visit.
- **Verdict as a request header:** the proxy forwards `x-radaric-new-visit: 1` to the page and strips any client-sent copy. Pages do not read the cookie, because Next merges a cookie set by the proxy into the same request's `cookies()` — a page would always see the marker the proxy just wrote.
- **Gate:** `lib/onboarding-revisit.ts` counts the user's non-hidden feeds (paused feeds count) only on a new visit, and redirects to `/onboarding/feeds?revisit=1` when there are none. It runs inside `requirePaidDashboardAccess({ revisitOnboarding: true })` after the billing check, so an unpaid user lands on `/settings/billing` first. Only `/posts` and `/feeds` opt in; `/feeds/new`, `/rules`, `/saved/*` and the detail pages (`/posts/[id]`, `/feeds/[id]`, `/folders/[id]`) do not.
- **`?revisit=1` is cosmetic:** it picks the "Welcome back — add your first feed" heading and the "Not now — go to dashboard" skip label, hides the Preferences phase, and is carried to `/onboarding/unresolved` and `/onboarding/review`. Opening `/onboarding/feeds?revisit=1` also clears `onboardingState` (`PATCH /api/user-settings { onboardingState: null }`), so review never shows the list from the first onboarding.
- **Destinations come from settings:** skip on feeds and save on review read `onboardingCompleted` from `GET /api/user-settings` (5 s timeout). Known returning → `/posts`; known first-time **or unknown** (the fetch failed or timed out) → `/onboarding/preferences`. A skip clicked before the settings arrive waits for them.
- **Server guard on preferences:** `app/onboarding/preferences/layout.tsx` redirects a user whose `onboardingCompleted` is `true` to `/posts`. The preferences step starts from default categories and would overwrite a returning user's filters, so the guard — not the client flag — is what keeps them out (failed settings fetch, back button, typed URL).
- **Latch untouched:** the gate never writes settings; `onboardingCompleted` stays `true`.

---

## Testing

| File | Coverage |
|------|---------|
| `e2e/onboarding-happy-path.spec.ts` | Full signup → feeds → review → preferences → posts flow. `parse-feeds` and `save-feeds` are mocked via Playwright route interception; auth and `user-settings` hit the real DB. |

`e2e/fixtures/auth.ts` provides the `authedPage` fixture used by the spec.

---

## Skip Flow

Users with zero feeds are redirected to `/onboarding/feeds` on login. They can skip each step individually:

- Skip feed import → go to preferences (no feeds saved)
- Skip preferences → save default disliked categories only, mark `onboardingCompleted: true`

A returning user sent back by the [revisit rule](#revisit-rule-rad-168) skips straight to `/posts` ("Not now — go to dashboard") and never sees the preferences step.

Once `onboardingCompleted` is `true`, this redirect does not trigger again; the [revisit rule](#revisit-rule-rad-168) is the only path back while the account has no feeds. **`true` is also permanent:** the flag is a one-way latch — `PUT` and `PATCH /api/user-settings` accept only `true` and silently ignore `false`, because `false` opens the full-access demo grant and both handlers are auth-only. Nothing ever resets the flag, by design: the revisit rule reopens the onboarding *pages* for a returning user with no feeds, but the flag stays `true` and the preferences step stays closed to them. The demo grant itself expires 24h after `User.createdAt` regardless of the flag (`ONBOARDING_DEMO_WINDOW_MS`), so a user who never finishes onboarding cannot hold free access indefinitely. Users can always add feeds and update content preferences later via the Feeds page and Settings (`/settings` → content interests via `ContentCategoryPicker`).
