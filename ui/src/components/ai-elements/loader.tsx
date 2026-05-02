// Hand-rolled equivalent of the (now removed-from-registry) ai-elements
// Loader. Single dot-pulse + optional status string (used for "Loading model
// into VRAM..." etc). Exported separately from shimmer.tsx so the message
// thread can import it without pulling motion.

import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  status?: string;
};

export const Loader = ({ status, className, ...props }: LoaderProps) => {
  const label = status && status.length > 0 ? status : "Thinking...";
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground ring-1 ring-inset ring-border",
        className,
      )}
      {...props}
    >
      <span className="inline-flex items-center gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current/60 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current/60 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current/60" />
      </span>
      <span>{label}</span>
    </div>
  );
};
