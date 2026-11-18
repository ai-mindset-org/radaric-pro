import { Badge } from "@/components/ui/badge"

/**
 * Live typography specimen (RAD-363 slice 7) — drawn with the real role
 * classes, so it repaints the moment the provider's `<style>` changes.
 */
export function TypographySpecimen() {
  return (
    <div className="space-y-3 rounded-lg bg-secondary/60 p-4 ring-1 ring-inset ring-hairline sm:p-5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="truncate">Design Digest</span>
        <span className="type-counter text-muted-foreground">24</span>
      </div>
      <div className="space-y-1.5">
        <h3 className="type-heading text-base font-semibold leading-snug">
          Figma rebuilds its text engine around variable fonts
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The new renderer reads a font&apos;s axes directly, so width and weight tweaks land in the file
          without swapping styles.
        </p>
        <p className="text-xs text-muted-foreground">
          <span className="type-counter">12</span> new · <span className="type-counter">87%</span> relevant
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="secondary">Design</Badge>
        <Badge variant="secondary">Tools</Badge>
      </div>
    </div>
  )
}
