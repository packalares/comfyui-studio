import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Each variant maps to a `.badge-*` shortcut class defined in `index.css`.
// Same render as the previous cva chain — same pixels, less DOM noise.
//
// Of the eleven variants the cva used to expose, only seven actually have
// consumers in the codebase (`slate`, `emerald`, `teal`, `rose`, `amber`,
// `outline`, `secondary`). The four unused shadcn-default variants are kept
// in the type union but currently fall through to the bare `.badge` base —
// styling is bg-transparent / text-inherit until someone needs them.

const VARIANT_CLASS: Record<string, string> = {
  emerald: "badge-emerald",
  amber: "badge-amber",
  rose: "badge-rose",
  slate: "badge-slate",
  teal: "badge-teal",
  outline: "badge-outline",
  secondary: "badge-secondary",
  // shadcn defaults retained for type-compat. No tone class — caller
  // composes via `className` prop if they want one.
  default: "",
  destructive: "",
  ghost: "",
  link: "",
}

export type BadgeVariant = keyof typeof VARIANT_CLASS

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & {
  variant?: BadgeVariant
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "span"
  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn("badge", VARIANT_CLASS[variant] ?? "", className)}
      {...props}
    />
  )
}

export { Badge }
