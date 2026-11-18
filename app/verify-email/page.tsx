import Link from "next/link"
import { ResendVerificationButton } from "@/components/auth/resend-verification-button"

const COPY: Record<string, { title: string; body: string }> = {
  verified: {
    title: "Email verified",
    body: "Your email is confirmed — AI features are unlocked.",
  },
  expired: {
    title: "This link has expired",
    body: "Verification links are valid for 24 hours. Sign in and request a fresh one.",
  },
  used: {
    title: "This link was already used",
    body: "If your email is already verified, you're all set. Otherwise request a new link.",
  },
  invalid: {
    title: "This link isn't valid",
    body: "The link is missing or malformed. Sign in and request a new verification email.",
  },
  error: {
    title: "Something went wrong",
    body: "We couldn't verify this link. Please try again in a moment.",
  },
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status = "invalid" } = await searchParams
  const copy = COPY[status] ?? COPY.invalid

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
      <p className="text-sm text-muted-foreground">{copy.body}</p>
      {status !== "verified" && <ResendVerificationButton />}
      <Link href="/posts" className="text-sm font-medium link">
        Continue to Radaric
      </Link>
    </main>
  )
}
