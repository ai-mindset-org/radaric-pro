/**
 * Encryption at rest for third-party credentials stored in the database
 * (RAD-221). Today: `user_settings.notion_token` and the
 * deprecated `settings.notion_token`.
 *
 * Scheme: AES-256-GCM (node:crypto, no extra dependency), a fresh 96-bit IV per
 * value, and associated data that binds every ciphertext to its column and row,
 * so a value copied into another user's row does not decrypt there. Stored form:
 *
 *   enc:v1:<keyId>:<iv>:<tag>:<ciphertext>      (base64url parts)
 *
 * `keyId` is the first 8 hex characters of a SHA-256 over the key. It names the
 * key that sealed the value, which is what makes rotation possible:
 *
 *   TOKEN_ENC_KEY           — the current key; every write uses it. Required to
 *                             store a token; reads of legacy plaintext work
 *                             without it.
 *   TOKEN_ENC_KEY_PREVIOUS  — optional; still accepted for reads during a
 *                             rotation, until `scripts/encrypt-notion-tokens.ts
 *                             --rotate` has re-sealed every row.
 *
 * A key is 32 bytes, given as 64 hex characters (`openssl rand -hex 32`) or as
 * base64 (`openssl rand -base64 32`). Procedure: docs/SECURITY.md.
 *
 * A value without the `enc:v1:` prefix is legacy plaintext and is returned as
 * is, so the code can ship before the backfill runs and the backfill can be
 * rolled back (`--decrypt`) without a code revert.
 *
 * Never log a value that passes through this module, sealed or not.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

export const ENCRYPTED_PREFIX = "enc:v1:"

const ALGORITHM = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16

/** Associated-data purposes. Each names one column; changing one orphans its rows. */
export const TOKEN_PURPOSE = {
  userNotionToken: "user_settings.notion_token",
  globalNotionToken: "settings.notion_token",
} as const
export type TokenPurpose = (typeof TOKEN_PURPOSE)[keyof typeof TOKEN_PURPOSE]

/** Thrown when a token must be sealed or opened and no usable key is configured. */
export class TokenKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TokenKeyError"
  }
}

/** Thrown when a sealed value fails to open (wrong row, tampered, malformed). */
export class TokenDecryptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TokenDecryptError"
  }
}

type Key = { id: string; bytes: Buffer }

function parseKey(name: string, raw: string): Key {
  const value = raw.trim()
  let bytes: Buffer
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    bytes = Buffer.from(value, "hex")
  } else {
    bytes = Buffer.from(value, "base64")
    // Buffer.from silently drops invalid base64 characters; a round trip
    // catches a mistyped or truncated key instead of sealing with garbage.
    const canonical = bytes.toString("base64").replace(/=+$/, "")
    if (bytes.length !== 32 || canonical !== value.replace(/=+$/, "")) {
      throw new TokenKeyError(
        `${name} must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64 (openssl rand -base64 32)`,
      )
    }
  }
  const id = createHash("sha256").update("radaric-token-key\0").update(bytes).digest("hex").slice(0, 8)
  return { id, bytes }
}

function readKey(name: string, raw: string | undefined): Key | null {
  if (!raw || raw.trim() === "") return null
  return parseKey(name, raw)
}

// Read on every call (not cached at import) so a rotation needs only a restart
// and tests can switch keys. Literal `process.env.X` reads keep the env-docs
// truth test able to see them.
function currentKey(): Key | null {
  return readKey("TOKEN_ENC_KEY", process.env.TOKEN_ENC_KEY)
}

function keyring(): Key[] {
  const keys: Key[] = []
  const current = currentKey()
  if (current) keys.push(current)
  const previous = readKey("TOKEN_ENC_KEY_PREVIOUS", process.env.TOKEN_ENC_KEY_PREVIOUS)
  if (previous && previous.id !== current?.id) keys.push(previous)
  return keys
}

/** The current key's id, or null when TOKEN_ENC_KEY is unset. Throws on a malformed key. */
export function currentTokenKeyId(): string | null {
  return currentKey()?.id ?? null
}

export function isEncryptedToken(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX)
}

function aad(purpose: TokenPurpose, rowKey: string): Buffer {
  return Buffer.from(`${purpose}\0${rowKey}`, "utf8")
}

/** Seal a plaintext token for one column of one row. Throws TokenKeyError without TOKEN_ENC_KEY. */
export function encryptToken(plaintext: string, purpose: TokenPurpose, rowKey: string): string {
  if (isEncryptedToken(plaintext)) {
    throw new TokenDecryptError("refusing to seal a value that is already sealed")
  }
  const key = currentKey()
  if (!key) {
    throw new TokenKeyError("TOKEN_ENC_KEY is not set: integration tokens cannot be stored")
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key.bytes, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(aad(purpose, rowKey))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return (
    ENCRYPTED_PREFIX +
    [key.id, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":")
  )
}

/** The key id a sealed value names, or null for plaintext / malformed input. */
export function tokenKeyId(stored: string): string | null {
  if (!isEncryptedToken(stored)) return null
  const parts = stored.slice(ENCRYPTED_PREFIX.length).split(":")
  return parts.length === 4 ? parts[0] : null
}

/**
 * Open a stored value. Plaintext (no prefix) comes back unchanged: rows written
 * before RAD-221, or restored by `--decrypt`. Throws TokenKeyError when the key
 * that sealed it is not configured, TokenDecryptError when it does not open.
 */
export function decryptToken(stored: string, purpose: TokenPurpose, rowKey: string): string {
  if (!isEncryptedToken(stored)) return stored
  const parts = stored.slice(ENCRYPTED_PREFIX.length).split(":")
  if (parts.length !== 4) throw new TokenDecryptError("malformed sealed token")
  const [keyId, ivPart, tagPart, ctPart] = parts
  const key = keyring().find((k) => k.id === keyId)
  if (!key) {
    throw new TokenKeyError(
      `sealed token names key ${keyId}, which is neither TOKEN_ENC_KEY nor TOKEN_ENC_KEY_PREVIOUS`,
    )
  }
  const iv = Buffer.from(ivPart, "base64url")
  const tag = Buffer.from(tagPart, "base64url")
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenDecryptError("malformed sealed token")
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key.bytes, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(aad(purpose, rowKey))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8")
  } catch {
    throw new TokenDecryptError("sealed token did not open (wrong row, wrong key or tampered)")
  }
}
