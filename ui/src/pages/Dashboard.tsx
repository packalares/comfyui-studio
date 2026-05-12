import { useMemo, type ComponentType, type ReactNode } from 'react';
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
import type { PluginHistoryEntry } from '../types';

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
  // recentGallery and dashboardSummary come from /api/system (exposed app-wide
  // via useApp) — no separate fetch needed here.
  const { systemStats, queueStatus, galleryTotal, recentGallery, connected, loading, launcherStatus, network, dashboardSummary } = useApp();
  const navigate = useNavigate();

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
    for (const h of (dashboardSummary?.pluginHistory ?? [])) {
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
  }, [recentGallery, dashboardSummary]);

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
            value={dashboardSummary?.modelsInstalled ?? '—'}
            hint="Installed"
          />
          <MetricCard
            icon={Package}
            label="Plugins"
            value={dashboardSummary?.pluginsInstalled ?? '—'}
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
              {recentGallery.slice(0, 6).map((item) => (
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
          <RecentActivityCard items={activityItems} loading={dashboardSummary === null} />
        </div>
      </div>
    </>
  );
}
