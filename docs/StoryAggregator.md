# Story Aggregator

## Vision

### User Story

As a curator who saves items to a Telegram inbox channel, I want each saved item to automatically become a well-structured editorial story in Notion, so that I spend my time refining stories instead of manually formatting them.

### Acceptance Criteria

- New Telegram messages in the inbox channel are detected in real time via GramJS
- Multi-photo albums are grouped into a single item (10s debounce)
- URLs are fetched and article content extracted (readability)
- The configured story model writes structured stories in the user's story language (English by default, `UserSettings.storyLanguage`) following the editorial policy
- Stories are saved to the configured Notion database with the expected properties
- Duplicate/related items are detected and merged into existing stories
- Re-sending the same URL is instantly deduplicated via a URL exact-match shortcut, bypassing AI
- Items about the same versioned product (e.g. "Claude 5", "Gemini 3.1 Pro") are instantly deduplicated via a versioned-entity shortcut, bypassing AI and working across languages
- Cyrillic-language titles are correctly compared by the Jaccard pre-filter
- Cyrillic proper nouns and acronym brands (`OpenAI`, `GPT`, `ИИ`) contribute to the key-entity signal, and the candidate side reads material titles
- Re-processing a story updates its existing Notion page instead of creating a duplicate
- Related past materials from an optional external PostgreSQL archive are linked via pgvector search
- Dashboard shows stories, pipeline status, and error states
- Worker health is monitored (GramJS connected, DB reachable, poll freshness)
- Errors are retried (max 3 attempts) and surfaced in UI
- All Telegram post formats are handled: photos, albums, videos, GIF, polls, documents
- Photos and documents are downloaded to R2 with a concurrency-limited batch downloader
- AI prompt includes media context ("X image(s), Y video(s)")
- Notion pages carry every member post's and inbox item's media, uncapped: the cover image first, the rest at the bottom after a divider, each as the block that plays it (image, video, embed, audio, pdf, file)
- Poll text is extracted and passed to the AI writer
- YouTube URLs are detected and transcripts extracted via the InnerTube API; the AI writer uses `video` materialType and summarizes the transcript, with a graceful fallback to metadata-only when no transcript is available

### UX Principles

- **Zero-touch happy path:** Save to Telegram, story appears in Notion. No manual steps.
- **Editor-first workflow:** Stories land as "suggested" in Notion. The editor retains full control over the editorial pipeline.
- **Transparent AI:** AI reasoning and rubric choices are visible. Override via Settings UI.
- **Graceful degradation:** If the external archive DB is unreachable, the story publishes without "See also" links. If Notion fails, the story is saved locally and retried.

### Out of Scope

- Automated publishing (stories always require editor review)
- Multi-user inbox channels (single editor per channel)
- Bot API integration (uses a GramJS user session, not a bot token)
- Video transcription for non-YouTube content (media is stored, but general video content is not transcribed)
- Custom Notion database schemas (works with the configured inbox database)

---

## Implementation

### Current Architecture

```
lib/story-aggregator/
├── schemas.ts            # Zod validation schemas, rubric constants
├── content-extractor.ts  # URL/text content extraction (Readability + linkedom + YouTube transcript)
├── notion-builder.ts     # Notion page properties + block construction (cover + trailing media from lib/notion-media.ts)
├── notion-page-update.ts # Re-publish onto an existing page: properties → list old ids → append new → delete old
├── album-grouper.ts      # Telegram album debounce/merge (10s window, sorted by messageId)
├── story-writer.ts       # Story-model prompt building + output validation + media context
├── processing-queue.ts   # Sequential queue (concurrency=1) + retry utility
├── health-check.ts       # Worker health monitoring (GramJS, DB, poll freshness)
├── pipeline.ts           # Full pipeline orchestrator (extract → write → match → Notion → archive link)
├── notion-client.ts      # @notionhq/client wrapper with block batching + rate limiting
├── retry-daemon.ts       # Periodic retry of ERROR items (15-min interval, max 3 attempts)
├── worker.ts             # GramJS listener, catch-up, SIGTERM handler, queue wiring
├── worker-helpers.ts     # extractPollText, downloadMessageMedia, downloadMediaBatch
├── story-matcher.ts      # Pre-filter (multi-signal) + AI match confirmation; matchContent() for content-based matching without DB fetch
├── material-story-pipeline.ts  # processApprovedMaterials() — links approved Materials to stories (model: STAGE_DEFAULTS.materialStory)
├── pipeline-deps.ts      # buildPipelineDeps() + buildMaterialStoryDeps() factories
├── archive-linker.ts    # Optional external archive search (OpenAI text-embedding-3-small + pgvector "See also"; env-gated)
├── heartbeat.ts          # Daily Telegram summary + error alerts
├── stories-api.ts        # Data layer for stories list/detail API
├── message-handler.ts    # GramJS NewMessage event handler → AlbumGrouper → queue
├── data-retention.ts     # cleanStaleContent (30d), archiveOldItems (90d), runRetention orchestrator
├── mime-validation.ts    # MIME allowlist, validateMediaUpload, getMimeTypeFromExtension
├── telegram-deleter.ts   # Auto-delete inbox messages from Telegram after confirmed Notion save (opt-in)
├── gap-scan.ts           # Scan the Telegram channel for missed messages, ingest gaps (limit 100, max 20)
├── ai-limits.ts          # Timeouts and retry budget for the story AI calls (model resolution lives in lib/models/registry.ts)
├── gramjs-client.ts      # GramJS connect/cleanup helpers (a failed connect destroys the client)
├── gramjs-errors.ts      # Dependency-free GramJS error vocabulary and classifier
├── gramjs-lifecycle.ts   # Single owner of the GramJS session lifecycle (one restart at a time)
├── gramjs-lock.ts        # Cross-process GramJS session lock (one worker per session)
└── dissolve-single-material-stories.ts  # Backfill: dissolve auto-created single-material stories
```

