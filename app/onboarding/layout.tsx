import { VerifyEmailNotice } from "@/components/auth/verify-email-notice"
import { AiNotConfiguredNotice } from "@/components/system/ai-not-configured-notice"

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      {/* RAD-297/RAD-293: recovery paths a brand-new account may actually need. */}
      <VerifyEmailNotice />
      <AiNotConfiguredNotice />
      <div className="max-w-2xl mx-auto py-12 px-6">{children}</div>
    </div>
  )
}
