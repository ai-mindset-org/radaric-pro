# API Reference

**Last Updated:** 2026-09-16

Radaric provides a RESTful API for managing feeds, items, and settings.

## Authentication

**Status:** ✅ Implemented (NextAuth.js v5 + Multi-user system)

All API endpoints require authentication via NextAuth.js, except the public routes: `/api/auth/*`, `/api/webhooks/*`, `/api/health`, and the secret-authenticated `/api/collections/regenerate-due`. Unauthenticated requests to protected routes are redirected to `/signup`.

**Technical details:**
- Uses NextAuth.js v5 with the credentials provider
- Authorization is checked by middleware in `proxy.ts`
- The session is stored in a JWT with `userId` and `role`
- Multi-user system with full data isolation between users
- Role-based access control (ADMIN/USER)
- See [AuthSystem.md](AuthSystem.md) for complete authentication system documentation

**Session Structure (JWT):**

```typescript
{
  user: {
    id: "user_id",           // User ID from database
    name: "username",
    email: "user@example.com",
    role: "ADMIN" | "USER",  // User role for RBAC
    username: "username"     // Username for display in UI
  },
  expires: "2025-12-10T00:00:00.000Z"
}
```

**Data Isolation:**

All API endpoints automatically filter data by the `userId` from the session:
- `GET /api/feeds` — returns only the current user's feeds
- `GET /api/posts` — returns only items from the user's feeds
- `GET /api/blacklist` — returns only the user's blacklist entries
- `GET /api/feedback` — returns only the user's feedback

**Admin-only endpoints:**

The following endpoints are available only to users with the ADMIN role:
- `GET/PUT /api/settings` — global settings (AI API key, Telegram credentials, Parallel API)
- `POST /api/telegram/auth/*` — Telegram auth management (start, verify, status, logout)
- `GET /api/admin/dashboard` — user analytics
- `POST /api/admin/fetch-all-covers` — batch cover re-fetch
- `POST /api/admin/reset-stories` — reset story grouping
- `POST /api/admin/dissolve-single-material-stories` — revert auto single-material stories
- `PUT /api/user-settings` — admin-only fields: `storyInboxChannelId`, `storyNotionDatabaseId`, `autoDeleteTelegramMessages`, and the story-model four `storyWriterModel` / `storyMatcherModel` / `materialStoryModel` / `storySystemPrompt` (the four are stripped from a non-admin body, not 403'd — RAD-369)

**Security Note:** Admin endpoints are protected by the `requireAdmin()` middleware, which checks the user's role from the JWT session.

## Base URL

Development: `http://localhost:3000/api`

## API Endpoints Overview

### Authentication
- `POST /api/auth/signup` — unified signup/signin (creates user or signs in)
- `POST /api/auth/forgot-password` — initiate password reset via email
- `POST /api/auth/reset-password` — complete reset with token

### Telegram Auth (admin only)
- `POST /api/telegram/auth/start` — start Telegram authentication **(ADMIN)**
- `POST /api/telegram/auth/verify` — verify code/password **(ADMIN)**
- `GET /api/telegram/auth/status` — check authentication status **(ADMIN)**
- `POST /api/telegram/auth/logout` — log out of Telegram **(ADMIN)**

### Feeds
- `GET /api/feeds` — list all feeds
- `POST /api/feeds` — add new feed (409 `DUPLICATE_FEED` when the URL is already added for this user; for `YOUTUBE` the duplicate check matches by channel id across both URL forms — canonical `/channel/UC…` and RSS feed-XML)
- `GET /api/feeds/[id]` — get feed by id
- `PATCH /api/feeds/[id]` — update feed
- `DELETE /api/feeds/[id]` — delete feed
- `POST /api/feeds/import-opml` — import feeds from OPML file
- `POST /api/feeds/[id]/clear-error` — clear feed error state
- `POST /api/feeds/[id]/fetch-cover` — re-fetch feed cover image
- `GET /api/feeds/[id]/feedback` — list feedback with stats for a feed
- `DELETE /api/feeds/[id]/feedback` — bulk reset all feedback for a feed

### Folders (RAD-393)
- `POST /api/folders` — create a source folder (`{ name }`, trimmed, ≤60 chars; `409` when a case-insensitive duplicate exists — enforced by the DB via `name_lower`)
- `PATCH /api/folders/[id]` — rename a folder (`{ name }`; same validation; `404` foreign)
- `DELETE /api/folders/[id]` — delete a folder; its sources are kept and return to Uncategorized (`sources.folder_id` is `ON DELETE SET NULL`)
- `PATCH /api/feeds/[id]/folder` — file a source into a folder or out (`{ folderId: string | null }`; `404` for a foreign or hidden backing feed / foreign folder)

### Posts (Materials)
- `GET /api/posts` — list posts with filtering (`filter`, `search`, `sourceId`, `sourceType`, `limit`, `offset`). Hidden (tracked-question monitor) feeds are excluded by default, **except** when `sourceId` names one explicitly — `/feeds/[id]` for such a feed must show its posts. `folderId` scopes to a folder's visible, active member sources (RAD-393; with `sourceId` also set both apply — the code intersects them, so the source must be a member of that folder). `userId` scoping applies in all cases and is what isolates the caller's data.
- `GET /api/posts/counts` — the toolbar's counts (filter + source-type), live; `?sourceId=` scopes them to one source, `?folderId=` to a folder's visible members (`404` for a foreign id) (RAD-343, RAD-393)
- `GET /api/posts/[id]` — get post by id
- `PATCH /api/posts/[id]` — update post (status, feedback)
- `DELETE /api/posts/[id]` — delete post
- `POST /api/posts/[id]/notion` — export post to Notion
- `POST /api/posts/[id]/feedback` — like/dislike a material
- `POST /api/posts/[id]/stories` — send material to Story Aggregator pipeline
- `DELETE /api/posts/clear` — delete all materials for current user
- `DELETE /api/posts/bulk-delete` — bulk delete by filter (FILTERED/APPROVED/NEW/ARCHIVED)
- `GET /api/posts/refilter` — re-evaluate posts against current AI rules (SSE)
- `POST /api/posts/group-stories` — trigger story matching for APPROVED materials
- `GET /api/posts/group-stories` — stream story grouping progress (SSE)

### Parsing
- `POST /api/parse` — trigger feed parsing (standard)
- `GET /api/parse-stream` — feed parsing with SSE progress stream
- `GET /api/parse-stream/status` — the user's current parse run (for a detached card)
- `POST /api/parse-stream/stop` — stop the user's running parse early

### Onboarding
- `POST /api/onboarding/parse-feeds` — detect feed types from pasted text or OPML
- `GET /api/onboarding/parse-feeds/status` — poll parse status
- `POST /api/onboarding/validate-feed` — validate single RSS URL
- `POST /api/onboarding/save-feeds` — save discovered feeds

### Stories
- `GET /api/stories` — list stories
- `GET /api/stories/[id]` — get story with materials
- `DELETE /api/stories/[id]` — delete story
- `POST /api/stories/[id]/notion` — export story to Notion
- `POST /api/stories/poll` — trigger story polling
- `POST /api/stories/retention` — run data retention

### Inbox Items
- `GET /api/inbox-items` — list inbox items
- `GET /api/inbox-items/[id]` — get inbox item
- `DELETE /api/inbox-items/[id]` — delete inbox item
- `POST /api/inbox-items/[id]/retry` — retry failed inbox item

### Settings
- `GET /api/settings` — get global settings (admin)
- `PUT /api/settings` — update global settings (admin)
- `POST /api/settings/test-notion` — test Notion integration

### User Settings
- `GET /api/user-settings` — get personal settings (incl. `typography`)
- `PUT /api/user-settings` — update personal settings (full replace; never writes `typography`)
- `PATCH /api/user-settings` — partial update (used by onboarding and the font picker — `typography`, RAD-363)

### UI State (RAD-408)
- `POST /api/ui-state` — persist sidebar preferences as httpOnly cookies the dashboard layout reads on first paint. Body (JSON, strict, at least one key): `sidebarOpen: boolean` → `sidebar-open` = `"1"`/`"0"`; `collapsedFolders: string[]` (≤ 100 ids, each `[A-Za-z0-9_-]{1,32}`) → `folders-collapsed` as JSON, an empty list deletes it. Cookies: `path=/`, `sameSite=lax`, one-year `maxAge`. `204` on success; `400` for a non-JSON body, a bad shape or an unknown key. A route handler on purpose — a cookie-setting server action refreshes the route.

### Account
- `PATCH /api/user/email` — set or change the signed-in user's email. Body `{ email }`; validates format, lowercases. **403** for OAuth-managed accounts (no `passwordHash`), **409** when the email belongs to another user. Clears `emailVerified` and syncs the Stripe customer email when a `stripeCustomerId` exists. Unblocks subscription for username-only accounts.

### Categories
- `GET /api/categories/custom` — aggregate custom categories across feeds

### Blacklist
- `GET /api/blacklist` — list blocklist entries
- `POST /api/blacklist` — add entry
- `DELETE /api/blacklist/[id]` — remove entry

### Feedback
- `GET /api/feedback` — list AI feedback entries
- `PATCH /api/feedback/[id]` — edit feedback comment or type
- `DELETE /api/feedback/[id]` — remove individual feedback

### Knowledge Base (Save → Collections → Library)
See [KnowledgeBase.md](KnowledgeBase.md) for the full feature. Writes are gated by `requireActiveSubscription`; reads stay open. Strict `WHERE userId` isolation; saving/excerpting checks material ownership via `material.feed.userId`.
- `GET /api/collections` — list the user's topic-collections with item + excerpt counts (self-filling collections carry `query` + `cadence`)
- `POST /api/collections` — create (idempotent get-or-create) a topic-collection `{ name }`
- `POST /api/collections/track` — create a **self-filling collection** (tracked question) `{ name, query, cadence }`; spins up a backing Parallel monitor that autonomously collects sources. Errors carry a `code`: `403 CAP_REACHED`, `409` (duplicate name), `503 PARALLEL_NOT_CONFIGURED`
- `DELETE /api/collections/[id]` — delete a collection; for a tracked question this also tears down its Parallel monitor + hidden backing feed (`404` if not owned)
- `POST /api/collections/[id]/discover` — **LLM source discovery** (Slice 3): suggest reputable sources for the tracked question's query, validated into real RSS feeds. Returns `{ sources: [{name, feedUrl, reason, alreadyAdded}], suggested }`. Cooldown-guarded (`429 COOLDOWN`); `400` if the collection has no query; `503 AI_NOT_CONFIGURED` if no AI key. The client adds chosen feeds via `POST /api/feeds`
- `POST /api/collections/regenerate-due` — **manual/ops trigger** (Slice 4) for the worker's self-filling freshness sweep. Secret-auth (`Authorization: Bearer $WORKER_TRIGGER_SECRET`, timing-safe); `404` when the secret is unset (disabled), `401` on mismatch. Returns `{ ok, regenerated }`. NOT a cron — the worker runs the sweep every 2 min
- `POST /api/collections/[id]/refresh` — **on-demand "Check for updates"** for a tracked question: pulls the backing monitor's latest events from Parallel (`parseInterestSource`), ingests + evaluates new material, and regenerates the cited living answer when something changed (or bootstraps the first answer). Returns `{ fetched, created, skipped, synthesisStatus }` (`synthesisStatus` is `"ok" | "empty" | "cooldown" | "not_found" | null`; `null` = no regenerate attempted). `400` if the collection has no backing monitor (not a tracked question), `404` if not owned, `429 COOLDOWN` (30s per-(user,collection)). The autonomous path is cadence-push only; this is the manual pull so a user can verify on demand
- `POST /api/collections/[id]/track` — record "Track this" intent on a manual collection (sets `trackRequestedAt` set-once; the Phase-2 demand sensor)
- `POST /api/collections/[id]/synthesis` — (re)generate the collection's **living answer** (LLM-maintained cited markdown from its saves; AI call). Returns `{ synthesis, synthesisDelta, synthesisUpdatedAt, sourceCount }`; `422` when the collection has no saves yet
- `GET /api/saved` — list saved whole-materials (optional `?collectionId=`)
- `POST /api/saved` — save a whole material `{ materialId, collectionId?, collectionName? }`; with neither collection field the server resolves a **smart-default** (most-recently-used → "Unsorted"). Idempotent per `(userId, materialId)` — returns the existing save (`created: false`) without re-filing.
- `DELETE /api/saved/[materialId]` — unsave a whole material
- `PATCH /api/saved/[materialId]` — re-file a saved item `{ collectionId? | collectionName? }` (the toast "Move")
- `POST /api/saved/excerpt` — save a highlighted passage `{ materialId, text, offsetStart, offsetEnd, collectionId?, collectionName? }` (offsets into the source content string)
- `DELETE /api/saved/excerpt/[id]` — remove a saved excerpt

### Admin (admin only)
- `GET /api/admin/dashboard` — user analytics and feed stats **(ADMIN)**
- `POST /api/admin/fetch-all-covers` — batch re-fetch all feed covers **(ADMIN)**
- `POST /api/admin/reset-stories` — reset story grouping, unlink materials **(ADMIN)**
- `POST /api/admin/dissolve-single-material-stories` — revert auto single-material stories (`?scope=self|all`) **(ADMIN)**

### Analytics
- `GET /api/stats` — aggregate stats
- `GET /api/analytics/accuracy` — AI accuracy metrics

### Health
- `GET /api/health` — health check (no auth)

### Webhooks
- `POST /api/webhooks/parallel` — Parallel Monitor inbound webhook

---

### Detailed Endpoint Reference

#### Feeds

#### GET /api/feeds
Get all feeds.

**Response:**
```json
[
  {
    "id": "clxxxx",
    "type": "RSS",
    "url": "https://example.com/feed",
    "name": "Example Feed",
    "coverUrl": "https://example.com/logo.png",
    "customPrompt": "Focus on design topics",
    "isActive": true,
    "status": "ACTIVE",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-01T00:00:00Z",
    "lastParsedAt": "2024-01-02T00:00:00Z",
    "_count": {
      "materials": 42
    }
  }
]
```

#### POST /api/feeds
Create a new feed.

**Request Body:**
```json
{
  "url": "https://example.com/feed",
  "type": "RSS",
  "name": "Example Feed",
  "coverUrl": "https://example.com/logo.png",
  "customPrompt": "Focus on design topics",
  "isActive": true
}
```

**RSS + TELEGRAM validation at creation:** a source that can never yield material is rejected at the door rather than stored and left to parse to nothing forever. Only a **definitive** answer rejects — a timeout, a 403/WAF, a network error, or a worker that's down all **fail open** (the feed is created with a `warning`), because our own probe failing is not evidence about the user's source.
- `400 NOT_A_FEED` — RSS: the URL fetched cleanly and isn't an RSS/Atom feed (also covers an SSRF-blocked address)
- `400 DNS_NOT_FOUND` — RSS: the hostname doesn't resolve (a typo'd domain)
- `400 FEED_UNREACHABLE_BY_POLICY` — RSS: a private/link-local address (SSRF guard). Definitive, but distinct from `NOT_A_FEED` on purpose: a self-hosted feed on `192.168.x.x` *is* a feed, so telling the user "that isn't a feed, try /feed" would be false and loop them
- `400 TELEGRAM_IS_BOT` / `400 TELEGRAM_IS_USER` — a bot or a personal account: no readable post history, so it parses to zero messages forever
- `400 TELEGRAM_NOT_FOUND` — Telegram says the username doesn't exist (`USERNAME_NOT_OCCUPIED` / `USERNAME_INVALID`)
- `400 TELEGRAM_INVALID_INPUT` — the input is not a public channel username: `me` / `self` / `this`, a phone number, a numeric peer id, a `t.me/c/…` link, a handle outside Telegram's grammar (a letter first, letters / digits / `_`, no `__`, no trailing `_`, 4–32 characters). Checked before the duplicate check and the probe (RAD-364 — the worker's GramJS session would resolve these against the operator's own account). Also returned when the worker refuses the resolved entity as not a public, username-owned channel or supergroup (a basic group, a private group, a handle the channel no longer owns)
- `400 TELEGRAM_PRIVATE_INVITE` — a private invite link (`t.me/+<hash>`, `t.me/joinchat/<hash>`): the worker reads only public channels. Checked before the duplicate check and the probe
- `409 DUPLICATE_FEED` — checked **before** validation, so a re-add doesn't pay for a probe

