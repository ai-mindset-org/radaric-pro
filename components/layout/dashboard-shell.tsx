"use client"

import { useState, useEffect, useSyncExternalStore } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useSession, signOut } from "next-auth/react"
import { useTheme } from "next-themes"
import {
  Database,
  FileText,
  Library,
  Settings,
  CircleUser,
  Sun,
  Moon,
  Monitor,
  LogOut,
  SlidersHorizontal,
  Shield,
  PanelLeft,
  ChevronLeft,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { LITE } from "@/lib/lite"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetTitle, SheetClose } from "@/components/ui/sheet"
import { MorphText } from "@/components/ui/morph-text"
import { cn } from "@/lib/utils"
import { Sidebar, type SidebarFolder, type SidebarSource } from "@/components/layout/sidebar"
import { SidebarTreeProvider } from "@/components/layout/sidebar-tree-provider"
import { persistUiState } from "@/lib/ui-state"

const DESKTOP_BREAKPOINT_QUERY = "(min-width: 768px)"
const DESKTOP_SIDEBAR_ID = "app-sidebar-desktop"
const MOBILE_SIDEBAR_ID = "app-sidebar-mobile"

// Viewport as external state: React reads it on the client and falls back to
// the server snapshot (desktop) during SSR + hydration, so the first paint
// matches the server HTML and a phone corrects itself right after hydrate.
function subscribeToViewport(onChange: () => void): () => void {
  const mq = window.matchMedia(DESKTOP_BREAKPOINT_QUERY)
  mq.addEventListener("change", onChange)
  return () => mq.removeEventListener("change", onChange)
}
const getIsDesktopViewport = () => window.matchMedia(DESKTOP_BREAKPOINT_QUERY).matches
const getServerIsDesktopViewport = () => true

type Stats = {
  feeds: {
    errorCount: number
  }
  inboxBySource?: Record<string, number>
}

type DashboardShellProps = {
  children: React.ReactNode
  initialSidebarOpen: boolean
  sources: SidebarSource[]
  folders: SidebarFolder[]
  initialCollapsedFolders: string[]
  banner?: React.ReactNode
}

