import { cookies } from "next/headers"
import { SignupForm } from "@/components/auth/signup-form"
import { isTrialOfferOpen, isTrialRef, TRIAL_REF_COOKIE } from "@/lib/trial-ref"

// RAD-293: read the same conditionals lib/auth.ts uses to register providers,
// at REQUEST time, and hand them to the client form.
export const dynamic = "force-dynamic"

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>
}) {
  // The trial line follows the same ref the account will be granted on: the
  // query param on a direct visit, the proxy's cookie after a landing CTA —
  // and only while the offer is open, like the grant itself.
  const { ref } = await searchParams
  const trial =
    isTrialOfferOpen() &&
    (isTrialRef(typeof ref === "string" ? ref : null) ||
      isTrialRef((await cookies()).get(TRIAL_REF_COOKIE)?.value))
  return (
    <SignupForm
      oauth={{
        google: Boolean(process.env.GOOGLE_CLIENT_ID),
        apple: Boolean(process.env.APPLE_ID),
      }}
      trial={trial}
    />
  )
}
