import { redirect } from "next/navigation"

export const metadata = { title: "Stories" }

export default function StoriesPage() {
  redirect("/posts")
}