export function DashboardShell({
  children,
  initialSidebarOpen,
  sources,
  folders,
  initialCollapsedFolders,
  banner,
}: DashboardShellProps) {
  const pathname = usePathname()
  const { data: session } = useSession()
  const isAdmin = session?.user?.role === "ADMIN"
  const [stats, setStats] = useState<Stats | null>(null)
  const [isSidebarOpen, setIsSidebarOpen] = useState(initialSidebarOpen)
  const [isMobileDrawerOpen, setIsMobileDrawerOpen] = useState(false)
  const isDesktop = useSyncExternalStore(subscribeToViewport, getIsDesktopViewport, getServerIsDesktopViewport)

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch("/api/stats")
        if (response.ok) {
          const data = await response.json()
          setStats(data)
        }
      } catch (error) {
        console.error("Failed to fetch stats:", error)
      }
    }

    fetchStats()
    const interval = setInterval(fetchStats, 30000)
    const onStatsChanged = () => fetchStats()
    window.addEventListener("radaric:stats-changed", onStatsChanged)
    return () => {
      clearInterval(interval)
      window.removeEventListener("radaric:stats-changed", onStatsChanged)
    }
  }, [])

  // Auto-close the mobile drawer when the route changes (link inside nav).
  // setState in an effect is correct here — the state transition is driven
  // by the pathname change, and there is no event handler on the Link we can
  // intercept from this component.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobileDrawerOpen(false)
  }, [pathname])

  // Breakpoint crossover: if the user resizes from mobile to desktop while
  // the drawer is open, force-close it so the desktop aside takes over
  // without leaving a half-open Sheet in the portal.
  useEffect(() => {
    if (typeof window === "undefined") return
    const mq = window.matchMedia(DESKTOP_BREAKPOINT_QUERY)
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setIsMobileDrawerOpen(false)
    }
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const handleToggleSidebar = () => {
    if (isDesktop) {
      const next = !isSidebarOpen
      setIsSidebarOpen(next)
      // A route handler, not a server action: a cookie-setting action refreshes
      // the route, which re-rendered the grid mid-toggle (RAD-408).
      persistUiState({ sidebarOpen: next })
    } else {
      setIsMobileDrawerOpen((prev) => !prev)
    }
  }

  // The toggle reports the region the viewport actually shows. The persisted
  // desktop state (default open) is invisible below md, and the drawer cannot
  // be open on desktop, so reading both with `||` announced "Close sidebar" over
  // a closed drawer on phones (RAD-382).
  const isToggledSidebarOpen = isDesktop ? isSidebarOpen : isMobileDrawerOpen

  return (
    <SidebarTreeProvider folders={folders} sources={sources} collapsed={initialCollapsedFolders}>
    {/* Mobile: natural document flow — the DOCUMENT scrolls, which is what lets
        iOS Safari minimize its bottom bar and float glass controls straight
        over the content (an inner-scroll shell keeps the bar expanded with a
        backdrop forever). Desktop (md+): classic app shell with independently
        scrolling panes, unchanged. */}
    <div className="flex flex-col min-h-dvh md:h-dvh md:overflow-hidden pt-[env(safe-area-inset-top)]">
      <header className="sticky top-0 md:static shrink-0 z-40 h-14 bg-card border-b border-hairline">
        <div className="relative flex items-center h-full px-4 sm:px-6">
          {/* Sidebar toggle — same control at every breakpoint (D12).
              aria-controls names the region this viewport shows: the desktop
              sidebar at md+, the mobile drawer below (unmounted in its portal
              while closed). */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleToggleSidebar}
            aria-expanded={isToggledSidebarOpen}
            aria-controls={isDesktop ? DESKTOP_SIDEBAR_ID : MOBILE_SIDEBAR_ID}
            aria-label={isToggledSidebarOpen ? "Close sidebar" : "Open sidebar"}
            className="mr-1 shrink-0"
          >
            <PanelLeft className="h-[18px] w-[18px]" />
          </Button>

          {/* Logo */}
          <Link
            href="/posts"
            className="type-heading flex items-center gap-2 font-semibold text-sm tracking-tight hover:opacity-80 transition-opacity shrink-0"
          >
            <div className="flex h-8 w-8 items-center justify-center">
              📡
            </div>
            <span className="hidden sm:inline">Radaric</span>
          </Link>

          {/* Nav links — centered */}
          <nav aria-label="Main navigation" className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1">
            <TopNavLink href="/posts" icon={FileText} label="Posts" />
            <TopNavLink href="/feeds" icon={Database} label="Feeds" errorCount={stats?.feeds.errorCount} />
            <TopNavLink href="/rules" icon={SlidersHorizontal} label="Rules" />
            {/* Library is the 4th top-nav peer (RAD-397). It was admin-gated
                from 2026-07-06 while the tracked-question ingestion was
                stabilized; the webhook + monitor-evaluation fixes made it
                collect again, so it is user-facing as designed. */}
            {!LITE && <TopNavLink href="/saved" icon={Library} label="Library" />}
          </nav>

          {/* Profile menu */}
          <div className="ml-auto">
            <ProfileMenu username={session?.user?.username} isAdmin={isAdmin} />
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Desktop aside — CSS-only breakpoint switching, no useMediaQuery.
            aria-hidden when collapsed so screen readers don't announce the
            nav region that's visually clipped to 0 width. */}
        <aside
          aria-hidden={!isSidebarOpen}
          className={cn(
            "hidden md:block overflow-hidden transition-[width] duration-[var(--dur-base)] ease-[var(--ease-snap)] motion-reduce:transition-none",
            isSidebarOpen ? "md:w-[260px]" : "md:w-0"
          )}
        >
          <div className="w-[260px] h-full border-r border-sidebar-border">
            <Sidebar instanceId="desktop" id={DESKTOP_SIDEBAR_ID} liveCounts={stats?.inboxBySource} />
          </div>
        </aside>

        {/* pb = home-indicator clearance: with viewport-fit=cover the canvas
            reaches the physical bottom edge, content scrolls under Safari's
            glass pill, and the padding lets the last item scroll clear of it.
            Scroll behavior is split: mobile scrolls the document (see the
            shell comment), desktop scrolls this pane. */}
        <main className="flex-1 min-w-0 md:overflow-y-auto scrollbar-stable pb-[env(safe-area-inset-bottom)]">
          {banner}
          {children}
        </main>
      </div>

      {/* Mobile drawer — Sheet handles focus trap, Esc, backdrop, body scroll lock.
          Overrides on the variant: border-r-0 (borderless hierarchy, no hairline
          against bg-sidebar), bg-sidebar (matches the desktop aside tone),
          sm:!max-w-[320px] beats the variant's sm:max-w-sm cap. Default close
          X (the first child button) is hidden; we render an explicit labelled
          Close control at the bottom of the drawer instead. */}
      <Sheet open={isMobileDrawerOpen} onOpenChange={setIsMobileDrawerOpen}>
        <SheetContent
          side="left"
          id={MOBILE_SIDEBAR_ID}
          className="flex flex-col p-0 w-[85vw] max-w-[320px] sm:!max-w-[320px] md:hidden border-r-0 bg-sidebar [&>button:first-of-type]:hidden"
        >
          <SheetTitle className="sr-only">Sources and folders</SheetTitle>
          <div className="flex-1 min-h-0">
            <Sidebar instanceId="mobile" liveCounts={stats?.inboxBySource} />
          </div>
          <div className="shrink-0 border-t-0 px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <SheetClose asChild>
              <Button
                variant="ghost"
                className="w-full justify-start gap-2 h-11"
                aria-label="Close sidebar"
              >
                <ChevronLeft className="h-[18px] w-[18px]" />
                <span>Close</span>
              </Button>
            </SheetClose>
          </div>
        </SheetContent>
      </Sheet>
    </div>
    </SidebarTreeProvider>
  )
}