### Module Dependency Graph

```
schemas.ts ◄──────── story-writer.ts ◄─── pipeline.ts
    ▲                      │                    │
    │                      ▼                    ├── content-extractor.ts
    └──────── notion-builder.ts ◄── notion-client.ts
                                                │
                                        story-matcher.ts (AI match confirmation)
                                        archive-linker.ts (pgvector)

worker.ts
  ├── worker-helpers.ts (extractPollText, downloadMessageMedia, downloadMediaBatch)
  └── message-handler.ts → album-grouper.ts → processing-queue.ts → pipeline.ts

content-extractor.ts    (standalone — @mozilla/readability, linkedom, youtube-transcript-plus)
album-grouper.ts        (standalone — pure TypeScript)
worker-helpers.ts       (standalone — GramJS media download + poll extraction)
processing-queue.ts     (standalone — pure TypeScript)
health-check.ts         (standalone — pure TypeScript)
retry-daemon.ts         (standalone — reads DB, calls pipeline)
telegram-deleter.ts     (standalone — GramJS client, never-throws)
heartbeat.ts            (standalone — Telegram Bot API)
stories-api.ts          (standalone — Prisma queries)
data-retention.ts       (standalone — Prisma queries, retention orchestrator)
mime-validation.ts      (standalone — pure TypeScript, MIME allowlist)
material-story-pipeline.ts (standalone — processApprovedMaterials, calls story-matcher + story-writer + DB)
pipeline-deps.ts        (standalone — dependency factories for both pipelines)
archive-linker.ts     (standalone — optional external archive + pgvector, never-throws)
```

`pipeline.ts` is the central orchestrator for the Telegram inbox pipeline. `material-story-pipeline.ts` is the parallel orchestrator for the approved-materials pipeline. `worker.ts` bootstraps the GramJS listener and wires everything together at startup.

### Data Contracts

**Zod Schemas (validated at runtime):**

| Schema | Purpose | Key Constraints |
|--------|---------|-----------------|
| `StoryOutputSchema` | Story-model JSON output | `languageFlag`: GB/RU, `rubrics`: 1-2 items, 6 enum fields |
| `ArchiveLinkSchema` | Related past material | `similarity`: 0-1, `url`: valid URL |
| `InboxItemCreateSchema` | New inbox item | `externalId`: `-channelId:messageId` pattern |
| `StoryMatchSchema` | AI match output | `isMatch`: boolean, `confidence`: 0-1, `reasoning`: string |

**Interfaces:**

| Interface | Module | Fields |
|-----------|--------|--------|
| `ExtractedContent` | content-extractor | title, content, ogImage, author (all nullable) |
| `StoryForNotion` | notion-builder | title, languageFlag, summary, body, keyPoints, sourceUrls, rubrics, archiveLinks, media (`{url, kind}[]` from `storyDetailMedia`) |
| `TelegramMessage` | album-grouper | messageId, groupedId, text, mediaUrl, date |
| `GroupedMessage` | album-grouper | messageIds[], primaryMessageId, text, mediaUrls[], groupedId, date |
| `InboxItemForStory` | story-writer | rawText, extractedTitle, extractedContent, sourceChannel, extractedUrl, mediaUrls, telegramPostUrl (optional), allMessageIds (optional) |
| `StoryWriterResult` | story-writer | success, story (or null), error (or null) |
| `HealthStatus` | health-check | status (ok/degraded/error), gramjs, database, lastPollAgo, lastPollStale, pendingItems, uptime, errors[] |
| `StoryMatchResult` | story-matcher | matchedStoryId (or null), confidence, reasoning |
| `ArchiveLink` | archive-linker | url, title, similarity, publishedAt |
| `PipelineDeps` | pipeline | saveToNotion, updateNotionPage? (optional), matchItem, archiveLinker |
| `MaterialStoryDeps` | material-story-pipeline | matchContent, writeStory, db |

