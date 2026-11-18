# Integration tokens at rest

How Radaric stores the third-party tokens users give it, and how to run, rotate and roll back the encryption. Reporting a vulnerability is covered by the root [`SECURITY.md`](../SECURITY.md).

## What is protected

| Column | Holds | Sealed |
|---|---|---|
| `user_settings.notion_token` | each user's Notion integration token, pasted in **Settings → Integrations** | yes (RAD-221) |
| `settings.notion_token` | deprecated global token; read only by the legacy one-off scripts `migrate-env-user.js` / `migrate-data-to-user.js`, which skip a sealed value | yes, by the backfill only |

A token never leaves the server in any form (RAD-380). `GET`, `PUT` and `PATCH /api/user-settings` answer with an allowlisted projection (`lib/user-settings-public.ts`) that carries `hasNotionToken: boolean` instead of the token, the settings page passes the same boolean to the form, and the form treats the field as write-only: it sends a token only when the user types a new one, and **Remove token** clears it. "Test Connection" without a typed token tests the saved one on the server.

The admin-only global settings (`settings.ai_api_key`, Telegram session, Parallel keys) are not sealed by this scheme yet.

## Scheme

`lib/token-crypto.ts`: AES-256-GCM from `node:crypto`, a random 96-bit IV per value, and associated data `"<column>\0<row key>"` (for user tokens the row key is the user id). A sealed value copied into another user's row, or into another column, fails to open. The stored form is

```
enc:v1:<keyId>:<iv>:<tag>:<ciphertext>
```

with base64url parts. `keyId` is the first 8 hex characters of a SHA-256 over the key: it names the key that sealed the value, and is what makes rotation work. A value without the `enc:v1:` prefix is legacy plaintext and is read as is, so the code runs correctly before the backfill and after a rollback.

| Variable | Role |
|---|---|
| `TOKEN_ENC_KEY` | Current key, 32 bytes: `openssl rand -hex 32` (64 hex characters) or `openssl rand -base64 32`. Every write uses it. Without it the server refuses to save a token (`PUT` answers 503) and cannot read sealed ones; legacy plaintext still reads. |
| `TOKEN_ENC_KEY_PREVIOUS` | Optional. Still accepted for reads during a rotation. |

`scripts/generate-env.sh` adds `TOKEN_ENC_KEY` to a self-host `.env`. Keep the key with the other secrets and keep it stable: losing it does not lose data, but every saved Notion token becomes unreadable and each user has to paste theirs again.

Where the token is used, it is opened per request (`lib/notion-token.ts`). Sending a post or a story to Notion and retrying an inbox item answer with an error when the token cannot be opened. Story polling and a post's story run carry on without the Notion export and log the reason, never the value.

## Turning it on for an existing database

1. Generate a key and set `TOKEN_ENC_KEY` in the app's environment (the worker shares it) before you start the version that reads it, so the first boot already has it.
2. Restart. Nothing changes in the database: plaintext rows keep working, and new saves are sealed.
3. Count, then seal, from a shell that has the app's environment (with Docker: `docker compose exec app sh`):

   ```bash
   npx tsx scripts/encrypt-notion-tokens.ts            # dry run: counts by state, writes nothing
   npx tsx scripts/encrypt-notion-tokens.ts --apply    # seal every plaintext token
   npx tsx scripts/encrypt-notion-tokens.ts            # expect plaintext=0
   ```

   The script prints counts only, never a token or a user id. Each write is conditional on the value it read, so a user saving a new token mid-run is never overwritten (the row is reported as skipped and the next run picks it up). Re-running is safe. Exit status 1 means some rows did not open; their counts are in the output and nothing was written for them.

No schema migration is involved: the column stays `text`, and the published migration baseline is unaffected.

## Rotating the key

1. Set `TOKEN_ENC_KEY_PREVIOUS` to the current key and `TOKEN_ENC_KEY` to a new one, restart.
2. `npx tsx scripts/encrypt-notion-tokens.ts --rotate` re-seals every row under the new key (and seals any plaintext left).
3. A dry run should show `sealed(other key)=0`. Then remove `TOKEN_ENC_KEY_PREVIOUS` and restart.

## Rolling back

`npx tsx scripts/encrypt-notion-tokens.ts --decrypt`, with the key that sealed the rows still set, writes every token back as plaintext. The code reads plaintext, so rolling back the data needs no code change. A dry run afterwards should show `sealed(current key)=0` and `sealed(other key)=0`; keep the key until it does.

If you ever run a version older than this encryption, decrypt first: an older version hands a sealed value straight to Notion, so every user with a sealed token would lose Notion export.
