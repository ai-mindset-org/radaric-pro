import { TelegramClient } from "telegram"
import { StringSession } from "telegram/sessions"
import { Api } from "telegram/tl"
import { computeCheck } from "telegram/Password"
import { db } from "@/lib/db"
import { isTelegramSessionState, type TelegramSessionState } from "@/lib/telegram-session-state"

import type { ParsedItem } from "./rss"

export interface ParsedTelegramItem extends ParsedItem {
  messageId: number
  channelUsername: string
}

export interface TelegramAuthRequest {
  phoneNumber: string
  phoneCodeHash?: string
}

const WORKER_URL = `http://localhost:${process.env.WORKER_HEALTH_PORT || "3001"}`
const WORKER_MAX_RETRIES = 6
const WORKER_INITIAL_DELAY_MS = 3_000

async function fetchWorkerWithRetry<T>(
  url: string,
  init: RequestInit,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker JSON is untyped on the wire
  transform: (data: any) => T,
  label: string
): Promise<T> {
  let delay = WORKER_INITIAL_DELAY_MS

  for (let attempt = 1; attempt <= WORKER_MAX_RETRIES; attempt++) {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (err) {
      // A timeout/abort is NOT an unreachable worker: re-running the whole
      // parse would double the media downloads still running behind the
      // timed-out response (RAD-359 plan D9). Fail once, no retry.
      const name = err instanceof Error ? err.name : ""
      if (name === "TimeoutError" || name === "AbortError") {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to ${label}: worker timed out (${msg})`)
      }
      if (attempt < WORKER_MAX_RETRIES) {
        console.warn(`[Telegram Parser] Worker unreachable (attempt ${attempt}/${WORKER_MAX_RETRIES}), retrying in ${delay / 1000}s...`)
        await new Promise(r => setTimeout(r, delay))
        delay = Math.min(delay * 2, 30_000)
        continue
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to ${label}: worker unreachable after ${WORKER_MAX_RETRIES} attempts (${msg})`)
    }

    if (response.ok) {
      const data = await response.json()
      return transform(data)
    }

    const errorText = await response.text()
    const isTransient = response.status === 503 || response.status === 502 ||
      (response.status === 400 && errorText.includes("not available"))

    if (isTransient && attempt < WORKER_MAX_RETRIES) {
      console.warn(`[Telegram Parser] Worker not ready (${response.status}, attempt ${attempt}/${WORKER_MAX_RETRIES}), retrying in ${delay / 1000}s...`)
      await new Promise(r => setTimeout(r, delay))
      delay = Math.min(delay * 2, 30_000)
      continue
    }

    throw new Error(`Failed to ${label}: ${errorText}`)
  }

  throw new Error(`Failed to ${label}: max retries exceeded`)
}

/**
 * Start Telegram authentication flow (sends code to phone)
 */
export async function startTelegramAuth(
  phoneNumber: string
): Promise<{ phoneCodeHash: string; sessionString: string }> {
  try {
    const settings = await db.settings.findFirst()

    if (!settings?.telegramApiId || !settings?.telegramApiHash) {
      throw new Error("Telegram API credentials not configured in settings")
    }

    const session = new StringSession("")
    const client = new TelegramClient(
      session,
      settings.telegramApiId,
      settings.telegramApiHash,
      {
        connectionRetries: 5,
      }
    )

    await client.connect()

    const result = await client.sendCode(
      {
        apiId: settings.telegramApiId,
        apiHash: settings.telegramApiHash,
      },
      phoneNumber
    )

    // Save the session string BEFORE disconnecting
    // This session is needed for verifyTelegramCode
    const sessionString = session.save()

    await client.disconnect()

    return {
      phoneCodeHash: result.phoneCodeHash,
      sessionString, // Return session so it can be used in verify step
    }
  } catch (error) {
    console.error("Error starting Telegram auth:", error)
    throw new Error(`Failed to send Telegram code: ${error}`)
  }
}

/**
 * Verify Telegram code and save session
 */