**Classes:**

| Class | Module | Key API |
|-------|--------|---------|
| `AlbumGrouper` | album-grouper | `add(msg)` -> `Promise<GroupedMessage \| null>` (null for non-primary album messages), `flushAll()`, `pendingCount` |
| `ProcessingQueue<T>` | processing-queue | `enqueue(item)`, `drain()`, `shutdown()`, `size`, `isProcessing` |
| `WorkerHealthCheck` | health-check | `setGramjsConnected()`, `setDatabaseReachable()`, `recordSuccessfulPoll()`, `getStatus()` |

### Nonfunctional Characteristics

| Characteristic | Requirement | Implementation |
|----------------|-------------|----------------|
| **Concurrency** | Sequential processing (no race conditions) | `ProcessingQueue` with concurrency=1 |
| **Retry** | Max 3 retries per item | `withRetry(fn, { maxRetries: 3 })` |
| **Album debounce** | 10-second window for grouped messages | `AlbumGrouper` with configurable debounce |
| **Content cap** | 5,000 characters max for AI input (articles); 12,000 characters for YouTube transcripts (~30 min) | `truncateContent()` with word-boundary truncation; `YOUTUBE_TRANSCRIPT_MAX_LENGTH = 12000` |
| **Health check** | Detect stale polls within 5 minutes | `WorkerHealthCheck` with 300s threshold |
| **Graceful shutdown** | Flush pending items on SIGTERM; release the GramJS session before a replacement container connects | `client.destroy()` first (3 s await), then `AlbumGrouper.flushAll()` + `ProcessingQueue.shutdown()` + `db.$disconnect()` |
| **Prompt injection** | User content wrapped in XML tags | `<user_content>` delimiters in `buildStoryUserContent()` |
| **Rubric validation** | Only known rubrics written to Notion | `validateRubrics()` filters against the rubric allowlist in `schemas.ts` |
| **Never-throw** | Content extraction and deletion never throw | `extractContentFromUrl()` returns nulls on any error; `deleteInboxMessages()` catches all errors internally |
| **Opt-in deletion** | Auto-delete is off by default | `UserSettings.autoDeleteTelegramMessages = false`; user enables via Settings toggle |
| **Admin isolation** | Only an admin user configures inbox/Notion; the worker monitors the admin channel only | API 403 guard + worker `findFirst` with a `user.role = "ADMIN"` filter |

### Admin Isolation

Story Aggregator settings are ADMIN-only at every layer:

**Admin-only `UserSettings` fields:**
- `storyInboxChannelId` — Telegram channel to monitor
- `storyNotionDatabaseId` — Notion database for story output
- `autoDeleteTelegramMessages` — delete inbox messages after Notion save

**API guard (`PUT /api/user-settings`):** Returns 403 if a non-ADMIN user attempts to set any of these three fields, so the restriction is enforced server-side, not only by hiding the UI.

**Worker admin filter (`setupGramJS()` in `worker.ts`):** Uses `db.userSettings.findFirst({ where: { storyInboxChannelId: { not: null }, user: { role: "ADMIN" } } })` — without the role filter, a non-admin user who somehow obtained `storyInboxChannelId` could have caused the worker to monitor the wrong channel.

**UI:** "AI Settings" and "Stories" settings sections are hidden for non-admin users. The navigation sidebar filters items by role. Regular users see only "Integrations" (Notion for materials) and "Danger Zone".

### Testing

**Framework:** Vitest (config: `vitest.config.ts`)
**Run:** `npx vitest run __tests__/story-aggregator/ --reporter=verbose`

**Coverage approach:** Unit tests cover all pure business logic. Integration boundaries (DB, GramJS, Notion API, AI providers) are covered via mocks. End-to-end verification is manual: one Telegram message produces one Notion page.

### Related Materials


---

## Behavior Details

### Telegram ingestion

