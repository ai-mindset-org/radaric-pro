# Knowledge Base — Save → Collections → Living answer → Self-filling (tracked questions)

## Metadata
- **ID:** FEAT-KNOWLEDGE-BASE
- **Status:** implemented — Save + collections + Library, the living answer, and the self-filling loop (Track-a-question → routing → source discovery → cadence freshness floor). The core question-shaped-subscription machine: *state a thesis → autonomous multi-source collection → self-maintaining cited answer.*
- **Updated:** 2026-06-15
- **Not yet built:** notification/delivery (the "subscription" half — pull the user back when the answer materially changes) and an evolution-over-time view (history of deltas). The synthesis quality is not yet proven on real populated content.

---

## Vision

A per-user **save** loop, distinct from Like/Dislike. Like/Dislike is the *machine's* judgment (a relevance signal for the AI filter); **Save** is the *user's own* judgment — "this is worth keeping / will be useful later." Saved items accumulate into topic-collections that become a personal knowledge base, and each collection is the seed of a future **question-shaped subscription** (a maintained, provenance-first "living answer").

The loop:

> Save (whole material or a highlighted excerpt) → topic-collection knowledge base → question-shaped synthesis (provenance-first) → better filtering → more saves.

### Why a feature, not a standalone bot
Folding question-shaped subscriptions into Radaric as a feature — aimed at the existing curator/analyst customer rather than a new standalone product, built provenance-first — builds the one durable moat: a **non-portable, compounding, per-user knowledge base.**

### Self-filling collections (tracked questions) — Slice 1
The original loop only filled a collection from **manual** saves. A self-filling collection closes the acquisition gap: the user states a question (a natural-language query + cadence) and Radaric **autonomously collects sources and maintains the living answer** — no manual saving required.

> **Track a question** → a backing Parallel **monitor** runs on the chosen cadence → each new APPROVED batch arms the collection → the worker regenerates the cited living answer on a trailing-edge debounce.

Mechanically, a tracked question is a `Collection` with a `query` + `cadence`, backed 1:1 by a **hidden** `EVENT_TRIGGER` `Feed` whose Parallel monitor ingests material. The monitor's APPROVED materials feed `regenerateSynthesis` alongside any manual saves. The backing feed is `hidden` — invisible in the feeds list, sidebar, posts stream, stats, and all polling/refilter paths — so a tracked question reads as a *collection*, never a *feed*. See **Self-filling collections** below for the full lifecycle.

### Acceptance Criteria
- Save a whole material from the card and the detail page (optimistic, idempotent per user+material, toggles to unsave)
- A save lands in a smart-default topic-collection (most-recent → "Unsorted"); never a void
- Re-file or create a collection from the save toast (Move); Undo within the toast lifetime
- Save a manually highlighted passage as a citation (with source offsets); session in-text green wash
- Library (4th top-nav peer): collections grid + collection detail
- Each collection shows a living-answer slot + a "Track this" intent button
- Writes gated by `requireActiveSubscription`; reads stay open; strict `WHERE userId` isolation

---

## Design rules (load-bearing)

1. **Saves feed the knowledge base / topic-collections — NOT the global relevance filter.** A save is an *ambiguous* signal at Radaric's per-user, high-weight scale ("more like this" vs "useful to me personally"); piping all saves into the global filter would drift the feed. A save *into a named topic-collection* is the clean signal.
2. **Save ≠ Like.** Three orthogonal "value" actions: Like/Dislike = the machine's judgment; Save = my judgment; To Notion = my external tools. ("To Notion" only appears once a user configures the integration — `hasNotionIntegration`.)
3. **Provenance-first** (the living-answer contract). The living answer MUST show its work — linked primary sources, what-changed-since-last, confidence. A saved *excerpt* is a citation atom.

---

## Data Model

Models below, introduced by five additive migrations:

