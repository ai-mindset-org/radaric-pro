"use client"

import { Badge } from "@/components/ui/badge"
import { AlertTriangle, CheckCircle, Loader2, XCircle } from "lucide-react"
import type { TelegramSessionState } from "@/lib/telegram-session-state"

/**
 * Truthful Telegram status badge (RAD-328).
 *
 * The previous badge was driven by `telegramPhoneNumber` presence in the
 * database — a green "Authorized" while the session key was dead and every
 * parse request was failing. This one renders the live worker state; only
 * `active` is green, and an unreachable worker reads as `unknown`, never as
 * authorized.
 */
export function TelegramAuthBadge({
  state,
  phoneNumber,
}: {
  state: TelegramSessionState
  phoneNumber?: string | null
}) {
  if (state === "active") {
    return (
      <Badge variant="default" className="gap-1">
        <CheckCircle className="h-[14px] w-[14px]" />
        {phoneNumber ? `Authorized: ${phoneNumber}` : "Authorized"}
      </Badge>
    )
  }

  if (state === "starting") {
    return (
      <Badge variant="info" className="gap-1">
        <Loader2 className="h-[14px] w-[14px] animate-spin" />
        Connecting…
      </Badge>
    )
  }

  if (state === "invalid") {
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-[14px] w-[14px]" />
        Session expired
      </Badge>
    )
  }

  if (state === "unknown") {
    return (
      <Badge variant="warning" className="gap-1">
        <AlertTriangle className="h-[14px] w-[14px]" />
        Status unknown
      </Badge>
    )
  }

  return (
    <Badge variant="secondary" className="gap-1">
      <XCircle className="h-[14px] w-[14px]" />
      Not authorized
    </Badge>
  )
}

/** The explanatory line under the badge — one sentence per state. */
export function telegramAuthHint(state: TelegramSessionState): string {
  switch (state) {
    case "active":
      return "You can parse Telegram channels"
    case "starting":
      return "Telegram is connecting — parsing is unavailable until it finishes"
    case "invalid":
      return "The Telegram session is invalid or expired — sign in again to restore parsing"
    case "unknown":
      return "The worker is not reachable — cannot confirm the Telegram session"
    case "unconfigured":
      return "Sign in to parse Telegram channels"
  }
}
