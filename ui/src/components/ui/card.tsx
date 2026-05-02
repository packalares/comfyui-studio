import * as React from "react"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Card primitives are tuned to match Studio's pre-existing `.panel`,
// `.panel-header`, `.panel-header-title`, `.panel-header-desc`, `.panel-body`,
// `.panel-footer`, `.panel-footer-note` rules in index.css so migrating
// consumers from those classes to <Card /> + slots is visually identical.

// Optional asChild lets callers render a Card-shaped <button>, <a>, etc.
// without losing the panel styling. Used by Dashboard's quick-action tiles.
function Card({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div"
  return (
    <Comp
      data-slot="card"
      className={cn(
        // .panel: overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm
        "overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm",
        className,
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        // .panel-header: border-b border-slate-200 px-4 py-3
        "border-b border-slate-200 px-4 py-3",
        className,
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        // .panel-header-title: text-sm font-semibold text-slate-900
        "text-sm font-semibold text-slate-900",
        className,
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn(
        // .panel-header-desc: mt-0.5 text-[11px] text-slate-400
        "mt-0.5 text-[11px] text-slate-400",
        className,
      )}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn("ml-auto flex items-center gap-2", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(
        // .panel-body: px-4 py-4
        "px-4 py-4",
        className,
      )}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        // .panel-footer: flex items-center justify-between gap-3 border-t
        // border-slate-200 bg-slate-50 px-4 py-3
        "flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3",
        className,
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