Rejection bodies carry `{ error, code, url }` (`url` = the canonicalized form); the prose the user sees is client-side (`lib/feed-rejection-copy.ts`), since a form and a bulk dialog need different wording for the same code. Public channels and public supergroups that own the handle are accepted; nothing else is. **The URL is never rewritten** — a site URL is not resolved to its feed; it's rejected with copy pointing at `/feed`.

Successful creation may carry a caveat spread onto the 201 body (the body remains the source object):
- `warning: "FEED_EMPTY"` — a real feed with zero items (e.g. a `releases.atom` for a repo that never cut a release). Legitimate, but the user must be told or the empty inbox reads as a bug.
- `warning: "FEED_UNVERIFIED"` — created without confirmation (probe inconclusive / worker down).

`PATCH /api/feeds/[id]` applies the same TELEGRAM gate (`400 TELEGRAM_INVALID_INPUT` / `TELEGRAM_PRIVATE_INVITE`) and, when the URL changes or the type switches to TELEGRAM, stores the canonical URL, checks it against the user's other feeds (`409 DUPLICATE_FEED`) and runs the same probe (`400 TELEGRAM_IS_BOT` / `TELEGRAM_IS_USER` / `TELEGRAM_NOT_FOUND` / `TELEGRAM_INVALID_INPUT`; an inconclusive probe saves with `warning: "FEED_UNVERIFIED"`). `POST /api/onboarding/save-feeds` canonicalizes TELEGRAM entries and drops non-conforming ones, invite links included, into `telegramSkipped`, but does not probe (a bulk body would have to probe up to 300 URLs in-request). RSS on PATCH, bulk and OPML import stays unvalidated. Whatever a row holds, the worker's parse and channel-info endpoints read only a public channel or supergroup that currently owns the requested username (checked against a fresh `channels.GetChannels`, not the session cache) — every other reference is refused there (422).

**YOUTUBE type (RAD-267):** `url` accepts any channel input — `@handle`, bare handle, channel/legacy (`/c/`, `/user/`) URL, a video URL, or the feed-XML URL. The server resolves it once to the canonical `https://www.youtube.com/channel/UC…` before storing. Responses:
- `400` — input could not be resolved to a channel (resolver message in `error`)
- `409 DUPLICATE_FEED` — the channel already exists for this user **in either URL form** (canonical or RSS feed-XML; matched by channel id)

#### GET /api/feeds/[id]
Get a single feed by ID.

#### PATCH /api/feeds/[id]
Update a feed (partial update).

**YOUTUBE type:** an edited `url` is re-canonicalized like POST (`400` on unresolvable input); editing onto a channel already held by another feed answers `409 DUPLICATE_FEED` (cross-form guard by channel id, same as POST).

**Request Body:**
```json
{
  "name": "New Name",
  "isActive": false,
  "status": "PAUSED"
}
```

#### DELETE /api/feeds/[id]
Delete a feed (cascading delete of its items).

---

### Posts

#### POST /api/parse
Trigger parsing of all active feeds.

**Process:**
1. Fetches all active feeds
2. Parses RSS feeds
3. Extracts the full text of articles
4. Checks for duplicates
5. Evaluates items with AI (batches of 3)
6. Saves results to the DB

