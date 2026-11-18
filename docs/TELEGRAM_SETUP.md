# Telegram Integration Setup

> **Status:** Implemented
>
> Parsing, authentication, media upload to Cloudflare R2, and the UI are complete.

This guide describes how to set up Telegram channel parsing in Radaric.

## Overview

Radaric uses **GramJS** (the TypeScript port of Telethon) to connect to Telegram as a regular user, not a bot. This allows reading messages from **any channel** you are subscribed to, without admin rights.

### Key Features

✅ Parses public and private Telegram channels
✅ Works as a regular user (no bot required)
✅ **Full 2FA support** (two-factor authentication)
✅ AI evaluation of messages using the same rules as RSS
✅ Automatic message deduplication by `messageId`
✅ **Photo upload to Cloudflare R2** (videos are skipped to save space and time)
✅ **Gallery support** — the first photo in an album is used as the thumbnail
✅ Media is never deleted with a material — objects are shared across subscribers (RAD-368)
✅ Session persistence for reuse

## Step 1: Get Telegram API Credentials

To use the Telegram API, you must obtain an **API ID** and **API Hash** from Telegram.

1. Go to https://my.telegram.org
2. Sign in with your phone number
3. Open **"API Development Tools"**
4. If you have no app yet, create one:
   - **App title**: `Radaric` (or any name)
   - **Short name**: `radaric` (or any short name)
   - **Platform**: Website or Android/iOS (either works)
5. After creation you will receive:
   - **App api_id** (for example: `12345678`)
   - **App api_hash** (for example: `abc123def456...`)

⚠️ **Important:** These credentials are tied to your Telegram account and must be kept secret.

## Step 2: Configure Radaric

### 2.1 Add credentials

1. Open Radaric and go to **Settings**
2. Find the **"Telegram Integration"** section
3. Enter:
   - **API ID**: the numeric identifier from step 1
   - **API Hash**: the string key from step 1
4. Click **"Save settings"**

### 2.2 Authorize in Telegram

After saving the credentials:

1. Click **"Sign in to Telegram"**
2. **Step 1 — Phone number**: Enter your number in international format (for example: `+79001234567`)
3. **Step 2 — Confirmation code**: Telegram sends a code to your app (usually 5 digits)
   - Enter the code within a few minutes (it is valid for ~3–5 minutes)
4. **Step 3 — 2FA password** *(if two-factor authentication is enabled)*:
   - The system detects automatically that a password is required
   - Enter your **cloud password** from the Telegram settings
   - ⚠️ This is NOT your account password, but the password from Settings → Privacy and Security → Two-Step Verification

After successful authorization you will see:
- ✅ A green **"Authorized"** badge with your phone number
- The button changes to **"Sign out of Telegram"**

⚠️ **Note:** The authorization is stored in the database as a session string — you do not need to sign in again each time.

## Step 3: Add Telegram sources

1. Go to the **Sources** page
2. Click **"Add source"**
3. Fill in the form:
   - **Name**: any name (for example, "Tech News Channel")
   - **Type**: select **"TELEGRAM"**
   - **URL**: the channel username as `@channelname` or `channelname`
   - **Custom Prompt**: *(optional)* rules specific to this channel
   - **Active**: enable for automatic parsing
4. Click **"Create"**

### Valid URL examples

```
@durov
durov
@TechCrunch
TechCrunch
```

⚠️ **Important:** You can only add channels your Telegram account is subscribed to.

## Step 4: Set up Cloudflare R2 (for media)

Telegram messages often contain photos, videos, and documents. Radaric automatically uploads media to **Cloudflare R2** through `@aws-sdk/client-s3` (an S3-compatible API).

### 4.1 Set up the R2 bucket and credentials

1. Go to the **Cloudflare Dashboard** → **R2 Object Storage**
2. Create a new bucket (for example, `radaric-media`)
3. In the account settings, create an **API Token** with access to the bucket
4. Copy the **Account ID** — it is part of the endpoint URL

Add the environment variables on your deployment platform (a container platform such as Railway):

```
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_BUCKET_NAME=radaric-media
R2_ACCESS_KEY_ID=<your-access-key-id>
R2_SECRET_ACCESS_KEY=<your-secret-access-key>
R2_PUBLIC_URL=https://<your-public-bucket-url>
```

