import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { SatelliteDish } from "lucide-react"
import { SiGithub } from "react-icons/si"
import { MobileStickyCta } from "@/components/landing/mobile-sticky-cta"
import { SourceTypesStrip } from "@/components/landing/source-types-strip"
import { cn } from "@/lib/utils"
import { isTrialOfferOpen, isTrialRef } from "@/lib/trial-ref"
import { buildLandingMetadata, buildLandingStructuredData } from "@/lib/seo"
import { getSiteUrl } from "@/lib/site-url"
import { getContactEmail } from "@/lib/contact"
import { isSelfHosted } from "@/lib/self-hosted"
import {
  LICENSE_URL,
  PUBLIC_REPO_URL,
  SELF_HOSTING_GUIDE_URL,
} from "@/lib/public-repo"

// The landing already reads searchParams, so it renders per request; stating it
// keeps the SELF_HOSTED redirect on the runtime env even if that changes.
export const dynamic = "force-dynamic"

export const metadata: Metadata = buildLandingMetadata(getSiteUrl())

function ctaClass(primary: boolean, size: "default" | "lg") {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50",
    size === "lg" ? "h-11 rounded-md px-8" : "h-10 px-4 py-2",
    primary
      ? "bg-primary/15 text-primary hover:bg-primary/25"
      : "bg-secondary text-secondary-foreground hover:bg-accent"
  )
}

function CtaBtn({
  href,
  children,
  primary = true,
  size = "lg",
  external = false,
}: {
  href: string
  children: React.ReactNode
  primary?: boolean
  size?: "default" | "lg"
  /** Off-site target (GitHub): a plain anchor, opened in a new tab. */
  external?: boolean
}) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={ctaClass(primary, size)}
      >
        {children}
      </a>
    )
  }
  return (
    <Link href={href} className={ctaClass(primary, size)}>
      {children}
    </Link>
  )
}

