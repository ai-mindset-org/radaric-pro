# Radaric — Architecture Layout

## Architecture

```
radaric/
├── app/                  # Next.js App Router
│   ├── (landing)/       # Public marketing pages (terms, privacy)
│   ├── (dashboard)/     # Main UI (feeds, posts, stories, saved, settings, admin)
│   ├── signup/          # Sign-up / sign-in page
│   ├── page.tsx         # Landing page (public)
│   ├── robots.ts        # SEO robots config
│   ├── sitemap.ts       # SEO sitemap
│   ├── fonts/           # Self-hosted faces (RAD-363): inter.ts (Inter 4 via next/font/local — latin preloaded, cyrillic/ext by unicode-range), one folder per family with its OFL.txt, SOURCES.md (version, sha256, licence notes), fonts.css (GENERATED @font-face bundles — never hand-edit)
│   ├── typography.css   # GENERATED per-font role token bundles (--f-<font>-<role>-*) — rebuilt by scripts/typography/build-css.ts; a test fails when it drifts from the builder
│   └── api/             # API Routes (incl. admin/dashboard)
├── components/          # React components
│   ├── providers/      # typography-provider.tsx (RAD-363) — holds the user's per-role font choice, renders it as one unlayered <style data-radaric-typography>, saves optimistically through a serialized PATCH queue and reverts on a failed latest save; mounted by app/(dashboard)/layout.tsx only
│   ├── ui/             # shadcn/ui components; morph-text.tsx is the house torph wrapper (RAD-341) — the continuity primitive for a value that changes in place, the only module allowed to import torph
│   ├── layout/         # Dashboard shell + sidebar: dashboard-shell.tsx (client wrapper, top bar + chevron toggle, matchMedia only inside click handler to avoid hydration flip, mobile <Sheet> with visible labelled Close at the bottom, Sheet primitive overrides border-r-0 bg-sidebar sm:!max-w-[320px]), sidebar.tsx (optional id prop so desktop + mobile instances get unique DOM ids, "All" row + sources list with monogram fallback, inset box-shadow accent bar, uniform font-medium)
│   ├── landing/        # Landing page components (mobile-sticky-cta; self-hosted-legal-page.tsx is the neutral /terms + /privacy body under SELF_HOSTED)
│   ├── feeds/          # Feed components (FeedTypeCards, ContentCategoryPicker, etc.)
│   ├── materials/      # Material components. material-card.tsx handles posts + stories; MaterialRow title links to original source URL; source link navigates to /feeds/[id]. materials-list.tsx is the screen shell for both /posts and /feeds/[id] (title/subtitle/hideSourceTypeFilter props; forces sourceTypeFilters to ["ALL"] under hideSourceTypeFilter to prevent cross-page filter leak). Since RAD-318 it delegates rather than doing: posts-toolbar.tsx owns the controls (one CSS grid, one DOM instance of each control at every width — mobile and desktop differ by grid placement, not by hidden twins), source-type-menu.tsx the type filter, use-post-processing.ts every SSE run, processing-card.tsx the run's visible state as the first grid cell. The run state is a store (`ProcessingStore`: subscribe/getSnapshot), not a render value — `ProcessingCell` subscribes with `useSyncExternalStore` so a streamed frame re-renders that one cell instead of the whole grid, which would otherwise re-run AnimatedGrid's dependency-less layout effect and re-measure every live cell (~130 measure passes per parse before, 59 after). MaterialCard is memoised and the handlers MaterialsList passes it are useCallback-stable for the same reason; story cells are the known exception. material-title.tsx renders a post's headline with the lede's own links when the title is derived (`isDerivedTitle`): the body cut that sentence out, so the headline is a link's only home — Telegram link entities are re-mapped onto the stored title (`remapToDerivedTitle`) and HTML is cut out of the stored markup and sanitized to its anchors (`derivedTitleHtml`); emphasis and spoiler/block entities never reach the heading (RAD-365), which falls back to the plain stored title when an unmappable cut would change the words.
│   ├── stories/        # Story surfaces: stories-list.tsx (the /stories index grid), story-card.tsx, story-detail.tsx (the full page /stories/[id]), story-article.tsx (the body shared with the side peek, RAD-345), story-peek.tsx
│   ├── saved/          # Knowledge Base UI: collection-card.tsx + collection-actions.tsx (landing grid; generate/refresh/delete), living-answer.tsx (the LLM-maintained cited answer), saved-excerpt-list.tsx, saved-materials-grid.tsx, discover-sources-dialog.tsx, track-question-dialog.tsx
│   ├── onboarding/     # Onboarding flow components (phase-indicator.tsx, feed-discovery-progress.tsx)
│   ├── rules/          # rules-page.tsx — the dedicated /rules page (Global Prompt, Blocklist, AI Knowledge Base)
│   ├── peek/           # Side peek (RAD-345), one open state with two skins: peek-host.tsx picks PeekPanel (docked right at lg+) or PeekSheet (bottom sheet below lg); peek-header.tsx, peek-column.tsx (the page's own reading measure), peek-states.tsx, peek-props.ts, use-is-desktop.ts
│   ├── reading/        # Shared chrome for the long-form reading pages — reading-layout.tsx (ReadingShell/ReadingHero/ReadingTitle/ActionRail) + reading-actions.tsx (open-original / archive / Notion / delete rail)
│   ├── admin/          # Admin components (admin-dashboard)
│   └── settings/       # Settings components; typography-section.tsx (Appearance → Typography: presets, four role selects, device notes) + typography-specimen.tsx (the live specimen, also on /design-system → Roles)
├── lib/                # Utilities and libraries
│   ├── db.ts          # Prisma client
│   ├── typography/    # Per-role font system (RAD-363). Client-safe: fonts.ts (registry — eleven fonts, four roles, font-family stacks), presets.ts, prefs.ts (lenient parse for the DB row, strict validateTypographyInput for PATCH), css.ts (the :root remap the provider renders), platform.ts (Apple/WebKit detection for the picker notes). Server-only: load.ts (never rejects — default on any error). Build-time: font-metrics.json (measured by scripts/typography/measure-fonts.py, pins each file's sha256), derive.ts (metrics → size-adjust, cap-height adjust, line-box overrides, stem-matched weight maps, figures face; static faces take the identity map and snap to the nearest shipped weight), design.ts (chosen, not measured: features — a `-tag` disables one — tracking factors, leading), build.ts (→ app/fonts/fonts.css + app/typography.css)
│   ├── ai.ts          # AI utilities (batch evaluation, prompt caching)
│   ├── models/        # THE model layer — registry.ts (catalogue, STAGE_DEFAULTS, resolver, reasoning effort; client-safe, imports no provider SDK so "use client" settings-form can render the lists) + provider.ts (server-only; the ONE createModelInstance, OpenRouter vs Anthropic credential branch, data_collection: deny fetch middleware). Every stage resolves and constructs here — there used to be six copies of this branch, and the five-of-six change is how worker.ts ended up the only path missing the JSON fence-stripper
│   ├── implicit-feedback.ts  # Auto-feedback on user overrides
│   ├── refilter-materials.ts # Re-evaluate all materials with current AI rules
│   ├── feed-utils.ts  # Pure feed logic (buildRenderItems, getFilterPredicate, FeedMaterial type)
│   ├── feed-type-color.ts  # Shared brand-tint class helper — same palette for sidebar monogram and per-source hero badge; importable from both server and client without crossing the "use client" boundary
│   ├── feed-extraction.ts  # Feed extraction utilities (extractFeedsFromLines, resolveStatus, extractFeedsWithLLM)
│   ├── onboarding-persist.ts  # Shared persistFeeds() helper: PATCH /api/user-settings with 1x retry (3s timeout on the retry), toast.warning on failure
│   ├── accuracy.ts    # Accuracy metrics computation
│   ├── opml-parser.ts # OPML import parser (Feedly/Inoreader)
│   ├── youtube.ts     # Shared YouTube primitives: channel resolution (@handle/video/feed-XML → canonical UC id), oEmbed metadata, capped transcript fetch — used by lib/parsers/youtube.ts and story-aggregator/content-extractor.ts
│   ├── materials/     # Shared materials logic. fetch-materials-page.ts exports fetchMaterialsPage() with /posts + per-source overloads, requireOnboarded(), FeedNotFoundOrForbiddenError; used by both /posts/page.tsx and /feeds/[id]/page.tsx. RAD-318 added three pure modules the UI reduces over: processing-state.ts (the run state machine — phase, per-source rows, log, outcome, and the generation that invalidates a stopped or superseded run), posts-query.ts (the request builder — buildPostsUrl() is the single place sourceId attaches to a request, and both of MaterialsList's /api/posts reads go through it, so a source-scoped screen cannot leak account-wide results; the query's lifecycle stays in the component, where the screen's SSR-then-top-up behaviour actually is), first-run.ts (the automatic first parse: server-owned, never aborted, onboarding flag written only on a server answer).
│   ├── contact.ts     # Server-only getContactEmail() — CONTACT_EMAIL (trimmed, blank = unset) or the hosted address; client components receive it as a prop
│   ├── motion.ts      # Motion tokens readable from JavaScript — WAAPI needs concrete values, not var() references, so getMotionTokens() resolves --dur-*/--ease-* off the document root (memoised; MOTION_FALLBACKS cover SSR/tests), plus prefersReducedMotion() and REFLOW_SPRING/springEasing() for the Posts grid reflow. JS-driven animation must read tokens here, never copy the value
│   ├── peek/          # Side-peek pure logic (RAD-345), unit-tested without touch/DOM events: peek-state.ts (the URL is the state — ?post=/?story=), peek-nav.ts (which History operation an open/close plans, and the walk's neighbour), click.ts (modified click stays a new tab), drag.ts (bottom-sheet dismiss thresholds), keyboard.ts (j/k nav intent)
│   ├── parsers/       # Parsers (RSS, Telegram, Twitter, YouTube, EventTrigger)
│   ├── story-aggregator/  # Story Aggregator
│   ├── stripe.ts      # Lazy Stripe client singleton (getStripe()), STRIPE_PRICES, getAppUrl()
│   ├── stripe-status-map.ts  # Stripe status string → Prisma enum mapper with UNKNOWN fallback
│   ├── stripe-customer.ts    # getOrCreateStripeCustomer — keyed solely on User.stripeCustomerId or fresh-create with metadata.userId (no email search — prevents orphan cross-match)
│   ├── stripe-webhook-handlers.ts  # handlers + syncSubscriptionFromStripe (re-fetches from Stripe)
│   ├── subscription.ts       # hasActiveAccess pure gate + requireActiveSubscription async wrapper
│   └── paywall.ts     # requirePaidDashboardAccess() server-side redirect helper
├── __tests__/         # Vitest unit/integration tests
├── e2e/               # Playwright E2E tests (onboarding happy path, skip flow, OPML, signup validation, onboarding bug fixes)
├── playwright.config.ts  # Playwright config (baseURL, auth fixture, global setup/teardown)
├── scripts/typography/  # measure-fonts.py (fontTools → lib/typography/font-metrics.json), subset-inter.py, build-css.ts (regenerates the two generated CSS files)
└── prisma/            # Database schema
```