**Response:**
```json
{
  "parsed": 15,
  "message": "Successfully parsed 15 materials"
}
```

#### GET /api/posts
Get items with filtering.

**Query Parameters:**
- `sourceId` (optional) - limit to a single source
- `filter` (optional) - preset: `INBOX`, `APPROVED`, `FILTERED`, `SENT_TO_NOTION`, `ARCHIVED`, `ALL`
- `sourceType` (optional) - source types, comma-separated: `RSS,TELEGRAM,TWITTER,YOUTUBE,EVENT_TRIGGER`
- `search` (optional) - search by title, text and source name
- `offset` (optional) - pagination offset
- `limit` (optional) - number of results (1–500, default 50)
- `aiEvaluation`, `userStatus` (optional) - legacy parameters, applied only when `filter` is not passed

**Filtering notes:**
- Items with DELETED and ARCHIVED statuses are excluded by default
- To view archived items, use `filter=ARCHIVED`
- Items with DELETED status are never returned by the API
- Hidden sources (`hidden: true` — backing monitor feeds of self-filling collections) are excluded from the general output, **but are returned when `sourceId` is passed explicitly**: the `/feeds/[id]` page for such a source must show its items. SSR works the same way (`lib/materials/fetch-materials-page.ts`). Data isolation is unaffected — `feed.userId` restricts every query to the owner (RAD-317)

**Response:**
```json
[
  {
    "id": "clxxxx",
    "sourceId": "clxxxx",
    "title": "Article Title",
    "url": "https://example.com/article",
    "content": "Full article text...",
    "publishedAt": "2024-01-01T00:00:00Z",
    "aiEvaluation": "APPROVED",
    "aiConfidence": 85,
    "aiReasoning": "This article matches the criteria because...",
    "userStatus": "NEW",
    "createdAt": "2024-01-01T00:00:00Z",
    "source": {
      "id": "clxxxx",
      "name": "Example Feed",
      "type": "RSS"
    }
  }
]
```

#### GET /api/posts/counts
The posts toolbar's counts — the same numbers the page computes (`lib/materials/material-counts.ts` holds one shared set of predicates, so the server render and the live update cannot drift apart).

**Query Parameters:**
- `sourceId` (optional) — scope the counts to one source; ownership is checked, and another user's id → 404

**Response:**
```json
{
  "filter": { "INBOX": 60, "APPROVED": 60, "FILTERED": 30, "SENT_TO_NOTION": 5, "ARCHIVED": 4, "ALL": 100 },
  "sourceType": { "ALL": 100, "RSS": 40, "TELEGRAM": 25, "TWITTER": 20, "YOUTUBE": 5, "EVENT_TRIGGER": 10 }
}
```

`sourceType` is returned only in account-wide mode — the per-source page hides that filter. The client (`components/materials/use-live-counts.ts`) requests the route on mount, on the `radaric:stats-changed` event (dispatched by every mutation and at the end of a parse run), and every 30 seconds (RAD-343).

#### GET /api/posts/[id]
Get a single item by ID.

#### PATCH /api/posts/[id]
Update an item's status.

**Request Body:**
```json
{
  "title": "Updated title",
  "content": "Updated content",
  "userStatus": "READ"
}
```

**Allowed fields for update:**
- `title` (string) - item title
- `content` (string) - item content
- `userStatus` (enum) - user status

**Allowed userStatus values:**
- `"NEW"` - new item
- `"READ"` - read
- `"SENT_TO_NOTION"` - sent to Notion
- `"ARCHIVED"` - archived (hidden from the main filters)
- `"DELETED"` - deleted (used by the system only)

**Validation:**
- The endpoint accepts only allowed fields (title, content, userStatus)
- Invalid fields are rejected with a 400 error
- userStatus must be one of the allowed enum values
- An empty request body returns a 400 error

**Response (Success):**
```json
{
  "id": "clxxxx",
  "title": "Updated title",
  "content": "Updated content",
  "userStatus": "READ",
  "updatedAt": "2025-11-26T10:00:00Z"
}
```

**Response (Error - Invalid Field):**
```json
{
  "error": "Invalid field: invalidField. Allowed fields: title, content, userStatus"
}
```

**Response (Error - Invalid UserStatus):**
```json
{
  "error": "Invalid userStatus value. Allowed: NEW, READ, SENT_TO_NOTION, ARCHIVED, DELETED"
}
```

#### DELETE /api/posts/[id]
Delete an item (soft delete - marks it as DELETED, does not physically delete it).

**Features:**
- Uses **soft delete** - the item stays in the DB with `userStatus: "DELETED"`
- Items are retained for history and AI training
- Feedback is correctly linked to the item
- Deleted items are excluded from list queries by a filter
- **Never deletes R2 media** (RAD-368): Telegram objects are deduped by key and shared by every subscriber, so the per-user delete leaves them in place (a GC sweep is the follow-up)
- `sourceFeedback` / `globalFeedback` are capped at 500 characters each (RAD-369) — over the cap or non-string answers `400` with `{ error }` and nothing is deleted or written

**Request Body (optional):**
```json
{
  "sourceFeedback": "This type of content is not relevant for this source",
  "globalFeedback": "Exclude articles about cryptocurrency"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Material deleted and feedback saved"
}
```

#### POST /api/posts/[id]/notion
Send an item to a Notion database.

**Features:**
- **Dynamic adaptation to the Notion DB structure** - automatically detects the available properties
- Sends only `title` (required field) + optional properties if they exist
- Content is split into chunks of 1900 characters
- **Rich text support** - if the item contains Telegram entities, links become clickable
- Works with any Notion database structure

**Fields sent:**

- `title` (required) - item title
- `Link` (optional, if it exists in the DB, type: url) - link to the original item

**Page content:**

- Paragraphs with content (up to 5 chunks of 1900 characters)
- Rich text with clickable links (for Telegram items with entities)
- Plain text (for RSS items or Telegram without entities)

**Response (Success):**
```json
{
  "success": true,
  "notionPageId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "notionUrl": "https://www.notion.so/Page-Title-xxxxxxxx"
}
```

**Response (Error):**
```json
{
  "error": "Notion integration not configured",
  "code": "unauthorized"
}
```

#### DELETE /api/posts/clear
Delete all items from the database (feeds are preserved).

**⚠️ WARNING:** This is an irreversible operation!

**Response:**
```json
{
  "message": "All materials deleted successfully",
  "count": 150
}
```

**Use case:** Useful for testing the parser or completely clearing data before re-parsing.

#### DELETE /api/posts/bulk-delete
Bulk delete items by status filter.

**Query Parameters:**
- `filter` (required): `"FILTERED"` | `"APPROVED"` | `"NEW"` | `"ARCHIVED"`

**Response:**
```json
{
  "message": "42 materials deleted",
  "count": 42,
  "filter": "FILTERED"
}
```

#### POST /api/posts/[id]/feedback
Like/dislike an item. Creates or updates a single feedback record per (userId, materialId).

**Request Body:**
```json
{
  "feedbackType": "LIKE" | "DISLIKE",
  "comment": "optional comment"
}
```

**Response:**
```json
{
  "id": "feedback_id",
  "feedbackType": "LIKE",
  "commentText": "optional comment",
  "createdAt": "2026-04-11T00:00:00Z"
}
```

#### POST /api/posts/[id]/stories
Send an item to the Story Aggregator pipeline. Creates an InboxItem for asynchronous processing.

**Request Body:** None

**Response:**
```json
{
  "success": true,
  "inboxItemId": "inbox_item_id"
}
```

#### POST /api/posts/group-stories
Trigger Story Matching for APPROVED items. Groups items by topic into Stories.

**Request Body (optional):**
```json
{
  "materialIds": ["id1", "id2"]
}
```

**Response:**
```json
{
  "storiesCreated": 3,
  "storiesUpdated": 1,
  "materialsProcessed": 15,
  "materialsSkipped": 2
}
```

#### GET /api/posts/group-stories
Streaming story grouping progress via SSE.

**SSE Events:**
- `start` — `{ total: number }`
- `progress` — `{ current, total, materialTitle, action: "matched"|"created"|"skipped" }`
- `complete` — `{ storiesCreated, storiesUpdated, materialsProcessed }`
- `error` — `{ message: string }`; a refused request gets `{ code, message }` instead — `RATE_LIMITED` (+ `retryAfter`), `UNAUTHORIZED` or `EMAIL_NOT_VERIFIED` (see `GET /api/parse-stream`, RAD-326, RAD-406)

**Note:** Supports abort-on-disconnect.

---

### Parsing

#### POST /api/parse
Trigger parsing of all active feeds (standard endpoint without streaming).

**Request Body (optional):**
```json
{
  "sourceIds": ["clxxxx", "clyyyy"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Parsing completed",
  "results": {
    "parsed": 100,
    "evaluated": 95,
    "approved": 45,
    "filtered": 50,
    "errors": []
  }
}
```

**Note:** Uses batch processing; items appear after the entire parse completes.

#### GET /api/parse-stream
Trigger parsing with real-time updates via Server-Sent Events (SSE).

**Query Parameters (optional):**
- `sourceIds` - comma-separated list of source IDs (e.g. `?sourceIds=id1,id2`). Without the parameter, all of the user's active sources are parsed.

**Response Type:** `text/event-stream`

**Headers:** `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no` — from the shared `SSE_HEADERS` in `lib/sse.ts`, alongside `startHeartbeat()`, which keeps the connection provably alive through a CDN fronting the instance while a single source takes up to `SOURCE_TIMEOUT_MS` (180s) to emit anything. `maxDuration` is 300, not 60: it must exceed the watchdog, or the two numbers contradict each other.

**A dropped client no longer ends the run (RAD-346).** A CDN or reverse proxy in front of the app can truncate this stream, and the route used to read that as a stop — skipping every source not yet started. The run is server-owned now: every source is still parsed, writing into the dead stream is a silent no-op, and progress/outcome live in the in-process registry `lib/parse-runs.ts`. One run per user may be active — a second `GET` answers with a run-level `error` frame instead of parsing.

