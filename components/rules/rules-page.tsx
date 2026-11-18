"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Save, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { USER_PROMPT_MAX } from "@/lib/validations/prompt-limits"

type BlacklistItem = {
  id: string
  term: string
  matchType: "EXACT" | "CONTAINS" | "REGEX"
  createdAt: Date
}

type FeedbackItem = {
  id: string
  feedbackType: "LIKE" | "DISLIKE"
  commentText: string | null
  isGlobal: boolean
  createdAt: Date
  feed: { id: string; name: string } | null
}

interface RulesPageProps {
  globalPrompt: string
  blacklist: BlacklistItem[]
  feedback: FeedbackItem[]
}

export function RulesPage({ globalPrompt: initialPrompt, blacklist: initialBlacklist, feedback }: RulesPageProps) {
  const router = useRouter()
  const [globalPrompt, setGlobalPrompt] = useState(initialPrompt)
  const [isSaving, setIsSaving] = useState(false)
  const [blacklist, setBlacklist] = useState<BlacklistItem[]>(initialBlacklist)
  const [newBlacklistItem, setNewBlacklistItem] = useState({
    term: "",
    matchType: "CONTAINS" as "EXACT" | "CONTAINS" | "REGEX",
  })

  async function handleSave() {
    setIsSaving(true)
    try {
      const response = await fetch("/api/user-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalPrompt }),
      })
      if (!response.ok) {
        // The server's cap message is the only explanation the user gets.
        const data = await response.json().catch(() => null)
        throw new Error(data?.error ?? "Failed to save")
      }
      toast.success("Rules saved")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save rules")
    } finally {
      setIsSaving(false)
    }
  }

  async function handleAddBlacklistItem() {
    if (!newBlacklistItem.term) return
    try {
      const response = await fetch("/api/blacklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newBlacklistItem),
      })
      if (!response.ok) throw new Error("Failed to add")
      const item = await response.json()
      setBlacklist([item, ...blacklist])
      setNewBlacklistItem({ term: "", matchType: "CONTAINS" })
      toast.success("Added to blocklist")
    } catch {
      toast.error("Failed to add blocklist item")
    }
  }

  async function handleDeleteBlacklistItem(id: string) {
    try {
      const response = await fetch(`/api/blacklist/${id}`, { method: "DELETE" })
      if (!response.ok) throw new Error("Failed to delete")
      setBlacklist(blacklist.filter((item) => item.id !== id))
      toast.success("Removed from blocklist")
    } catch {
      toast.error("Failed to remove blocklist item")
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-6 px-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Rules</h1>
          <p className="text-sm text-muted-foreground">
            Content filtering criteria, blocklist, and AI knowledge base
          </p>
        </div>
        <Button onClick={handleSave} disabled={isSaving} size="sm" className="md:text-base md:h-9">
          {isSaving ? "Saving..." : (
            <>
              <Save className="mr-2 h-[16px] w-[16px]" />
              Save
            </>
          )}
        </Button>
      </div>

      {/* Global Prompt */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Global Prompt</h2>
          <p className="text-sm text-muted-foreground">
            Tell the AI what content matters to you and why. Describe your role and goals in plain language — the AI reads this to decide which materials to approve or filter out.
          </p>
        </div>
        <Textarea
          placeholder="Example: I curate a weekly design and tech newsletter. Approve articles about UX trends, new design tools, notable product launches, and deep technical analyses. Filter out job postings, self-promotion, and generic AI news without substance."
          rows={12}
          maxLength={USER_PROMPT_MAX}
          value={globalPrompt}
          onChange={(e) => setGlobalPrompt(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Used by &quot;Run AI Rules&quot; and during parsing to evaluate each material
        </p>
      </section>

      {/* Blocklist */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Blocklist</h2>
          <p className="text-sm text-muted-foreground">
            Automatically filter out materials matching these patterns (no AI needed)
          </p>
        </div>

        <div className="rounded-lg p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="newPattern">Pattern</Label>
              <Input
                id="newPattern"
                placeholder="e.g.: spam"
                value={newBlacklistItem.term}
                onChange={(e) =>
                  setNewBlacklistItem({ ...newBlacklistItem, term: e.target.value })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddBlacklistItem()
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newType">Match Type</Label>
              <Select
                value={newBlacklistItem.matchType}
                onValueChange={(value: "EXACT" | "CONTAINS" | "REGEX") =>
                  setNewBlacklistItem({ ...newBlacklistItem, matchType: value })
                }
              >
                <SelectTrigger id="newType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EXACT">Exact match</SelectItem>
                  <SelectItem value="CONTAINS">Contains</SelectItem>
                  <SelectItem value="REGEX">Regular expression</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleAddBlacklistItem} size="sm">
            <Plus className="mr-2 h-[16px] w-[16px]" />
            Add
          </Button>
        </div>

        <div className="space-y-2">
          {blacklist.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Blocklist is empty
            </p>
          ) : (
            blacklist.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-lg p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.term}</span>
                  <Badge variant="outline">
                    {item.matchType === "EXACT" && "Exact"}
                    {item.matchType === "CONTAINS" && "Contains"}
                    {item.matchType === "REGEX" && "Regex"}
                  </Badge>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${item.term}`}
                  onClick={() => handleDeleteBlacklistItem(item.id)}
                >
                  <Trash2 className="h-[16px] w-[16px]" />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* AI Knowledge Base */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">AI Knowledge Base</h2>
          <p className="text-sm text-muted-foreground">
            Accumulated feedback from your likes and dislikes — AI uses this to learn your preferences
          </p>
        </div>

        <div className="space-y-2">
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No feedback yet. Like or dislike materials to teach AI your preferences.
            </p>
          ) : (
            feedback.map((item) => (
              <Card key={item.id} className="p-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    {item.isGlobal ? (
                      <Badge>Global</Badge>
                    ) : item.feed ? (
                      <Badge variant="outline">{item.feed.name}</Badge>
                    ) : (
                      <Badge variant="outline">Per source</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {new Date(item.createdAt).toLocaleDateString("en-US")}
                    </span>
                  </div>
                  <p className="text-sm">{item.commentText || "Reaction (no comment)"}</p>
                </div>
              </Card>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
