import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Image as ImageIcon, Video, Music, Layers, WifiOff, Settings, Package,
  MonitorSmartphone, Zap, Clock, Box, Sparkles, Trash2, RefreshCw, Globe,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import PageSubbar from '../components/layout/PageSubbar';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';
import { Badge } from '../components/ui/badge';
import { api } from '../services/comfyui';
import type { GalleryItem, PluginHistoryEntry } from '../types';

type ComfyUIProcessStatus = 'running' | 'stopped' | 'starting' | 'unknown';

interface ActivityItem {
  id: string;
  icon: ReactNode;
  label: string;
  ts: number;
}

function formatRelative(ts: number): string {
  if (!ts) return '';
  const delta = Date.now() - ts;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// ---- TEMP: Badge consolidation preview ---------------------------------
// Renders the PROPOSED post-consolidation Badge primitive in every variant
// + treatment so we can pick the canonical look before migrating call sites.
// Once approved, replace this with the real <Badge> rewrite. Delete after.

// Inline preview of the proposed primitive — base: text-[10px], rounded (4px),
// px-2 py-0.5, font-medium. Variants: success/warning/danger/brand/neutral/
// secondary. Treatments: soft (default, `bg-X/10 + ring-X/30`) and solid
// (`bg-X + text-X-foreground`).
type PreviewVariant = 'success' | 'warning' | 'danger' | 'brand' | 'neutral' | 'secondary';
type PreviewTreatment = 'soft' | 'solid';

function PreviewBadge({
  variant,
  treatment = 'soft',
  children,
}: {
  variant: PreviewVariant;
  treatment?: PreviewTreatment;
  children: React.ReactNode;
}) {
  const base = 'inline-flex h-5 items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium whitespace-nowrap';
  const styleMap: Record<PreviewVariant, Record<PreviewTreatment, string>> = {
    success: {
      soft: 'bg-success/10 text-success ring-1 ring-inset ring-success/30',
      solid: 'bg-success text-success-foreground',
    },
    warning: {
      soft: 'bg-warning/10 text-warning ring-1 ring-inset ring-warning/30',
      solid: 'bg-warning text-warning-foreground',
    },
    danger: {
      soft: 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/30',
      solid: 'bg-destructive text-primary-foreground',
    },
    brand: {
      soft: 'bg-brand/10 text-brand ring-1 ring-inset ring-brand/30',
      solid: 'bg-brand text-brand-foreground',
    },
    neutral: {
      soft: 'bg-muted text-foreground ring-1 ring-inset ring-border',
      solid: 'bg-foreground text-background',
    },
    secondary: {
      soft: 'bg-secondary text-secondary-foreground',
      solid: 'bg-secondary text-secondary-foreground',
    },
  };
  return <span className={`${base} ${styleMap[variant][treatment]}`}>{children}</span>;
}

function BadgeShowcase() {
  const variants: PreviewVariant[] = ['success', 'warning', 'danger', 'brand', 'neutral', 'secondary'];
  return (
    <Card className="p-4 space-y-6 border-warning/30">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Badge audit · BEFORE vs AFTER
        </h3>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          temporary — pick a winner
        </span>
      </div>

      {/* ============ BEFORE — every current pattern ============ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
            BEFORE
          </span>
          <span className="text-xs text-muted-foreground">8 conflicting patterns currently shipped</span>
        </div>

        {/* C1: solid filled pill (TemplateCard) */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            C1 — solid inline (`bg-X/90`, `rounded`, `text-[10px] font-semibold`)
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-success/90 text-success-foreground">success</span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning/90 text-warning-foreground">warning</span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-destructive/90 text-primary-foreground">destructive</span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-brand/90 text-brand-foreground">brand</span>
          </div>
        </div>

        {/* C2: soft tinted, border-based (ImportWorkflowModal) */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            C2 — soft, border (`bg-X/10`, `border-X/30`, `rounded`)
          </p>
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 rounded bg-success/10 border border-success/30 px-1.5 py-0.5 text-[10px] font-medium text-success">success</span>
            <span className="inline-flex items-center gap-1 rounded bg-warning/10 border border-warning/30 px-1.5 py-0.5 text-[10px] font-medium text-warning">warning</span>
            <span className="inline-flex items-center gap-1 rounded bg-destructive/10 border border-destructive/30 px-1.5 py-0.5 text-[10px] font-medium text-destructive">destructive</span>
            <span className="inline-flex items-center gap-1 rounded bg-brand/10 border border-brand/30 px-1.5 py-0.5 text-[10px] font-medium text-brand">brand</span>
          </div>
        </div>

        {/* B: shadcn <Badge> variants */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            B — shadcn `&lt;Badge&gt;` (62 uses; `rounded-full`, `text-xs`, `ring-inset`)
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <Badge variant="emerald">emerald</Badge>
            <Badge variant="amber">amber</Badge>
            <Badge variant="rose">rose</Badge>
            <Badge variant="slate">slate</Badge>
            <Badge variant="teal">teal</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">outline</Badge>
          </div>
        </div>

        {/* A: raw .badge .badge-X CSS classes */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            A — raw `.badge .badge-X` CSS classes (same look as B, different routing)
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="badge badge-emerald">emerald</span>
            <span className="badge badge-amber">amber</span>
            <span className="badge badge-rose">rose</span>
            <span className="badge badge-slate">slate</span>
            <span className="badge badge-teal">teal</span>
            <span className="badge badge-gray">gray</span>
            <span className="badge badge-secondary">secondary</span>
            <span className="badge badge-outline">outline</span>
            <span className="badge badge-destructive">destructive (dead)</span>
          </div>
        </div>

        {/* C3-C6 + D: small specials & overlay */}
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            C3 / C4 / C5 / C6 / D — assorted one-off patterns
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-normal text-muted-foreground ring-1 ring-inset ring-border/70">creator name (C3)</span>
            <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground font-mono">qwen3:30b (C4)</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Read-only (C5)</span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/20 text-[10px] font-bold text-brand">3</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/60 text-background border border-transparent px-1.5 py-0.5 text-[10px] font-medium">Video (D overlay)</span>
          </div>
        </div>
      </div>

      <div className="border-t border-border" />

      {/* ============ AFTER — proposed primitive ============ */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-success bg-success/10 px-1.5 py-0.5 rounded">
            AFTER
          </span>
          <span className="text-xs text-muted-foreground">
            One `&lt;Badge variant treatment&gt;` primitive · base{' '}
            <code className="rounded bg-muted px-1">text-[10px] · rounded · px-2 py-0.5 · font-medium · h-5</code>
          </span>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            treatment="soft" (default — status pills, tags, kinds)
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {variants.map(v => (
              <PreviewBadge key={v} variant={v}>{v}</PreviewBadge>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            treatment="solid" (replaces the C1 inline pattern)
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            {variants.map(v => (
              <PreviewBadge key={v} variant={v} treatment="solid">{v}</PreviewBadge>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Real-world examples (what current call sites become)
          </p>
          <div className="flex flex-wrap gap-1.5 items-center">
            <PreviewBadge variant="success" treatment="solid">Ready</PreviewBadge>
            <PreviewBadge variant="brand" treatment="solid">User</PreviewBadge>
            <PreviewBadge variant="brand" treatment="solid">CivitAI</PreviewBadge>
            <PreviewBadge variant="success">Installed</PreviewBadge>
            <PreviewBadge variant="brand">Downloading 42%</PreviewBadge>
            <PreviewBadge variant="warning">Required</PreviewBadge>
            <PreviewBadge variant="danger">Failed</PreviewBadge>
            <PreviewBadge variant="neutral">SDXL</PreviewBadge>
            <PreviewBadge variant="success">resolved via civitai</PreviewBadge>
            <PreviewBadge variant="danger">Unresolved</PreviewBadge>
          </div>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Kept as separate primitives (different shape/intent, not Badge variants)
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground font-mono">qwen3:30b</span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/20 text-[10px] font-bold text-brand">3</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-foreground/60 text-background px-1.5 py-0.5 text-[10px] font-medium">Video</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---- Big-number metric card ---------------------------------------------

interface MetricCardProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: ReactNode;
  hint?: string;
  tint?: 'brand' | 'muted';
}

function MetricCard({ icon: Icon, label, value, hint, tint = 'muted' }: MetricCardProps) {
  const tintClasses = tint === 'brand'
    ? 'bg-brand/10 text-brand'
    : 'bg-muted text-muted-foreground';
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-md ${tintClasses}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <h3 className="stat-label">{label}</h3>
      </div>
      <p className="text-2xl font-bold text-foreground leading-none">{value}</p>
      {hint && (
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1.5">
          {hint}
        </p>
      )}
    </Card>
  );
}

// ---- System info card ----------------------------------------------------

const NETWORK_ROWS = [
  { key: 'github', label: 'GitHub' },
  { key: 'huggingface', label: 'HuggingFace' },
  { key: 'pip', label: 'pip' },
] as const;

interface SystemInfoCardProps {
  launcherStatus: ReturnType<typeof useApp>['launcherStatus'];
  systemStats: ReturnType<typeof useApp>['systemStats'];
  network: ReturnType<typeof useApp>['network'];
}

function SystemInfoCard({ launcherStatus, systemStats, network }: SystemInfoCardProps) {
  // Each row only renders when its underlying value is present, so an
  // unreachable / unconfigured ComfyUI doesn't paint a card full of "—".
  const rows: Array<{ icon: ComponentType<{ className?: string }>; label: string; value: string }> = [];
  if (launcherStatus?.versions?.comfyui) {
    rows.push({ icon: Package, label: 'ComfyUI', value: `v${launcherStatus.versions.comfyui}` });
  }
  if (launcherStatus?.versions?.frontend) {
    rows.push({ icon: MonitorSmartphone, label: 'Frontend', value: launcherStatus.versions.frontend });
  }
  if (launcherStatus?.gpuMode) {
    rows.push({ icon: Zap, label: 'GPU mode', value: launcherStatus.gpuMode });
  }
  if (launcherStatus?.uptime) {
    rows.push({ icon: Clock, label: 'Uptime', value: launcherStatus.uptime });
  }
  if (systemStats?.system.pytorch_version) {
    rows.push({ icon: Sparkles, label: 'PyTorch', value: systemStats.system.pytorch_version });
  }
  if (systemStats?.system.python_version) {
    rows.push({ icon: Box, label: 'Python', value: systemStats.system.python_version.split(' ')[0] });
  }

  // Network rollup — same logic the standalone NetworkWidget used. Folded
  // into the System card so dashboard real estate isn't paying for two
  // tiny status lists side by side.
  const reach = network?.reachability;
  const states = NETWORK_ROWS.map(r => {
    const e = reach?.[r.key];
    if (!e || (e.latencyMs == null && !e.accessible)) return 'unknown' as const;
    return e.accessible ? 'ok' : 'fail';
  });
  const fails = states.filter(s => s === 'fail').length;
  const unknowns = states.filter(s => s === 'unknown').length;
  const networkSummary = network === null
    ? 'Checking…'
    : !network
      ? 'Unavailable'
      : unknowns === states.length
        ? 'Checking…'
        : fails === 0
          ? 'All reachable'
          : `${fails} unreachable`;

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-muted">
          <Settings className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <h3 className="stat-label">System</h3>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Not connected.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <r.icon className="w-3 h-3" />
                {r.label}
              </span>
              <span className="font-mono text-foreground truncate max-w-[180px]" title={r.value}>
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Network rollup — compact reachability list with latencies. */}
      <div className="mt-3 pt-3 border-t">
        <div className="flex items-center justify-between mb-1.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            <Globe className="w-3 h-3" />
            Network
          </span>
          <span className="text-[10px] text-muted-foreground">{networkSummary}</span>
        </div>
        <ul className="space-y-1">
          {NETWORK_ROWS.map((row, i) => {
            const r = reach?.[row.key];
            const s = states[i];
            const dot = s === 'ok' ? 'bg-success' : s === 'fail' ? 'bg-destructive' : 'bg-warning';
            return (
              <li key={row.key} className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-2 text-foreground">
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                  {row.label}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {r?.latencyMs != null ? `${r.latencyMs} ms` : s === 'unknown' ? '—' : 'offline'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

// ---- Recent activity feed ------------------------------------------------

function pluginVerb(t: PluginHistoryEntry['type']): string {
  switch (t) {
    case 'install': return 'Installed';
    case 'uninstall': return 'Uninstalled';
    case 'enable': return 'Enabled';
    case 'disable': return 'Disabled';
    case 'switch-version': return 'Switched version';
    default: return 'Updated';
  }
}

function pluginIcon(t: PluginHistoryEntry['type']): ComponentType<{ className?: string }> {
  if (t === 'uninstall') return Trash2;
  if (t === 'switch-version') return RefreshCw;
  return Package;
}

function mediaIcon(mediaType: string): ComponentType<{ className?: string }> {
  if (mediaType === 'video') return Video;
  if (mediaType === 'audio') return Music;
  return ImageIcon;
}

function RecentActivityCard({ items, loading }: { items: ActivityItem[]; loading: boolean }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-muted">
          <Layers className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
        <h3 className="stat-label">Recent activity</h3>
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner size="sm" className="text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">No recent activity yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 text-xs">
              <div className="mt-0.5 shrink-0 text-muted-foreground">{it.icon}</div>
              <div className="flex-1 min-w-0 truncate text-foreground" title={it.label}>
                {it.label}
              </div>
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                {formatRelative(it.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- Page ----------------------------------------------------------------

export default function Dashboard() {
  const { systemStats, queueStatus, galleryTotal, connected, loading, launcherStatus, network } = useApp();
  const navigate = useNavigate();

  const [modelsTotal, setModelsTotal] = useState<number | null>(null);
  const [pluginsTotal, setPluginsTotal] = useState<number | null>(null);
  const [recentGallery, setRecentGallery] = useState<GalleryItem[]>([]);
  const [pluginHistory, setPluginHistory] = useState<PluginHistoryEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Each request is fired and resolved independently — a 4xx/5xx on one
    // endpoint shouldn't blank the rest of the dashboard. Failed metrics
    // fall back to "—" via the `?? '—'` render below.
    api.getModelsCatalogPaged(1, 1, { installed: true })
      .then(r => { if (!cancelled) setModelsTotal(r.total); })
      .catch(() => { /* keep null */ });
    api.getPluginsPaged(1, 1, { filter: 'installed' })
      .then(r => { if (!cancelled) setPluginsTotal(r.total); })
      .catch(() => { /* keep null */ });
    api.getGalleryPaged(1, 6)
      .then(r => { if (!cancelled) setRecentGallery(r.items); })
      .catch(() => { /* keep [] */ });
    api.getPluginHistory(20)
      .then(r => { if (!cancelled) setPluginHistory(r.history ?? []); })
      .catch(() => { /* keep [] */ })
      .finally(() => { if (!cancelled) setActivityLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const processStatus = useMemo<ComfyUIProcessStatus>(() => {
    if (!launcherStatus) return 'unknown';
    if (launcherStatus.reachable === false) return 'unknown';
    return launcherStatus.running ? 'running' : 'stopped';
  }, [launcherStatus]);

  // Activity feed — interleaves recent generations + plugin operations
  // sorted by timestamp; cap at 10 rows for readability.
  const activityItems = useMemo<ActivityItem[]>(() => {
    const out: ActivityItem[] = [];
    for (const g of recentGallery) {
      const ts = typeof g.createdAt === 'number'
        ? g.createdAt
        : new Date(g.createdAt ?? 0).getTime();
      const Icon = mediaIcon(g.mediaType);
      out.push({
        id: `g-${g.id}`,
        icon: <Icon className="h-3.5 w-3.5" />,
        label: `Generated ${g.filename}`,
        ts,
      });
    }
    for (const h of pluginHistory) {
      const Icon = pluginIcon(h.type);
      const verb = pluginVerb(h.type);
      out.push({
        id: `p-${h.id}`,
        icon: <Icon className="h-3.5 w-3.5" />,
        label: `${verb} plugin ${h.pluginName ?? h.pluginId}`,
        ts: h.startTime,
      });
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, 10);
  }, [recentGallery, pluginHistory]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="xl" className="text-muted-foreground" />
      </div>
    );
  }

  const queueActive = (queueStatus?.queue_running ?? 0) + (queueStatus?.queue_pending ?? 0);

  return (
    <>
      <PageSubbar
        title="Dashboard"
        description="Overview of your ComfyUI instance"
      />
      <div className="page-container space-y-4">
        {/* TEMP: Badge audit visual showcase. Delete once consolidation lands. */}
        <BadgeShowcase />

        {/* Not Connected banner */}
        {!connected && processStatus !== 'stopped' && processStatus !== 'unknown' && (
          <Card className="px-4 py-3 border-warning/30 bg-warning/10">
            <div className="flex items-start gap-3">
              <WifiOff className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-warning">Not Connected</h3>
                <p className="text-xs text-warning mt-0.5">ComfyUI is not reachable.</p>
              </div>
              <Button
                onClick={() => navigate('/settings')}
                variant="secondary"
                className="!border-warning/30 !text-warning hover:!bg-warning/20"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Check Settings</span>
              </Button>
            </div>
          </Card>
        )}

        {/* Hero — at-a-glance counts */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <MetricCard
            icon={Layers}
            label="Generations"
            tint="brand"
            value={galleryTotal}
            hint="Total in gallery"
          />
          <MetricCard
            icon={Sparkles}
            label="Queue"
            value={connected ? queueActive : '—'}
            hint={
              connected
                ? `${queueStatus?.queue_running ?? 0} running · ${queueStatus?.queue_pending ?? 0} pending`
                : 'Not connected'
            }
          />
          <MetricCard
            icon={Box}
            label="Models"
            value={modelsTotal ?? '—'}
            hint="Installed"
          />
          <MetricCard
            icon={Package}
            label="Plugins"
            value={pluginsTotal ?? '—'}
            hint="Installed"
          />
        </div>

        {/* Recent generations strip — up to 6 thumbnails */}
        {recentGallery.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="field-label">Recent generations</label>
              <button
                type="button"
                onClick={() => navigate('/gallery')}
                className="text-xs text-brand hover:underline cursor-pointer"
              >
                View all
              </button>
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {recentGallery.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigate('/gallery')}
                  className="aspect-square overflow-hidden rounded-md border bg-muted hover:border-brand transition-colors cursor-pointer"
                  title={item.filename}
                >
                  <img
                    src={`/api/thumbnail/${encodeURIComponent(item.id)}?w=256`}
                    alt={item.filename}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Quick Actions — unchanged behaviour, kept where it was */}
        <div>
          <label className="field-label mb-2 block">Quick Actions</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card asChild className="p-4 flex items-center gap-3 hover:border-brand transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/flux_text_to_image')}
                className="text-left"
              >
                <div className="p-2 bg-brand/10 rounded-lg">
                  <ImageIcon className="w-4 h-4 text-brand" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Generate Image</p>
                  <p className="text-xs text-muted-foreground">Text to image with Flux</p>
                </div>
              </button>
            </Card>
            <Card asChild className="p-4 flex items-center gap-3 hover:border-input transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/wan_image_to_video')}
                className="text-left"
              >
                <div className="p-2 bg-muted rounded-lg">
                  <Video className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Generate Video</p>
                  <p className="text-xs text-muted-foreground">Image to video with Wan2.2</p>
                </div>
              </button>
            </Card>
            <Card asChild className="p-4 flex items-center gap-3 hover:border-input transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/ace_step_music')}
                className="text-left"
              >
                <div className="p-2 bg-muted rounded-lg">
                  <Music className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">Create Music</p>
                  <p className="text-xs text-muted-foreground">Generate with ACE-Step</p>
                </div>
              </button>
            </Card>
          </div>
        </div>

        {/* System info + Recent activity, side by side on lg */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <SystemInfoCard
            launcherStatus={launcherStatus}
            systemStats={systemStats}
            network={network}
          />
          <RecentActivityCard items={activityItems} loading={activityLoading} />
        </div>
      </div>
    </>
  );
}