- **Album grouping:** Multi-photo albums group on a 10-second debounce; messages are sorted ascending by `messageId` before merging so photo order is deterministic. Only the primary message resolver receives the grouped result — the others get `null`, so duplicate stories are not created.
- **Catch-up:** On startup the worker feeds all missed messages to the grouper and calls `flushAll()` once, rather than awaiting each `add()` individually.
- **Media download (allowlist):** The real-time handler and the catch-up loop download `MessageMediaPhoto` and `MessageMediaDocument`; other media types are skipped gracefully. Documents larger than 50 MB are skipped before download, but their presence is still noted in the AI prompt. The catch-up batch downloader runs up to 5 downloads in parallel (p-limit).
- **Poll text:** `extractPollText` formats poll messages as `[Опрос] Question?\n1. Answer A\n2. Answer B` and stores them in `rawText`.
- **Entity URLs:** `extractTextWithEntityUrls()` extracts URLs from Telegram `MessageEntityTextUrl` entities.
- **Gap scan:** `gap-scan.ts` scans the channel for messages missed during downtime (`GAP_SCAN_LIMIT = 100` scanned, `GAP_SCAN_MAX_INGEST = 20` ingested) and back-fills them.
- **AI media context:** the story prompt appends "Attached media: X image(s), Y video(s)" when `mediaUrls` are present; `classifyMediaUrl` infers the media type from the URL.
- **Notion media blocks (RAD-401):** `publishToNotion()` loads the story's member posts (`title`, `thumbnailUrl`, `mediaUrls`, `feed.type`; `createdAt` desc, as the story page does) and its inbox items (`createdAt` asc) and builds `StoryForNotion.media` with `storyDetailMedia` — visual entries, then files. Inbox `mediaUrls` whose kind is `"unknown"` (article pages, as a rule) are dropped first; inbox thumbnails stay even when extensionless. `lib/notion-media.ts` maps each kind onto a block: `image` → image, `video` → video, `embed` → video for a single YouTube video (`/watch?v=`, `/embed/<id>`, `youtu.be/<id>`) and a generic `embed` for anything else (Shorts, live, playlists, Vimeo), `audio` → audio, `document` → pdf when the path ends `.pdf`, else file; placeholders and unknown kinds get no block. No caps. The first image is the cover (top of the page); everything else follows the last section after a divider. Every URL is normalised first — trimmed, parsed, http(s) only, sent as the encoded `href` — and an entry whose href exceeds 2000 characters is skipped: Notion rejects such a URL and fails the whole request. Pages over 100 blocks are created with the first 100 and appended in batches.
- **Re-publish:** `updateNotionPage` (`notion-page-update.ts`, shared by the worker and the API routes) appends the new blocks before deleting the old ones, so a failed append leaves the previous content instead of an empty page; batches that landed before the failure are removed again; old-block deletes retry 429/5xx, count archived/not-found as done, stop on 401/403, and reject if a block is still left so the next re-publish cleans it (RAD-403).

Telegram format coverage:

| Format | Status |
|--------|--------|
| Text, Text+URL | Handled |
| Photos (single) | Downloaded to R2 |
| Photo albums | Each downloaded, sorted by messageId |
| Video ≤50MB | Downloaded to R2 |
| Video >50MB | Skipped, noted in AI prompt |
| GIF/Animation | `MessageMediaDocument` allowlist |
| Polls | `extractPollText` |
| Documents/PDF | `MessageMediaDocument` allowlist |
| Web preview | URL extracted from the webpage |
| Voice/Sticker/Dice/etc | Skipped gracefully |

### Story matching & deduplication

- **URL exact-match shortcut** — `matchItem()` normalizes and compares `extractedUrl` against all existing story `sourceUrls` before calling the AI. A match bypasses AI entirely — instant and free. Normalization: lowercase, strip trailing slash, strip `www.` prefix, strip fragment.
- **Versioned-entity shortcut** — `extractVersionedEntities()` extracts product names with version numbers from the new item's `title` + `rawText` and from candidate story titles (`materialTitles` included). Recognizes patterns like "Claude 5", "Gemini 3.1 Pro", "Seedance 2.0". Known product qualifiers (Pro, Flash, Ultra, Max, Mini, Plus, Lite, Turbo, Advanced, Standard, Basic, Premium, Enterprise, Edge) are preserved to distinguish variants. Generic structural terms ("Figure N", "Step N", "Version N", "Chapter N") are filtered as false positives. An entity match returns immediately, without an AI call, and works across languages (English item vs Russian story title).
- **Cyrillic-aware tokenizer** — the tokenizer regex includes `а-яё`; 30+ Russian stop words (с, и, в, на, о, по, из, за, etc.) are filtered. The Jaccard pre-filter therefore works correctly for Cyrillic titles.
- **Multi-signal pre-filter scoring** — replaces title-only Jaccard. Signals and weights: title overlap (0.35), content overlap (0.15), entity overlap (0.40), domain bonus (0.10). Entity overlap uses `extractKeyEntities()` output; the domain bonus fires when source domains match.
- **`extractKeyEntities()`** — extracts proper nouns (capitalized tokens), version strings via `extractVersionedEntities()`, and 2+ digit numbers. Designed for cross-language matching. Cyrillic proper nouns and acronyms, inner-capital brands (`OpenAI`, `MacBook`, `iOS`), generic-abbreviation skips, and candidate entity text that reads material titles are all included.
- **Adaptive candidate count** — candidate count scales with corpus size: ≤20 stories → all pass to AI; ≤50 → top 25; >50 → top 15. Reduces unnecessary AI calls on large story archives.
- **Zero-score fallback** — when all candidates score 0 (typical for cross-language pairs with no shared tokens), the top 5 stories by recency are sent to AI instead of returning "no match" without consultation.
- **Material titles in story candidates** — the story query loads `materialTitles`; the pre-filter and the AI matching prompt both see original article titles alongside the story title, improving recall for stories with generic titles.
- **URLs in the matching prompt** — `buildMatchingPrompt()` includes `sourceUrl`/`sourceUrls` and a rule stating a URL match always means the same story.
- **Reader-centric matching heuristic** (`buildMatchingPrompt()` in `story-writer.ts`) — instead of strict same-event/same-topic criteria: "would a reader feel this is redundant?" SAME: same event; commentary without new actionable info; same topic in different languages. DIFFERENT: follow-up with significant new developments (security issue, recall); truly distinct topics sharing a category (e.g. "Dark mode in Figma" vs "Dark mode in VS Code"); different product qualifiers or versions.
- **Media-only posts** — `extractAndSave()` dispatches in three branches: (1) `extractedUrl` present → fetch from the URL; (2) `rawText` present → extract from text; (3) media only → synthesize a descriptive body with a `"Media album: N image(s), N video(s)"` title so the AI can produce a usable story instead of `<UNKNOWN>`. Truly empty items → status `NO_CONTENT`. When `telegramPostUrl` is set, `buildStoryUserContent()` emits a `"Telegram post: <URL>"` line.

