"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import {
  CheckCircle,
  ChevronDownIcon,
  Circle,
  Clock,
  FileText,
  Plug,
  Search,
  Terminal,
  Wand2,
  Wrench,
  XCircle,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { MessageResponse } from "./message";

// Plain monospace JSON renderer — fallback for short plain-text output
// that isn't JSON or markdown (keeps the shiki budget zero for that case).
const ToolJsonBlock = ({ code }: { code: string }) => (
  <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs font-mono text-foreground whitespace-pre">
    {code}
  </pre>
);

// ---------------------------------------------------------------------------
// 1. Per-tool icon
// ---------------------------------------------------------------------------
export function getToolIcon(
  rawName: string
): React.ComponentType<{ className?: string }> {
  if (rawName.startsWith("mcp__")) return Plug;
  const n = rawName.toLowerCase();
  if (n.includes("web") || n.includes("search")) return Search;
  if (n.includes("image") || n.includes("generate_image")) return Wand2;
  if (n.includes("read") || n.includes("file")) return FileText;
  if (n.includes("code") || n.includes("bash") || n.includes("shell"))
    return Terminal;
  return Wrench;
}

// ---------------------------------------------------------------------------
// 2. MCP name split
// ---------------------------------------------------------------------------
export type SplitToolName =
  | { server: string; label: string }
  | { server?: never; label: string };

export function splitToolName(raw: string): SplitToolName {
  const mcpMatch = raw.match(/^mcp__([^_]+)__(.+)$/);
  if (mcpMatch) {
    const server = mcpMatch[1].replace(/[-_]/g, " ");
    const label = mcpMatch[2].replace(/[-_]/g, " ");
    return { server, label };
  }
  // Strip legacy "tool-" prefix, replace separators, capitalise first word
  const stripped = raw.replace(/^tool-/, "").replace(/[-_]/g, " ");
  const label =
    stripped.charAt(0).toUpperCase() + stripped.slice(1).toLowerCase();
  return { label };
}

// ---------------------------------------------------------------------------
// 6. Collapsed inline summary (exported for MessageThread.tsx)
// ---------------------------------------------------------------------------
export function getCollapsedSummary(input: unknown): string | null {
  if (!input || typeof input !== "object" || isValidElement(input)) return null;
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;

  const primaryKeys = ["query", "prompt", "url", "path", "message", "q"];
  for (const k of primaryKeys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) {
      const text = v.trim();
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
  }

  const n = keys.length;
  return n === 1 ? "1 param" : `${n} params`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-2 w-full rounded-md border", className)}
    {...props}
  />
);

export type ToolPart = ToolUIPart | DynamicToolUIPart;

export type ToolHeaderProps = {
  title?: string;
  className?: string;
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"];
      state: DynamicToolUIPart["state"];
      toolName: string;
    }
);

// ---------------------------------------------------------------------------
// 3. Status badge — new Badge API
// ---------------------------------------------------------------------------
const PulsingClock = ({ className }: { className?: string }) => (
  <Clock className={cn(className, "animate-pulse")} />
);

export const getStatusBadge = (status: ToolPart["state"]): ReactNode => {
  switch (status) {
    case "approval-requested":
      return (
        <Badge variant="warning" treatment="soft" icon={Clock}>
          Awaiting Approval
        </Badge>
      );
    case "approval-responded":
      return (
        <Badge variant="brand" treatment="soft" icon={CheckCircle}>
          Responded
        </Badge>
      );
    case "input-available":
      return (
        <Badge variant="neutral" treatment="soft" icon={PulsingClock}>
          Running
        </Badge>
      );
    case "input-streaming":
      return (
        <Badge variant="neutral" treatment="soft" icon={Circle}>
          Pending
        </Badge>
      );
    case "output-available":
      return (
        <Badge variant="success" treatment="soft" icon={CheckCircle}>
          Completed
        </Badge>
      );
    case "output-denied":
      return (
        <Badge variant="warning" treatment="soft" icon={XCircle}>
          Denied
        </Badge>
      );
    case "output-error":
      return (
        <Badge variant="danger" treatment="soft" icon={XCircle}>
          Error
        </Badge>
      );
    default:
      return null;
  }
};

// ---------------------------------------------------------------------------
// ToolHeader — per-tool icon, MCP server badge, collapsed summary
// ---------------------------------------------------------------------------
export const ToolHeader = ({
  className,
  title,
  type,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => {
  const rawName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-");

  const split = splitToolName(rawName);
  const Icon = getToolIcon(rawName);

  const labelNode = title ? (
    <span className="font-medium text-sm">{title}</span>
  ) : split.server ? (
    <>
      <Badge variant="neutral" treatment="soft" className="text-[10px] px-1.5 py-0">
        {split.server}
      </Badge>
      <span className="font-medium text-sm">{split.label}</span>
    </>
  ) : (
    <span className="font-medium text-sm">{split.label}</span>
  );

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-2.5",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {labelNode}
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

// ---------------------------------------------------------------------------
// 4. Tighter chrome
// ---------------------------------------------------------------------------
export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 space-y-2 px-3 py-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"];
};

// ---------------------------------------------------------------------------
// 5. Skip dead labels + 7. Syntax-highlighted JSON via Streamdown
// ---------------------------------------------------------------------------
export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  // Skip entirely when input is null/undefined or an empty object
  if (input == null) return null;
  if (
    typeof input === "object" &&
    !isValidElement(input) &&
    Object.keys(input as object).length === 0
  )
    return null;

  const rendered =
    typeof input === "object" && !isValidElement(input) ? (
      <MessageResponse>{`\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``}</MessageResponse>
    ) : typeof input === "string" ? (
      <ToolJsonBlock code={input} />
    ) : (
      <ToolJsonBlock code={JSON.stringify(input, null, 2)} />
    );

  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-[10px] uppercase tracking-wide">
        Parameters
      </h4>
      {rendered}
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"];
  errorText: ToolPart["errorText"];
};

const MARKDOWN_RE = /[#`*>]|^- |^\d+\. /m;

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  // Error: no header, just a styled box
  if (errorText) {
    return (
      <div
        className={cn(
          "bg-destructive/10 text-destructive px-3 py-2 rounded-md text-xs",
          className
        )}
        {...props}
      >
        {errorText}
      </div>
    );
  }

  let renderedOutput: ReactNode;

  if (typeof output === "object" && !isValidElement(output)) {
    // Object → syntax-highlighted JSON via Streamdown/shiki
    renderedOutput = (
      <MessageResponse>{`\`\`\`json\n${JSON.stringify(output, null, 2)}\n\`\`\``}</MessageResponse>
    );
  } else if (typeof output === "string") {
    if (MARKDOWN_RE.test(output)) {
      // Markdown string → render as Streamdown markdown
      renderedOutput = <MessageResponse>{output}</MessageResponse>;
    } else {
      // Plain text → simple monospace block
      renderedOutput = <ToolJsonBlock code={output} />;
    }
  } else {
    renderedOutput = <div>{output as ReactNode}</div>;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-[10px] uppercase tracking-wide">
        Result
      </h4>
      <div className="overflow-x-auto rounded-md text-xs [&_table]:w-full bg-muted/50 text-foreground">
        {renderedOutput}
      </div>
    </div>
  );
};
