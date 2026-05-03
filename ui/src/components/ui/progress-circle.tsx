import { cn } from "@/lib/utils"

// SVG donut showing `percent` filled clockwise from 12 o'clock. Track + fill
// stroke colors are class-driven so callers can re-tint based on context
// (emerald / amber / rose for the chat context meter, teal for generic
// progress, etc). Defaults render in slate.

interface ProgressCircleProps {
  /** 0–100. Out-of-range values get clamped. */
  percent: number
  /** SVG container size — defaults to `h-3.5 w-3.5` (14px) for inline use. */
  className?: string
  /** Stroke color of the unfilled track. Default: `stroke-slate-200`. */
  trackClassName?: string
  /** Stroke color of the filled portion. Default: `stroke-emerald-500`. */
  fillClassName?: string
  /** Stroke thickness. Defaults to 2 (out of a 16-unit viewBox). */
  strokeWidth?: number
}

export function ProgressCircle({
  percent,
  className,
  trackClassName,
  fillClassName,
  strokeWidth = 2,
}: ProgressCircleProps) {
  const r = 7 - strokeWidth / 2
  const circumference = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, percent || 0))
  const offset = circumference - (clamped / 100) * circumference
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("h-3.5 w-3.5 -rotate-90 shrink-0", className)}
      aria-hidden
    >
      <circle
        cx="8" cy="8" r={r}
        className={cn("fill-none stroke-slate-200", trackClassName)}
        strokeWidth={strokeWidth}
      />
      <circle
        cx="8" cy="8" r={r}
        className={cn("fill-none stroke-emerald-500 transition-all", fillClassName)}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  )
}