### Notion output

The story goes into the database configured in `storyNotionDatabaseId`. Properties written by `buildNotionProperties()` (`lib/story-aggregator/notion-builder.ts`):

| Property | Notion type | Written value |
|---|---|---|
| `Name` | title | the story title, as generated (no language-flag prefix) |
| `Ссылка` | url | the story's primary source URL, or empty when it has none |
| `Рубрика` | multi-select | the generated rubrics, filtered by the allowlist (`VALID_RUBRICS` in `schemas.ts`) |
| `AI summary` | rich text | the one-to-two sentence summary |

`Status` (select) is read, never written: any value means an editor has taken the page over, and `updateStoryPage` leaves it alone from then on. The pipeline's own lifecycle lives in the database (`StoryStatus`: `DRAFT` while processing, `SENT_TO_NOTION` after a successful save, `ERROR` after three failed attempts), not in Notion.

The page body follows the same schema: the first accepted image as the cover, the title as a `heading_2`, the body as paragraphs, then `Главные мысли` (`heading_3`) over the key points, `Источники` (`heading_3`) over one bookmark per source URL, an optional `Из архива` ("From the archive") section with the archive links, and the remaining media after a final divider. Rubric values come from `STORY_RUBRICS` (comma-separated) or the generic default list (`lib/story-aggregator/schemas.ts`).

- **Language flags:** `languageFlag` (GB/RU) is generated and stored, but no flag emojis are rendered in Notion titles or in the web UI.
- **Archive links (optional):** when `ARCHIVE_DATABASE_URL` is configured, related past materials from an optional external PostgreSQL archive are appended as a "See also" section — OpenAI `text-embedding-3-small` + pgvector similarity, cosine threshold 0.3, max 5 links. The linker is non-blocking: if the archive is unreachable, the story publishes without "See also" links.

### YouTube transcript extraction

- **`isYouTubeUrl(url)`** — detects all YouTube URL variants: `youtube.com/watch?v=`, `/shorts/`, `/live/`, and `youtu.be/` shortlinks. Case-insensitive, handles the `m.` mobile subdomain.
- **`extractVideoId(url)`** — extracts the 11-character video ID from any supported URL format; returns `null` for non-YouTube URLs.
- **Metadata** — title, author (channel name) and thumbnail are fetched via the public `youtube.com/oembed` endpoint (no API key; the inner URL is `encodeURIComponent`-encoded when building the request).
- **Transcript** — fetched via `youtube-transcript-plus` (InnerTube ANDROID client API, not watch-page scraping); segments are joined into plain text and HTML entities are decoded (`&amp;`, `&#39;`, `&quot;`, `&#NNN;`, `&#xHHH;`, `&nbsp;`). Returns `null` when captions are disabled or unavailable; failures are logged to stderr: `[YouTube] Transcript fetch failed for <videoId>: <error message>`. The YouTube primitives live in `lib/youtube.ts` and are shared with the YouTube feed parser.
- **`extractContentFromYouTube(url)`** — orchestrates metadata + transcript fetching in parallel (`Promise.all`). The transcript is truncated to `YOUTUBE_TRANSCRIPT_MAX_LENGTH = 12000` characters (~30 min of video) at a word boundary. Content format: header (`Video: …` / `Channel: …`) + transcript, with a graceful fallback note when no transcript was available. Never throws — returns nulls on any error.
- **Routing** — the YouTube check runs after the tweet check and before the Readability fallback in `extractContentFromUrl()`.
- **Editorial prompt** — a "YouTube videos" section instructs the writer to use `materialType "video"`, summarize transcript key points (not quote verbatim), mention the channel name, and note when no transcript was available.

### Auto-delete of Telegram inbox messages (opt-in)

