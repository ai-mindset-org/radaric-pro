// @vitest-environment node

/**
 * RAD-221 — integration tokens are sealed at rest.
 *
 * Contract:
 *  - a sealed value never contains the plaintext and differs on every write;
 *  - it opens only for the same column and the same row (associated data);
 *  - tampering, a missing key or an unknown key fail loudly, never return junk;
 *  - legacy plaintext passes through unchanged (code ships before the backfill,
 *    and `--decrypt` can roll the data back without a code revert);
 *  - rotation: a value sealed with TOKEN_ENC_KEY_PREVIOUS still opens.
 */

import { randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ENCRYPTED_PREFIX,
  TOKEN_PURPOSE,
  TokenDecryptError,
  TokenKeyError,
  currentTokenKeyId,
  decryptToken,
  encryptToken,
  isEncryptedToken,
  tokenKeyId,
} from "@/lib/token-crypto"

const KEY_A = randomBytes(32).toString("hex")
const KEY_B = randomBytes(32).toString("base64")
const TOKEN = "ntn_TESTTOKEN_0123456789abcdefghijklmnopqrstuvwxyz"
const P = TOKEN_PURPOSE.userNotionToken

const saved = { cur: process.env.TOKEN_ENC_KEY, prev: process.env.TOKEN_ENC_KEY_PREVIOUS }

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = KEY_A
  delete process.env.TOKEN_ENC_KEY_PREVIOUS
})

afterEach(() => {
  if (saved.cur === undefined) delete process.env.TOKEN_ENC_KEY
  else process.env.TOKEN_ENC_KEY = saved.cur
  if (saved.prev === undefined) delete process.env.TOKEN_ENC_KEY_PREVIOUS
  else process.env.TOKEN_ENC_KEY_PREVIOUS = saved.prev
})

describe("encryptToken / decryptToken", () => {
  it("round-trips, and the sealed form never contains the plaintext", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    expect(sealed.startsWith(ENCRYPTED_PREFIX)).toBe(true)
    expect(isEncryptedToken(sealed)).toBe(true)
    expect(sealed).not.toContain(TOKEN)
    expect(sealed).not.toContain(Buffer.from(TOKEN).toString("base64"))
    expect(decryptToken(sealed, P, "user-1")).toBe(TOKEN)
  })

  it("uses a fresh IV: sealing the same token twice gives two different values", () => {
    expect(encryptToken(TOKEN, P, "user-1")).not.toBe(encryptToken(TOKEN, P, "user-1"))
  })

  it("binds the value to its row: another user's row does not open it", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    expect(() => decryptToken(sealed, P, "user-2")).toThrow(TokenDecryptError)
  })

  it("binds the value to its column: another purpose does not open it", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    expect(() => decryptToken(sealed, TOKEN_PURPOSE.globalNotionToken, "user-1")).toThrow(TokenDecryptError)
  })

  it("rejects a tampered ciphertext", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    const parts = sealed.split(":")
    const ct = Buffer.from(parts[5], "base64url")
    ct[0] ^= 0x01
    parts[5] = ct.toString("base64url")
    expect(() => decryptToken(parts.join(":"), P, "user-1")).toThrow(TokenDecryptError)
  })

  it("rejects a malformed sealed value", () => {
    expect(() => decryptToken(`${ENCRYPTED_PREFIX}abc`, P, "user-1")).toThrow(TokenDecryptError)
  })

  it("passes legacy plaintext through unchanged, with or without a key", () => {
    expect(decryptToken(TOKEN, P, "user-1")).toBe(TOKEN)
    delete process.env.TOKEN_ENC_KEY
    expect(decryptToken(TOKEN, P, "user-1")).toBe(TOKEN)
  })

  it("refuses to store a token when TOKEN_ENC_KEY is unset", () => {
    delete process.env.TOKEN_ENC_KEY
    expect(() => encryptToken(TOKEN, P, "user-1")).toThrow(TokenKeyError)
  })

  it("cannot open a sealed value once the key is gone, and says why", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    delete process.env.TOKEN_ENC_KEY
    expect(() => decryptToken(sealed, P, "user-1")).toThrow(TokenKeyError)
  })

  it("refuses to seal an already sealed value (no double encryption)", () => {
    const sealed = encryptToken(TOKEN, P, "user-1")
    expect(() => encryptToken(sealed, P, "user-1")).toThrow()
  })

  it("rejects a malformed key instead of sealing with it", () => {
    process.env.TOKEN_ENC_KEY = "too-short"
    expect(() => encryptToken(TOKEN, P, "user-1")).toThrow(TokenKeyError)
    process.env.TOKEN_ENC_KEY = randomBytes(16).toString("hex")
    expect(() => encryptToken(TOKEN, P, "user-1")).toThrow(TokenKeyError)
  })

  it("rejects a 44-character base64-looking key with invalid characters", () => {
    process.env.TOKEN_ENC_KEY = KEY_B.slice(0, 10) + "!" + KEY_B.slice(11)
    expect(() => encryptToken(TOKEN, P, "user-1")).toThrow(TokenKeyError)
  })

  it("accepts a base64 key as well as a hex key", () => {
    process.env.TOKEN_ENC_KEY = KEY_B
    expect(decryptToken(encryptToken(TOKEN, P, "user-1"), P, "user-1")).toBe(TOKEN)
  })
})

describe("rotation", () => {
  it("names the sealing key, and a value sealed with the previous key still opens", () => {
    const oldSealed = encryptToken(TOKEN, P, "user-1")
    const oldId = currentTokenKeyId()
    expect(tokenKeyId(oldSealed)).toBe(oldId)

    process.env.TOKEN_ENC_KEY = KEY_B
    process.env.TOKEN_ENC_KEY_PREVIOUS = KEY_A
    expect(currentTokenKeyId()).not.toBe(oldId)
    expect(decryptToken(oldSealed, P, "user-1")).toBe(TOKEN)

    const newSealed = encryptToken(TOKEN, P, "user-1")
    expect(tokenKeyId(newSealed)).toBe(currentTokenKeyId())

    delete process.env.TOKEN_ENC_KEY_PREVIOUS
    expect(() => decryptToken(oldSealed, P, "user-1")).toThrow(TokenKeyError)
    expect(decryptToken(newSealed, P, "user-1")).toBe(TOKEN)
  })
})
