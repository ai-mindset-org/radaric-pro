import { FileQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import Link from "next/link"

export default function DashboardNotFound() {
  return (
    <div className="p-4 lg:p-8 flex flex-col items-center justify-center min-h-[50vh] gap-4">
      <FileQuestion className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">Page not found</h2>
      <p className="text-sm text-muted-foreground text-center max-w-md">
        The post or story you&apos;re looking for doesn&apos;t exist or has been deleted.
      </p>
      <Button variant="outline" asChild className="mt-2">
        <Link href="/posts">Back to posts</Link>
      </Button>
    </div>
  )
}