| Model (table) | Purpose | Key constraints |
|---|---|---|
| `Collection` (`collections`) | A topic-collection; seeds a future subscription | `(userId, name)` unique; `isSystem` marks the "Unsorted" default; `trackRequestedAt` = demand sensor ("Track this", set-once); `synthesis` / `synthesisDelta` / `synthesisUpdatedAt` = the **living answer** (LLM-maintained cited markdown). **Self-filling:** `query` + `cadence` (NL question + `InterestCadence`), `monitorFeedId` (`@unique` FK → `Feed`, `ON DELETE SET NULL`), `autoSynthAt` (the "new material since" marker the webhook bumps) |
| `SavedItem` (`saved_items`) | A saved whole material | `(userId, materialId)` unique (one bookmark; Move re-files) |
| `SavedExcerpt` (`saved_excerpts`) | A saved fragment / citation | `text` + `offsetStart`/`offsetEnd` (against the **source content string**, not the DOM) |
| `CollectionMaterial` (`collection_materials`) | A material **auto-routed** into a tracked question from a normal feed (Slice 2) | `(collectionId, materialId)` unique; cascade-deletes with either side. Distinct from `SavedItem` (manual, one per user+material) so routing can't collide with saves |
| `Material` (`materials`) | + self-filling routing watermark | `routedAt` (null = not yet considered by the router) |
| `Feed` (`sources`) | + self-filling: a backing monitor feed | `hidden` (excludes it from all feed/triage/stats surfaces), `monitorDeletePending` (orphaned-monitor reconcile flag), `backedCollection` (inverse of `Collection.monitorFeed`) |

All three saved-models cascade-delete with their `user` / `material` / `collection`. The card's saved state rides along the material object via a `savedItems` relation added to the shared `lib/materials/fetch-materials-page.ts` select (parallel to `feedbacks`).

---

## Architecture

