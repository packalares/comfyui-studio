"use client";

import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";
import { memo, useMemo } from "react";

// Pure-CSS shimmer text. Replaces an earlier Framer Motion implementation
// (`motion/react` import was the sole consumer of the `motion` package, ~740K
// + transitive deps). Same visual: a "shine" gradient slides across the text
// while the text itself stays in `var(--color-muted-foreground)`.
//
// The animation rides on `--animate-text-shimmer` (declared in index.css's
// `@theme` block, generated as the `animate-text-shimmer` Tailwind utility).
// `duration` is overridden via inline `animationDuration`; `spread` controls
// the half-width of the bright zone via the `--spread` CSS var.

export interface TextShimmerProps {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
}

const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  );

  return (
    <Component
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "animate-text-shimmer",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className
      )}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          animationDuration: `${duration}s`,
          backgroundImage:
            "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
    >
      {children}
    </Component>
  );
};

export const Shimmer = memo(ShimmerComponent);
