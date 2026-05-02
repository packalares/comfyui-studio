import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Variants are tuned to match Studio's pre-existing `.btn-primary`,
// `.btn-secondary`, `.btn-icon`, `.btn-ghost`, `.btn-sm` rules in index.css so
// migrating consumers from those classes to <Button /> is visually identical.
// See ui/src/index.css for the original rules.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-transparent whitespace-nowrap font-medium transition outline-none select-none focus-visible:ring-2 focus-visible:ring-teal-500/40 disabled:opacity-50 disabled:pointer-events-none disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // .btn-primary: bg-teal-600 text-white hover:bg-teal-700
        default: "bg-teal-600 text-white hover:bg-teal-700",
        // .btn-secondary: white surface with slate border
        secondary:
          "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        outline:
          "border-slate-300 bg-transparent text-slate-700 hover:bg-slate-50",
        // .btn-ghost / .btn-icon hover: light slate hover
        ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-700",
        destructive: "bg-rose-600 text-white hover:bg-rose-700",
        link: "text-teal-600 underline-offset-4 hover:underline",
      },
      size: {
        // matches .btn (px-2.5 py-1.5 text-xs)
        default: "px-2.5 py-1.5 text-xs",
        // matches .btn-sm (px-1.5 py-0.5 text-[11px])
        sm: "px-1.5 py-0.5 text-[11px]",
        // legacy xs alias for sm; preserved for any existing consumers
        xs: "px-1.5 py-0.5 text-[11px]",
        lg: "px-3 py-2 text-sm",
        // .btn-icon: square padding, no x/y padding
        icon: "p-1.5",
        "icon-xs": "p-1 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "p-1.5",
        "icon-lg": "p-2",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
