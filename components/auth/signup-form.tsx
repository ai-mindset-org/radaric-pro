"use client"
import { signIn } from "next-auth/react"; import { useRouter } from "next/navigation"; import { useState } from "react"; import { Button } from "@/components/ui/button"; import { Input } from "@/components/ui/input"; import { Label } from "@/components/ui/label"; import { Loader2, Eye, EyeOff } from "lucide-react"; import { FcGoogle } from "react-icons/fc"; import { FaApple } from "react-icons/fa"; import Link from "next/link"

export function SignupForm({ oauth, trial = false }: { oauth: { google: boolean; apple: boolean }; trial?: boolean }) {
  const router = useRouter(); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [isLoading, setIsLoading] = useState(false); const [showPassword, setShowPassword] = useState(false)

  // RAD-293: providers are resolved SERVER-side and passed in, so the buttons
  // are in the first paint (no pop-in) and an unconfigured provider is never
  // offered (clicking one ejects the user to the Auth.js error page).
  const hasOauth = oauth.google || oauth.apple

  const isEmail = email.includes("@")

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); setError(""); setIsLoading(true)
    try {
      if (isEmail) {
        // Email flow — unified signup/signin
        const res = await fetch("/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
        const data = await res.json()
        if (!res.ok) { setError(data.error || "An error occurred"); setIsLoading(false); return }
        const result = await signIn("credentials", { email, password, redirect: false })
        if (result?.error) { setError("Invalid email or password"); setIsLoading(false); return }
        router.push(data.action === "signup" ? "/onboarding/feeds" : "/posts"); router.refresh()
      } else {
        // Username flow — legacy sign-in for existing users
        const result = await signIn("credentials", { username: email, password, redirect: false })
        if (result?.error) { setError("Invalid username or password"); setIsLoading(false); return }
        router.push("/posts"); router.refresh()
      }
    } catch { setError("An error occurred"); setIsLoading(false) }
  }

  return (<div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden">
    <div className="absolute inset-0 opacity-[0.04] dark:opacity-[0.07] blur-sm scale-110 bg-cover bg-center pointer-events-none" style={{ backgroundImage: "url('/images/app-preview.png')" }} />
    <div className="w-full max-w-md space-y-8 p-8 relative z-10">
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">Radaric</h1>
        <p className="mt-4 text-3xl font-bold tracking-tight leading-tight">AI that filters hundreds of posts.<br/>You read the best.</p>
        <p className="mt-3 text-base text-muted-foreground">Sign in or create an account</p>
        {trial && <p className="mt-2 text-sm font-medium text-primary">7 days free, no card required</p>}
      </div>
      {hasOauth && (
      <>
      <div className="space-y-3">
        {oauth.google && <Button type="button" variant="outline" className="w-full bg-card text-foreground hover:bg-accent h-11" onClick={() => signIn("google", { callbackUrl: "/posts" })}><FcGoogle className="h-[18px] w-[18px] mr-3" />Continue with Google</Button>}
        {oauth.apple && <Button type="button" variant="outline" className="w-full bg-card text-foreground hover:bg-accent h-11" onClick={() => signIn("apple", { callbackUrl: "/posts" })}><FaApple className="h-[18px] w-[18px] mr-3" />Continue with Apple</Button>}
      </div>
      <div className="relative"><div className="absolute inset-0 flex items-center"><div className="w-full h-px bg-border" /></div><div className="relative flex justify-center text-xs uppercase"><span className="bg-background px-2 text-muted-foreground">or</span></div></div>
      </>
      )}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="email">Email or username</Label><Input id="email" type="text" autoComplete="email" placeholder="you@example.com" required value={email} onChange={e => setEmail(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="password">Password</Label><div className="relative"><Input id="password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="Your password" required minLength={8} value={password} onChange={e => setPassword(e.target.value)} className="pr-10" /><button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground" aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff className="h-[16px] w-[16px]" /> : <Eye className="h-[16px] w-[16px]" />}</button></div><div className="flex justify-end"><Link href="/forgot-password" className="text-xs text-muted-foreground hover:text-foreground">Forgot password?</Link></div></div>
        {error && <div className="text-sm text-destructive text-center">{error}</div>}
        <Button type="submit" disabled={isLoading} className="w-full h-11">{isLoading ? <><Loader2 className="h-[16px] w-[16px] mr-2 animate-spin" />Signing in...</> : "Continue"}</Button>
      </form>
      <p className="text-xs text-muted-foreground text-center">By continuing you agree to our <Link href="/terms" className="link">Terms of Service</Link> and <Link href="/privacy" className="link">Privacy Policy</Link></p>
    </div>
  </div>)
}