### Server
- `lib/saved/collections.ts` — `ensureUnsorted`, `resolveDefaultCollectionId` (most-recently-used collection → "Unsorted"), `resolveTargetCollectionId` (`{collectionId | collectionName | default}`; returns `null` when an explicit id is not owned).
- `lib/saved/queries.ts` — Library reads: `getCollectionsWithCounts`, `getSavedTotals`, `getCollection`, `getSavedItemsForCollection`, `getSavedExcerptsForCollection`.
- `lib/validations/saved.ts` — zod schemas: `createCollectionSchema`, `saveItemSchema`, `moveSavedSchema`, `saveExcerptSchema`.
- `lib/saved/synthesis.ts` — **the living answer**. `regenerateSynthesis(userId, collectionId)`: gathers the collection's saved items + excerpts **plus the backing monitor feed's APPROVED materials AND routed materials** (self-filling; all URL-deduped against manual saves) as numbered sources → prompts the LLM (reusing `createModel()` exported from `lib/ai.ts`: global `Settings` model/key, Anthropic/OpenRouter) for a concise, **cited markdown** answer + a "what changed" delta (`generateObject`, zod-validated, `AbortSignal.timeout`) → persists to `Collection.synthesis`/`synthesisDelta`/`synthesisUpdatedAt`. The prompt's TOPIC is `query ?? name`. Karpathy LLM-wiki style: the collection IS the wiki page; provenance-first ("no claim without a source"); bounded length; honest when sources are thin.
- `lib/saved/subscription.ts` — **the tracked-question lifecycle** (self-filling). `createTrackedQuestion` (cap-checked → create the paid Parallel monitor → in a `$transaction` with a per-user `pg_advisory_xact_lock` create the hidden `EVENT_TRIGGER` backing feed + the collection → roll the monitor back on any DB failure), `deleteTrackedCollection` (monitor → feed → collection; on a failed monitor delete it KEEPS the feed flagged so the monitorId survives for reconcile), `sweepDueCollections` (the worker's trailing-edge debounce), `reconcileOrphanMonitors` (retries failed monitor deletes + drops the orphaned feed once gone). Cap: `SELF_FILLING_CAP` (10, env-overridable; admins exempt). Debounce: `SYNTH_DEBOUNCE_MS` (5 min).
- `lib/parsers/interest.ts` `processParallelEvent` — the Parallel **webhook** that ingests monitor events. Events are evaluated with the backing collection's `query` as the sole criterion (the same clean context routing uses; RAD-397) — a user-created monitor feed with no backing collection keeps its feed-prompt + global evaluation. After persisting APPROVED material it bumps `Collection.autoSynthAt = now()` (swallowed; non-fatal), **arming** the worker sweep.
- `lib/saved/routing.ts` `routeRecentMaterials` (Slice 2) — the worker routing pass. Routes APPROVED normal-feed material into matching tracked questions (keyword pre-filter → `evaluateMaterialsBatch({criteria})` → `CollectionMaterial` link + `autoSynthAt`). `Material.routedAt` watermark advances only on a clean run. Caps: `ROUTING_BATCH_LIMIT`, `ROUTING_USER_RUN_EVAL_CAP`, `ROUTING_USER_DAILY_CAP`.
- `lib/saved/discovery.ts` `discoverSourcesForTopic` (Slice 3) — LLM source discovery. `generateObject` suggests reputable sources for the query; each is VALIDATED into a real, reachable RSS feed (`validateFeed`: `safeFetch` — redirect-validated, SSRF-guarded, hard-bounded — + parse; falls back to `detectRSSFeed` for a site's advertised feed); only what resolves is returned (no hallucinated/dead URLs), deduped + flagged `alreadyAdded`. Returns `{sources, suggested}` (so the dropped count is surfaced). The client adds chosen feeds via the canonical `POST /api/feeds`; Slice-2 routing then pulls their content in. RSS-only by design.
- `lib/ai.ts` `evaluateMaterialsBatch({criteria})` — the clean tracked-question eval (Slice 2): `criteria` builds a context with the query as the sole criterion + blacklist, suppressing the feed's customPrompt/categories/feedback.
- `lib/story-aggregator/worker.ts` — runs `routeRecentMaterials()` → `sweepDueCollections()` → `reconcileOrphanMonitors()` every `SELF_FILLING_SWEEP_INTERVAL_MS` (2 min), each independently try-caught, with an overlap guard. Started after the DB check, **independent of GramJS**, so tracked-question answers stay fresh even if the Telegram listener is down. The cadence **freshness floor** (Slice 4) is throttled to `SELF_FILLING_FLOOR_INTERVAL_MS` (15 min).
- `sweepDueCollections` (Slice 4) — two due-paths: the armed trailing-edge debounce (Slice 1) **or** the **cadence freshness floor** (regenerate when the answer is older than the question's cadence AND there's material newer than it — a safety net for a missed `autoSynthAt`-arm and the first synthesis of a never-generated question; floor predicates match the synthesis exactly so it never loops). Capped at `SWEEP_MAX_REGENS` per tick. `POST /api/collections/regenerate-due` (secret-auth, `WORKER_TRIGGER_SECRET`) is a manual/ops trigger for the same sweep — **not** a cron.

### API (see [API_REFERENCE.md](API_REFERENCE.md) → Knowledge Base; writes gated by `requireActiveSubscription`)
`GET/POST /api/collections` · **`POST /api/collections/track`** (create a self-filling collection: `{name, query, cadence}`) · **`DELETE /api/collections/[id]`** (delete a collection; tears down a tracked question's monitor) · **`POST /api/collections/[id]/discover`** (Slice 3 — LLM-suggest + validate RSS sources for the question; cooldown-guarded) · `POST /api/collections/[id]/track` (record "Track this" intent on a manual collection, set-once) · `POST /api/collections/[id]/synthesis` (regenerate the living answer; AI call) · `GET/POST /api/saved` · `DELETE/PATCH /api/saved/[materialId]` · `POST /api/saved/excerpt` · `DELETE /api/saved/excerpt/[id]`.

### UI
- `components/materials/material-save-button.tsx` — `MaterialSaveButton`: optimistic Bookmark (fill + `.animate-icon-pop`), toggle-to-unsave; raises the toast on a fresh save. Reused on the card (compact) and the detail page (labelled).
- `components/materials/save-toast.tsx` — `SaveToast` (sonner `toast.custom`): "Saved to {collection}" + **Move** (re-file / create) + **Undo**.
- `components/materials/excerpt-saver.tsx` — `ExcerptSaver`: wraps the detail-page content; a text selection raises a floating "Save excerpt" pill; persists offsets; leaves a session in-text green wash (`<mark>` via `range.surroundContents`, best-effort).
- `app/(dashboard)/saved/page.tsx` — Library landing (collections grid + an empty state that "sells the future") + the **Track a question** button.
- `app/(dashboard)/saved/[collectionId]/page.tsx` — collection detail; merges manual saves with the backing feed's auto-collected materials (tagged so the grid shows manual saves as unsave-able and auto sources as read-only).
- `components/saved/` — `CollectionCard` (+ a "Tracking" badge + the query preview for self-filling); **`LivingAnswer`** (when no answer yet → dormant promise + **Generate answer** + **Track this**, or **Auto-updating** for a self-filling collection; when an answer exists → **cited markdown** via `react-markdown` + a "What changed" delta + "Updated {date}" + **Refresh**); **`TrackQuestionDialog`** (name + query + cadence → `POST /api/collections/track`); **`CollectionActions`** (self-filling indicator + delete via `AlertDialog`); `SavedMaterialsGrid` (reuses `MaterialCard`; auto-collected items render read-only via the new `hideSave` prop); `SavedExcerptList`.
- `components/layout/dashboard-shell.tsx` — **Library** added as the 4th top-nav peer (Posts · Feeds · Rules · Library).

---

## Roadmap (phases)

| Phase | Scope | Status |
|---|---|---|
| 0 | Save (whole + manual excerpt) + topic-collections + Library + "Track this" demand sensor | Shipped |
| 2 (thin slice) | **Living answer** — manual-trigger LLM-maintained cited markdown page per collection (Karpathy LLM-wiki) | Shipped |
| Self-filling **Slice 1** | **Track a question** — NL query + cadence → backing Parallel monitor autonomously collects + maintains the answer (worker debounce); hidden-feed isolation; paid-monitor lifecycle | Built |
| Self-filling **Slice 2** | Route relevant **existing-feed** materials into tracked questions (worker pass: keyword pre-filter → clean-context eval → `CollectionMaterial` link; `routedAt` watermark; per-user/run + 24h caps) | Built |
| Self-filling **Slice 3** | LLM **source discovery** — suggest reputable sources for a tracked question, validate to real RSS feeds, user adds them (then Slice-2 routing pulls their content in) | Built |
| Self-filling **Slice 4** | Worker cadence **freshness floor** (regenerate when cadence elapsed + newer material — catches missed arms + first synthesis) + per-sweep regen cap + secret-auth manual `regenerate-due` trigger | Built |
| 1 (reframed) | Saved exemplars improve relevance — *needs material embeddings (none exist); the living-answer wiki leapfrogs it.* | Deferred / optional |
| **Next (the "subscription" half)** | **Notification / delivery** — pull the user back when the answer materially changes (in-app / email / digest); surfaces the already-computed `synthesisDelta` | Planned |
| Later | Evolution-over-time view (history of `synthesisDelta`, not just the latest); cost ceilings; SSRF hardening | Planned |

> **Approach note (why a wiki, not embeddings):** the living answer is a Karpathy-style LLM-maintained markdown page — the *structure* (collection = page, Library = index) does the navigating, so no vector DB. This is provenance-native (a cited page = showing your work), cheaper than the embeddings path, and human-curatable (fits "scale the curator"). Embeddings were the wrong tool for high-volume relevance filtering; the wiki is the right tool for synthesis.

---

## Self-filling collections (tracked questions)

### Lifecycle
1. **Create** (`POST /api/collections/track` → `createTrackedQuestion`): cap pre-check → create the **paid Parallel monitor** for `{query, cadence}` → in a `$transaction` (per-user `pg_advisory_xact_lock` to serialize the cap) create the hidden `EVENT_TRIGGER` backing `Feed` (carrying `parallelMonitorId`/`interestQuery`/`interestCadence`) + the `Collection` (`query`/`cadence`/`monitorFeedId`). **Any DB failure rolls the monitor back** so a paid monitor is never orphaned.
2. **Collect** — two sources feed a tracked question (plus a manual pull):
   - **Monitor** (Parallel webhook → `processParallelEvent`): delivers events on the cadence; the interest parser evaluates + persists APPROVED material under the backing feed (a tracked question's events are judged against its `query`, not the global prompt) and bumps `Collection.autoSynthAt = now()`.
   - **On-demand pull** (`POST /api/collections/[id]/refresh` → `parseInterestSource`): the same monitor's events, fetched directly on demand (the "Check for updates" button) instead of waiting for the cadence push. Ingests + evaluates new material, then regenerates the answer inline (created>0 OR never-synthesized) — it does **not** arm `autoSynthAt`/defer to the worker, so the user sees the result immediately. 30s cooldown; the cooldown is released if the pull throws so a transient Parallel failure doesn't lock out a retry.
   - **Routing** (Slice 2, worker `routeRecentMaterials`): APPROVED material from the user's NORMAL feeds is routed into a tracked question when it matches. Per user with a tracked question: a cheap whole-word keyword pre-filter → a CLEAN-context AI eval (`evaluateMaterialsBatch({criteria})` — query as the sole criterion + blacklist) → a `CollectionMaterial` link + `autoSynthAt` bump. `Material.routedAt` is a watermark advanced only on a clean run; overflow + transient-AI-failure batches defer to the next run. Cost bounded by: only users-with-tracked-questions, a per-run batch cap, a per-user/run eval cap, and a per-user/24h routed-in budget. (Manual saves are excluded from routing so they're never double-counted.)
3. **Synthesize** (worker `sweepDueCollections`, every 2 min): a **trailing-edge debounce** — regenerate a collection's answer only once arrivals have settled for `SYNTH_DEBOUNCE_MS` (so a burst coalesces into one paid synthesis), then clear `autoSynthAt` *guarded on the value read* (a newer arrival landing mid-synthesis isn't lost). `regenerateSynthesis` reads the backing feed's APPROVED materials as cited sources.
4. **Delete** (`DELETE /api/collections/[id]` → `deleteTrackedCollection`): monitor → feed → collection. If the Parallel monitor delete **fails**, the backing feed is KEPT (flagged `monitorDeletePending`) so the orphaned `parallelMonitorId` survives; `reconcileOrphanMonitors` (worker, 2 min) retries the delete and then drops the now-collection-less feed.

### Operating requirements & known gaps (read this if a tracked question isn't collecting)
- **The Parallel webhook secret MUST be set** (Settings → Parallel webhook secret = the account secret from platform.parallel.ai → Settings → Webhooks). Without it the `/api/webhooks/parallel` handler answers `503` to every event by design → the monitor fires but nothing is ingested → the answer stays empty. The verifier accepts both of Parallel's live schemes: **Standard Webhooks** (strip `whsec_`, base64-decode the remainder, HMAC-SHA256 of `id.ts.body`) and the **legacy** raw-secret key. The handler likewise accepts both payload envelopes — the Standard Webhooks `{type, timestamp, data:{monitor_id, event:{event_group_id}}}` and the pre-migration flat `{event_type, monitor_id, event_group_id}` (RAD-397; the handler previously understood only the flat shape, so every migrated delivery 400'd and autonomous collection stopped).
- **Autonomous delivery is cadence-push; an on-demand pull also exists.** A tracked question's backing monitor delivers *autonomously* on the chosen cadence (Parallel → webhook → `processParallelEvent`; hourly fastest, daily up to ~a day) — the hidden feed is excluded from the normal manual-parse path. For verify-now / impatience there is a dedicated **on-demand pull**: `POST /api/collections/[id]/refresh` (the **"Check for updates"** button on a tracked-question detail) calls `parseInterestSource` to fetch the monitor's latest events directly, ingest + evaluate new material, and regenerate the cited answer when something changed (or bootstrap the first answer). It does **not** re-route the hidden feed through the polling parser; it's a one-shot `fetchMonitorEvents` pull, subscription-gated with a 30s per-(user,collection) cooldown.
- **No scheduled RSS/Twitter parsing by default.** Only Telegram updates in real time (GramJS); RSS/Twitter/monitor-poll feeds refresh only on a manual parse. So the **Slice-2 "route from your own feeds" path stays starved** until a parse runs. The primary source for a tracked question is its monitor (webhook), which is independent of this.
- **Query fit:** a monitor watches for *new* content on an evolving topic. A static fact ("Who is the President of Russia?") gives it nothing to detect — phrase questions as theses/topics that change.
- **Webhook hardening follow-ups:** replay window (pending timestamp-format confirmation); rate-limit IP trust behind multi-edge proxies; fail-closed gate vs the `NODE_ENV` dependency.

### The `hidden` mechanism (feed vs collection)
A tracked question's backing feed is `hidden: true`. The user manages it as a *collection*, never a *feed*, so `hidden` feeds (and their materials) are excluded everywhere a user-managed feed would appear or be processed:
- **Display/counts:** feeds list (`/api/feeds`, feeds page), sidebar + sidebar Inbox count, the posts stream (`fetchMaterialsPage` content + every filter/source-type count), `/api/stats`, custom categories, first-parse feed count.
- **Processing:** `parse` + `parse-stream` (a hidden monitor feed must never be re-fetched via the polling path — it's webhook-driven; doing so would re-pay Parallel and double-ingest), `refilter` (re-evaluating monitor material with the *global* prompt would corrupt the answer's source set), `group-stories`, `analytics/accuracy`, `clear` + `bulk-delete` (a triage clear must not wipe a tracked question's sources).
- **Mutation guards:** the feed `PATCH` and `DELETE` routes reject a hidden backing feed (`409`) — it must be managed through its collection so `Collection.monitorFeedId` can't desync from `Feed.parallelMonitorId`.

### Slice-1 hardening
- **Cap race closed for real.** A bare transactional `count()` under READ COMMITTED doesn't stop two concurrent creates; `createTrackedQuestion` takes a per-user `pg_advisory_xact_lock` inside the transaction so the second racer counts after the first commits.
- **No orphaned paid monitors.** The create rolls the monitor back on DB failure; delete keeps the monitorId recorded on a failed teardown; `reconcileOrphanMonitors` finishes the job and cleans the leftover feed.
- **True trailing-edge debounce** anchored to material *arrival* (`autoSynthAt`), not last-synthesis time — a chatty monitor can't trigger a regenerate storm, and the marker clear is race-guarded.
- **Honest auto-source UX.** Auto-collected materials render read-only (`MaterialCard hideSave`), not as falsely "Saved" cards with a dead unsave toggle.
- **Disambiguated errors.** The Track dialog branches on the response `code` (`CAP_REACHED` / `PARALLEL_NOT_CONFIGURED` / `SUBSCRIPTION_REQUIRED` / `SUBSCRIPTION_CHECK_FAILED`), not an ambiguous status.

---

## Hardening
- **Idempotent save.** `POST /api/saved` catches the `(userId, materialId)` unique violation (P2002) from a lost find-then-create race (two tabs / undo→re-save) and returns the existing save (`created: false`) instead of a 500.
- **Best-effort collection touch.** The "sort to top" `collection.update(updatedAt)` after a save/excerpt is wrapped in try/catch so a touch failure never fails an already-persisted save.
- **Reserved system name.** `collectionNameSchema` rejects the reserved `"Unsorted"` name (case-insensitive) so a user-named collection can't conflate with the auto-created system bucket via the `(userId, name)` upsert.
- **Library unsave refresh.** `SavedMaterialsGrid` passes `onUnsave={() => router.refresh()}` so unsaving inside a collection removes the card and updates counts (no stale card).

### Synthesis hardening
- **Synthesis cooldown.** `POST /api/collections/[id]/synthesis` refuses a regenerate within `COOLDOWN_MS` (8s) of the last one → `429` (the client shows "try again in a few seconds"). Bounds accidental/scripted re-fire of a paid LLM call beyond the client-side `busy` flag. *(A full per-user rate-limiter is a follow-up; the endpoint is also subscription-gated.)*
- **Truncate before sanitize.** Source content is sliced to `~MAX_SOURCE_CHARS*4` *before* `stripHtml`, so a regenerate never runs `sanitize-html` over full large articles just to keep the first 1500 chars.
- **Honors `aiTemperature`.** `generateObject` is passed `settings.aiTemperature` (parity with the eval path).
- **Safe date render.** `LivingAnswer` parses `synthesisUpdatedAt` defensively (date-fns v4 throws on an invalid Date) so a malformed value can't crash the collection page.
- **react-markdown safety.** The answer renders via `react-markdown` with no `rehype-raw` → raw HTML in LLM output is not rendered (no XSS); links get `target="_blank" rel="noopener noreferrer"`.

## Deferred
- **Persistent in-text excerpt wash on reload** — currently session-only; the excerpts persist and surface in the collection's Excerpts list. Re-highlighting saved ranges on load is deferred. **Note on offsets:** `ExcerptSaver` computes offsets against the *rendered* content text. This matches `Material.content` for plain-text and Telegram-entity materials, but **not** for HTML materials (rendered via `dangerouslySetInnerHTML(sanitizeHtml(...))`, where tags are stripped) — so for HTML sources the stored offsets are best-effort metadata, not exact indices into the raw content. The durable citation is the stored `text`; re-highlighting will need a source-string anchor (e.g. a fuzzy text match) rather than raw offsets.
- **Sidebar-collections IA** — Library uses a collections landing grid rather than reusing the sources sidebar; revisit if desired.

**"Track this" demand sensor:** "Track this" persists intent per collection (`Collection.trackRequestedAt`, set-once, via `POST /api/collections/[id]/track`) and renders a "Tracking requested" state on reload. Query `collections WHERE track_requested_at IS NOT NULL` for the signal.

**Known minor:** a collection-card source count can over-count by 1 for an article present as BOTH a backing-feed material and a manual save (the count is raw-additive; the grid and the answer URL-dedup) — cosmetic.
