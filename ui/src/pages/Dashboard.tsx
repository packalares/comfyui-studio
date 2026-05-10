import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Image,
  Video,
  Music,
  Layers,
  Cog,
  WifiOff,
  Settings,
  Package,
  MonitorSmartphone,
  Zap,
  Clock,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import PageSubbar from '../components/layout/PageSubbar';
import NetworkWidget from '../components/NetworkWidget';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';
import { Spinner } from '../components/ui/spinner';

type ComfyUIProcessStatus = 'running' | 'stopped' | 'starting' | 'unknown';

export default function Dashboard() {
  const { systemStats, queueStatus, galleryTotal, connected, loading, launcherStatus } = useApp();
  const navigate = useNavigate();

  const processStatus = useMemo<ComfyUIProcessStatus>(() => {
    if (!launcherStatus) return 'unknown';
    if (launcherStatus.reachable === false) return 'unknown';
    return launcherStatus.running ? 'running' : 'stopped';
  }, [launcherStatus]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner size="xl" className="text-muted-foreground" />
      </div>
    );
  }

  const hasInfoStrip = !!(launcherStatus && (
    launcherStatus.versions?.comfyui ||
    launcherStatus.versions?.frontend ||
    launcherStatus.gpuMode ||
    launcherStatus.uptime
  ));

  return (
    <>
      <PageSubbar
        title="Dashboard"
        description="Overview of your ComfyUI instance"
        right={hasInfoStrip ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {launcherStatus?.versions?.comfyui && (
              <span className="inline-flex items-center gap-1">
                <Package className="w-3 h-3 text-muted-foreground" />
                ComfyUI <strong className="text-foreground font-semibold">v{launcherStatus.versions.comfyui}</strong>
              </span>
            )}
            {launcherStatus?.versions?.frontend && (
              <span className="inline-flex items-center gap-1">
                <MonitorSmartphone className="w-3 h-3 text-muted-foreground" />
                Frontend <strong className="text-foreground font-semibold">{launcherStatus.versions.frontend}</strong>
              </span>
            )}
            {launcherStatus?.gpuMode && (
              <span className="inline-flex items-center gap-1">
                <Zap className="w-3 h-3 text-muted-foreground" />
                GPU Mode <strong className="text-foreground font-semibold">{launcherStatus.gpuMode}</strong>
              </span>
            )}
            {launcherStatus?.uptime && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3 text-muted-foreground" />
                Uptime <strong className="text-foreground font-semibold">{launcherStatus.uptime}</strong>
              </span>
            )}
          </div>
        ) : undefined}
      />
      <div className="page-container space-y-4">
        {/* Not Connected Banner */}
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

        {/* Stats Grid — GPU card moved to the sidebar footer (visible on
            every page). The grid auto-reflows to 3 cards on lg. */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Queue + Gallery combined */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-md bg-brand/10">
                <Layers className="w-3.5 h-3.5 text-brand" />
              </div>
              <h3 className="stat-label">Activity</h3>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-2xl font-bold text-foreground leading-none">
                  {connected ? queueStatus.queue_running : '--'}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">Running</p>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="min-w-0">
                <p className="text-2xl font-bold text-foreground leading-none">
                  {connected ? queueStatus.queue_pending : '--'}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">Pending</p>
              </div>
              <div className="h-8 w-px bg-border" />
              <div className="min-w-0">
                <p className="text-2xl font-bold text-foreground leading-none">{galleryTotal}</p>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">Gallery</p>
              </div>
            </div>
          </Card>

          {/* System */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-md bg-muted">
                <Cog className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
              <h3 className="stat-label">System</h3>
            </div>
            {systemStats ? (
              <div className="space-y-1">
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-muted-foreground">PyTorch</span>
                  <span className="font-semibold text-foreground">{systemStats.system.pytorch_version}</span>
                </div>
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-muted-foreground">Python</span>
                  <span className="font-semibold text-foreground">{systemStats.system.python_version.split(' ')[0]}</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Not connected</p>
            )}
          </Card>

          {/* Network */}
          <NetworkWidget />
        </div>

        {/* Quick Actions */}
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
                  <Image className="w-4 h-4 text-brand" />
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

      </div>

    </>
  );
}