Opt-in feature that auto-deletes Telegram inbox messages after the pipeline confirms the story was saved to Notion. Deletion is handled by `telegram-deleter.ts` and triggered via the `onPipelineSuccess()` hook in both `processing-queue.ts` and `retry-daemon.ts`.

- **`deleteInboxMessages(client, messageIds, channelId)`** sends `DeleteMessagesRequest` for up to 100 message IDs at a time. Never throws — all errors are caught internally. `telegramDeletedAt` is written to `InboxItem` on success as an audit trail and idempotency guard.
- **Six safety guards** — deletion is skipped unless ALL of the following hold: (1) `UserSettings.autoDeleteTelegramMessages === true`; (2) `item.status === "PROCESSED"`; (3) `item.notionPageId` is non-null; (4) `item.telegramDeletedAt` is null (idempotency); (5) `item.allMessageIds` is non-empty (legacy items with `[]` are skipped); (6) the GramJS client is connected.
- **Schema:** `InboxItem.allMessageIds Int[]` (all message IDs in an album group, populated at ingest) and `InboxItem.telegramDeletedAt DateTime?` (set on successful deletion); `UserSettings.autoDeleteTelegramMessages Boolean @default(false)`; all three arrive in one additive migration.
- **UI/API:** admin-only. Settings → Stories has an "Auto-delete from Telegram" section with a "Delete after saving to Notion" switch (off by default), rendered for admins only; `PUT /api/user-settings` accepts `autoDeleteTelegramMessages: boolean`, answers 403 when a non-admin sets it to `true` (a `false`/`null` is stripped silently), and validates the channel ID format on update.

### Story aggregation in posts

Approved materials from the posts pipeline are automatically grouped into stories when they cover the same topic. Matching and writing both run on the `materialStory` stage model — overridable per user via `UserSettings.materialStoryModel` — constructed by `lib/models/provider.ts`. Stories appear inline in the materials list as stacked cards (2-3 sources) or wide double-width cards (4+ sources).

**Architecture:**

```
Parse → AI Filter → APPROVED materials
                          ↓
              POST /api/posts/group-stories
                          ↓
              processApprovedMaterials()
              matchContent() scores existing stories + standalone posts in one pass
              (URL match → versioned entity → Jaccard → AI; requireSignal skips AI on no signal)
              ├─ Matches an existing story  → link material + regenerate story
              ├─ Matches another standalone → form a NEW 2-post story (atomic $transaction)
              └─ No match                   → leave standalone (renders verbatim)
```

**A lone post never becomes a single-material story** — that is what made the feed render AI summaries instead of original posts. Stories form only from genuine ≥2-post clusters; the sole exception is the explicit manual "send to stories" action (`allowSingletonStory`). Pre-existing auto single-material stories can be reverted with `POST /api/admin/dissolve-single-material-stories` (`?scope=self|all`).

**Backend:**

- **`Material.storyId`** — FK to `Story`; links a material to its aggregated story; **`Material.storyMatchedAt`** records when the material was matched.
- **`matchContent()`** (`story-matcher.ts`) — content-based matching without a DB fetch; accepts raw title + text and returns `StoryMatchResult`. Used by the materials pipeline to avoid loading all stories for each candidate.
- **`buildStoryUserContent()` `sourceType` field** (`story-writer.ts`) — accepts `"rss" | "twitter" | "telegram"` to produce correct source labels in the AI prompt.
- **`updateExistingStory()` cross-pipeline** (`pipeline.ts`) — queries both `InboxItem` and `Material` tables when regenerating a story, so stories fed from both sources stay up to date.
- **`material-story-pipeline.ts`** — `processApprovedMaterials(materialIds, userId, deps, opts?)` runs the cluster-or-standalone flow: join a matching story, pair with a matching standalone post into a new 2-post story (atomic — `$transaction` + conditional `updateMany({ storyId: null })`), or leave standalone. `opts.allowSingletonStory` (manual path only) permits a single-material story. The candidate pool is a global, bounded DB query (APPROVED, unlinked, non-hidden feeds, excludes DELETED/ARCHIVED).
- **`dissolveSingleMaterialStories()`** + **`POST /api/admin/dissolve-single-material-stories`** (`?scope=self|all`, ADMIN) — backfill that reverts auto-created single-material stories, sparing Notion-exported, manually-sent, inbox-backed and multi-source stories.
- **`buildMaterialStoryDeps()`** (`pipeline-deps.ts`) — factory that wires the configured provider into `MaterialStoryDeps`.
- **`POST /api/posts/group-stories`** — manual trigger endpoint; also called automatically after parse completes.
- **Parse stream returns `approvedMaterialIds`** so the client can trigger grouping immediately after parse.
- **PATCH handler auto-trigger** — manual approval of FILTERED materials triggers story matching for the approved item.

**Frontend:**

