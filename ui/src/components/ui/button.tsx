import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Each variant + size maps to a CSS shortcut class defined in `index.css`
// (`.btn-primary`, `.btn-sm`, `.btn-icon-pad`, etc) so the rendered DOM stays
// readable (`<button class="btn-primary">`) and there's a single source of
// truth in CSS. The Tailwind utility chain still ships through `@apply`
// inside each shortcut — same pixels, less verbosity.

const VARIANT_CLASS: Record<string, string> = {
  default: "btn-primary",
  secondary: "btn-secondary",
  outline: "btn-outline",
  ghost: "btn-ghost",
  destructive: "btn-destructive",
  link: "btn-link",
}

const SIZE_CLASS: Record<string, string> = {
  // default size baked into each variant class — no extra modifier needed
  default: "",
  sm: "btn-sm",
  // legacy alias preserved for any existing consumers
  xs: "btn-sm",
  lg: "btn-lg",
  // size=icon swaps padding only — variant supplies colors
  icon: "btn-icon-pad",
  "icon-xs": "btn-icon-xs",
  "icon-sm": "btn-icon-pad",
  "icon-lg": "btn-icon-lg",
}

export type ButtonVariant = keyof typeof VARIANT_CLASS
export type ButtonSize = keyof typeof SIZE_CLASS

export interface ButtonVariantsArgs {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
}

/** Compose the CSS class string for a given variant/size. Kept as a function
 *  export so existing call sites that previously imported `buttonVariants`
 *  from cva (e.g. `alert-dialog.tsx`) keep working unchanged. */
export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: ButtonVariantsArgs = {}): string {
  // Always include `btn` (the base) — Tailwind v4 forbids `@apply btn` inside
  // variant rules, so the variant classes carry ONLY their colors. The base
  // layout/typography needs to be present on the element directly.
  return cn("btn", VARIANT_CLASS[variant] ?? "", SIZE_CLASS[size] ?? "", className)
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={buttonVariants({ variant, size, className })}
      {...props}
    />
  )
}

export { Button }
