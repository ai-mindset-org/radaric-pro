# Tech Stack

**Last Updated:** April 2026

---

## Runtime

| Package | Version | Role |
|---------|---------|------|
| next | ^16.1.6 | Framework (App Router) |
| typescript | ^5 | Language |
| react / react-dom | ^19.2.1 | UI runtime |
| Node.js | LTS | Server runtime (Railway) |

## Database

| Package | Version | Role |
|---------|---------|------|
| prisma | ^6.19.0 | ORM + migrations |
| @prisma/client | ^6.19.0 | Generated DB client |
| Railway PostgreSQL | — | Managed database |

Migration runs at start: `prisma migrate deploy` (not at build time).

## Media Storage

| Package | Version | Role |
|---------|---------|------|
| @aws-sdk/client-s3 | ^3.994.0 | Cloudflare R2 (S3-compatible API) |

## UI

| Package | Version | Role |
|---------|---------|------|
| tailwindcss | ^4 | Utility CSS |
| shadcn/ui | — | Component system (Radix UI primitives) |
| @radix-ui/* | various | Headless UI primitives (accordion, dialog, dropdown, select, tabs…) |
| lucide-react | ^0.553.0 | Icon set |
| react-icons | ^5.6.0 | Additional icons |
| next-themes | ^0.4.6 | Light/dark mode |
| sonner | ^2.0.7 | Toast notifications |
| react-markdown | ^9.1.0 | Render the Knowledge-Base "living answer" markdown (no raw HTML / no `rehype-raw` → safe) |

## AI

| Package | Version | Role |
|---------|---------|------|
| ai | ^6.0.134 | Vercel AI SDK core (streaming, tool calls) |
| @ai-sdk/anthropic | ^3.0.63 | Anthropic Claude provider |
| @ai-sdk/openai | ^3.0.47 | OpenAI provider (embeddings) |
| openai | ^6.22.0 | Direct OpenAI client (text-embedding-3-small) |

**Providers in use:**
- Anthropic Claude — content scoring with prompt caching, batch evaluation (10 materials/prompt)
- OpenRouter — Gemini 2.x, GLM-4/5, Qwen 3.5 (story aggregation, configurable per user)
- OpenAI — `text-embedding-3-small` embeddings

## Auth

| Package | Version | Role |
|---------|---------|------|
| next-auth | ^5.0.0-beta.32 | Session management (NextAuth v5) |
| bcryptjs | ^3.0.3 | Password hashing (10 rounds) |
| jsonwebtoken | ^9.0.3 | Apple Sign In JWT |

**Providers:** Email/password, Google OAuth, Apple Sign In.

## Parsers & Integrations

| Package | Version | Role |
|---------|---------|------|
| telegram (GramJS) | ^2.26.22 | Telegram channel reader (private channels) |
| rss-parser | ^3.13.0 | RSS/Atom feed parsing |
| @mozilla/readability | ^0.6.0 | Web article extraction |
| youtube-transcript-plus | ^1.2.0 | YouTube transcript extraction |
| xml2js | ^0.6.2 | OPML import (Feedly/Inoreader) |
| linkedom | ^0.18.12 | Server-side DOM for readability |
| @notionhq/client | ^5.3.0 | Notion export integration |
| sanitize-html | ^2.17.0 | HTML sanitization |

TwitterAPI.io is used for Twitter/X — HTTP API, no npm package.

## Testing

A large Vitest unit/integration suite plus Playwright E2E.

| Package | Version | Role |
|---------|---------|------|
| vitest | ^4.1.12 | Unit + integration tests |
| @vitest/coverage-v8 | ^4.1.12 | Coverage (ratchet thresholds) |
| @playwright/test | ^1.59.1 | E2E tests |
| @testing-library/react | ^16.3.2 | React component testing |
| @testing-library/jest-dom | ^6.9.1 | DOM matchers |
| jsdom | ^28.1.0 | DOM environment for unit tests |

## Code Quality

| Package | Version | Role |
|---------|---------|------|
| eslint | ^9 | Linter (flat config + eslint-config-next) |
| husky | ^9.1.7 | Git hooks (pre-commit, pre-push) |
| lint-staged | ^16.4.0 | Run ESLint on staged files only |
| knip | ^6.3.0 | Dead code detection |

## Monitoring

| Package | Version | Role |
|---------|---------|------|
| @sentry/nextjs | ^10.78.0 | Error tracking + performance |

## Email

| Package | Version | Role |
|---------|---------|------|
| resend | ^6.9.4 | Transactional email (daily review digests) |

## Deployment

| Aspect | Detail |
|--------|--------|
| Platform | Railway (managed PaaS) |
| Process model | Long-running Node.js — Next.js + Story Aggregator worker in one dyno |
| Start command | `sh scripts/start.sh` — PID 1 entrypoint: traps SIGTERM/SIGINT and forwards them to both the worker and Next.js, and runs `scripts/migrate-safe.js` before `prisma migrate deploy` |
| Database | PostgreSQL, hosted anywhere; the reference deployment runs on Railway |

---

## Rationale

**Railway over Vercel.** The Story Aggregator requires a persistent GramJS (Telegram) session. Vercel's serverless functions are stateless and time-limited — GramJS would disconnect on every cold start and cause `AUTH_KEY_DUPLICATED` errors if multiple instances shared a session. Railway runs a single long-lived Node.js process, which keeps the GramJS session alive and allows the worker to run alongside Next.js without coordination overhead.

**Prisma.** Schema-first approach fits the project's data model well: strong TypeScript types from generated client, declarative migrations with `prisma migrate`, and `prisma studio` for quick inspection during development. The migration safety script (`scripts/migrate-safe.js`) runs `prisma migrate deploy` at startup rather than build time, so schema changes apply atomically before traffic is served.

**shadcn/ui.** Components are copied into the repository rather than installed as a dependency, which means the design system is fully under version control and can be customized without fighting library constraints. This pairs well with Tailwind CSS v4 and the project's OKLCH-based Radix Colors design system (Sage gray + Green accent), maintaining visual consistency without a separate component library lock-in.
