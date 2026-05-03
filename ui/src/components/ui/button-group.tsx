import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"
import { Separator } from "@/components/ui/separator"

// Emits the `.btn-group` / `.btn-group-vertical` shortcut classes defined in
// `index.css` so the rendered DOM stays readable (`<div class="btn-group">`)
// and there's a single source of truth for segmented-button styling. Same
// JSX API as before; the cva chain that used to live here has been hoisted
// into CSS via `@apply`.

export type ButtonGroupOrientation = "horizontal" | "vertical"
export type ButtonGroupSize = "sm" | "default" | "lg"

const SIZE_CLASS: Record<ButtonGroupSize, string> = {
  default: "",
  sm: "btn-group-sm",
  lg: "btn-group-lg",
}

function ButtonGroup({
  className,
  orientation = "horizontal",
  size = "default",
  ...props
}: React.ComponentProps<"div"> & {
  orientation?: ButtonGroupOrientation
  size?: ButtonGroupSize
}) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      data-size={size}
      className={cn(
        orientation === "vertical" ? "btn-group-vertical" : "btn-group",
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    />
  )
}

function ButtonGroupText({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean
}) {
  const Comp = asChild ? Slot.Root : "div"

  return (
    <Comp
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-muted px-2.5 text-sm font-medium [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

function ButtonGroupSeparator({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="button-group-separator"
      orientation={orientation}
      className={cn(
        "relative self-stretch bg-input data-horizontal:mx-px data-horizontal:w-auto data-vertical:my-px data-vertical:h-auto",
        className
      )}
      {...props}
    />
  )
}

export {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
}