- **`story-card.tsx`** — two variants: stacked (2-3 sources) and wide/double-width (4+ sources). Action buttons (Like/Dislike, Archive/Restore, Delete) propagate to all constituent materials via batch API calls with `Promise.allSettled` partial-failure resilience.
- **Materials list story grouping** — materials with the same `storyId` are grouped and rendered as a story card inline in the list. Batch handlers (`handleStoryArchive`, `handleStoryDelete`, `handleStoryRestore`) live in `materials-list.tsx`.
- **Date interleaving** — stories always interleave with posts by date; there is no separate "Stories" filter chip. `/stories` redirects to `/posts`.
- **Story card feedback** — Like/Dislike submits feedback for the primary material via `MaterialFeedbackButtons`, then propagates to the remaining materials. Dislike auto-archives the entire story.

### Configurable models & OpenRouter

All story model selectors support both Anthropic and Gemini/OpenRouter models; no models are hardcoded. Stage defaults live in `lib/models/registry.ts` (`STAGE_DEFAULTS`).

- **`UserSettings.materialStoryModel String?`** — per-user model for story generation; null falls back to the system default.
- **`createModelForId(modelId)`** — shared factory that builds an AI SDK model instance for any supported ID.
- **`isOpenRouterModel(modelId)`** — returns `true` when `modelId` contains `/`; routes the call through the OpenRouter adapter instead of Anthropic directly.
- **OpenRouter adapter** — provider `@ai-sdk/openai` pointed at `https://openrouter.ai/api/v1`; env var `OPENROUTER_API_KEY`; model IDs like `google/gemini-2.5-flash`.
- **Worker wiring** — `worker.ts` builds its dependencies through the same routing helper (`createModelInstance`), so the story writer and matcher both honour an OpenRouter model ID set in user settings.

### Refilter materials

Re-evaluates existing materials against updated AI rules without re-parsing sources.

- **`lib/refilter-materials.ts`** — `refilterMaterials(userId, onProgress)`: iterates all non-archived materials and re-runs AI evaluation with the current rules; skips SENT_TO_STORIES and SENT_TO_NOTION to preserve user overrides.
- **`GET /api/posts/refilter`** — SSE endpoint; streams `{"processed": N, "total": M}` events; stops on client disconnect via `request.signal` abort.

### Data retention & API surface

- **Retention:** `data-retention.ts` — `cleanStaleContent` strips `extractedContent` from PROCESSED items after 30 days; `archiveOldItems` archives PROCESSED items after 90 days; `runRetention` orchestrates both. `POST /api/stories/retention` triggers the policy; `DELETE /api/stories/[id]` deletes a story and unlinks its inbox items.
- **Stories API:** `GET /api/stories`, `GET /api/stories/[id]`, `POST /api/stories/poll`. The stories list polls `GET /api/stories` every 30 seconds; the response includes `pendingCount`, `errorCount`, and `processedToday` for the pipeline status bar.

### Migrations

- **Models:** `InboxItem` — raw Telegram messages with status tracking; `Story` — editorial stories with Notion sync.
- **Enums:** `InboxItemStatus` — PENDING / EXTRACTING / EXTRACTED / MATCHED / PROCESSED / ERROR; `StoryStatus` — DRAFT / SENT_TO_NOTION / ERROR.
- **`UserSettings`:** `storyInboxChannelId`, `storyNotionDatabaseId`, `storyLastMessageId`, `storySystemPrompt`, `storyPromptVersion`, `autoDeleteTelegramMessages`, `materialStoryModel`.
- **`InboxItem`:** `allMessageIds Int[]`, `telegramDeletedAt DateTime?`.
- **`Material`:** `storyId String?` (FK to `Story`), `storyMatchedAt DateTime?`.
- **Migration strategy:** `prisma migrate deploy` (not `db push`) for production safety.

---

## Known Issues

