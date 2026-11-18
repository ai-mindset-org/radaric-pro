"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"

type State = "idle" | "sending" | "sent" | "error"

/**
 * Resend a verification link for the signed-in account (RAD-297). Shown on the
 * verify page for non-verified statuses; the endpoint is rate-limited per user.
 */
export function ResendVerificationButton() {
  const [state, setState] = useState<State>("idle")
  const [message, setMessage] = useState("")

  async function resend() {
    setState("sending")
    try {
      const res = await fetch("/api/auth/resend-verification", { method: "POST" })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setState("sent")
        setMessage("Verification email sent — check your inbox.")
        return
      }
      if (res.status === 429) {
        setState("error")
        setMessage("Too many requests — try again in a few minutes.")
        return
      }
      if (res.status === 401) {
        setState("error")
        setMessage("Sign in first, then request a new link.")
        return
      }
      setState("error")
      setMessage(data.error || "Could not send the email. Try again later.")
    } catch {
      setState("error")
      setMessage("Could not send the email. Try again later.")
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button onClick={resend} disabled={state === "sending"} variant="outline">
        {state === "sending" ? "Sending…" : "Resend verification email"}
      </Button>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
    </div>
  )
}