**Rate limit, as an EventSource can see it (RAD-326).** This route, `GET /api/posts/refilter` and `GET /api/posts/group-stories` are per-user rate-limited (10 / 5 / 10 per minute; ADMIN exempt). EventSource exposes neither the status nor the headers of a response, so a bare `429` reached the UI as a dropped connection. A request whose `Accept` includes `text/event-stream` (EventSource always sends it) therefore gets the refusal in-band: `200`, `content-type: text/event-stream`, `cache-control: no-store`, `Retry-After: N`, and one frame:

```
retry: N000
data: {"type":"error","code":"RATE_LIMITED","retryAfter":N,"message":"Too many requests — try again in Ns","error":"Too many requests — try again in Ns"}
```

The response then ends. It is the same single request and the same bucket, so nothing is counted twice. Clients must close on this frame and must not retry on their own; `retry:` only keeps a client that forgets from reconnecting inside the window. Any other caller still gets the JSON `429 { code: "RATE_LIMITED" }` with `Retry-After`.

**Every pre-stream refusal, as an EventSource can see it (RAD-406).** The same three routes refuse in two more ways before the stream starts, and an event-stream caller gets each one in-band, exactly like the rate limit — `200`, `content-type: text/event-stream`, `cache-control: no-store`, one frame, then the end of the response:

| `code` | Cause | Non-stream caller gets |
|---|---|---|
| `RATE_LIMITED` | per-user rate limit; the frame adds `retryAfter` and the response `Retry-After` | `429 { code: "RATE_LIMITED" }` |
| `UNAUTHORIZED` | no session — expired or signed out | `401 { error: "Unauthorized" }` from the route; `proxy.ts` redirects any other signed-out `/api/*` caller to `/signup` |
| `EMAIL_NOT_VERIFIED` | `requireVerifiedEmail` (RAD-297) | `403 { error, code: "EMAIL_NOT_VERIFIED" }` |

```
retry: 60000
data: {"type":"error","code":"UNAUTHORIZED","message":"Your session has ended — sign in again to continue.","error":"…same…"}
```

A signed-out request never reaches the route: `proxy.ts` redirects signed-out non-public requests to `/signup`, and an EventSource that follows that redirect gets an HTML document and fails without saying why. So the proxy itself answers a signed-out `/api/*` request whose `Accept` includes `text/event-stream` with the `UNAUTHORIZED` frame — no redirect, so RAD-304's tagging does not apply — and the route's own conversion covers a session that disappears between the two. `retry:` is 60 s for the two refusals waiting cannot fix, so a client that forgets to close does not reconnect in a tight loop. The copy for every code lives in `lib/stream-refusal.ts` (client-safe, the single reader `readRefusal` beside it); the helper that writes the frame is `streamableRefusal` in `lib/sse.ts`.

#### GET /api/parse-stream/status
The authenticated user's current run, or `{ "run": null }`. The processing card checks it once on mount (to attach to a run started in another tab or before a reload) and polls it (every 4 s) after losing the stream, then settles with the returned `results`. The feed card follows a dropped stream the same way (RAD-407); both use `followServerRun` in `lib/parse-run-follow.ts`. Snapshot shape: `{ id, startedAt, finishedAt, status: "running" | "done" | "stopped", total, processed, approved, filtered, results }`. Auth required; no rate limit (no AI spend) and `cache-control: no-store`.

The endpoint answers with the user's **latest** run and keeps a finished one for 15 minutes, so a follow must know which run is its own. It follows the `runId` its stream's `parse_start` named, and a snapshot with another id is unusable (two in a row settle the follow as gone). A stream that died before `parse_start` has no id: the follow then takes only a run it has seen `running`, so an earlier finished run is never reported as this one. The exception is a card refused with "already running": that refusal proves the registry holds the running run, so it may be taken finished. A status answer that is signed out (`401`, or a redirect to `/signup`) ends the follow at once as an `UNAUTHORIZED` refusal, not as a lost run.

#### POST /api/parse-stream/stop
Ask the user's running parse to stop: sources that have not started are skipped, the run is recorded `stopped`, and `parse_complete` is not sent. Returns `{ "stopped": boolean }` — `false` means there was nothing running (never that the request failed). Auth required.

**SSE Events:**

0. `parse_start` — the eligible-source manifest, emitted **once, first**, after ownership, `isActive`, `hidden` and the non-Pro Twitter exclusion have all been applied. It is the only trustworthy denominator for progress; a run with no eligible sources still emits it with `sourceCount: 0` rather than leaving the client to infer one. Additive — clients that do not know the event ignore it.
```json
{
  "type": "parse_start",
  "sourceCount": 3,
  "sources": [{ "id": "clxxxx", "name": "Example Feed" }],
  "runId": "6f1c…"
}
```
`runId` is the id of the run the route claimed in the registry, the same `id` `GET /api/parse-stream/status` returns (RAD-407). A zero-source run claims nothing and sends no `runId`.

1. `source_start` - source parsing started
```json
{
  "type": "source_start",
  "sourceId": "clxxxx",
  "sourceName": "Example Feed"
}
```

2. `items_fetched` - items fetched from the source
```json
{
  "type": "items_fetched",
  "sourceId": "clxxxx",
  "count": 20
}
```

3. `material_created` - a new item was created
```json
{
  "type": "material_created",
  "material": {
    "id": "clxxxx",
    "title": "Article Title",
    "url": "https://example.com/article",
    "content": "Full article text...",
    "thumbnailUrl": "https://example.com/og-image.jpg",
    "mediaUrls": ["https://example.com/og-image.jpg"],
    "aiEvaluation": "APPROVED",
    "aiConfidence": 85,
    "aiReasoning": "Relevant because...",
    "userStatus": "NEW",
    "feed": {
      "id": "clxxxx",
      "name": "Example Feed",
      "type": "RSS"
    }
  },
  "sourceId": "clxxxx",
  "progress": {
    "current": 5,
    "total": 15
  }
}
```

5. `source_complete` - source parsing finished
```json
{
  "type": "source_complete",
  "sourceId": "clxxxx",
  "sourceName": "Example Feed",
  "stats": {
    "parsed": 20,
    "new": 15,
    "approved": 8,
    "filtered": 7
  }
}
```

6. `parse_complete` - the entire parse finished
```json
{
  "type": "parse_complete",
  "results": {
    "parsed": 100,
    "evaluated": 95,
    "approved": 45,
    "filtered": 50,
    "errors": []
  }
}
```

7. `error` - parsing error
```json
{
  "type": "error",
  "sourceId": "clxxxx",
  "sourceName": "Example Feed",
  "message": "Failed to fetch feed"
}
```

**Timeouts & hang protection (RAD-232):**
- Deployed on Railway (long-running Node) — the `maxDuration = 60` export is a Vercel-only directive and is **ignored** here; the route may run as long as needed.
- Sources are parsed concurrently with `p-limit` (`SOURCE_CONCURRENCY = 5`).
- **Per-source watchdog** (`SOURCE_TIMEOUT_MS = 180000`): each source's work is wrapped in `Promise.race`, so a single hung source can never block `Promise.allSettled` / `parse_complete`. A timeout surfaces as a `source` `error` event and marks the feed `ERROR`.
- **AI eval timeout** (`AI_EVAL_TIMEOUT_MS = 60000` in `lib/ai.ts`): every `generateObject` call carries an `AbortSignal.timeout` + explicit `maxRetries`, so a hung OpenRouter request fails fast instead of stalling the stream.

**Example usage (JavaScript):**
```javascript
const eventSource = new EventSource('/api/parse-stream')

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data)

  switch (data.type) {
    case 'material_created':
      // Add material to UI in real-time
      addMaterialToList(data.material)
      break
    case 'parse_complete':
      // Close connection
      eventSource.close()
      break
  }
}

eventSource.onerror = (error) => {
  console.error('SSE error:', error)
  eventSource.close()
}
```

---

### Settings

Radaric splits settings into two levels:
1. **Global Settings** (`/api/settings`) — AI API key and model overrides, Telegram credentials, Parallel API (ADMIN only)
2. **User Settings** (`/api/user-settings`) — global prompt, Notion integration, story-aggregator and onboarding fields (all users; some fields admin-only)

#### GET /api/settings
Get the global settings record. **Auth: ADMIN only** (`requireAdmin()`). Creates the record with defaults on the first call.

**Response:**
```json
{
  "id": "clxxxx",
  "aiApiKey": "sk-or-v1-xxx",
  "aiModel": "z-ai/glm-5.3-flash",
  "aiTemperature": 0.7,
  "synthesisModel": null,
  "discoveryModel": null,
  "filterReasoningEffort": null,
  "telegramApiHash": "abcdef1234567890",
  "telegramApiId": 12345678,
  "telegramPhoneNumber": "+1234567890",
  "telegramSessionString": "session_string",
  "parallelApiKey": "parallel_xxx",
  "parallelWebhookSecret": "webhook_secret",
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-01T00:00:00Z"
}
```

`telegramApiId` is a number. The deprecated `globalPrompt`, `notionToken` and `notionDatabaseId` columns remain on the record for migration only — use `/api/user-settings` for those.

#### PUT /api/settings
Update the global settings record. **Auth: ADMIN only.**

**Request Body (flat — any subset of fields; an absent key leaves that field unchanged):**
```json
{
  "aiApiKey": "sk-or-v1-xxx",
  "aiModel": "z-ai/glm-5.3-flash",
  "aiTemperature": 0.5,
  "synthesisModel": "z-ai/glm-5.3",
  "discoveryModel": null,
  "filterReasoningEffort": "high",
  "telegramApiId": 12345678,
  "telegramApiHash": "abcdef1234567890",
  "telegramSessionString": "session_string",
  "telegramPhoneNumber": "+1234567890",
  "parallelApiKey": "parallel_xxx",
  "parallelWebhookSecret": "webhook_secret"
}
```

