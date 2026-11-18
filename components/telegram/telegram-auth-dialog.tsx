"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"

interface TelegramAuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (phoneNumber: string) => void
}

export function TelegramAuthDialog({
  open,
  onOpenChange,
  onSuccess,
}: TelegramAuthDialogProps) {
  const [step, setStep] = useState<"phone" | "code" | "password">("phone")
  const [phoneNumber, setPhoneNumber] = useState("")
  const [phoneCode, setPhoneCode] = useState("")
  const [phoneCodeHash, setPhoneCodeHash] = useState("")
  const [sessionString, setSessionString] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [requiresPassword, setRequiresPassword] = useState(false)

  const resetDialog = () => {
    setStep("phone")
    setPhoneNumber("")
    setPhoneCode("")
    setPhoneCodeHash("")
    setSessionString("")
    setPassword("")
    setRequiresPassword(false)
    setIsLoading(false)
  }

  const handleSendCode = async () => {
    if (!phoneNumber) {
      toast.error("Enter your phone number")
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch("/api/telegram/auth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.details || data.error || "Failed to send code")
      }

      setPhoneCodeHash(data.phoneCodeHash)
      setSessionString(data.sessionString)
      setStep("code")
      toast.success(`Code sent to ${phoneNumber}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      toast.error(`Error: ${errorMessage}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleVerifyCode = async () => {
    if (!phoneCode) {
      toast.error("Enter the SMS code")
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch("/api/telegram/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber,
          phoneCode,
          phoneCodeHash,
          sessionString,
          password: requiresPassword ? password : undefined,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        // Check if 2FA is required
        if (data.requiresPassword) {
          setRequiresPassword(true)
          setStep("password")
          toast.info("Two-factor authentication password required")
          return
        }

        throw new Error(data.details || data.error || "Failed to verify code")
      }

      toast.success("Authorization successful!")
      resetDialog()
      onOpenChange(false)
      onSuccess(phoneNumber)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      toast.error(`Error: ${errorMessage}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    resetDialog()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Telegram Authorization</DialogTitle>
          <DialogDescription>
            {step === "phone" &&
              "Enter your phone number in international format"}
            {step === "code" && `Enter the code sent to ${phoneNumber}`}
            {step === "password" &&
              "Enter your two-factor authentication password"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {step === "phone" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  placeholder="+79001234567"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendCode()}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Use international format (e.g., +79001234567)
                </p>
              </div>

              <Button
                onClick={handleSendCode}
                disabled={isLoading || !phoneNumber}
                className="w-full"
              >
                {isLoading ? "Sending..." : "Send Code"}
              </Button>
            </>
          )}

          {step === "code" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="code">SMS Code</Label>
                <Input
                  id="code"
                  placeholder="12345"
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleVerifyCode()}
                  disabled={isLoading}
                  maxLength={5}
                />
                <p className="text-xs text-muted-foreground">
                  Telegram sent a 5-digit code to your number
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setStep("phone")}
                  disabled={isLoading}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={handleVerifyCode}
                  disabled={isLoading || !phoneCode}
                  className="flex-1"
                >
                  {isLoading ? "Verifying..." : "Confirm"}
                </Button>
              </div>
            </>
          )}

          {step === "password" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="password">2FA Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleVerifyCode()}
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  You have two-factor authentication enabled
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setStep("code")
                    setRequiresPassword(false)
                  }}
                  disabled={isLoading}
                  className="flex-1"
                >
                  Back
                </Button>
                <Button
                  onClick={handleVerifyCode}
                  disabled={isLoading || !password}
                  className="flex-1"
                >
                  {isLoading ? "Verifying..." : "Sign In"}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
