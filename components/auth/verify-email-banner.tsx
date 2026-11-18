"use client"

import { MailWarning } from "lucide-react"
import { ResendVerificationButton } from "@/components/auth/resend-verification-button"

/**
 * Persistent dashboard banner for unverified accounts (RAD-297) — the one
 * place with the resend action. AI-spend routes answer 403 EMAIL_NOT_VERIFIED;
 * the streaming ones send it to an EventSource as an in-band frame instead
 * (RAD-406), and the processing and feed cards' copy for it points here.
 */
export function VerifyEmailBanner() {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline bg-primary-subtle px-4 py-2.5 text-primary-subtle-foreground"
    >
      <p className="flex items-center gap-2 text-sm">
        <MailWarning className="h-4 w-4 shrink-0" aria-hidden />
        Verify your email to run AI features. Check your inbox for the link.
      </p>
      <ResendVerificationButton />
    </div>
  )
}