function ThemedImg({
  lightSrc,
  darkSrc,
  alt,
  className,
}: {
  lightSrc: string
  darkSrc: string
  alt: string
  className?: string
}) {
  return (
    /* The shadow lives on this wrapper, not on the images: `.elevation-card`
       masks them into a squircle, and a mask is applied after `filter`, so a
       drop-shadow on the same element is generated and then clipped away. */
    <span className="elevation-shadow block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={lightSrc}
        alt={alt}
        className={cn("themed-light", className)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={darkSrc}
        alt={alt}
        className={cn("themed-dark", className)}
      />
    </span>
  )
}

function Figure({
  alt,
  lightSrc,
  darkSrc,
  caption,
}: {
  alt: string
  lightSrc: string
  darkSrc: string
  caption?: string
}) {
  return (
    <figure className="my-10 !max-w-[1100px]">
      <ThemedImg
        lightSrc={lightSrc}
        darkSrc={darkSrc}
        alt={alt}
        className="w-full rounded-xl elevation-card"
      />
      {caption && (
        <figcaption className="mt-3 text-center text-xs text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string | string[] }>
}) {
  // A self-hosted install has no hosted landing to show: sign in (or create
  // the first account) instead. Read per request — the image is built without
  // SELF_HOSTED.
  if (isSelfHosted()) redirect("/login")

  const { ref } = await searchParams
  // Referral-trial visitors get the trial on sign-up (lib/trial-ref.ts); the
  // proxy remembers the ref, so the CTAs below need no query param.
  const trial = isTrialOfferOpen() && isTrialRef(typeof ref === "string" ? ref : null)
  const contactEmail = getContactEmail()
  // Built here, not at module scope: the JSON-LD must state the origin this
  // request arrived on, and the page is rendered per request.
  const structuredData = buildLandingStructuredData(getSiteUrl())
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Server-rendered, so it lands in the raw HTML that non-JS crawlers read. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className="mx-auto flex max-w-[1100px] items-center justify-between px-6 pt-8 pb-10 text-sm">
        <Link
          href="/"
          className="flex items-center gap-2 font-semibold tracking-tight hover:opacity-80 transition-opacity"
        >
          <span>Radaric</span>
          <SatelliteDish className="size-4 text-primary" aria-hidden />
        </Link>
        <nav className="flex items-center gap-1">
          <a
            href={PUBLIC_REPO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Radaric on GitHub"
            className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-accent hover:text-foreground"
          >
            <SiGithub className="size-4" aria-hidden />
            <span className="hidden sm:inline">GitHub</span>
          </a>
          <Link
            href="/signup"
            prefetch={false}
            className="rounded-md px-3 py-2 text-sm font-medium text-foreground/80 hover:bg-accent hover:text-foreground"
          >
            Log in
          </Link>
          <CtaBtn href="/signup" size="default">
            Get started
          </CtaBtn>
        </nav>
      </header>

      <main className="mx-auto max-w-[1100px] px-6 pb-24">
        <article
          className={cn(
            "mx-auto",
            // Default width for every direct child: 680px, centered
            "[&>*]:mx-auto [&>*]:max-w-[680px]",
            // Wider blocks (figures + anything with data-wide): 1100px
            "[&>figure]:max-w-[1100px]",
            "[&>[data-wide]]:max-w-[1100px]"
          )}
        >
          {/* Hero */}
          <p className="pt-2 text-xs uppercase tracking-wider text-muted-foreground">
            Open source.{" "}
            <a
              href={PUBLIC_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              The code is on GitHub
            </a>
          </p>

          <h1 className="mt-4 mb-9 text-[2.25rem] leading-[1.1] font-bold tracking-[calc(-0.035em*var(--type-df,1))] sm:text-[2.625rem] sm:leading-[1.1] sm:tracking-[calc(-0.035em*var(--type-df,1))]">
            Your content taste, but scaled
          </h1>

          <p className="text-lg font-semibold leading-snug">
            Stop scrolling and start reading what&apos;s really worth it.
          </p>

          <p className="mt-4 text-sm leading-relaxed">
            The AI learns from every post you approve or reject. It doesn&apos;t
            decide what you read. It helps you scale your own decisions. And
            when 15 sources cover the same news, you get one story with all the
            facts instead of 15 near-copies to skim.
          </p>

          <div className="my-6 flex items-start gap-4">
            <img
              src="/landing/kirill.jpg"
              alt="Kirill Oleinichenko"
              width={48}
              height={48}
              className="icon-tile mt-1 size-12 shrink-0 object-cover"
              style={{ "--tile-size": "3rem" } as React.CSSProperties}
            />
            <p className="text-sm leading-relaxed text-muted-foreground">
              Built by{" "}
              <a
                href="https://kirill.green"
                target="_blank"
                rel="noreferrer"
                className="link"
              >
                Kirill Oleinichenko
              </a>
              , editor of Zhurnalus — a weekly design digest, 500+ issues since
              2016.
            </p>
          </div>

          <div className="pt-2 pb-4">
            <div className="flex w-fit flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <CtaBtn href="/signup">Add your feeds →</CtaBtn>
              <SourceTypesStrip />
            </div>
            {trial && (
              <p className="mt-3 text-sm font-medium text-primary">
                7 days free, no card required
              </p>
            )}
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Prefer your own server? Run Radaric there for free with your own
              AI keys:{" "}
              <a
                href={SELF_HOSTING_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                className="link"
              >
                self-hosting guide
              </a>
              .
            </p>
          </div>

          <Figure
            alt="Radaric inbox with AI-filtered posts"
            lightSrc="/landing/posts-light.webp"
            darkSrc="/landing/posts-dark.webp"
          />

          {/* How It Works */}
          <h2 className="mt-16 mb-4 text-[1.625rem] leading-[1.2] font-bold tracking-[calc(-0.01em*var(--type-df,1))] sm:text-2xl sm:leading-snug sm:tracking-tight">
            Optimized for your judgment, not your engagement
          </h2>

          <p className="text-sm leading-relaxed">
            Four steps from a pile of feeds to a feed that reflects what
            matters to you.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">
            01 — Connect your feeds
          </h3>
          <p className="text-sm leading-relaxed">
            RSS, Telegram (private channels too), Twitter/X, YouTube and Event
            Triggers, all in one place. For YouTube the AI reads the video
            transcript for you. Add feeds one at a time, bring a hundred over
            at once from Feedly or Inoreader with an OPML file, or add
            Substack, Bluesky, Mastodon, Product Hunt, GitHub and arXiv in one
            click.
          </p>

          <Figure
            alt="Feed management with RSS, Telegram, Twitter, and YouTube sources"
            lightSrc="/landing/feeds-light.png"
            darkSrc="/landing/feeds-dark.png"
          />

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">
            02 — AI filters every item
          </h3>
          <p className="text-sm leading-relaxed">
            Write down what matters to you in plain words. Every new post is
            checked against it and gets a confidence score and a short reason.
            Rejected posts aren&apos;t deleted. They sit one click away, so you
            can always see what the AI threw out and why.
          </p>

          <figure className="my-10 !max-w-[1100px]">
            <div className="w-full">
              <div className="mx-auto w-[85%] sm:mx-0 sm:ml-auto sm:w-[72%]">
                <ThemedImg
                  lightSrc="/landing/global-prompt-light.webp"
                  darkSrc="/landing/global-prompt-dark.webp"
                  alt="Global AI prompt configuration"
                  className="w-full rounded-xl elevation-card"
                />
              </div>
              <div className="relative z-10 -mt-[18%] w-full sm:w-[78%]">
                <ThemedImg
                  lightSrc="/landing/filters-light.webp"
                  darkSrc="/landing/filters-dark.webp"
                  alt="Global content interests — the categories every feed is filtered against"
                  className="w-full rounded-xl elevation-card"
                />
              </div>
            </div>
          </figure>

          <div data-wide className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-[1fr_394px] sm:items-center sm:gap-10">
            <div className="mx-auto max-w-[680px] sm:mx-0 sm:pl-[140px]">
              <h3 className="mb-2 text-[1.375rem] font-bold sm:text-xl">03 — AI learns from you</h3>
              <p className="text-sm leading-relaxed">
                Approve, reject, explain why. Every correction trains your
                filter, and so does what you save and open. After a few weeks it
                knows your editorial taste better than you could write it down.
              </p>
            </div>
            <div className="mx-auto w-[280px] sm:mx-0 sm:w-full">
              <ThemedImg
                lightSrc="/landing/feedback-light.webp"
                darkSrc="/landing/feedback-dark.webp"
                alt="Giving feedback on a specific material"
                className="w-full rounded-xl elevation-card"
              />
            </div>
          </div>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">04 — Read what matters</h3>
          <p className="text-sm leading-relaxed">
            What&apos;s left is a short feed of posts that passed your filter.
            Hours of triage turn into 20 minutes of reading, and every original
            post is one click away.
          </p>

          <Figure
            alt="Filtered posts view showing AI-rejected items"
            lightSrc="/landing/filtered-posts-light.webp"
            darkSrc="/landing/filtered-posts-dark.webp"
          />

          <div className="flex flex-wrap gap-3 pt-6">
            <CtaBtn href="/signup">Add your feeds →</CtaBtn>
          </div>

          {/* Story Aggregator */}
          <h2 className="mt-16 mb-4 text-[1.625rem] leading-[1.2] font-bold tracking-[calc(-0.01em*var(--type-df,1))] sm:text-2xl sm:leading-snug sm:tracking-tight">
            Stop reading the same story fifteen times
          </h2>

          <p className="text-sm leading-relaxed">
            When the same event hits 15 of your channels, Radaric merges them
            into one story and keeps a link to every source.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">How it works</h3>
          <p className="text-sm leading-relaxed">
            Radaric compares posts from every source you connect: titles,
            content, the names and entities they mention, and when they were
            posted. When enough of that lines up, the posts become one story
            with the key facts pulled together, and each original post stays
            linked as a source.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">Why it matters</h3>
          <p className="text-sm leading-relaxed">
            You see each piece of news once instead of fifteen times, so the
            pile feels smaller and you still have every source. It works across
            sources and languages: a Russian Telegram channel, an English
            Twitter thread and a Portuguese RSS feed end up in one story when
            they&apos;re about the same event.
          </p>

          <Figure
            alt="Story card merging multiple sources about the same event"
            lightSrc="/landing/story-light.webp"
            darkSrc="/landing/story-dark.webp"
          />

          {/* Compare */}
          <h2 className="mt-16 mb-4 text-[1.625rem] leading-[1.2] font-bold tracking-[calc(-0.01em*var(--type-df,1))] sm:text-2xl sm:leading-snug sm:tracking-tight">
            How Radaric compares
          </h2>

          <div className="my-6 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-3 pr-3 font-medium"></th>
                  <th className="py-3 pr-3 font-medium">Feedly Pro+</th>
                  <th className="py-3 pr-3 font-medium">Research assistant</th>
                  <th className="py-3 font-medium text-primary">Radaric</th>
                </tr>
              </thead>
              <tbody>
                {[
                  [
                    "Price",
                    "$18/month",
                    "$2,000+/month",
                    "Free on your server, hosted from $9/month",
                  ],
                  ["Source code", "Closed", "—", "Public on GitHub"],
                  ["Telegram private", "No", "Manual", "Yes, automated"],
                  [
                    "Learns your taste",
                    "No — same AI for all",
                    "After months",
                    "After weeks",
                  ],
                  [
                    "Sources covered",
                    "RSS only",
                    "All, but manually",
                    "RSS, Telegram, YouTube, Substack, Bluesky & more — X on Pro",
                  ],
                  ["Story dedup", "No", "Manual", "Automatic grouping"],
                ].map((row, i) => (
                  <tr key={i} className="border-b border-border align-top">
                    <td className="py-3 pr-3 font-semibold">{row[0]}</td>
                    <td className="py-3 pr-3 text-muted-foreground">{row[1]}</td>
                    <td className="py-3 pr-3 text-muted-foreground">{row[2]}</td>
                    <td className="py-3">{row[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pricing */}
          <h2 className="mt-16 mb-4 text-[1.625rem] leading-[1.2] font-bold tracking-[calc(-0.01em*var(--type-df,1))] sm:text-2xl sm:leading-snug sm:tracking-tight">
            Run it yourself for free, or let us host it
          </h2>

          {/* Stacked cards keep the 680px text column; three across need the
              wide one. */}
          <div className="my-8 grid gap-6 lg:!max-w-[1100px] lg:grid-cols-3">
            <div className="flex flex-col rounded-xl border border-border bg-card p-6">
              <h3 className="text-[1.375rem] font-bold sm:text-xl">Self-hosted</h3>
              <p className="mt-3">
                <span className="text-3xl font-bold tracking-tight">$0</span>{" "}
                <span className="text-sm text-muted-foreground">on your own server</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                You pay your AI provider directly.
              </p>
              <ul className="mt-4 space-y-1.5 pl-5 text-sm leading-relaxed [&>li]:list-disc marker:text-muted-foreground/50">
                <li>Every feature, Twitter/X included</li>
                <li>
                  Bring your own keys: OpenRouter or Anthropic for the AI,
                  TwitterAPI.io for X, a Telegram account for channels
                </li>
                <li>Starts with one Docker Compose command</li>
                <li>Your feeds and data stay on your machine</li>
                <li>Questions and fixes go through GitHub issues</li>
                <li>
                  Free for you and your company under{" "}
                  <a
                    href={LICENSE_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="link whitespace-nowrap"
                  >
                    FSL-1.1
                  </a>
                  ; reselling it as a hosted service is not allowed
                </li>
              </ul>
              <div className="mt-auto pt-6">
                <CtaBtn href={PUBLIC_REPO_URL} external>
                  <SiGithub className="size-4" aria-hidden />
                  View on GitHub
                </CtaBtn>
              </div>
            </div>

            <div className="flex flex-col rounded-xl border border-border bg-card p-6">
              <h3 className="text-[1.375rem] font-bold sm:text-xl">Lite</h3>
              <p className="mt-3">
                <span className="text-3xl font-bold tracking-tight">$9</span>{" "}
                <span className="text-sm text-muted-foreground">/month · $90/year</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Yearly is 2 months free.
              </p>
              <ul className="mt-4 space-y-1.5 pl-5 text-sm leading-relaxed [&>li]:list-disc marker:text-muted-foreground/50">
                <li>Feeds from RSS, Telegram, and YouTube</li>
                <li>
                  Substack, Bluesky, Mastodon, Product Hunt, GitHub, arXiv —
                  one click to add
                </li>
                <li>AI reads YouTube video transcripts</li>
                <li>AI filtering with feedback learning</li>
                <li>Story Aggregator</li>
                <li>Private Telegram channel support</li>
                <li>See the AI&apos;s reason for every decision</li>
                <li className="font-medium text-foreground">Twitter/X accounts — not included</li>
              </ul>
              <div className="mt-auto pt-6">
                <CtaBtn href="/signup">Get started</CtaBtn>
              </div>
            </div>

            <div className="flex flex-col rounded-xl border border-primary/40 bg-card p-6 ring-1 ring-primary/20">
              <div className="flex items-center justify-between">
                <h3 className="text-[1.375rem] font-bold sm:text-xl">Pro</h3>
                <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
                  Recommended
                </span>
              </div>
              <p className="mt-3">
                <span className="text-3xl font-bold tracking-tight">$59</span>{" "}
                <span className="text-sm text-muted-foreground">/month · $499/year</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Yearly saves $209 vs. monthly.
              </p>
              <ul className="mt-4 space-y-1.5 pl-5 text-sm leading-relaxed [&>li]:list-disc marker:text-muted-foreground/50">
                <li>Everything in Lite</li>
                <li className="font-medium text-foreground">Twitter/X account parsing</li>
                <li>30-day money-back guarantee</li>
              </ul>
              <div className="mt-auto pt-6">
                <CtaBtn href="/signup">Get started</CtaBtn>
              </div>
            </div>
          </div>

          <p className="mt-8 text-sm font-semibold">
            Early users get direct access to the developer. This won&apos;t
            scale.
          </p>
          <p className="text-xs text-muted-foreground">
            Lite and Pro come with a 30-day money-back guarantee.
          </p>

          {/* FAQ */}
          <h2 className="mt-16 mb-4 text-[1.625rem] leading-[1.2] font-bold tracking-[calc(-0.01em*var(--type-df,1))] sm:text-2xl sm:leading-snug sm:tracking-tight">
            Frequently asked questions
          </h2>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">
            How is this different from Feedly or Inoreader?
          </h3>
          <p className="text-sm leading-relaxed">
            Feedly and Inoreader are RSS readers, and their AI is the same for
            every user. Radaric also reads Telegram (private channels included),
            Twitter/X and YouTube, where the AI works from the video transcript,
            which no RSS reader does. The bigger difference: it learns from your
            approvals and rejections, so the filter is yours and gets sharper
            with every decision.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">
            Is my Telegram account safe?
          </h3>
          <p className="text-sm leading-relaxed">
            Radaric&apos;s connection to Telegram is read-only. It reads
            messages and never sends, modifies or deletes anything in your
            Telegram account.
            Your credentials are stored encrypted.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">
            Can I run Radaric on my own server?
          </h3>
          <p className="text-sm leading-relaxed">
            Yes. The full code is{" "}
            <a
              href={PUBLIC_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              on GitHub
            </a>{" "}
            under the Functional Source License (FSL-1.1). You can run it,
            change it and use it inside your company for free, with your own AI
            keys. The license forbids one thing: selling Radaric to others as a
            competing hosted service. Two years after each release, that version
            becomes Apache 2.0. The{" "}
            <a
              href={SELF_HOSTING_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              self-hosting guide
            </a>{" "}
            walks you through setup with Docker Compose.
          </p>

          <h3 className="mt-8 mb-2 text-[1.375rem] font-bold sm:text-xl">Who built this?</h3>
          <p className="text-sm leading-relaxed">
            Radaric is built by Kirill, the editor of Zhurnalus — a weekly
            design digest with 500+ issues over 10 years. He built Radaric to
            solve his own curation problem: scanning hundreds of feeds every
            day. It&apos;s been in daily use since November 2025.
          </p>

          <div className="flex flex-wrap gap-3 pt-10">
            <CtaBtn href="/signup">Add your feeds →</CtaBtn>
          </div>
        </article>

        <footer className="mx-auto mt-20 max-w-[680px] border-t border-border pt-6 text-xs text-muted-foreground">
          <p className="mb-3">
            Radaric © {new Date().getFullYear()}. Open source under{" "}
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              FSL-1.1
            </a>
            .
          </p>
          <nav className="flex flex-wrap gap-4">
            <Link href="/terms" className="link">
              Terms
            </Link>
            <Link href="/privacy" className="link">
              Privacy
            </Link>
            <Link href="/signup" prefetch={false} className="link">
              Log in
            </Link>
            <a
              href={PUBLIC_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              GitHub
            </a>
            <a
              href={SELF_HOSTING_GUIDE_URL}
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              Self-hosting
            </a>
            <a
              href={`mailto:${contactEmail}`}
              className="link"
            >
              Contact
            </a>
          </nav>
        </footer>
      </main>

      <MobileStickyCta />
    </div>
  )
}