| ID | Type | Priority | Status | Description |
|----|------|----------|--------|-------------|
| #1 | gap | high | **fixed** | **No Prisma schema.** Resolved: `InboxItem`, `Story` models + migration applied. |
| #2 | gap | high | **fixed** | **No worker entry point.** Resolved: `worker.ts` wires GramJS → AlbumGrouper → queue → pipeline. |
| #3 | gap | medium | **improved** | **No integration tests.** Unit tests cover all modules via mocks; true end-to-end verification is manual. |
| #4 | risk | medium | accepted | **Telegram session string in plaintext.** Stored in DB without encryption. Mitigated by database encryption at rest. Future: AES-256-GCM at the application layer. |
| #5 | risk | medium | accepted | **Notion token in plaintext.** Same as #4 — accepted with database encryption at rest. |
| #6 | debt | low | open | **Rubric allowlist hardcoded.** The rubric list is a constant in `schemas.ts`. If the target Notion rubrics change, code must be updated. Future: fetch rubrics from the Notion DB dynamically. |
| #7 | gap | medium | **fixed** | **No API routes.** Resolved: `GET /api/stories`, `GET /api/stories/[id]`, `POST /api/stories/poll`. |
| #8 | gap | low | **fixed** | **No full dashboard UI.** Resolved: stories search (title/summary/rubrics/URLs), enriched pipeline status bar with today/week counts, Settings UI, DELETE endpoint. |
| #9 | risk | low | accepted | **Content extraction fragile for SPAs.** `@mozilla/readability` cannot extract from JavaScript-rendered pages. Accepted — most design articles are server-rendered. |
| #10 | debt | low | **closed** | **Test count discrepancy.** Closed — `npx vitest run` is the single source of truth; this document does not track test counts. |
| #11 | bug | high | **fixed** | **Worker not running on a deploy.** The supported container entrypoint is `sh scripts/start.sh`: it runs as PID 1, installs a SIGTERM/SIGINT trap, forwards the signal to both the story-aggregator worker and Next.js, and waits for both to exit. The previous inline backgrounding form dropped SIGTERM, so the worker's `shutdown()` never ran and the GramJS client was never destroyed. |
| #12 | bug | high | **fixed** | **saveToNotion used wrong user settings.** `buildPipelineDeps()` now requires a `userId` parameter. `saveToNotion` uses `@notionhq/client` with properly scoped user settings. The poll route reads the Notion token from user settings instead of an env var. |
| #13 | bug | medium | **fixed** | **ingestMessage read from a non-existent env var.** `ingestMessage` now receives `channelId` as a parameter. The heartbeat also reads the channel from the DB. |
| #14 | bug | medium | **fixed** | **Notion property names were Latin transliterations.** All Notion property names, rubric names, status values and block headings were updated to match the target database schema exactly. |
| #15 | bug | low | **fixed** | **Language flag emojis in Notion titles.** `formatNotionTitle` no longer prepends flag emojis to titles. The `languageFlag` field is still generated and stored in the DB but not rendered in Notion. |
| #16 | bug | high | **fixed** | **Album grouper created duplicate stories.** `AlbumGrouper.add()` returned the grouped result to all resolvers in the same album. Now returns `GroupedMessage \| null` — only the first (primary) resolver gets the result; others get null, and the real-time handler skips null results. |
| #17 | bug | medium | **fixed** | **Catch-up loop awaited each add() call individually.** Sequential awaiting caused incorrect debounce behavior during startup catch-up. Fixed: the loop feeds all messages to the grouper, then calls `flushAll()` once to drain all pending groups. |
| #18 | enhancement | low | **fixed** | **Stories page required manual refresh.** The stories list now polls `GET /api/stories` every 30 seconds. Pipeline counts (`pendingCount`, `errorCount`, `processedToday`) are included in the API response. |
| #19 | debt | low | **fixed** | **Flag emojis still shown in the web UI.** `FLAG_EMOJIS` removed from `stories-list.tsx` and `story-detail.tsx`; language flags are no longer displayed in the web interface. |
| #20 | gap | high | **fixed** | **Media-only Telegram posts (photos, video, GIF, polls, documents) were not downloaded.** `worker-helpers.ts` added with `downloadMessageMedia` (allowlist: MessageMediaPhoto, MessageMediaDocument) and `downloadMediaBatch` (5 parallel). Integrated into the real-time handler and the catch-up loop. |
| #27 | bug | high | **fixed** | **Same-URL items created duplicate stories.** Re-sending an already-saved link with a different Cyrillic comment produced a second story. Fixed: URL exact-match shortcut in `matchItem()` — if `extractedUrl` matches any existing story's `sourceUrls`, return an immediate match without calling the AI. |
| #28 | gap | medium | **fixed** | **AI matching prompt contained no URLs.** The matcher could not detect that two items linked to the same URL when the text was ambiguous. Fixed: `buildMatchingPrompt()` now includes `sourceUrl`/`sourceUrls` and a rule stating URL match always means the same story. |
| #29 | gap | medium | **fixed** | **Versioned product items (e.g. "Gemini 3.1 Pro release", "Claude 5 announced") created duplicate stories when titles were in different languages or phrased differently.** Fixed: `extractVersionedEntities()` extracts versioned product names from the new item's title+rawText and existing story titles; the entity shortcut in `matchItem()` returns an immediate match — no AI call. False positives like "Figure 3" are filtered via a stop-word list. `buildMatchingPrompt()` strengthened with product-version and cross-language matching rules. |
| #30 | bug | high | **fixed** | **AUTH_KEY_DUPLICATED on rolling deploys.** Old and new containers overlapped with the same active GramJS session, permanently invalidating it. Fixed: (1) `client.destroy()` moved to step 1 of the SIGTERM handler (3 s await); (2) `disconnect()` replaced with `destroy()` in all 3 call sites; (3) default startup delay raised to 30 s; (4) an `AUTH_KEY_DUPLICATED` circuit-breaker in `attemptReconnect()` stops the retry loop immediately on permanent invalidation. See [TELEGRAM_SETUP.md](TELEGRAM_SETUP.md) pitfall #8 for full analysis. |