`R2_PUBLIC_URL` is the base URL media is served from — the bucket's public
hostname or a custom domain in front of it. `lib/blob-storage.ts` throws
without it, so media upload fails until it is set.

### 4.2 Cost

Cloudflare R2 is very inexpensive:
- **Storage**: free up to 10 GB, $0.015/GB per month beyond that
- **Traffic**: free (no egress fees — the key advantage over AWS S3)
- Far cheaper than Cloudinary (~$18/month) or AWS S3

**Example:** 1,000 photos (200 MB) cost $0/month (within the free tier).

### 4.3 File organization

Media is stored in an organized structure:
```
telegram/
  ├── channelname/
  │   ├── 123.jpg
  │   ├── 124.mp4
  │   └── 125.pdf
  └── anotherchannel/
      └── 456.jpg
```

When a material is deleted, its media files are automatically removed from R2.

## Step 5: Parse messages

After adding sources:

1. Go to the **Materials** page
2. Click **"Parse All Sources"** or use the "Parse" button on a specific source
3. Radaric:
   - Fetches the last 10 messages from each Telegram channel
   - **Uploads photos only** to Cloudflare R2 (videos are skipped)
   - **Merges galleries** — only the first photo of an album is uploaded
   - Applies timeout handling and retry logic (30 s timeout, 2 attempts)
   - Evaluates messages with AI
   - Stores only new messages (deduplication by `messageId`)
   - Applies your filtering rules

Results appear in the material list tagged with the source. Materials with photos show thumbnails.

### Media parsing specifics

**What is uploaded:**
- ✅ **Photos** — uploaded and displayed as thumbnails
- ❌ **Videos** — skipped (too large for fast upload)
- ❌ **Documents** — skipped
- ✅ **Webpage previews with photos** — preview photos are uploaded

**Galleries (media albums)**:
- Telegram albums are merged into one material
- Only the **first photo** of the album is uploaded
- If an album contains only videos, no media is uploaded and only the text is stored
- The text is taken from the first message in the group

**Error handling**:
- Network errors trigger an automatic retry (up to 2 attempts)
- A file upload times out after 30 seconds
- A failure of one file does not stop channel parsing

## FAQ

### Can I parse private channels?

Yes. If your Telegram account is subscribed to a private channel, Radaric can read its messages.

### Do I need admin rights in the channel?

No. Unlike the Telegram Bot API, GramJS works as a regular user, so no special rights are required.

### How often can I parse channels?

Parse no more than once every 5–10 minutes to avoid rate limiting by the Telegram API.

### What if the session expires?

If you see the error "Telegram session is invalid or expired":
1. Go to Settings
2. Click "Sign out of Telegram"
3. Click "Sign in to Telegram" again
4. Complete the authorization flow again

### Is 2FA (two-factor authentication) supported?

**Yes.** 2FA support is complete. If two-factor authentication is enabled in Telegram:

1. Complete the usual authorization steps (phone number → code)
2. The system detects automatically that a 2FA password is required
3. An extra step appears for entering the **cloud password**
4. Enter the password from the Telegram settings: **Settings → Privacy and Security → Two-Step Verification**

**Important:** This is the cloud password (the two-step verification password), not your Telegram account password.

**If you get the error "2FA password verification failed":**
- Make sure you enter the correct cloud password
- Make sure you remember the password (you can verify it in the Telegram settings)
- If needed, reset the password through Telegram and set a new one

### Can I parse groups and chats?

The current version supports only public and private **channels**. Support for groups and chats may be added in the future.

### How does gallery (album) parsing work?

Radaric recognizes galleries by `groupedId` and merges them:
- Telegram sends an album as several separate messages sharing a group ID
- All messages with the same `groupedId` are collected
- One material is created with all media files from the album
- The text is taken from the first message in the group

### What if files are too large?

The current limit is **50 MB per file**. If a file exceeds the limit:
- It is skipped with a warning in the logs
- Parsing continues for the remaining files
- The material will contain only the files that passed the check

