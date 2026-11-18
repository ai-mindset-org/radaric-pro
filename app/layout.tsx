import type { Metadata, Viewport } from "next";
import { interCyrillic, interExt, interLatin } from "./fonts/inter";
import { clubDisplay, clubUi } from "./fonts/club20";
import "./fonts/fonts.css";
import "./globals.css";
import "./club20-theme.css";
import { Toaster } from "@/components/ui/toaster";
import { AuthSessionProvider } from "@/components/providers/session-provider";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { getSiteUrl } from "@/lib/site-url";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // Extend the page canvas under iOS Safari's glass chrome (bottom pill).
  // Without it, app-shell pages (h-dvh + inner scroll) get letterboxed above
  // the bottom bar and iOS paints the gap with an opaque background slab.
  viewportFit: "cover",
  // Tint Safari's chrome backdrop to the app canvas (--background) so the
  // expanded bottom bar blends with the page instead of defaulting to
  // white/black. Values mirror globals.css :root / .dark.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b0b" },
  ],
};

export const metadata: Metadata = {
  // Without this, Next resolves every RELATIVE metadata URL (og:image,
  // twitter:image) against http://localhost:3000 — which is exactly what
  // production was emitting, so no share on Telegram/X/LinkedIn/Slack ever
  // rendered a preview image. Set here rather than per-page so it covers
  // current and future routes, and from the environment so a self-hosted
  // install points at its own domain.
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: "Radaric",
    template: "%s — Radaric",
  },
  description: "AI-powered content curation system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${interLatin.variable} ${interCyrillic.variable} ${interExt.variable} ${clubDisplay.variable} ${clubUi.variable}`}
    >
      <body className="antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <AuthSessionProvider>
            {children}
            <Toaster />
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
