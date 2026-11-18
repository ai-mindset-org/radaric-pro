"use client"
import { CheckCircle } from "lucide-react"
export type OnboardingPhase = "import" | "review" | "preferences"
const PHASES: { key: OnboardingPhase; label: string }[] = [{ key: "import", label: "Import" }, { key: "review", label: "Review" }, { key: "preferences", label: "Preferences" }]
// skipPreferences: a returning user (RAD-168, ?revisit=1) never visits the preferences step.
export function PhaseIndicator({ currentPhase, skipPreferences = false }: { currentPhase: OnboardingPhase; skipPreferences?: boolean }) {
  const phases = skipPreferences ? PHASES.filter((p) => p.key !== "preferences") : PHASES
  const currentIndex = phases.findIndex((p) => p.key === currentPhase)
  return (<nav aria-label="Onboarding progress" className="flex items-center justify-center gap-2">
    {phases.map((phase, i) => { const isCompleted = i < currentIndex; const isActive = i === currentIndex; return (<div key={phase.key} className="flex items-center gap-2">
      {i > 0 && <div className={`w-8 h-px ${isCompleted || isActive ? "bg-green-bright" : "bg-border"}`} />}
      <div className="flex items-center gap-1.5">
        {isCompleted ? <CheckCircle className="h-[16px] w-[16px] text-primary" /> : <div className={`h-[8px] w-[8px] rounded-full ${isActive ? "bg-green-bright" : "bg-muted-foreground/30"}`} />}
        <span className={`text-xs font-medium ${isActive ? "text-foreground" : isCompleted ? "text-primary" : "text-muted-foreground"}`}>{phase.label}</span>
      </div></div>)})}
  </nav>)
}
