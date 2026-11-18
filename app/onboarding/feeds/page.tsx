"use client"
import { useState, useRef, useCallback, useEffect, use } from "react"; import { useRouter } from "next/navigation"; import { Button } from "@/components/ui/button"; import { PhaseIndicator } from "@/components/onboarding/phase-indicator"; import { Loader2, Upload, X, FileText } from "lucide-react"; import { FeedDiscoveryProgress } from "@/components/onboarding/feed-discovery-progress"; import type { ExtractedFeed } from "@/lib/onboarding-types"; import { persistFeeds } from "@/lib/onboarding-persist"
type PageState = "input" | "parsing"
export default function ImportFeedsPage({ searchParams }: { searchParams?: Promise<{ revisit?: string | string[] }> }) {
  const router = useRouter(); const [state, setState] = useState<PageState>("input"); const [text, setText] = useState(""); const [file, setFile] = useState<File|null>(null); const [isLoading, setIsLoading] = useState(false); const [error, setError] = useState(""); const [feeds, setFeeds] = useState<ExtractedFeed[]>([]); const fileInputRef = useRef<HTMLInputElement>(null); const abortControllerRef = useRef<AbortController | null>(null)
  // RAD-168: ?revisit=1 (set by the revisit gate) is cosmetic — welcome-back copy, no Preferences phase — and rides along to the next step.
  const revisit = (searchParams ? use(searchParams) : undefined)?.revisit === "1"; const q = revisit ? "?revisit=1" : ""
  // Where skip goes comes from onboardingCompleted, tri-state: known returning → /posts; first-time or unknown (failed / timed out) → preferences, whose server guard sends a returning user on to /posts.
  const returningRef = useRef<Promise<boolean> | null>(null); const [skipping, setSkipping] = useState(false)
  useEffect(() => { returningRef.current = fetch("/api/user-settings", { signal: AbortSignal.timeout(5000) }).then(r => r.ok ? r.json() : null).then(s => s?.onboardingCompleted === true).catch(() => false) }, [])
  // A revisit must not resume the list from a first onboarding months ago (review reads onboardingState first).
  useEffect(() => { if (revisit) fetch("/api/user-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboardingState: null }) }).catch(() => {}) }, [revisit])
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) { if (f.size > 5*1024*1024) { setError("File too large. Max 5 MB."); return }; setFile(f); setError("") } }
  const handleDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { if (f.size > 5*1024*1024) { setError("Max 5 MB."); return }; setFile(f); setError("") } }, [])
  // persistFeeds imported from lib/onboarding-persist (shared helper with retry + toast)
  const handleSubmit = async () => {
    if (!text.trim() && !file) return; setIsLoading(true); setError("")
    const controller = new AbortController(); abortControllerRef.current = controller
    try {
      const fd = new FormData(); if (text.trim()) fd.append("text", text.trim()); if (file) fd.append("file", file)
      const res = await fetch("/api/onboarding/parse-feeds", { method: "POST", body: fd, signal: controller.signal }); if (!res.ok) { setError((await res.json()).error || "Failed"); setIsLoading(false); return }
      setState("parsing"); setIsLoading(false); const reader = res.body?.getReader(); const dec = new TextDecoder(); const parsed: ExtractedFeed[] = []
      if (reader) { while (true) { const { done, value } = await reader.read(); if (done) break; for (const line of dec.decode(value, { stream: true }).split("\n")) { if (line.startsWith("data: ")) { try { const ev = JSON.parse(line.slice(6)); if (ev.type==="feed") { parsed.push(ev.feed); setFeeds([...parsed]) }; if (ev.type==="update") { const i = parsed.findIndex(f => f.url===ev.feed.url && f.name===ev.feed.name); if (i!==-1) { parsed[i]=ev.feed; setFeeds([...parsed]) } }; if (ev.type==="complete") { setFeeds([...parsed]); await persistFeeds(parsed); sessionStorage.setItem("onboarding:feeds", JSON.stringify(parsed)) }; if (ev.type==="error") setError(ev.message) } catch {} } } } }
    } catch (e) { if (e != null && (e as { name?: string }).name === "AbortError") return; setError("An error occurred. Try pasting URLs one per line."); setIsLoading(false) }
  }
  const handleSkip = async () => { if (skipping) return; setSkipping(true); abortControllerRef.current?.abort(); router.push((await returningRef.current) ? "/posts" : "/onboarding/preferences") }
  if (state === "parsing") return (<><PhaseIndicator currentPhase="import" skipPreferences={revisit} /><FeedDiscoveryProgress feeds={feeds} error={error} onComplete={(resolved) => { const unr = resolved.filter(f => f.type==="WEBSITE" && f.status==="not_found"); if (unr.length >= 3) router.push(`/onboarding/unresolved${q}`); else router.push(`/onboarding/review${q}`) }} onBack={() => { setState("input"); setFeeds([]) }} /></>)
  return (<><PhaseIndicator currentPhase="import" skipPreferences={revisit} /><div className="mt-10 space-y-6">
    <div><h1 className="text-3xl font-bold tracking-tight">{revisit ? "Welcome back — add your first feed" : "Add your feeds"}</h1><p className="mt-2 text-base text-muted-foreground">Paste links, drop a file, or type — we&apos;ll figure out the rest</p></div>
    <textarea value={text} onChange={e => setText(e.target.value)} rows={14} className="w-full rounded-lg bg-secondary px-4 py-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 resize-none placeholder:text-muted-foreground" placeholder={"Paste your feeds here...\n\nRSS feeds, website URLs, Telegram channels, Twitter accounts, YouTube channels — in any format"} />
    <div role="button" tabIndex={0} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click() } }} onDrop={handleDrop} onDragOver={e => e.preventDefault()} onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-2 rounded-lg bg-secondary hover:bg-accent py-4 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50">
      {file ? <div className="flex items-center gap-2 text-sm"><FileText className="h-[16px] w-[16px] text-muted-foreground" /><span>{file.name}</span><button onClick={e => { e.stopPropagation(); setFile(null) }} className="text-muted-foreground hover:text-destructive" aria-label="Remove file"><X className="h-[14px] w-[14px]" /></button></div> : <><Upload className="h-[18px] w-[18px] text-muted-foreground" /><span className="text-sm text-muted-foreground">Upload file</span><span className="text-xs text-muted-foreground">.txt .json .md .opml</span></>}
      <input ref={fileInputRef} type="file" accept=".txt,.json,.md,.opml" onChange={handleFileChange} className="hidden" />
    </div>
    {error && <p className="text-sm text-destructive">{error}</p>}
    <div className="flex items-center justify-between"><Button variant="ghost" onClick={handleSkip} disabled={skipping}>{revisit ? "Not now — go to dashboard" : <>Skip, I&apos;ll add later →</>}</Button><Button onClick={handleSubmit} disabled={isLoading || (!text.trim() && !file)}>{isLoading ? <><Loader2 className="h-[16px] w-[16px] mr-2 motion-safe:animate-spin" />Finding feeds...</> : "Find feeds"}</Button></div>
  </div></>)
}
