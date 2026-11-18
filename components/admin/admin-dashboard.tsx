"use client"

import { useState, useEffect, type ComponentType, type ReactNode } from "react"
import {
  Users,
  Database,
  FileText,
  MessageSquare,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Rss,
  Globe,
  Youtube,
  Gift,
  Timer,
} from "lucide-react"
import { RiTelegramLine } from "react-icons/ri"
import { FaXTwitter } from "react-icons/fa6"
import { toast } from "sonner"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MorphText } from "@/components/ui/morph-text"
import { cn } from "@/lib/utils"
import {
  adminSubBadge,
  adminSubSummary,
  adminTrialBadge,
  type AdminSubscriptionView,
} from "@/lib/admin-subscription-state"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"

type UserRow = {
  id: string
  username: string
  name: string | null
  email: string | null
  role: string
  isActive: boolean
  complimentaryAccessUntil: string | null
  // The comp is the referral sign-up trial (judged server-side, RAD-419).
  launchTrial: boolean
  subscription: AdminSubscriptionView | null
  createdAt: string
  feeds: {
    rss: number
    telegram: number
    twitter: number
    youtube: number
    interest: number
    total: number
    active: number
    error: number
  }
  materials: number
  feedbackCount: number
  lastParsedAt: string | null
}

type DashboardData = {
  users: UserRow[]
  totals: {
    users: number
    feeds: number
    materials: number
    feedback: number
    subscribers: number
    referralTrials: number
    referralTrialsActive: number
  }
}

