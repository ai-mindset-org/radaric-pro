"use client"

import { useEffect, useState } from "react"
import { useRouter, useParams } from "next/navigation"
import { FeedForm } from "@/components/feeds/feed-form"
import { FeedFeedbackManager } from "@/components/feeds/feed-feedback-manager"
import type { SourceFormData } from "@/lib/validations/feed"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"

export default function EditFeedPage() {
  const router = useRouter()
  const params = useParams()
  const [source, setSource] = useState<SourceFormData | null>(null)
  const [customPool, setCustomPool] = useState<{ liked: string[]; disliked: string[] }>()
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const [sourceRes, poolRes] = await Promise.all([
          fetch(`/api/feeds/${params.id}`),
          fetch("/api/categories/custom"),
        ])
        if (!sourceRes.ok) throw new Error("Failed to fetch feed")
        const data = await sourceRes.json()
        setSource({
          url: data.url,
          type: data.type,
          name: data.name,
          coverUrl: data.coverUrl || "",
          customPrompt: data.customPrompt || "",
          isActive: data.isActive,
          twitterType: data.type === "TWITTER" ? "ACCOUNT" : undefined,
          twitterValue: data.type === "TWITTER"
            ? data.url.replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").split("/")[0]
            : "",
          interestQuery: data.interestQuery || "",
          interestCadence: data.interestCadence || undefined,
          includeRetweets: data.includeRetweets ?? false,
          likedCategories: data.likedCategories || [],
          dislikedCategories: data.dislikedCategories || [],
        })
        if (poolRes.ok) {
          setCustomPool(await poolRes.json())
        }
      } catch (error) {
        console.error("Error fetching feed:", error)
        toast.error("Error loading feed")
        router.push("/feeds")
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [params.id, router])

  async function onSubmit(data: SourceFormData) {
    try {
      const response = await fetch(`/api/feeds/${params.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        throw new Error("Failed to update feed")
      }

      toast.success("Feed updated successfully")
      router.push("/feeds")
      router.refresh()
    } catch (error) {
      console.error("Error updating feed:", error)
      toast.error("Error updating feed")
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    )
  }

  if (!source) {
    return null
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div>
        <div className="flex h-16 items-center px-4 md:px-6 mt-2 lg:mt-4">
          <Button variant="ghost" size="icon" className="-ml-3 mr-2" asChild>
            <Link href="/feeds">
              <ArrowLeft className="h-[16px] w-[16px]" />
            </Link>
          </Button>
          <div>
            <h1 className="text-xl md:text-2xl font-bold">Edit feed</h1>
            <p className="text-sm text-muted-foreground hidden sm:block">
              Update feed settings and AI learning
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-auto scrollbar-stable-both">
        <div className="max-w-2xl mx-auto px-4 md:px-6 py-6">
          <Tabs defaultValue="settings">
            <TabsList className="mb-6">
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="ai-learning">AI Learning</TabsTrigger>
            </TabsList>

            <TabsContent value="settings">
              <div className="bg-card rounded-xl p-6">
                <FeedForm
                  initialData={source}
                  onSubmit={onSubmit}
                  onCancel={() => router.push("/feeds")}
                  submitLabel="Save changes"
                  customCategoryPool={customPool}
                />
              </div>
            </TabsContent>

            <TabsContent value="ai-learning">
              <div className="bg-card rounded-xl p-6">
                <h2 className="text-lg font-semibold mb-4">Feedback & Learned Rules</h2>
                <p className="text-sm text-muted-foreground mb-6">
                  Your likes and dislikes help the AI learn what content is relevant for this feed.
                </p>
                <FeedFeedbackManager sourceId={params.id as string} />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
