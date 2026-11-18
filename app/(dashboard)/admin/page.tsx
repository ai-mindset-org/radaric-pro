import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { AdminDashboard } from "@/components/admin/admin-dashboard"

export const metadata: Metadata = { title: "Admin" }
export const dynamic = "force-dynamic"

export default async function AdminPage() {
  const session = await auth()
  if (!session?.user?.id) redirect("/signup")
  if (session.user.role !== "ADMIN") redirect("/posts")

  return <AdminDashboard />
}
