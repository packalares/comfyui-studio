// Integrated MCP Tools — toggle built-in tools exposed to the chat LLM.
// One outer Card with two always-open subcards (Comfy / Studio Catalog),
// mirroring the LaunchOptionsCard → CategorySection pattern.

import { useEffect, useCallback, useState } from 'react';
import { Wrench, Cpu, Server, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Badge } from '../ui/badge';
import { Switch } from '../ui/switch';
import { getMcpToolsSettings, setMcpToolsEnabled, type McpToolListing } from '../../api/mcp';

/* ---- single tool row ---- */

function ToolRow({
  tool,
  checked,
  onChange,
  disabled,
}: {
  tool: McpToolListing;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted">
      <div className="shrink-0">
        <Switch
          checked={checked}
          disabled={disabled}
          onCheckedChange={v => onChange(Boolean(v))}
        />
      </div>
      <div className="min-w-0 flex-1">
        <code className="font-mono text-xs font-semibold text-foreground">
          {tool.label || tool.name}
        </code>
        {tool.description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {tool.description}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---- subcard (mirrors LaunchOptionsCard's CategorySection) ---- */

function ToolSubcard({
  label,
  icon: Icon,
  tools,
  enabled,
  onChange,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  tools: McpToolListing[];
  enabled: Record<string, boolean>;
  onChange: (name: string, v: boolean) => void;
  disabled: boolean;
}) {
  const enabledCount = tools.filter(t => !!enabled[t.name]).length;
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 bg-muted px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
            {label}
          </span>
          {enabledCount > 0 && (
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/20 text-[10px] font-bold text-brand">
              {enabledCount}
            </span>
          )}
        </div>
        <span className="text-[11px] font-medium text-muted-foreground">{tools.length} tools</span>
      </div>
      <div className="divide-y border-t">
        {tools.map(t => (
          <ToolRow
            key={t.name}
            tool={t}
            checked={!!enabled[t.name]}
            onChange={v => onChange(t.name, v)}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

/* ---- section ---- */

export default function IntegratedToolsSection() {
  const [listings, setListings] = useState<McpToolListing[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMcpToolsSettings();
      setListings(data.listings);
      setEnabled(data.enabled);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404') || msg.includes('Not Found')) {
        setError('Backend not available yet — check back after deploy.');
      } else {
        setError('Could not load tool settings.');
        console.error(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const handleChange = async (name: string, value: boolean) => {
    const prev = enabled;
    const next = { ...prev, [name]: value };
    setEnabled(next); // optimistic — flip immediately, no global lock
    try {
      await setMcpToolsEnabled(next);
    } catch (err) {
      setEnabled(prev); // roll back on failure
      toast.error('Failed to save', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const comfyTools = listings.filter(t => t.category === 'comfy');
  const studioTools = listings.filter(t => t.category === 'studio');
  const totalEnabled = listings.filter(t => !!enabled[t.name]).length;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-semibold text-foreground leading-tight">Integrated MCP Tools</h2>
            <p className="text-xs text-muted-foreground">
              In-process tools exposed to the chat LLM. Off by default.
            </p>
          </div>
        </div>
        {!loading && listings.length > 0 && (
          <Badge variant="slate">
            <Wrench className="h-3 w-3" />
            {totalEnabled} of {listings.length} enabled
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        ) : loading ? (
          <div className="grid gap-2 md:grid-cols-2">
            {[1, 2].map(i => (
              <div key={i} className="h-32 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : listings.length === 0 ? (
          <div className="empty-box">No integrated tools available.</div>
        ) : (
          // CSS columns (masonry) — subcards flow top-to-bottom and pack
          // tightly regardless of individual heights. Same pattern as
          // LaunchOptionsCard.
          <div className="md:columns-2 md:gap-2 [&>*]:break-inside-avoid [&>*]:mb-2 md:[&>*:last-child]:mb-0">
            {comfyTools.length > 0 && (
              <ToolSubcard
                label="ComfyUI"
                icon={Cpu}
                tools={comfyTools}
                enabled={enabled}
                onChange={handleChange}
                disabled={false}
              />
            )}
            {studioTools.length > 0 && (
              <ToolSubcard
                label="Studio Catalog"
                icon={Server}
                tools={studioTools}
                enabled={enabled}
                onChange={handleChange}
                disabled={false}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