export async function verifyTelegramCode(
  phoneNumber: string,
  phoneCode: string,
  phoneCodeHash: string,
  tempSessionString: string,
  password?: string
): Promise<{ success: boolean; sessionString: string }> {
  try {
    const settings = await db.settings.findFirst()

    if (!settings?.telegramApiId || !settings?.telegramApiHash) {
      throw new Error("Telegram API credentials not configured in settings")
    }

    // Use the session from startTelegramAuth, NOT a new empty session
    const session = new StringSession(tempSessionString)
    const client = new TelegramClient(
      session,
      settings.telegramApiId,
      settings.telegramApiHash,
      {
        connectionRetries: 5,
      }
    )

    await client.connect()

    try {
      // First, try to sign in with the phone code
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phoneNumber,
          phoneCodeHash: phoneCodeHash,
          phoneCode: phoneCode,
        })
      )
    } catch (error: unknown) {
      // Check if 2FA password is required
      const err = error as { message?: string }
      if (err.message?.includes("SESSION_PASSWORD_NEEDED")) {
        // If password was not provided, throw error to request it
        if (!password) {
          throw error
        }

        // If password was provided, use it for 2FA authentication
        try {
          const passwordSrpResult = await client.invoke(new Api.account.GetPassword())
          const passwordSrpCheck = await computeCheck(passwordSrpResult, password)

          await client.invoke(
            new Api.auth.CheckPassword({
              password: passwordSrpCheck,
            })
          )
        } catch (passwordError: unknown) {
          console.error("2FA password verification failed:", passwordError)
          throw new Error(`2FA password verification failed: ${passwordError instanceof Error ? passwordError.message : passwordError}`)
        }
      } else {
        // If it's a different error, throw it
        throw error
      }
    }

    const sessionString = (client.session as StringSession).save()

    // Save session string to database
    await db.settings.update({
      where: { id: settings.id },
      data: {
        telegramSessionString: sessionString,
        telegramPhoneNumber: phoneNumber,
      },
    })

    await client.disconnect()

    // Notify the worker to pick up the new session
    try {
      await fetch(`${WORKER_URL}/telegram/reconnect`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      })
      console.log("[Telegram Auth] Worker notified to reconnect with new session")
    } catch (err) {
      console.warn("[Telegram Auth] Could not notify worker to reconnect:", err instanceof Error ? err.message : err)
    }

    return {
      success: true,
      sessionString,
    }
  } catch (error) {
    console.error("Error verifying Telegram code:", error)
    throw new Error(`Failed to verify Telegram code: ${error}`)
  }
}

/**
 * Live Telegram session state from the worker.
 *
 * `unknown` covers a worker that is unreachable or answers something
 * unexpected — it must never collapse into "authorized". The old
 * implementation fell back to "does a session string exist in the DB?", which
 * reported a dead session as valid for exactly the outage this guards against
 * (RAD-328).
 */
export async function getTelegramSessionState(): Promise<TelegramSessionState> {
  try {
    const response = await fetch(`${WORKER_URL}/telegram/session-check`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return "unknown"
    const data = await response.json()
    if (data.valid === true) return "active"
    return isTelegramSessionState(data.state) ? data.state : "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Check if the Telegram session is live. Anything short of an active session —
 * including an unreachable worker — is not valid.
 */
export async function checkTelegramSession(): Promise<boolean> {
  return (await getTelegramSessionState()) === "active"
}

/**
 * Parse messages from a Telegram channel via the worker's GramJS connection.
 * The worker exposes /telegram/parse-channel to avoid AUTH_KEY_DUPLICATED errors
 * from multiple GramJS clients using the same session string.
 */
export async function parseTelegramChannel(
  channelUsername: string,
  limit: number = 20,
  skipMedia: boolean = false
): Promise<ParsedTelegramItem[]> {
  return fetchWorkerWithRetry<ParsedTelegramItem[]>(
    `${WORKER_URL}/telegram/parse-channel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelUsername, limit, skipMedia }),
      signal: AbortSignal.timeout(120_000),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker JSON is untyped on the wire
    (data) => data.items.map((item: any) => ({
      ...item,
      publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
    })),
    "parse Telegram channel"
  )
}

/**
 * Get channel metadata via the worker's GramJS connection
 */
export async function getTelegramChannelInfo(channelUsername: string): Promise<{
  name: string
  description?: string
  imageUrl?: string
}> {
  const cleanUsername = extractChannelUsername(channelUsername)
  return fetchWorkerWithRetry(
    `${WORKER_URL}/telegram/channel-info?username=${encodeURIComponent(cleanUsername)}`,
    { signal: AbortSignal.timeout(15_000) },
    (data) => data,
    "get Telegram channel info"
  )
}

/**
 * Extract channel username from various URL formats
 * Supports: @username, username, https://t.me/username, t.me/username, /username
 */
function extractChannelUsername(input: string): string {
  // Remove whitespace
  let username = input.trim()

  // Remove protocol and domain if present (https://t.me/username → username)
  username = username.replace(/^https?:\/\/(www\.)?t\.me\//i, "")

  // The web-preview form (t.me/s/username) keeps "s" as a path segment that
  // would otherwise become the username (RAD-359)
  username = username.replace(/^s\//, "")

  // Remove @ if present (@username → username)
  username = username.replace(/^@/, "")

  // Remove leading/trailing slashes (/username/ → username)
  username = username.replace(/^\/+|\/+$/g, "")

  // Remove any path segments after username (username/123 → username)
  const pathSegments = username.split("/")
  username = pathSegments[0]

  return username.trim()
}

/**
 * Disconnect Telegram session (logout)
 */
export async function disconnectTelegram(): Promise<void> {
  try {
    const settings = await db.settings.findFirst()

    if (!settings?.id) {
      throw new Error("Settings not found")
    }

    // Clear session from database
    await db.settings.update({
      where: { id: settings.id },
      data: {
        telegramSessionString: null,
        telegramPhoneNumber: null,
      },
    })
  } catch (error) {
    console.error("Error disconnecting Telegram:", error)
    throw new Error(`Failed to disconnect Telegram: ${error}`)
  }
}
