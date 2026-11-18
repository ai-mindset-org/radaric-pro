"use client"
import { useState, useEffect, useRef } from "react"
import { CheckCircle, XCircle, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ExtractedFeed } from "@/lib/onboarding-types"
const TYPE_COLORS: Record<string, string> = { RSS: "bg-[#f76b15]", TELEGRAM: "bg-info", TWITTER: "bg-muted-foreground", YOUTUBE: "bg-[#e5484d]", WEBSITE: "bg-muted-foreground/50" }
interface Props { feeds: ExtractedFeed[]; error?: string; onComplete: (feeds: ExtractedFeed[]) => void; onBack: () => void }
export function FeedDiscoveryProgress({ feeds, error, onComplete, onBack }: Props) {
  const completedRef = useRef(false); const onCompleteRef = useRef(onComplete)
  useEffect(() => { onCompleteRef.current = onComplete }, [onComplete])
  const [showCelebration, setShowCelebration] = useState(false); const [showAll, setShowAll] = useState(false); const [showDetails, setShowDetails] = useState(false)
  const total = feeds.length; const found = feeds.filter(f => f.status === "found").length; const notFound = feeds.filter(f => f.status === "not_found").length; const pending = feeds.filter(f => f.status === "pending").length
  const progress = total > 0 ? ((found + notFound) / total) * 100 : 0; const allDone = pending === 0 && total > 0; const isCompact = total > 50
  useEffect(() => { if (allDone && !completedRef.current) { completedRef.current = true; setShowCelebration(true); setTimeout(() => { setShowCelebration(false); onCompleteRef.current(feeds) }, 1500) } }, [allDone, feeds])
  const visibleFeeds = showAll || showDetails ? feeds : total > 20 ? feeds.slice(0, 10) : feeds; const hiddenCount = total - (total > 20 ? 10 : total)
  return (<div className="mt-10 space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">{showCelebration ? `All ${found} feeds found` : "Finding your feeds..."}</h1><p className="mt-2 text-base text-muted-foreground">Checking {total} feeds</p></div>
    {error && <div className="rounded-xl bg-destructive-subtle p-4"><p className="text-sm text-destructive">{error}</p><Button variant="ghost" size="sm" className="mt-2" onClick={onBack}>← Try again</Button></div>}
    {isCompact && !showDetails && <div className="space-y-3"><div className="flex flex-wrap gap-1">{feeds.map((f, i) => <div key={i} className={`h-[6px] w-[6px] rounded-full ${f.status === "found" ? "bg-green-bright" : f.status === "not_found" ? "bg-destructive/70" : "bg-muted-foreground/30"}`} title={f.name} />)}</div><button onClick={() => setShowDetails(true)} className="text-sm text-muted-foreground hover:text-foreground">Show details</button></div>}
    <div className={`space-y-1 ${isCompact && !showDetails ? "hidden" : ""}`} aria-live="polite">
      {visibleFeeds.map((feed, i) => <div key={`${feed.name}-${i}`} className="flex items-start gap-3 py-2 px-3 rounded-md hover:bg-accent/50 transition-colors motion-safe:animate-fade-in-up" style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}>
        <div className={`mt-1.5 h-[8px] w-[8px] rounded-full shrink-0 ${TYPE_COLORS[feed.type]}`} />
        <div className="shrink-0 mt-0.5">{feed.status === "found" ? <CheckCircle className="h-[16px] w-[16px] text-primary" /> : feed.status === "not_found" ? <XCircle className="h-[16px] w-[16px] text-destructive/70" /> : <Loader2 className="h-[16px] w-[16px] text-muted-foreground motion-safe:animate-spin" />}</div>
        <div className="flex-1 min-w-0"><div className="flex items-center gap-3"><span className="text-sm font-medium truncate">{feed.name}</span><span className={`text-xs shrink-0 ${feed.status === "found" ? "text-primary" : feed.status === "not_found" ? "text-destructive/70" : "text-muted-foreground"}`}>{feed.status === "found" ? (feed.type === "TELEGRAM" ? "Telegram" : feed.type === "TWITTER" ? "Twitter/X" : feed.type === "YOUTUBE" ? "YouTube" : "RSS found") : feed.status === "not_found" ? "No feed found" : "Searching..."}</span></div>
        {feed.recentHeadline && <p className="text-xs text-muted-foreground/70 truncate italic mt-0.5">Latest: {feed.recentHeadline}</p>}</div></div>)}
      {!showAll && hiddenCount > 0 && <button onClick={() => setShowAll(true)} className="flex items-center gap-1 px-3 py-2 text-sm text-muted-foreground hover:text-foreground">▾ Show {hiddenCount} more</button>}
    </div>
    <div><div className="h-1.5 bg-muted rounded-full overflow-hidden" role="progressbar" aria-valuenow={found + notFound} aria-valuemin={0} aria-valuemax={total}><div className="h-full bg-green-bright rounded-full transition-all duration-300" style={{ width: `${progress}%` }} /></div>
      {/* Plain text, not a morph: a morph root beside the static total paints
          its digits with a different advance, and two digit runs on one line
          show it (RAD-353/354). The visible copy is the announced copy. */}
      <p className="text-xs text-muted-foreground mt-1.5 text-right" aria-live="polite" aria-atomic="true"><span className="type-counter">{found + notFound}</span> of <span className="type-counter">{total}</span></p>
    </div>
    {showCelebration && <div className="flex items-center justify-center gap-2 py-4 motion-safe:animate-fade-in-scale"><CheckCircle className="h-[20px] w-[20px] text-primary" /><span className="text-base font-medium text-primary">All {found} feeds found</span></div>}
    {allDone && !showCelebration && <div className="flex items-center justify-between"><Button onClick={() => onComplete(feeds)}>Continue →</Button><Button variant="ghost" onClick={onBack}>← Start over</Button></div>}
  </div>)
}