To raise the limit, change `MAX_FILE_SIZE` in `lib/blob-storage.ts`:
```typescript
const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
  // ...
}
```

⚠️ **Note:** Consider R2 storage cost ($0.015/GB per month beyond the 10 GB free tier) when raising the limit.

### Is it safe to store the session string in the database?

The session string is stored in your private PostgreSQL database (a managed PostgreSQL instance when deployed to a platform such as Railway) with the same safeguards as other sensitive data (API keys, Notion tokens, and so on).

For additional safety:
- Use environment variables for DATABASE_URL
- Never share logs that may contain the session string
- Regularly review the device list in the Telegram settings

## Troubleshooting

### Error: "Telegram credentials not configured"

**Fix:** Make sure you:
1. Entered the API ID and API Hash in Settings
2. Clicked "Save settings"
3. Reloaded the page

### Error: "Failed to parse Telegram channel"

**Possible causes:**
- Your account is not subscribed to the channel
- The channel was deleted or banned
- Malformed username (check for a leading @)
- The session expired

**Fix:** Check in Telegram that the channel exists and that you are subscribed to it.

### Error: "PHONE_CODE_INVALID"

**Fix**:
- Make sure you enter the correct code from Telegram
- The code is valid for only a few minutes; request a new one if it expired

### Error: "PHONE_CODE_EXPIRED"

**This error was fixed in a recent version.** It used to expire even on fast input because the session was not preserved between authorization steps.

If you still get this error:
- Make sure you run the latest version of the app
- Enter the code within 3–5 minutes of receiving it
- If the code has really expired, click "Back" and request a new one

### Error: "2FA password verification failed"

**Fix**:
- Make sure you enter the **cloud password**, not your account password
- Where to find the cloud password: Telegram → Settings → Privacy and Security → Two-Step Verification
- If you forgot the password, reset it through Telegram and set a new one
- After setting the new password, repeat the authorization in Radaric

## Technical Details

### Architecture

```
User → Settings UI → API Routes → Telegram Parser (lib/parsers/telegram.ts)
                                          │
                                          │  HTTP proxy (fetchWorkerWithRetry)
                                          │  6 retries, exponential backoff 3s→30s
                                          ▼
                              worker.ts HTTP server (port 3001)
                              POST /telegram/parse-channel
                              GET  /telegram/channel-info
                              GET  /telegram/session-check
                              POST /telegram/reconnect
                                          │
                                          ▼
                              Single GramJS client → Telegram API
                                          │
                                     Database (session) + Cloudflare R2 (media)
```

**Single GramJS connection principle:** Only the worker process holds an active GramJS session. The parser (`lib/parsers/telegram.ts`) must never create its own `TelegramClient` with the stored session — doing so causes `AUTH_KEY_DUPLICATED` errors. All Telegram API calls from the parser route through the worker's HTTP server.

**Auth flow exception:** `startTelegramAuth()` and `verifyTelegramCode()` create ephemeral GramJS clients with an empty session string (no conflict). After `verifyTelegramCode()` saves the new session, it calls `POST /telegram/reconnect` so the worker adopts the new session immediately.

**Shutdown order:** On SIGTERM, `client.destroy()` is called first (step 1, with 3 s await) before queue drain or DB close. This prevents the deploy-overlap window where the outgoing and incoming containers of a rolling deploy hold active connections simultaneously, which triggers `AUTH_KEY_DUPLICATED` and permanently invalidates the session. `destroy()` must be used — not `disconnect()` — because only `destroy()` stops the internal update loop and releases borrowed media DC senders.

### Technologies

