import Link from "next/link"

/**
 * Project-owned Auth.js error page (RAD-325). The framework default is an
 * unstyled "Access Denied" with no way forward; this one explains the
 * pre-hijacking refusal and the actual recovery path.
 */
export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  const isLinkBlocked = error === "AccessDenied"

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        {isLinkBlocked ? "This email already has an account" : "Couldn't sign you in"}
      </h1>
      {isLinkBlocked ? (
        <>
          <p className="text-sm text-muted-foreground">
            An account with this address was created with a password and never verified, so we
            don&apos;t link it to Google or Apple automatically.
          </p>
          <p className="text-sm text-muted-foreground">
            Sign in with your password (or reset it), verify your email, then connect the provider
            from the same address.
          </p>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Something went wrong during sign-in. Please try again.
        </p>
      )}
      <div className="flex items-center gap-4">
        <Link href="/signup" className="text-sm font-medium link">
          Back to sign in
        </Link>
        <Link href="/forgot-password" className="text-sm font-medium link">
          Forgot password
        </Link>
      </div>
    </main>
  )
}
