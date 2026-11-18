import Link from "next/link"

/**
 * The neutral page a self-hosted install shows at `/terms` and `/privacy`.
 *
 * The hosted text names the service operator, its prices and the radaric.pro
 * address — none of which are true of someone else's install. The operator is
 * told to replace the page; SELF_HOSTING.md carries the same instruction.
 */
export function SelfHostedLegalPage({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-3xl font-bold">{title}</h1>
      <p className="mt-8 text-base leading-relaxed text-muted-foreground">{children}</p>

      <div className="mt-12">
        <Link href="/" className="text-sm link">
          &larr; Back to home
        </Link>
      </div>
    </div>
  )
}
