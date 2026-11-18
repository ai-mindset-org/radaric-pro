import type { Metadata } from "next"
import Link from "next/link"
import { SelfHostedLegalPage } from "@/components/landing/self-hosted-legal-page"
import { isSelfHosted } from "@/lib/self-hosted"

// The neutral self-hosted page follows SELF_HOSTED at request time. The image
// is built without the flag, so a build-time choice would ship the hosted text
// into every self-hosted install.
export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Terms of Service",
}

export default function TermsPage() {
  if (isSelfHosted()) {
    return (
      <SelfHostedLegalPage title="Terms of Service">
        This is a self-hosted Radaric instance. Its operator is responsible for
        its terms of service and should replace this page with their own — see{" "}
        <code>SELF_HOSTING.md</code> in the repository.
      </SelfHostedLegalPage>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="text-3xl font-bold">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Last updated: March 2026
      </p>

      <div className="mt-8 space-y-6 text-base leading-relaxed text-muted-foreground">
        <section>
          <h2 className="text-lg font-semibold text-foreground">1. Service</h2>
          <p>
            Radaric (&quot;the Service&quot;) is an AI-powered content curation tool
            operated by Kirill Oleinichenko (&quot;we&quot;, &quot;us&quot;). By using the Service,
            you agree to these terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">2. Account</h2>
          <p>
            You must provide accurate information when creating an account. You are
            responsible for maintaining the security of your credentials. One person
            per account.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">3. Payment</h2>
          <p>
            Subscriptions are billed monthly ($59/month) or annually ($499/year)
            via Stripe. All prices are in USD. You can cancel at any time. Annual
            subscriptions include a 30-day money-back guarantee.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">4. Content Sources</h2>
          <p>
            The Service connects to RSS feeds, Telegram channels, Twitter/X, and
            other sources on your behalf. We access content in read-only mode. You
            are responsible for ensuring you have the right to access the sources
            you connect.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">5. AI Filtering</h2>
          <p>
            The Service uses AI to filter and evaluate content based on your
            preferences and feedback. AI decisions are not guaranteed to be
            accurate. Filtered items are not deleted and remain accessible for
            review.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">6. Data</h2>
          <p>
            Your filtering preferences, feedback, and source configurations are
            stored securely. We do not sell your data. See our{" "}
            <Link href="/privacy" className="link">
              Privacy Policy
            </Link>{" "}
            for details.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">7. Termination</h2>
          <p>
            We may suspend or terminate your account if you violate these terms.
            You may delete your account at any time by contacting us.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">8. Limitation of Liability</h2>
          <p>
            The Service is provided &quot;as is&quot; without warranties. We are not liable
            for missed content, AI filtering errors, or third-party service
            outages.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">9. Changes</h2>
          <p>
            We may update these terms. Continued use of the Service after changes
            constitutes acceptance.
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