**Response:** the saved Settings record (the same flat shape as GET).

**Response (403 for a non-admin):**
```json
{
  "error": "Forbidden: Admin access required"
}
```

**Model fields — validation and semantics.**

`aiModel`, `synthesisModel` and `discoveryModel` are validated against the
catalogue in `lib/models/registry.ts`; anything not offered is stored as `null`,
which means "no override" and lets the stage fall back to its `STAGE_DEFAULTS`
entry. Rejecting on the way in is deliberate — a bad id reaches the provider as
a hard error rather than a fallback, so it must never reach the column. Reads
are the mirror image: a stored id that has since been retired is tolerated and
resolved to the default at call time, so Settings can still show the user that
their saved choice is gone instead of silently swapping it.

`filterReasoningEffort` accepts `none | minimal | low | medium | high | xhigh`
(the enum `@ai-sdk/openai` parses) and `null` for "use the default", currently
`high`. It only reaches models whose OpenRouter `supported_parameters` include
`reasoning_effort`; the rest get a request with no effort field.

#### POST /api/settings/test-notion
Test the Notion connection.

**Request Body:**
```json
{
  "token": "secret_xxx",
  "databaseId": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

**Response:**
```json
{
  "success": true
}
```

---

### Blacklist

#### GET /api/blacklist
Get all blacklist entries.

**Response:**
```json
[
  {
    "id": "clxxxx",
    "pattern": "cryptocurrency",
    "type": "KEYWORD",
    "reason": "Not relevant to design digest",
    "createdAt": "2024-01-01T00:00:00Z"
  }
]
```

#### POST /api/blacklist
Add a blacklist entry.

**Request Body:**
```json
{
  "pattern": "crypto",
  "type": "KEYWORD",
  "reason": "Not relevant"
}
```

**Types:**
- `KEYWORD` - keyword search in title and content
- `DOMAIN` - block all items from a particular domain
- `AUTHOR` - block items from a particular author

#### DELETE /api/blacklist/[id]
Remove a blacklist entry.

---

### Feedback

#### GET /api/feedback
Get the feedback history for the AI.

**Response:**
```json
[
  {
    "id": "clxxxx",
    "sourceFeedback": "More technical content for this source",
    "globalFeedback": "Focus on practical examples",
    "materialId": "clxxxx",
    "sourceId": "clxxxx",
    "createdAt": "2024-01-01T00:00:00Z",
    "source": {
      "id": "clxxxx",
      "name": "Example Feed"
    }
  }
]
```

#### PATCH /api/feedback/[id]
Edit feedback comment or type.

**Auth:** Required
**Request Body:**
```json
{
  "feedbackType": "LIKE" | "DISLIKE",
  "comment": "updated comment"
}
```

**Response:** Updated feedback object.

#### DELETE /api/feedback/[id]
Remove individual feedback entry.

**Auth:** Required
**Response:** `{ "success": true }`

---

## Stats API

### GET /api/stats

Get statistics on items and feeds.

**Parameters:** None

**Response:**
```json
{
  "materials": {
    "total": 150,
    "approved": 85,
    "filtered": 65,
    "new": 25,
    "sentToNotion": 40,
    "archived": 15
  },
  "feeds": {
    "total": 12,
    "active": 10
  }
}
```

**Field descriptions:**

**Materials:**
- `total` - total items (excluding DELETED and ARCHIVED)
- `approved` - approved by the AI (aiEvaluation = APPROVED, excluding DELETED and ARCHIVED)
- `filtered` - filtered out by the AI (aiEvaluation = FILTERED, excluding DELETED and ARCHIVED)
- `new` - new items (userStatus = NEW)
- `sentToNotion` - sent to Notion (userStatus = SENT_TO_NOTION)
- `archived` - archived items (userStatus = ARCHIVED)

**Feeds:**
- `total` - total feeds
- `active` - active feeds (isActive = true)

**Important:** Counting APPROVED and FILTERED items excludes the ARCHIVED status for correct statistics. This prevents double-counting items that were archived after the initial AI evaluation.

**Use cases:**
- Displaying counters in the sidebar (desktop and mobile navigation)
- Counters in the item filters (show the count for each type, including archive)
- Dashboard statistics
- Real-time UI updates (polling every 30 seconds)

**Error Response:**
```json
{
  "error": "Failed to fetch stats",
  "details": "Database connection error"
}
```

---

## Parallel Monitor Webhook API

### POST /api/webhooks/parallel

**Access:** Public (with signature verification)

Webhook endpoint for receiving notifications from the Parallel Monitor API about new items.

**Security Measures:**

1. **Webhook Signature Verification (HMAC-SHA256)**
   - Standard Webhooks: `webhook-id` / `webhook-timestamp` / `webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>`
   - The secret is `Settings.parallelWebhookSecret` (DB, a field in the Settings UI); the `PARALLEL_WEBHOOK_SECRET` env var does not exist (RAD-288)
   - `crypto.timingSafeEqual()` + buffer length check against timing attacks

2. **Rate Limiting**
   - At most 100 requests per minute from one IP
   - Serverless-safe implementation (no `setInterval`)
   - Cleanup of expired entries on every request

3. **Payload Validation (Zod)**
   - `parallelWebhookSchema` for the base structure
   - `monitorEventSchema` for `monitor.event.detected` events
   - Rejection of invalid data with a 400 status

4. **User & Source Validation**
   - Checks that the Source exists by `parallelMonitorId`
   - Checks `source.isActive = true`
   - Checks that `source.userId` exists
   - Owner access (RAD-323): `resolveAccessForUserId` — denied → 200 `access_inactive`; unknown (DB error) → 503 retryable
   - The signature is required in every environment (RAD-289); `PARALLEL_WEBHOOK_INSECURE=1` — local development only

**Request Headers:**
```
Content-Type: application/json
webhook-id / webhook-timestamp / webhook-signature: v1,<base64 HMAC-SHA256 of id.timestamp.body>  (Standard Webhooks)
x-real-ip / x-forwarded-for: client IP for rate limiting (X-Real-IP; fallback — the last XFF hop; the CDN address is not used)
```

**Request Body (monitor.event.detected):**
```json
{
  "event_type": "monitor.event.detected",
  "monitor_id": "mon_xxxxxxxxx",
  "event_group_id": "evt_xxxxxxxxx"
}
```

**Response (Success):**
```json
{
  "status": "ok",
  "created": 5,
  "skipped": 2
}
```

**Response (Ignored - Unknown Monitor):**
```json
{
  "status": "ignored",
  "reason": "unknown_monitor"
}
```

**Response (Ignored - Source Inactive):**
```json
{
  "status": "ignored",
  "reason": "source_inactive"
}
```

**Response (Error - User Not Found):**
```json
{
  "status": "error",
  "reason": "user_not_found"
}
```

**Response (Error - Invalid Signature):**
```json
{
  "error": "Invalid signature"
}
```

**Response (Error - Rate Limit):**
```json
{
  "error": "Rate limit exceeded"
}
```

**Response (Error - Temporary Processing Error):**
```json
{
  "error": "Temporary processing error",
  "retryable": true
}
```

**Smart Error Handling:**

- **503 (Service Unavailable)** - for retryable errors (fetch errors, network issues, rate limits)
  - The Parallel API automatically retries the request
- **200 (OK) with error** - for permanent errors (invalid data, configuration issues)
  - Prevents infinite retries

**Process Flow:**

```
1. Rate Limit Check (IP-based)
   ↓
2. Signature Verification (HMAC-SHA256)
   ↓
3. Payload Validation (Zod schemas)
   ↓
4. Find Source by monitor_id
   ↓
5. Check source.isActive
   ↓
6. Check source.userId exists
   ↓
7. Validate User exists & isActive ← NEW
   ↓
8. Process Event Group (fetch & save materials)
   ↓
9. Return results
```

**Use Cases:**
- Automatic ingestion of items from Parallel monitors
- Protection against forged webhook requests
- Rate limiting as DDoS protection
- Per-user data isolation (multi-user support)

**Health Check:**

```bash
GET /api/webhooks/parallel

