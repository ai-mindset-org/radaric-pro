import type { Metadata } from "next"
import Link from "next/link"
import { SelfHostedLegalPage } from "@/components/landing/self-hosted-legal-page"
import { getContactEmail } from "@/lib/contact"
import { isSelfHosted } from "@/lib/self-hosted"

// The neutral self-hosted page follows SELF_HOSTED at request time. The image
// is built without the flag, so a build-time choice would ship the hosted text
// into every self-hosted install.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Privacy Policy",
}

export default function PrivacyPage() {
  if (isSelfHosted()) {
    return (
      <SelfHostedLegalPage title="Privacy Policy">
        This is a self-hosted Radaric instance. Its operator is responsible for
        its privacy practices and should replace this page with their own — see{" "}
        <code>SELF_HOSTING.md</code> in the repository.
      </SelfHostedLegalPage>
    )
  }

  const contactEmail = getContactEmail()

  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-3xl font-bold">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated: October 2026
      </p>

      <div className="mt-8 space-y-6 text-base leading-relaxed text-muted-foreground">
        <section>
          <h2 className="text-lg font-semibold text-foreground">What we collect</h2>
          <p>
            Account information (username, email), content source configurations,
            AI filtering preferences, and feedback (approve/reject decisions with
            optional comments). We also collect standard server logs (IP address,
            browser type, timestamps).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">How we use it</h2>
          <p>
            To operate and improve the Service. Your feedback trains your personal
            AI filter. We do not use your data to train models for other users.
            Each user&apos;s filter is isolated.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Content access</h2>
          <p>
            Radaric accesses content from your connected sources (RSS, Telegram,
            Twitter, YouTube) in read-only mode. We do not modify, delete, or
            publish content on your behalf. Telegram connections use a secure
            session that does not expose your account credentials.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Data storage</h2>
          <p>
            Data is stored on secure servers (Railway, PostgreSQL). Passwords are
            hashed with bcrypt. Connections use HTTPS. We do not store payment card
            details — all payments are processed by Stripe.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Third parties</h2>
          <p>
            We use Stripe for payments, AI providers (Anthropic, Google, OpenAI)
            for content filtering, and Cloudflare R2 for media storage. We do not
            sell, rent, or share your personal data with third parties for
            marketing purposes.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Data retention</h2>
          <p>
            Your data is retained while your account is active. After account
            deletion, we remove your data within 30 days. Aggregated,
            non-identifying statistics may be retained.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Your rights</h2>
          <p>
            You can request export or deletion of your data by contacting us at{" "}
            <a
              href={`mailto:${contactEmail}`}
              className="link"
            >
              {contactEmail}
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Cookies</h2>
          <p>
            All of our cookies are first-party: set by radaric.pro, read only
            by radaric.pro, and never shared. We use no third-party analytics
            or advertising cookies.
          </p>
          <ul className="list-disc space-y-1 pl-6">
            <li>
              Session and sign-in cookies (<code>authjs.*</code>,{" "}
              <code>next-auth.*</code>), which keep you signed in for up to 30
              days, protect the sign-in forms and secure the Google and Apple
              sign-in round-trip.
            </li>
            <li>
              Interface preferences (<code>sidebar-open</code>,{" "}
              <code>folders-collapsed</code>, one year) and a visit marker
              (<code>radaric_visit</code>, one hour of inactivity) used to
              decide what to show when you return.
            </li>
            <li>
              Sign-up source (<code>radaric_src</code>, up to 30 days): if you
              arrive through a link that names where it came from, such as a
              directory listing, we remember that name and save it with your
              account if you sign up, so we know which listings bring people.
              It holds only that name, nothing about you. The cookie is removed
              when your account is created.
            </li>
            <li>
              Launch offer (<code>radaric_ref</code>, up to 7 days): if you
              arrive through a launch-offer link, it lets us apply the offer
              when you sign up, and is removed once it has been applied.
            </li>
          </ul>
          <p>
            We also keep a few display preferences (how posts open, which
            stories you have viewed, the last source type you added, filter
            state) in your browser&apos;s local storage. They never leave your
            device.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">Changes</h2>
          <p>
            We may update this policy. Material changes will be communicated via
            email or in-app notice.
          </p>
        </section>
      </div>

      <div className="mt-12">
        <Link href="/" className="text-sm link">
          &larr; Back to home
        </Link>
      </div>
    </div>
  )
}