- **GramJS**: JavaScript/TypeScript library for the Telegram MTProto API
- **StringSession**: session persistence as a string (survives between requests)
- **Cloudflare R2** (`@aws-sdk/client-s3`): storage for media files (photos, documents)
- **Prisma ORM**: PostgreSQL access (managed Postgres such as Railway's)
- **Next.js API Routes**: backend endpoints for authorization and parsing
- **telegram/Password**: module for SRP verification of 2FA passwords

### Code layout

- `lib/parsers/telegram.ts` — core parsing and authorization logic (350+ lines)
- `lib/blob-storage.ts` — Cloudflare R2 utilities via `@aws-sdk/client-s3` (media upload/delete)
- `app/api/telegram/auth/*` — authorization API endpoints (start, verify, status, logout)
- `components/telegram/telegram-auth-dialog.tsx` — authorization dialog UI with 3 steps
- `prisma/schema.prisma` — DB schema with the Telegram fields on the Settings model

### Implementation highlights

**Session-preserving authorization:**
- `startTelegramAuth()` saves a temporary session after `sendCode()`
- The frontend passes that session into `verifyTelegramCode()`
- Reusing one session prevents the "PHONE_CODE_EXPIRED" error

**2FA via SRP verification:**
- On `SESSION_PASSWORD_NEEDED`, `account.GetPassword()` is called
- The password is processed through `computeCheck()` for SRP
- The final call is `auth.CheckPassword()` with the SRP hash

**Material deduplication:**
- Every message has a unique `externalId = "channelUsername:messageId"`
- The database has a unique index on `(sourceId, externalId)`
- Repeated messages are skipped automatically

**Media handling:**
- Upload to R2 under the key `telegram/{channel}/{messageId}.{extension}`
- `addRandomSuffix: false` for consistent URLs (helps with deduplication)
- A material delete leaves its R2 objects in place: `telegram/{channel}/{messageId}.{extension}`
  is deduped by key and shared by every subscriber, so per-user deletes are disabled (RAD-368).
  Unreferenced objects are left for a future GC sweep.

**Gallery support (grouped media):**
- Detection of messages with `groupedId` (albums of several photos/videos)
- Deduplication of processed groups via `Set<string>`
- All media in the group are merged into one material with a `mediaUrls` array
- The first photo/video is used as `thumbnailUrl`

**Robust media upload:**
- **Timeout handling**: 30 s for the Telegram download, 20 s for the R2 upload
- **Retry logic**: up to 3 attempts with exponential backoff (2 s → 4 s → 8 s)
- **Size limit**: 50 MB per file maximum
- **Graceful degradation**: a failure of one file does not stop the whole parse

## Common Pitfalls

This section documents the mistakes we made during development and how to avoid them in the future.

### 1. TypeScript Type Completeness

**Problem**: Telegram API credentials (telegramApiId and telegramApiHash) disappeared after saving in Settings, even though the DB write succeeded.

**Cause**: The TypeScript Settings interface was missing the `telegramSessionString` field, so a React state update wiped it and then overwrote the DB.

**Lesson**: ⚠️ **ALWAYS verify that TypeScript types match the DB schema exactly**
- Missing fields in TypeScript types cause **silent data loss**
- Use Prisma types directly where possible: `Prisma.SettingsGetPayload<{}>`
- When adding new DB fields, update ALL of these:
  - Prisma schema
  - TypeScript interfaces/types
  - API endpoints (GET, POST, PUT)
  - Frontend forms and state
  - Default values and auto-initialization

**Files to check when adding new fields**:
- `prisma/schema.prisma`
- `components/settings/settings-form.tsx` (Settings type)
- `app/api/settings/route.ts` (GET and PUT endpoints)
- `app/(dashboard)/settings/page.tsx` (default values)

### 2. Session Preservation in Multi-Step Auth

**Problem**: The "The code has expired" error appeared even when the Telegram code was entered immediately.

**Cause**: The Telegram auth code is bound to a specific client session. We created a NEW client with an empty session in `verifyTelegramCode`, so Telegram could not match the code to the original `sendCode` request.

**Lesson**: ⚠️ **Multi-step authentication flows require preserved context**
- A stateless API requires explicit session-state passing between steps
- The Telegram MTProto API requires the same session for `sendCode` → `signIn`
- Never create a new client with `new StringSession("")` in intermediate steps
- Save `session.save()` after the first step and pass it to later steps

**Correct pattern**:
```typescript
// Step 1: Start auth
const session = new StringSession("")
const client = new TelegramClient(session, apiId, apiHash)
await client.sendCode(phoneNumber)
const sessionString = session.save() // SAVE
return { sessionString }

// Step 2: Verify code (receive sessionString from Step 1)
const session = new StringSession(sessionString) // USE the saved session
const client = new TelegramClient(session, apiId, apiHash)
await client.signIn(phoneCode)
```

### 3. Database Migration Locking (historical lesson)

**Problem**: In serverless deployments, `prisma migrate deploy` failed with `P1002 - Postgres advisory lock timeout (10000ms)`.

**Cause**: `prisma migrate deploy` requires an exclusive advisory lock to prevent concurrent migrations. In serverless environments this can time out because of:
- Unfinished previous locks
- Connection-pooling problems
- Execution-time limits

**Lesson**: ⚠️ **Serverless environments constrain database locking**
- Never run `prisma db push` against a deployed database — it bypasses the migration history the next deploy relies on
- Use `prisma migrate deploy` from CI/CD, over a connection the platform will not cut mid-run

**Current configuration**: `prisma migrate deploy` runs at container startup (`scripts/migrate-safe.js`) — a long-running container platform such as Railway has no serverless timeout limits, so the advisory lock works correctly.

### 4. React State Synchronization Patterns

**Problem**: After a successful Telegram authorization, the UI kept showing "Not authorized" although parsing worked.

**Cause**: A race condition between closing the dialog and `router.refresh()`. The form's local state did not update until the server reload.

**Lesson**: ⚠️ **For immediate UI feedback, update local state BEFORE the server refresh**
- `router.refresh()` is asynchronous and can take time
- Users expect instant feedback after an action
- Use the "optimistic updates" pattern

**Correct pattern**:
```typescript
onSuccess={(data) => {
  // 1. Update local state first (instant)
  setLocalState(prev => ({ ...prev, newData: data }))

  // 2. Show a toast (optional)
  toast.success("Success!")

  // 3. Then refresh for server-side data consistency
  router.refresh()
}
```

### 5. GramJS API Type Safety

**Problem**: The TypeScript build failed with an error about a nonexistent `workers` parameter in `client.downloadMedia()`.

**Cause**: Incorrect API usage — the parameter does not exist in `DownloadMediaInterface`.

**Lesson**: ⚠️ **Check the official documentation and types before using external APIs**
- GramJS evolves actively; the API can change
- TypeScript types are the source of truth for available parameters
- Never copy code from outdated examples without checking

**Useful links**:
- [GramJS API Reference](https://gram.js.org/beta/modules.html)
- [Telegram API Documentation](https://core.telegram.org/api)

### 6. 2FA SRP Verification

**Problem**: Entering the 2FA password returned the "two-factor authentication password required" error again and again.

**Cause**: The code ignored the password. SESSION_PASSWORD_NEEDED requires SRP verification through `computeCheck()`, not a direct password submission.

**Lesson**: ⚠️ **Telegram 2FA requires the SRP (Secure Remote Password) protocol**
- You cannot just send the password in plaintext
- Use the `telegram/Password` module for `computeCheck()`
- Correct flow:
  1. `auth.SignIn` → catch `SESSION_PASSWORD_NEEDED`
  2. `account.GetPassword()` → fetch the SRP parameters
  3. `computeCheck(passwordSrpResult, password)` → compute the SRP hash
  4. `auth.CheckPassword({ password: srpCheck })` → submit the hash

**Correct implementation**:
```typescript
import { computeCheck } from "telegram/Password"

try {
  await client.invoke(new Api.auth.SignIn({ phoneNumber, phoneCode, phoneCodeHash }))
} catch (error) {
  if (error.message?.includes("SESSION_PASSWORD_NEEDED")) {
    const passwordSrpResult = await client.invoke(new Api.account.GetPassword())
    const passwordSrpCheck = await computeCheck(passwordSrpResult, password)
    await client.invoke(new Api.auth.CheckPassword({ password: passwordSrpCheck }))
  }
}
```

### 7. Media Upload Timeouts — Video Skipping Strategy

**Problem**: Parsing channels with videos caused long delays and timeout errors during upload.

**Causes**:
1. Video files (2–3 MB+) took 30+ seconds each to upload
2. With retry logic (2 attempts), a single video could take 60+ seconds
3. Even processing 2–3 messages with videos caused a timeout

**Lesson**: ⚠️ **Optimize media upload for speed and reliability**
- Video files are too large for fast upload
- Photos upload instantly (0.3 MB ≈ 1–2 seconds)
- Skipping a video beats a timeout that loses the whole batch

**Final solution — skip videos**:
```typescript
// Galleries: upload only the first photo
const firstPhotoMessage = groupMessages.find(msg =>
  msg.media instanceof Api.MessageMediaPhoto && msg.media.photo
)

if (firstPhotoMessage) {
  const uploaded = await uploadTelegramMedia(client, firstPhotoMessage, cleanUsername)
  mediaUrls.push(uploaded.url)
  thumbnailUrl = uploaded.url
} else {
  console.log(`Gallery has no photos (only videos/documents), skipping media upload`)
}

// Single messages: upload photos only
if (message.media instanceof Api.MessageMediaPhoto && message.media.photo) {
  const uploaded = await uploadTelegramMedia(client, message, cleanUsername)
  mediaUrls.push(uploaded.url)
  thumbnailUrl = uploaded.url
}
// Skip videos and documents
else if (message.media instanceof Api.MessageMediaDocument) {
  console.log(`Skipping video/document for message ${message.id} (videos disabled)`)
}
```

**Current configuration** (`lib/blob-storage.ts`):
```typescript
const UPLOAD_CONFIG = {
  MAX_FILE_SIZE: 50 * 1024 * 1024,  // 50MB max
  DOWNLOAD_TIMEOUT: 30000,           // 30s for download (optimized)
  UPLOAD_TIMEOUT: 20000,             // 20s for R2 upload
  MAX_RETRIES: 2,                    // 2 attempts (reduced from 3)
  RETRY_DELAY: 1000,                 // 1s initial delay
}
```

**Optimization results:**
- ✅ Parsing 10 messages with photos: ~20–30 seconds (within the limit)
- ✅ Photos upload quickly and reliably
- ✅ Videos are skipped but the text is preserved
- ✅ Galleries with videos: text is preserved; if a photo exists, the first one is uploaded
- ✅ Works reliably on a long-running container (no serverless timeout limits)

### 8. AUTH_KEY_DUPLICATED During Rolling Deploys

**Problem**: Telegram session periodically invalidated after redeploys. Worker logs show error 406 `AUTH_KEY_DUPLICATED`, session becomes permanently unusable, all Telegram parsing stops until manual re-auth.

**Cause**: A rolling deploy keeps the old container alive for ~15–30 seconds after the new one starts. During overlap, both containers hold an active GramJS connection with the same session key. Telegram detects duplicate auth keys and permanently invalidates the session (error is not transient — retrying makes it worse).

There are **two independent failure modes** — both must be fixed:

1. **Shutdown order.** On SIGTERM, the worker must call `client.destroy()` FIRST, before queue drain or DB close. `destroy()` stops GramJS's internal update loop, releases borrowed media DC senders, and tears down the MTProto connection cleanly. `disconnect()` alone leaves the update loop polling.
2. **Signal propagation.** The previous start command `... & next start` backgrounds the worker and leaves `sh` at PID 1. The platform's SIGTERM reaches PID 1 only; non-interactive `sh` exits without forwarding to backgrounded children, and the kernel then SIGKILLs the worker. `shutdown()` never runs, `destroy()` never fires, and the in-worker shutdown fix is bypassed. Fixed by `scripts/start.sh`, which runs as PID 1, installs a `trap … TERM INT`, and forwards SIGTERM to both the worker and Next.js so the in-process shutdown handlers actually execute.

**Rules**:
- Shutdown sequence in `worker.ts`: `destroy()` → queue drain → DB close (not the reverse).
- Add a 3 s await after `destroy()` to give the MTProto teardown time to propagate before the process exits.
- Startup delay on the new container (≥ 30 s via `GRAMJS_STARTUP_DELAY_MS`) ensures the old container finishes destroying before the new one connects.
- The start command **must** propagate SIGTERM to every long-lived child. Never use `... & next start` inline. Use `scripts/start.sh` (or an init like `tini`/`dumb-init`).
- On `AUTH_KEY_DUPLICATED` in reconnect loops: stop retrying immediately — the session is permanently dead. Keep the worker process alive (for health checks) and surface the error clearly so an operator can trigger manual re-auth via `POST /telegram/reconnect`.
- **Cross-process session lock (RAD-328).** The startup delay is a bet, not a guarantee — a deploy whose new container is unhealthy can keep both containers alive for minutes. The worker therefore takes a Postgres session advisory lock before connecting (dedicated single-connection Prisma client, `connection_limit=1`), re-verifies ownership against `pg_locks` every 15 s, and destroys its client the moment ownership is lost. A worker that cannot acquire the lock throws and waits with capped backoff — that is a normal deploy-overlap state, not an error. `GET /telegram/session-check` reports `state` (`starting | active | invalid | unconfigured | unavailable`); `/health` adds `gramjsState` and `lockWaitSeconds` so a lock-waiting worker is distinguishable from a dead Telegram session. The lock must be on a **direct** Postgres connection: transaction-mode poolers (any `pooler` hostname, or `pgbouncer=true`) void session advisory locks.
- Shutdown order is owned by `disposeGramJSSession()`: `destroy()` → release the session lock → flush queues → close DB. If the client cannot be destroyed (throws or times out), the lock is deliberately **kept** and the process exits, so the orphan dies with the process and no peer can connect alongside it.

**Correct shutdown order in worker.ts**:
```typescript
// SIGTERM handler — destroy FIRST
process.on("SIGTERM", async () => {
  await client.destroy()           // step 1: release session
  await new Promise(r => setTimeout(r, 3000))  // give MTProto time to close
  await queue.shutdown()           // step 2: drain pending items
  await db.$disconnect()           // step 3: close DB
  process.exit(0)
})
```

**Correct entrypoint `scripts/start.sh`**:
```sh
#!/bin/sh
set -e
node scripts/migrate-safe.js

npx tsx lib/story-aggregator/worker.ts &
WORKER_PID=$!
next start &
NEXT_PID=$!

term() { kill -TERM "$WORKER_PID" "$NEXT_PID" 2>/dev/null || true; }
trap term TERM INT
wait
```

Regression test: `__tests__/start-script-signal.test.ts` spawns `start.sh` with stubbed children, sends SIGTERM, and asserts the stub worker's trap actually fires (i.e., it didn't get SIGKILLed).

**AUTH_KEY_DUPLICATED circuit-breaker in `attemptReconnect()`**:
```typescript
if (error.message?.includes("AUTH_KEY_DUPLICATED")) {
  console.error("Session permanently invalidated — stopping reconnect loop")
  return  // do NOT retry; worker stays alive for health checks
}
```

## Additional Resources

- [GramJS Documentation](https://gram.js.org/)
- [Telegram API Documentation](https://core.telegram.org/api)
- [my.telegram.org](https://my.telegram.org) — obtaining API credentials

---

**Document version**: 2.3
**Last updated**: 2026-04-08
**Author**: Radaric Development Team

**Changes in version 2.3:**
- ✅ **CRITICAL DECISION**: Skip videos for upload reliability and speed
- ✅ Photos only (videos and documents are skipped)
- ✅ Parse 10 messages instead of 20 for reliability
- ✅ Reduced retries (2 attempts) and timeouts (30 s download, 20 s upload)
- ✅ Updated the documentation to describe the current implementation

**Changes in version 2.2:**
- ✅ Added gallery (grouped media/album) support
- ✅ Implemented timeout handling for media upload
- ✅ Added retry logic with exponential backoff
- ✅ Set a file-size limit (50 MB)
- ✅ Documented the issue with parsing channels that have galleries

**Changes in version 2.1:**
- ✅ Added the Common Pitfalls section
- ✅ Documented 7 critical mistakes and their fixes
- ✅ Fixed the authorization status display in the UI
- ✅ Documented the advisory-lock timeout problem in serverless deployments
- ✅ Added best practices to prevent typical mistakes

**Changes in version 2.0:**
- ✅ Added full 2FA (two-factor authentication) support
- ✅ Fixed the authorization-code expiry problem
- ✅ Added media-storage integration (originally Vercel Blob, migrated to Cloudflare R2)
- ✅ Improved the documentation with step-by-step instructions
- ✅ Added implementation details
