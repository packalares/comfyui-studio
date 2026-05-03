import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

// Centralized loading indicator. Replaces 50+ ad-hoc
// `<Loader2 className="w-X h-X animate-spin" />` invocations across the app.
//
// Defaults to `size="md"` (16px) — matches the bulk of pre-existing usages.
// Adds `role="status"` + `aria-label="Loading"` so screen readers announce
// every spinner without per-call boilerplate.

export type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl"

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: "w-3 h-3",        // 12px — inline with small text labels
  sm: "w-3.5 h-3.5",    // 14px — most common, button-icon size
  md: "w-4 h-4",        // 16px — body text default
  lg: "w-5 h-5",        // 20px — panel placeholders
  xl: "w-6 h-6",        // 24px — App splash, big modal loaders
  "2xl": "w-10 h-10",   // 40px — Studio empty-state full-bleed loader
}

interface SpinnerProps extends React.ComponentProps<"svg"> {
  size?: SpinnerSize
}

function Spinner({ size = "md", className, ...props }: SpinnerProps) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("animate-spin", SIZE_CLASS[size], className)}
      {...props}
    />
  )
}

export { Spinner }
