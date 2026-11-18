"use client"
import { useState } from "react"; import { Button } from "@/components/ui/button"; import { Input } from "@/components/ui/input"; import { Label } from "@/components/ui/label"; import { Loader2, ArrowLeft, CheckCircle } from "lucide-react"; import Link from "next/link"
export default function ForgotPasswordPage() {
  const [email,setEmail]=useState(""); const [loading,setLoading]=useState(false); const [sent,setSent]=useState(false); const [error,setError]=useState("")
  async function submit(e: React.FormEvent) { e.preventDefault(); setError(""); setLoading(true); try { const r = await fetch("/api/auth/forgot-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email})}); if (r.ok) setSent(true); else setError((await r.json()).error||"Error") } catch { setError("Error") } finally { setLoading(false) } }
  return (<div className="min-h-screen flex items-center justify-center bg-background"><div className="w-full max-w-md space-y-6 p-8">
    <Link href="/signup" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-[16px] w-[16px]"/>Back to sign in</Link>
    {sent?<div className="space-y-4 text-center"><CheckCircle className="h-[48px] w-[48px] text-primary mx-auto"/><h1 className="text-2xl font-bold">Check your email</h1><p className="text-muted-foreground">If an account with <strong>{email}</strong> exists, we&apos;ve sent a reset link.</p></div>:<>
    <div><h1 className="text-2xl font-bold">Reset your password</h1><p className="mt-2 text-muted-foreground">Enter your email and we&apos;ll send a reset link</p></div>
    <form onSubmit={submit} className="space-y-4"><div className="space-y-2"><Label htmlFor="e">Email</Label><Input id="e" type="email" placeholder="you@example.com" required value={email} onChange={e=>setEmail(e.target.value)}/></div>{error&&<p className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={loading} className="w-full">{loading?<><Loader2 className="h-[16px] w-[16px] mr-2 animate-spin"/>Sending...</>:"Send reset link"}</Button></form></>}
  </div></div>)
}