Response:
{
  "status": "ok",
  "service": "parallel-webhook",
  "timestamp": "2025-12-09T10:00:00.000Z"
}
```

---

### Auth

#### POST /api/auth/signup
Unified signup/signin endpoint. Creates user if not exists, signs in if exists with valid password. The first account in an empty database becomes ADMIN.

**Auth:** Not required
**Body:**
```json
{
  "email": "user@example.com",
  "password": "min8chars"
}
```
**Response:** `{ "action": "signup", "verificationSent": true }` or `{ "action": "signin" }` — `verificationSent` reports whether the verification email went out (RAD-297); when verification is not enforced (self-host mode), the account is created already verified.
**Errors:** 400 if invalid email format, password < 8 chars, or wrong password ("Invalid email or password"). 429 (`RATE_LIMITED`) over the signup budgets: 60/15 min per IP aggregate, 20 account creations/hour per IP, 10 sign-ins/15 min per IP+email.

#### POST /api/auth/forgot-password
Initiate password reset. Sends reset link via Resend email.

**Body:** `{ "email": "user@example.com" }`
**Response:** `{ "message": "If an account exists, we sent a reset link." }` (200 regardless of account existence — no email enumeration; the send runs after the response, so timing does not leak either)
**Errors:** 400 without an email. 429 (`RATE_LIMITED`) after 5 requests/15 min per IP or 3/15 min per address. 503 when the mail transport is unconfigured (`RESEND_API_KEY` unset) — an honest failure instead of a fake success.
**Notes:** RAD-324: the reset token is a 32-byte random value stored as a SHA-256 hash in `password_reset_tokens`; single-use, 1 h TTL, and a successful reset marks every other outstanding token for that account used. If user has no passwordHash (Google/Apple sign-in only), sends a different email suggesting OAuth.

#### POST /api/auth/reset-password
Complete password reset with the token from the email link.

**Body:** `{ "token": "opaque_token", "password": "new_password" }`
**Response:** `{ "message": "Password updated" }` — also stamps `emailVerified` (control of the mailbox is proven) and invalidates the account's other outstanding reset tokens.
**Errors:** 400 if token expired/invalid/used, password < 8 chars. 429 (`RATE_LIMITED`) after 5 requests/15 min per IP. 503 on an internal failure.

---

### Onboarding

> **Shared with dashboard bulk-add (RAD-169):** `POST /api/onboarding/parse-feeds` and `POST /api/onboarding/save-feeds` are reused by `BulkAddFeedsDialog` (`components/feeds/bulk-add-feeds-dialog.tsx`) on `/feeds` — the contract must stay stable for both callers. Neither endpoint flips `onboardingCompleted`, so the dashboard call is side-effect-free.

#### POST /api/onboarding/parse-feeds
Parse user input (pasted text or OPML file) and detect feed types.

**Auth:** Required
**Content-Type:** `multipart/form-data`
**Body:** `text` (pasted URLs/names) and/or `file` (OPML file, max 5 MB — `FILE_SIZE_LIMIT` export)
**Response:** SSE stream of events: `{type:"feed",feed}` (initial extraction), `{type:"update",feed}` (after RSS resolution), `{type:"complete",feeds}`, `{type:"error",message}`.
**Notes:** Uses RSS auto-detection, Telegram channel pattern matching, Twitter @username detection, OPML parsing, and LLM-based extraction for ambiguous inputs. 10s timeout per feed detection. Called by onboarding (`/onboarding/feeds`) and dashboard bulk-add (`BulkAddFeedsDialog`).

#### GET /api/onboarding/parse-feeds/status
Polling endpoint for parse status (used during async feed detection).

**Auth:** Required

#### POST /api/onboarding/validate-feed
Validate a single RSS feed URL.

**Auth:** Required
**Body:** `{ "url": "https://example.com/feed.xml" }`
**Response:** `{ "valid": true, "name": "Feed Title", "itemCount": 42 }` or `{ "valid": false, "error": "Not a valid RSS/Atom feed" }`

#### POST /api/onboarding/save-feeds
Save discovered feeds to the database.

**Auth:** Required
**Body:** `{ "feeds": [{ "name": "...", "url": "...", "type": "RSS"|"TELEGRAM"|"TWITTER"|"YOUTUBE" }] }` (max 300 feeds, enforced via `z.max(300)`)
**Response:** `{ "created": 5, "skipped": 2, "twitterSkipped": 0, "youtubeSkipped": 0, "telegramSkipped": 0 }` (201)
**Notes:** Deduplicates by URL, skips feeds already in user's account. `YOUTUBE` entries are resolved to the canonical `/channel/UC…` form before insert (concurrency-limited, max 50 resolves per request — beyond-cap entries count into `youtubeSkipped`); unresolvable ones are dropped and counted in `youtubeSkipped`, and a channel already present as a plain RSS feed-XML URL is skipped by channel-id match. `TELEGRAM` entries are stored as `https://t.me/<channel>`; an entry that is not a public channel username (`me`, a phone number, a peer id, a private invite link…) is dropped and counted in `telegramSkipped` (RAD-364). Does **not** flip `onboardingCompleted` — that happens separately in `/onboarding/preferences`, so this endpoint is safe to call from dashboard bulk-add (`BulkAddFeedsDialog`).

---

### Feeds (Additional Endpoints)

#### POST /api/feeds/import-opml
Import RSS feeds from OPML file (Feedly/Inoreader export).

**Auth:** Required
**Content-Type:** `text/xml`
**Body:** Raw OPML XML content (max 2MB)
**Response:** `{ "imported": 15, "skipped": 3, "errors": [] }`
**Notes:** YouTube channel feeds in the export (`youtube.com/feeds/videos.xml?channel_id=UC…`) are upgraded to native `YOUTUBE` sources (canonical `/channel/UC…` URL, transcript-based eval); duplicate detection matches both URL forms by channel id.

#### POST /api/feeds/[id]/clear-error
Clear error state on a feed after failed parse.

**Auth:** Required
**Response:** `{ "success": true }`

#### POST /api/feeds/[id]/fetch-cover
Re-fetch cover image for a feed (OG/twitter:image for RSS, channel avatar for Telegram).

**Auth:** Required
**Response:** `{ "coverUrl": "https://..." }` or `{ "coverUrl": null }`

#### GET /api/feeds/[id]/feedback
List feedback entries with stats for a specific feed.

**Auth:** Required
**Response:**
```json
{
  "feedbacks": [...],
  "stats": { "likes": 12, "dislikes": 3, "total": 15 }
}
```

#### DELETE /api/feeds/[id]/feedback
Bulk reset all feedback for a feed.

**Auth:** Required
**Response:** `{ "deleted": 15 }`

---

### Stories

#### GET /api/stories
List all stories for current user.

**Auth:** Required
**Query:** `?status=DRAFT|SENT_TO_NOTION`
**Response:** Array of Story objects with materials.

#### GET /api/stories/[id]
Get single story with all materials.

**Auth:** Required
**Response:** The story with its `inboxItems` and its constituent `materials` — each material with its feed and the requesting user's own feedback (`take: 1`, newest first). The same select `/stories/[id]` renders, so the side peek and the page cannot drift (RAD-345). 404s a story that does not exist or belongs to another user.

#### DELETE /api/stories/[id]
Delete a story.

**Auth:** Required

#### POST /api/stories/[id]/notion
Export story to Notion. Marks all constituent materials as SENT_TO_NOTION.

**Auth:** Required
**Notes:** Requires Notion integration configured in UserSettings.

#### POST /api/stories/poll
Trigger story polling — process pending inbox items into stories.

**Auth:** Required
**Response:** Processing summary with counts.

#### POST /api/stories/retention
Run data retention on old inbox items.

**Auth:** Required
**Response:** `{ "success": true, "archived": 12 }`

---

### Inbox Items

#### GET /api/inbox-items
List inbox items (raw messages from Telegram Story Aggregator).

**Auth:** Required
**Query:** `?status=PENDING|PROCESSED|ERROR&limit=50` (max 200)
**Response:** Array of InboxItem objects.

#### GET /api/inbox-items/[id]
Get single inbox item.

**Auth:** Required

#### DELETE /api/inbox-items/[id]
Delete an inbox item (ownership verified).

**Auth:** Required
**Response:** `{ "success": true }`

#### POST /api/inbox-items/[id]/retry
Retry processing a failed (ERROR status) inbox item. Resets status to PENDING and re-runs pipeline.

**Auth:** Required
**Response:** `{ "success": true, "storyId": "optional" }`

---

### Admin

#### GET /api/admin/dashboard
Admin dashboard with user analytics, feed stats, and material counts.

**Auth:** Admin only (`requireAdmin()`)
**Response:** Users list with activity stats, feed/material counts per user, and each user's paid subscription — `subscription`: `{ state: "active" | "ending" | "past_due" | "lapsed", status, tier, interval, currentPeriodEnd, cancelAtPeriodEnd, canceledAt, createdAt, stripeSubscriptionId }`, or `null` when there is no subscription row. Totals include `subscribers` — access-granting rows whose id is a real Stripe subscription (`sub_…`); the scripts' legacy comp rows (`comp_…`) are excluded.

#### POST /api/admin/fetch-all-covers
Batch re-fetch cover images for all feeds.

**Auth:** Admin only

#### POST /api/admin/reset-stories
Reset story grouping — unlink materials from stories, delete stories.

**Auth:** Admin only
**Request Body:**
```json
{
  "allUsers": false  // default: false (current admin only)
}
```

**Response:**
```json
{
  "scope": "admin only",
  "materialsUnlinked": 45,
  "storiesDeleted": 12,
  "storiesBefore": 12,
  "message": "Story grouping reset for admin only"
}
```

#### POST /api/admin/dissolve-single-material-stories
One-time backfill that reverts pre-existing **auto single-material stories** so lone posts render their original content again. Detaches the material (`storyId → null`) then deletes the orphan story. Spares multi-source clusters, Notion-exported, inbox-backed, and manually-sent (`SENT_TO_STORIES`/`SENT_TO_NOTION`) stories. Idempotent.