export function AdminDashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  // When `data` arrived: the clock the trial badges are judged against (render stays pure).
  const [fetchedAt, setFetchedAt] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedUser, setExpandedUser] = useState<string | null>(null)

  const fetchData = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/dashboard")
      if (!res.ok) throw new Error("Failed to fetch")
      setData(await res.json())
      setFetchedAt(Date.now())
    } catch {
      setError("Failed to load admin data")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchData() }, [])

  if (loading && !data) {
    return (
      <div className="p-4 lg:p-8">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error && !data) {
    return (
      <div className="p-4 lg:p-8 space-y-4">
        <p className="text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={fetchData}>Retry</Button>
      </div>
    )
  }

  if (!data) return null

  const { users, totals } = data

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mt-2 lg:mt-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Admin</h1>
          <p className="text-sm text-muted-foreground hidden sm:block">
            User analytics & system overview
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchData}
          disabled={loading}
        >
          <RefreshCw className={`h-[16px] w-[16px] mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Overview Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard icon={Users} label="Users" value={totals.users} />
        <StatCard icon={CreditCard} label="Subscribers" value={totals.subscribers} />
        <StatCard
          icon={Timer}
          label="Referral trials"
          value={totals.referralTrials}
          detail={<><span className="type-counter">{String(totals.referralTrialsActive)}</span> active</>}
        />
        <StatCard icon={Database} label="Feeds" value={totals.feeds} />
        <StatCard icon={FileText} label="Materials" value={totals.materials} />
        <StatCard icon={MessageSquare} label="Feedback" value={totals.feedback} />
      </div>

      {/* Users Table */}
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Users</h2>
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 text-muted-foreground text-left">
                  <th className="px-3 py-2.5 font-medium w-8"></th>
                  <th className="px-3 py-2.5 font-medium">User</th>
                  <th className="px-3 py-2.5 font-medium text-center hidden sm:table-cell">Role</th>
                  <th className="px-3 py-2.5 font-medium text-center">Feeds</th>
                  <th className="px-3 py-2.5 font-medium text-center hidden md:table-cell">Materials</th>
                  <th className="px-3 py-2.5 font-medium text-center hidden md:table-cell">Feedback</th>
                  <th className="px-3 py-2.5 font-medium hidden lg:table-cell">Last Parse</th>
                  <th className="px-3 py-2.5 font-medium hidden lg:table-cell">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map(user => (
                  <UserTableRow
                    key={user.id}
                    user={user}
                    expanded={expandedUser === user.id}
                    onToggle={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                    onMutated={fetchData}
                    nowMs={fetchedAt}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon: Icon, label, value, detail }: { icon: ComponentType<{ className?: string }>; label: string; value: number; detail?: ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xs bg-muted">
            <Icon className="h-[16px] w-[16px] text-muted-foreground" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{label}</p>
            {detail ? (
              <div className="flex items-baseline gap-1.5">
                <MorphText as="p" className="text-lg font-semibold type-counter">
                  {value.toLocaleString()}
                </MorphText>
                <span className="text-xs text-muted-foreground">{detail}</span>
              </div>
            ) : (
              <MorphText as="p" className="text-lg font-semibold type-counter">
                {value.toLocaleString()}
              </MorphText>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function UserTableRow({ user, expanded, onToggle, onMutated, nowMs }: { user: UserRow; expanded: boolean; onToggle: () => void; onMutated: () => void; nowMs: number }) {
  const Arrow = expanded ? ChevronDown : ChevronRight
  const comp = compState(user.complimentaryAccessUntil)
  const paidBadge = user.subscription ? adminSubBadge(user.subscription) : null
  // A referral trial replaces the Comp badge; a manual comp keeps it.
  const trialBadge = adminTrialBadge(user, nowMs)

  return (
    <>
      <tr
        className="hover:bg-muted/30 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-3 py-2.5">
          {/* Real button so the disclosure is keyboard-reachable (the row's own
              onClick stays for mouse convenience). */}
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse user details" : "Expand user details"}
            onClick={(e) => { e.stopPropagation(); onToggle() }}
            className="flex h-[24px] w-[24px] items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
          >
            <Arrow className="h-[14px] w-[14px]" />
          </button>
        </td>
        <td className="px-3 py-2.5">
          <div className="font-medium">{user.username}</div>
          {user.email && (
            <div className="text-xs text-muted-foreground">{user.email}</div>
          )}
          {(paidBadge || comp.kind !== "none") && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {paidBadge && (
                <Badge
                  role="note"
                  variant={paidBadge.variant}
                  size="sm"
                  title={paidBadge.tooltip}
                  aria-label={paidBadge.tooltip}
                >
                  {paidBadge.label}
                </Badge>
              )}
              {trialBadge && (
                <Badge
                  role="note"
                  variant={trialBadge.variant}
                  size="sm"
                  className="gap-1"
                  title={trialBadge.tooltip}
                  aria-label={trialBadge.tooltip}
                >
                  <Timer className="h-[11px] w-[11px]" />
                  <span>{trialBadge.label}</span>
                </Badge>
              )}
              {!trialBadge && comp.kind === "active" && (
                <Badge
                  variant="info"
                  size="sm"
                  className="gap-1"
                  title={`Complimentary access until ${formatDate(user.complimentaryAccessUntil!)}`}
                >
                  <Gift className="h-[11px] w-[11px]" />
                  {/* One flex item: the badge's gap would detach the number from its words. */}
                  <span>Comp · <span className="type-counter">{comp.daysLeft}</span>d</span>
                </Badge>
              )}
              {!trialBadge && comp.kind === "expired" && (
                <Badge
                  variant="outline"
                  size="sm"
                  className="text-muted-foreground"
                  title={`Complimentary access ended ${formatDate(user.complimentaryAccessUntil!)}`}
                >
                  Comp expired
                </Badge>
              )}
            </div>
          )}
        </td>
        <td className="px-3 py-2.5 text-center hidden sm:table-cell">
          <Badge variant={user.role === "ADMIN" ? "default" : "outline"} size="sm">
            {user.role}
          </Badge>
        </td>
        <td className="px-3 py-2.5 text-center">
          <span className="type-counter">{user.feeds.total}</span>
          {user.feeds.error > 0 && (
            <span className="ml-1 text-destructive text-xs">(<span className="type-counter">{user.feeds.error}</span> err)</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-center type-counter hidden md:table-cell">{user.materials.toLocaleString()}</td>
        <td className="px-3 py-2.5 text-center type-counter hidden md:table-cell">{user.feedbackCount}</td>
        <td className="px-3 py-2.5 hidden lg:table-cell text-muted-foreground">
          {user.lastParsedAt ? formatRelative(user.lastParsedAt) : "Never"}
        </td>
        <td className="px-3 py-2.5 hidden lg:table-cell text-muted-foreground">
          {formatDate(user.createdAt)}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={8} className="bg-muted/20 px-4 py-4">
            <UserDetail user={user} onMutated={onMutated} />
          </td>
        </tr>
      )}
    </>
  )
}

function UserDetail({ user, onMutated }: { user: UserRow; onMutated: () => void }) {
  return (
    <div className="space-y-4">
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">Feeds by Type</p>
          <div className="space-y-1">
            {user.feeds.telegram > 0 && (
              <FeedTypeLine icon={RiTelegramLine} label="Telegram" count={user.feeds.telegram} />
            )}
            {user.feeds.rss > 0 && (
              <FeedTypeLine icon={Rss} label="RSS" count={user.feeds.rss} />
            )}
            {user.feeds.twitter > 0 && (
              <FeedTypeLine icon={FaXTwitter} label="Twitter" count={user.feeds.twitter} />
            )}
            {user.feeds.youtube > 0 && (
              <FeedTypeLine icon={Youtube} label="YouTube" count={user.feeds.youtube} />
            )}
            {user.feeds.interest > 0 && (
              <FeedTypeLine icon={Globe} label="Monitor" count={user.feeds.interest} />
            )}
            {user.feeds.total === 0 && (
              <p className="text-muted-foreground">No feeds</p>
            )}
          </div>
        </div>
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">Feed Status</p>
        <p><span className="text-primary font-medium type-counter">{user.feeds.active}</span> active</p>
        {user.feeds.error > 0 && (
          <p><span className="text-destructive font-medium type-counter">{user.feeds.error}</span> errors</p>
        )}
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">Activity</p>
        <p><span className="font-medium type-counter">{user.materials.toLocaleString()}</span> materials</p>
        <p><span className="font-medium type-counter">{user.feedbackCount}</span> feedback</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground mb-1">Account</p>
        <p>Joined {formatDate(user.createdAt)}</p>
        <p>Status: {user.isActive ? <span className="text-primary">Active</span> : <span className="text-destructive">Inactive</span>}</p>
      </div>
    </div>
      <SubscriptionBlock user={user} />
      <CompAccessControl user={user} onMutated={onMutated} />
    </div>
  )
}

function SubscriptionBlock({ user }: { user: UserRow }) {
  const sub = user.subscription

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CreditCard className="h-[13px] w-[13px]" />
        <span>Subscription</span>
      </div>
      <div className="text-sm min-w-0">
        {sub ? (
          <span className={cn("tabular-nums", sub.state === "past_due" && "text-warning")}>
            {adminSubSummary(sub)}
          </span>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </div>
      {sub && (
        <span
          className="ml-auto font-mono text-xs text-muted-foreground"
          title="Stripe subscription ID"
        >
          {sub.stripeSubscriptionId}
        </span>
      )}
    </div>
  )
}

function CompAccessControl({ user, onMutated }: { user: UserRow; onMutated: () => void }) {
  const [busy, setBusy] = useState(false)
  const comp = compState(user.complimentaryAccessUntil)

  async function mutate(days: number | null) {
    setBusy(true)
    try {
      const res = await fetch("/api/admin/comp-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, days }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || "Request failed")
      }
      toast.success(
        days === null
          ? `Revoked complimentary access for ${user.username}`
          : `Granted ${days} days of complimentary access to ${user.username}`
      )
      onMutated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isActive = comp.kind === "active"
  const grantLabel = comp.kind === "none" ? "Grant access" : "Grant again"

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Gift className="h-[13px] w-[13px]" />
        <span>Complimentary access</span>
      </div>
      <div className="text-sm">
        {comp.kind === "active" && (
          <span>
            Active until{" "}
            <span className="font-medium">{formatDate(user.complimentaryAccessUntil!)}</span>{" "}
            <span className="text-muted-foreground">(<span className="type-counter">{comp.daysLeft}</span>d left)</span>
          </span>
        )}
        {comp.kind === "expired" && (
          <span className="text-muted-foreground">
            Expired {formatDate(user.complimentaryAccessUntil!)}
          </span>
        )}
        {comp.kind === "none" && <span className="text-muted-foreground">None</span>}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy} className="ml-auto">
            {isActive ? "Extend / Revoke" : grantLabel}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{isActive ? "Extend by" : "Grant for"}</DropdownMenuLabel>
          {[7, 14, 30].map((d) => (
            <DropdownMenuItem key={d} onClick={() => mutate(d)}>
              {isActive ? `+${d} days` : `${d} days`}
            </DropdownMenuItem>
          ))}
          {isActive && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => mutate(null)}
                className="text-destructive focus:text-destructive focus:bg-destructive/10"
              >
                Revoke access
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// Classify a comp-access timestamp for display. Client-only (data is fetched in
// an effect), so Date.now() is safe — no SSR/hydration boundary to cross.
function compState(iso: string | null): { kind: "none" } | { kind: "expired" } | { kind: "active"; daysLeft: number } {
  if (!iso) return { kind: "none" }
  const t = new Date(iso).getTime()
  const now = Date.now()
  if (t <= now) return { kind: "expired" }
  return { kind: "active", daysLeft: Math.ceil((t - now) / 86_400_000) }
}

function FeedTypeLine({ icon: Icon, label, count }: { icon: ComponentType<{ className?: string }>; label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-[13px] w-[13px] text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium type-counter">{count}</span>
    </div>
  )
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "Just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatDate(iso)
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}