function TopNavLink({
  href,
  icon: Icon,
  label,
  errorCount,
}: {
  href: string
  icon: LucideIcon
  label: string
  errorCount?: number
}) {
  const pathname = usePathname()
  const isActive = pathname.startsWith(href)

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      // aria-label keeps the accessible name on mobile, where the visible
      // label is display:none (icon-only). px-4 below sm holds the 44px
      // touch-target floor for the icon-only hit area.
      aria-label={label}
      className={`h-14 flex items-center gap-2 px-4 sm:px-3 text-sm border-b-2 -mb-px transition-colors ${
        isActive
          ? "text-foreground font-semibold border-green-bright"
          : "text-muted-foreground font-medium border-transparent hover:text-foreground"
      }`}
    >
      <Icon className="h-[16px] w-[16px]" />
      <span className="hidden sm:inline">{label}</span>
      {errorCount !== undefined && errorCount > 0 && (
        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded-xs bg-destructive-subtle text-destructive type-counter">
          <MorphText>{errorCount}</MorphText>
        </span>
      )}
    </Link>
  )
}

function ProfileMenu({ username, isAdmin }: { username?: string | null; isAdmin?: boolean }) {
  const { setTheme } = useTheme()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-11 gap-2 rounded-full px-3"
          aria-label="User menu"
        >
          <CircleUser className="h-[20px] w-[20px]" />
          {username && (
            <span className="hidden sm:inline text-sm font-medium">{username}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <Link href="/settings" className="flex items-center gap-2">
            <Settings className="h-[16px] w-[16px]" />
            Settings
          </Link>
        </DropdownMenuItem>
        {isAdmin && !LITE && (
          <DropdownMenuItem asChild>
            <Link href="/admin" className="flex items-center gap-2">
              <Shield className="h-[16px] w-[16px]" />
              Admin
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="flex items-center gap-2">
            <Sun className="h-[16px] w-[16px]" />
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem onClick={() => setTheme("light")} className="flex items-center gap-2">
              <Sun className="h-[14px] w-[14px]" />
              Light
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("dark")} className="flex items-center gap-2">
              <Moon className="h-[14px] w-[14px]" />
              Dark
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setTheme("system")} className="flex items-center gap-2">
              <Monitor className="h-[14px] w-[14px]" />
              System
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => signOut({ callbackUrl: "/" })}
          className="flex items-center gap-2 text-destructive"
        >
          <LogOut className="h-[16px] w-[16px]" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