**Auth:** Admin only
**Query params:** `?scope=self` (default — calling admin's stories) | `?scope=all` (every user)

**Response:**
```json
{ "scope": "self", "dissolved": 399, "materialsDetached": 398 }
```

---

### User Settings

#### GET /api/user-settings
Get current user's personal settings (story model, language, categories, Notion config, typography). `typography` is included — `null` means the default (Inter in every role).

**Response (all three methods):** an allowlisted projection of the row (`lib/user-settings-public.ts`). The Notion token never appears in any form; `hasNotionToken: boolean` says whether one is saved (RAD-380).

**Auth:** Required

#### PUT /api/user-settings
Update personal settings (full replace). Admin-only fields (`storyInboxChannelId`, `storyNotionDatabaseId`, `autoDeleteTelegramMessages`) return 403 for non-admin users; the story-model four (`storyWriterModel`, `storyMatcherModel`, `materialStoryModel`, `storySystemPrompt`) are silently stripped instead, because the settings form re-sends whatever GET returned (RAD-369). `globalPrompt` is capped at 8000 characters and `storySystemPrompt` at 20000 — a longer value answers 400 and writes nothing; re-sending the stored value unchanged is a no-op, not an error. `typography` is ignored here — it is written only through PATCH. `notionToken` is write-only: an absent key keeps the saved token, `null` or `""` clears it, a non-empty string replaces it and is sealed with `TOKEN_ENC_KEY` before it is written (RAD-221; without the key → 503, nothing written; a non-string → 400).

**Auth:** Required (some fields admin-only)
**Body:** Full UserSettings object. Model fields validated against allowlist.

#### PATCH /api/user-settings
Partial update of user settings (used by the onboarding flow and the font picker).

**Auth:** Required
**Supported Fields:** `globalPrompt`, `globalLikedCategories`, `globalDislikedCategories`, `onboardingCompleted`, `onboardingBannerDismissed`, `onboardingState`, `typography`. `globalPrompt` is capped at 8000 characters (over the cap → 400, nothing written; an unchanged over-cap value is a no-op).
**Response:** the updated settings, same projection as GET.

**`typography` (RAD-363)** — the per-role font choice, validated strictly by `validateTypographyInput` (`lib/typography/prefs.ts`) before any write:

```json
{ "typography": { "heading": "inter", "text": "pt-root-ui", "counter": "martian-mono", "tag": "inter" } }
```

- The value is either the **full object** with exactly the four keys `heading`, `text`, `counter`, `tag`, each a registry id (`inter`, `martian-grotesk`, `pt-root-ui`, `sf-pro`, `sf-pro-rounded`, `martian-mono`, `sf-mono` — `lib/typography/fonts.ts`), or **`null`**, which resets to the default and is stored as a DB null.
- **400** (nothing written) for anything else: a non-object (string, array, number), a missing or extra key (`typography must be an object with heading, text, counter and tag`), or an unknown id (`unknown font for <role>`); error strings never echo the value.
- A partial object is not merged — send all four roles. The field is absent from the body → untouched.

> **`onboardingCompleted` is a one-way latch (RAD-294).** Both PUT and PATCH
> accept **only `true`** for this field; `false` is silently ignored and the
> stored value is left untouched. `onboardingCompleted === false` opens the
> time-bounded full-access demo grant (see FEATURES.md → Billing), and both
> handlers are guarded by `requireAuth()` alone — accepting the client's
> `false` handed any signed-in user an unlimited free reset. No legitimate
> client ever sends `false`: the only writers of `true` are
> `app/onboarding/preferences/page.tsx` and the server-side auto-complete in
> `lib/paywall.ts`. If you add a third write path, latch it too.

---

### Categories

#### GET /api/categories/custom
Aggregate custom (user-defined) categories across all user's feeds. Returns categories not in the built-in LIKED/DISLIKED lists.

**Auth:** Required
**Response:** `{ "liked": ["custom-cat-1"], "disliked": ["custom-cat-2"] }`

---

### Health

#### GET /api/health
Health check endpoint. No auth required.

**Response:** `{ "status": "ok", "sha": "<40-char commit SHA or null>", "deploymentId": "<Railway deployment UUID or null>" }`

`status: "error"` with HTTP 500 when the DB probe fails. `sha` and `deploymentId` are reported on **both** paths — a failing deploy is when you most need to know which build is answering — and are `null` off Railway. Sent with `cache-control: no-store`. Release verification compares `sha` against the merged commit (the full 40-character SHA).

---

## Error Responses

All endpoints return errors in the following format:

```json
{
  "error": "Error message description"
}
```

**HTTP Status Codes:**
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation error)
- `404` - Not Found
- `500` - Internal Server Error

---

## Data Models

### User
```typescript
type User = {
  id: string
  username: string
  email: string | null  // unique; null until set
  emailVerified: Date | null
  passwordHash: string | null  // bcryptjs hash (never returned via API); null for OAuth-only accounts
  name: string | null
  role: "ADMIN" | "USER"
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}
```

### UserSettings
```typescript
type UserSettings = {
  id: string
  userId: string  // Foreign key to User
  globalPrompt: string | null
  notionToken: string | null  // sealed at rest (enc:v1:…, RAD-221); never returned by the API (RAD-380)
  notionDatabaseId: string | null
  typography: { heading: string; text: string; counter: string; tag: string } | null  // per-role font ids (RAD-363); null = default
  // Story Aggregator, category and onboarding fields omitted here —
  // see prisma/schema.prisma for the full model
  createdAt: Date
  updatedAt: Date
}
```

### Feed
```typescript
type Feed = {
  id: string
  userId: string  // Foreign key to User - isolates feeds per user
  type: "RSS" | "TELEGRAM" | "TWITTER" | "INTEREST" | "EVENT_TRIGGER" | "YOUTUBE"
  url: string
  name: string
  coverUrl: string | null
  customPrompt: string | null
  isActive: boolean
  status: "ACTIVE" | "PAUSED" | "ERROR"
  createdAt: Date
  updatedAt: Date
  lastParsedAt: Date | null
}
// Prisma model: Feed (@@map("sources")); type is the SourceType enum — INTEREST is deprecated
```

### Material
```typescript
type Material = {
  id: string
  feedId: string
  title: string
  url: string
  externalId: string | null
  content: string
  contentEntities: any[] | null // Telegram entities for formatting (links etc.)
  publishedAt: Date | null
  thumbnailUrl: string | null
  mediaUrls: string[]
  aiEvaluation: "APPROVED" | "FILTERED"
  aiConfidence: number // 0-100
  aiReasoning: string | null
  userStatus: "NEW" | "READ" | "SENT_TO_NOTION" | "ARCHIVED" | "DELETED"
  createdAt: Date
  updatedAt: Date
}
```

**Item statuses:**
- `NEW` - new item (default after parsing)
- `READ` - read by the user
- `SENT_TO_NOTION` - sent to Notion
- `ARCHIVED` - archived (hidden from the main filters, can be restored)
- `DELETED` - deleted (soft delete, not shown in the API)

### BlacklistItem
```typescript
type BlacklistItem = {
  id: string
  userId: string  // Foreign key to User - isolates blacklist per user
  pattern: string
  type: "KEYWORD" | "DOMAIN" | "AUTHOR"
  reason: string | null
  createdAt: Date
}
```

### Settings (Global - Admin only)
```typescript
type Settings = {
  id: string
  aiApiKey: string | null
  aiModel: string | null
  aiTemperature: number | null
  synthesisModel: string | null
  discoveryModel: string | null
  filterReasoningEffort: string | null  // none | minimal | low | medium | high | xhigh | null
  telegramApiHash: string | null
  telegramApiId: number | null
  telegramPhoneNumber: string | null
  telegramSessionString: string | null
  parallelApiKey: string | null
  parallelWebhookSecret: string | null
  createdAt: Date
  updatedAt: Date
}

// Deprecated fields (migrated to UserSettings, kept for migration only):
// - globalPrompt → UserSettings.globalPrompt
// - notionToken → UserSettings.notionToken
// - notionDatabaseId → UserSettings.notionDatabaseId
```

### AIFeedback
```typescript
type AIFeedback = {
  id: string
  userId: string  // Foreign key to User - isolates feedback per user
  sourceFeedback: string | null
  globalFeedback: string | null
  materialId: string | null
  sourceId: string | null
  createdAt: Date
}
```

---

## Rate Limiting

**AI Evaluation:**
- Batch processing of 3 items for optimization
- Avoids the Anthropic API rate limits

**Notion API:**
- At most 3 requests per second (per Notion documentation)

---

## Best Practices

1. **Parsing:** Run parsing on a schedule, not on every request
2. **Feedback:** Provide feedback when deleting items to improve the AI
3. **Prompts:** Combine the global prompt with source-specific ones for better results
4. **Blacklist:** Use it for automatic filtering before AI analysis (saves API calls)

---

## Future Enhancements

- GraphQL API (optional)
- Distributed rate limiting (a shared store across instances — the shipped limiter is in-process)
- API versioning

---

## Telegram Authentication API

**Status:** ✅ Implemented (2025-11-15)

A set of endpoints for authenticating with the Telegram API using GramJS. Supports a multi-step authentication flow with 2FA.

### Authentication Flow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │
       │ 1. POST /api/telegram/auth/start
       │    { phoneNumber: "+1234567890" }
       ▼
┌─────────────────────────────────┐
│ Telegram API sends SMS code     │
└──────┬──────────────────────────┘
       │
       │ 2. POST /api/telegram/auth/verify
       │    { code: "12345" }
       ▼
┌─────────────────────────────────┐
│ If 2FA enabled → needs password │
└──────┬──────────────────────────┘
       │
       │ 3. POST /api/telegram/auth/verify
       │    { password: "mypass" }
       ▼
┌─────────────────────────────────┐
│ Session saved, authenticated ✅  │
└─────────────────────────────────┘
```

### POST /api/telegram/auth/start

Starts the authentication process. Sends a verification code to the given phone number.

**Request Body:**
```json
{
  "phoneNumber": "+1234567890"
}
```

**Response (Success):**
```json
{
  "success": true,
  "phoneCodeHash": "xxxxxxxxxxxxx"
}
```

**Response (Error - Missing API Credentials):**
```json
{
  "error": "Telegram API credentials not configured"
}
```

**Response (Error - Invalid Phone):**
```json
{
  "error": "Failed to send code: PHONE_NUMBER_INVALID"
}
```

**Stored data:**
- `telegramPhoneNumber` - the phone number (stored in Settings)
- Phone code hash - temporarily in memory for the next step

### POST /api/telegram/auth/verify

Verifies the SMS code or the 2FA password.

**Request Body (Step 1 - Code Verification):**
```json
{
  "code": "12345"
}
```

**Request Body (Step 2 - 2FA Password, if required):**
```json
{
  "password": "my2fapassword"
}
```

**Response (Success - Authenticated):**
```json
{
  "success": true,
  "authenticated": true
}
```

**Response (Success - 2FA Required):**
```json
{
  "success": true,
  "authenticated": false,
  "passwordRequired": true
}
```

**Response (Error - Invalid Code):**
```json
{
  "error": "Invalid code"
}
```

**Response (Error - Invalid Password):**
```json
{
  "error": "Invalid password"
}
```

**Response (Error - Session Expired):**
```json
{
  "error": "Session expired. Please start authentication again."
}
```

**Stored data:**
- `telegramSessionString` - StringSession for subsequent connections
- Saved to Settings after successful authentication

### GET /api/telegram/auth/status

Checks the current Telegram authentication status.

**Response (Authenticated):**
```json
{
  "authenticated": true,
  "state": "active",
  "phoneNumber": "+1234567890"
}
```

**Response (Not Authenticated):**
```json
{
  "authenticated": false,
  "state": "unconfigured"
}
```

**Session state (RAD-328):** the response also carries `state` — one of
`active` (live session), `starting` (worker connecting or waiting for the
session lock), `invalid` (Telegram rejected the session — re-authenticate),
`unconfigured` (no session or phone stored), `unknown` (worker unreachable).
`authenticated` is true only for `active` and is never inferred from the
stored session string.

**Use Cases:**
- Checking whether authentication is needed before parsing
- UI indication of the Telegram connection status
- Validating the session before critical operations

### POST /api/telegram/auth/logout

Disconnects the Telegram session and deletes the stored data.

**Request Body:** None

**Response (Success):**
```json
{
  "success": true
}
```

**Response (Error):**
```json
{
  "error": "Failed to logout"
}
```

**Deleted data:**
- `telegramSessionString` (cleared)
- `telegramPhoneNumber` (cleared)
- The active Telegram client connection is closed

**Use Cases:**
- Switching the Telegram account
- Signing out
- Troubleshooting connection issues

### Security Considerations

1. **Session Storage:**
   - The session string is stored encrypted in the DB
   - Never returned via the API
   - Used by the server side only

2. **Phone Number Privacy:**
   - The phone number is stored in Settings (privately)
   - Available only to authorized users

3. **Rate Limiting:**
   - The Telegram API has rate limits on sending SMS
   - Do not repeat requests more often than once a minute

4. **Error Messages:**
   - Do not reveal sensitive information
   - Are logged on the server for debugging

### Integration with Parsing

After successful authentication, Telegram feeds can be parsed:

```typescript
// 1. Authenticate
await fetch('/api/telegram/auth/start', {
  method: 'POST',
  body: JSON.stringify({ phoneNumber: '+1234567890' })
})

await fetch('/api/telegram/auth/verify', {
  method: 'POST',
  body: JSON.stringify({ code: '12345' })
})

// 2. Add Telegram feed
await fetch('/api/feeds', {
  method: 'POST',
  body: JSON.stringify({
    type: 'TELEGRAM',
    url: '@channelname',  // or t.me/channelname
    name: 'My Channel'
  })
})

// 3. Parse
await fetch('/api/parse')
```

### Error Codes Reference

| Error Code | Description | Resolution |
|------------|-------------|------------|
| `Telegram API credentials not configured` | API ID or Hash is not set | Add them in Settings |
| `PHONE_NUMBER_INVALID` | Invalid phone number format | Use the format +1234567890 |
| `Invalid code` | Wrong SMS code | Check the code from the SMS |
| `Invalid password` | Wrong 2FA password | Check the Cloud Password |
| `Session expired` | The session expired, re-authentication is needed | Start the process again |
| `Failed to send code` | Could not send the SMS | Check the number, try again later |

### Known Limitations

1. **Session Expiration:**
   - Telegram sessions can expire after several weeks of inactivity
   - Re-authentication is required once they expire

2. **Rate Limits:**
   - Telegram limits the number of SMS codes (usually 5 per day)
   - If exceeded, wait 24 hours

3. **2FA Requirement:**
   - If the account has 2FA, the password is required
   - It cannot be bypassed or disabled via the API

4. **Public Channels Only:**
   - GramJS supports public channels only
   - Private channels require an invite

### Documentation

**Full setup guide:** [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md)

**Includes:**
- Obtaining API credentials from Telegram
- Step-by-step authentication
- Cloudflare R2 setup (media storage)
- Troubleshooting

---

## Architecture & Best Practices

### State Management Patterns

**Optimistic Updates with Rollback:**

All archive and restore operations use the optimistic update pattern with rollback on error:

```typescript
// Saving the original state
const originalMaterials = materials
const originalStreamedMaterials = streamedMaterials

// Optimistic UI update
setMaterials(prev => prev.map(m =>
  m.id === id ? { ...m, userStatus: "ARCHIVED" } : m
))

try {
  await fetch(`/api/posts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ userStatus: "ARCHIVED" })
  })

  toast.success("Item moved to the archive")
} catch (error) {
  // Roll back the state on error
  setMaterials(originalMaterials)
  setStreamedMaterials(originalStreamedMaterials)
  toast.error("Failed to archive the item")
}
```

**Benefits:**
- Instant UI response
- Protection against data inconsistency on network errors
- Improved UX

### Performance Optimization

**Material Deduplication:**

To prevent duplicate items when combining `streamedMaterials` and `materials`:

```typescript
const combinedMaterials = useMemo(() => {
  const seen = new Set<string>()
  const combined = [...streamedMaterials, ...materials]

  return combined.filter(material => {
    if (seen.has(material.id)) return false
    seen.has(material.id)
    return true
  })
}, [streamedMaterials, materials])
```

**Filter Counts Memoization:**

Filter item counts are optimized with `useMemo`:

```typescript
const filterCounts = useMemo(() => ({
  all: combinedMaterials.length,
  approved: combinedMaterials.filter(m => m.aiEvaluation === "APPROVED").length,
  filtered: combinedMaterials.filter(m => m.aiEvaluation === "FILTERED").length,
  // ...
}), [combinedMaterials])
```

This prevents recounting on every render, which matters for large item lists.

### Server-Side Data Loading vs Client-Side Filtering

**CRITICAL PATTERN — the server loads the data, the client filters the UI:**

When using Next.js Server Components, it is important to understand the difference between server-side data loading and client-side filtering.

**Server-Side (SSR) - Data Provider:**

```typescript
// app/(dashboard)/posts/page.tsx

// ✅ CORRECT: Load ALL data the client may need
export default async function MaterialsPage() {
  const materials = await db.material.findMany({
    where: {
      userStatus: {
        not: "DELETED",  // Exclude only permanently removed data
      },
    },
    // ... select, orderBy
  })

  return <MaterialsList initialMaterials={materials} />
}

// ❌ WRONG: Excluding data the client needs
where: {
  userStatus: {
    notIn: ["DELETED", "ARCHIVED"],  // Bug: the client won't get ARCHIVED items
  },
}
```

**Client-Side (CSR) - UI Presentation:**

```typescript
// components/materials/materials-list.tsx

// The client decides what to show the user
const baseFilter = materials.filter(m => {
  // Hide ARCHIVED by default (but they ARE in the data!)
  if (activeFilter !== "ARCHIVED" && m.userStatus === "ARCHIVED") {
    return false
  }

  // Show ARCHIVED only when the "Archive" filter is active
  if (activeFilter === "ARCHIVED") {
    return m.userStatus === "ARCHIVED"
  }

  // Other filters...
  return true
})
```

**Rule:**

> **The server sends all data the client may want to display.**
> **The client decides what to show the user based on UI state.**

**Consequences of violating this:**

- Data disappears after a page refresh (the client doesn't get it from the server)
- Filters don't work (there is nothing to filter)
- Counters show 0 (no data to count)
- The user thinks the data is lost

**When to exclude data on the server:**

- Only permanently removed data (DELETED)
- Data the user must NEVER see (for security or privacy reasons)

**When to filter on the client:**

- Data that may be shown/hidden depending on UI state (ARCHIVED, filters, search)
- Transient states (NEW, READ)
- User preferences

### API Input Validation

**PATCH Endpoint Security — whitelist and enum validation:**

All PATCH endpoints must validate input data:

```typescript
// app/api/posts/[id]/route.ts

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json()

  // 1. Validate allowed fields (whitelist approach)
  const allowedFields = ["title", "content", "userStatus"]
  const updateFields = Object.keys(body)
  const invalidFields = updateFields.filter(field => !allowedFields.includes(field))

  if (invalidFields.length > 0) {
    return NextResponse.json(
      { error: `Invalid field: ${invalidFields[0]}. Allowed fields: ${allowedFields.join(", ")}` },
      { status: 400 }
    )
  }

  // 2. Validate enum values
  const validStatuses = ["NEW", "READ", "SENT_TO_NOTION", "ARCHIVED", "DELETED"]
  if (body.userStatus && !validStatuses.includes(body.userStatus)) {
    return NextResponse.json(
      { error: `Invalid userStatus value. Allowed: ${validStatuses.join(", ")}` },
      { status: 400 }
    )
  }

  // 3. Proceed with update
  const updated = await db.material.update({
    where: { id: params.id },
    data: body
  })

  return NextResponse.json(updated)
}
```

**Benefits:**

- Protection against field injection
- Protection against invalid enum values
- Informative error messages
- Security best practices (whitelist approach)

---

### Content Sanitization

All incoming HTML content is automatically sanitized before being saved to the DB:

**Functions:**
- `sanitizeHtml()` — removes dangerous tags and attributes, keeping the allowed ones (p, h1-h6, ul/ol/li, a, strong/em, code, pre, blockquote)
- `stripHtml()` — extracts plain text from HTML for AI analysis and excerpts
- `isHtml()` — detects the presence of HTML markup in the content
- `truncateContent()` — truncates content >100KB and automatically closes unclosed tags via sanitize-html

**Applied to:**
- RSS parsing: HTML from article content
- Telegram parsing: formatted messages
- Interest parsing: content from the Parallel API
- RSS fallback: raw RSS content if readability fails

**URI Validation:**
- `ALLOWED_URI_REGEXP` blocks `javascript:` and `data:` schemes
- Applied to links in HTML content
- Applied to Telegram entities (text with URLs)
- Protection against XSS via embedded links

---

_Last updated: 2026-09-16_
