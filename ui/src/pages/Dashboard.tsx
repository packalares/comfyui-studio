import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Image,
  Video,
  Music,
  Layers,
  HardDrive,
  Cpu,
  Cog,
  Loader2,
  WifiOff,
  Settings,
  Package,
  MonitorSmartphone,
  Zap,
  Clock,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import PageSubbar from '../components/PageSubbar';
import NetworkWidget from '../components/NetworkWidget';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/card';

type ComfyUIProcessStatus = 'running' | 'stopped' | 'starting' | 'unknown';

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

export default function Dashboard() {
  const { systemStats, monitorStats, queueStatus, galleryTotal, connected, loading, launcherStatus } = useApp();
  const navigate = useNavigate();

  const processStatus = useMemo<ComfyUIProcessStatus>(() => {
    if (!launcherStatus) return 'unknown';
    if (launcherStatus.reachable === false) return 'unknown';
    return launcherStatus.running ? 'running' : 'stopped';
  }, [launcherStatus]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
      </div>
    );
  }

  const gpu = systemStats && systemStats.devices.length > 0 ? systemStats.devices[0] : null;
  // Only trust VRAM sampling after the first crystools.monitor WS tick.
  // The initial /system GET can return vram_used==vram_total as a placeholder
  // and would otherwise paint the bar 100% full until WS overwrites it.
  const vramReady = !!gpu && gpu.vram_total > 0 && monitorStats != null;
  const vramPct = vramReady ? (gpu!.vram_used / gpu!.vram_total) * 100 : 0;

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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            {launcherStatus?.versions?.comfyui && (
              <span className="inline-flex items-center gap-1">
                <Package className="w-3 h-3 text-slate-400" />
                ComfyUI <strong className="text-slate-700 font-semibold">v{launcherStatus.versions.comfyui}</strong>
              </span>
            )}
            {launcherStatus?.versions?.frontend && (
              <span className="inline-flex items-center gap-1">
                <MonitorSmartphone className="w-3 h-3 text-slate-400" />
                Frontend <strong className="text-slate-700 font-semibold">{launcherStatus.versions.frontend}</strong>
              </span>
            )}
            {launcherStatus?.gpuMode && (
              <span className="inline-flex items-center gap-1">
                <Zap className="w-3 h-3 text-slate-400" />
                GPU Mode <strong className="text-slate-700 font-semibold">{launcherStatus.gpuMode}</strong>
              </span>
            )}
            {launcherStatus?.uptime && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3 text-slate-400" />
                Uptime <strong className="text-slate-700 font-semibold">{launcherStatus.uptime}</strong>
              </span>
            )}
          </div>
        ) : undefined}
      />
      <div className="page-container space-y-4">
        {/* Not Connected Banner */}
        {!connected && processStatus !== 'stopped' && processStatus !== 'unknown' && (
          <Card className="px-4 py-3 border-amber-200 bg-amber-50">
            <div className="flex items-start gap-3">
              <WifiOff className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-amber-800">Not Connected</h3>
                <p className="text-xs text-amber-700 mt-0.5">ComfyUI is not reachable.</p>
              </div>
              <Button
                onClick={() => navigate('/settings')}
                variant="secondary"
                className="!border-amber-200 !text-amber-800 hover:!bg-amber-100"
              >
                <Settings className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Check Settings</span>
              </Button>
            </div>
          </Card>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* GPU */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-md bg-blue-50">
                <Cpu className="w-3.5 h-3.5 text-blue-600" />
              </div>
              <h3 className="stat-label">GPU</h3>
            </div>
            {gpu ? (
              <div>
                <p className="text-sm font-medium text-slate-900 truncate" title={gpu.name}>{gpu.name}</p>
                {vramReady && (
                  <div className="mt-2">
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                      <span>VRAM</span>
                      <span>{formatBytes(gpu.vram_used)} / {formatBytes(gpu.vram_total)}</span>
                    </div>
                    <div className="progress-track">
                      <div
                        className={`h-full rounded-full transition-all ${
                          vramPct > 90 ? 'bg-red-500' : vramPct > 70 ? 'bg-amber-500' : 'bg-blue-500'
                        }`}
                        style={{ width: `${vramPct}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <HardDrive className="w-3.5 h-3.5" />
                <span>{connected ? 'No GPU detected' : 'Not connected'}</span>
              </div>
            )}
          </Card>

          {/* Queue + Gallery combined */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-md bg-teal-50">
                <Layers className="w-3.5 h-3.5 text-teal-600" />
              </div>
              <h3 className="stat-label">Activity</h3>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <p className="text-2xl font-bold text-slate-900 leading-none">
                  {connected ? queueStatus.queue_running : '--'}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">Running</p>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div className="min-w-0">
                <p className="text-2xl font-bold text-slate-900 leading-none">
                  {connected ? queueStatus.queue_pending : '--'}
                </p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">Pending</p>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div className="min-w-0">
                <p className="text-2xl font-bold text-slate-900 leading-none">{galleryTotal}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">Gallery</p>
              </div>
            </div>
          </Card>

          {/* System */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="p-1.5 rounded-md bg-slate-100">
                <Cog className="w-3.5 h-3.5 text-slate-600" />
              </div>
              <h3 className="stat-label">System</h3>
            </div>
            {systemStats ? (
              <div className="space-y-1">
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-slate-500">PyTorch</span>
                  <span className="font-semibold text-slate-900">{systemStats.system.pytorch_version}</span>
                </div>
                <div className="flex justify-between items-baseline text-xs">
                  <span className="text-slate-500">Python</span>
                  <span className="font-semibold text-slate-900">{systemStats.system.python_version.split(' ')[0]}</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">Not connected</p>
            )}
          </Card>

          {/* Network */}
          <NetworkWidget />
        </div>

        {/* Quick Actions */}
        <div>
          <label className="field-label mb-2 block">Quick Actions</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card asChild className="p-4 flex items-center gap-3 hover:border-teal-300 transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/flux_text_to_image')}
                className="text-left"
              >
                <div className="p-2 bg-teal-50 rounded-lg">
                  <Image className="w-4 h-4 text-teal-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">Generate Image</p>
                  <p className="text-xs text-slate-500">Text to image with Flux</p>
                </div>
              </button>
            </Card>
            <Card asChild className="p-4 flex items-center gap-3 hover:border-purple-300 transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/wan_image_to_video')}
                className="text-left"
              >
                <div className="p-2 bg-purple-50 rounded-lg">
                  <Video className="w-4 h-4 text-purple-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">Generate Video</p>
                  <p className="text-xs text-slate-500">Image to video with Wan2.2</p>
                </div>
              </button>
            </Card>
            <Card asChild className="p-4 flex items-center gap-3 hover:border-orange-300 transition-colors cursor-pointer">
              <button
                type="button"
                onClick={() => navigate('/studio/ace_step_music')}
                className="text-left"
              >
                <div className="p-2 bg-orange-50 rounded-lg">
                  <Music className="w-4 h-4 text-orange-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">Create Music</p>
                  <p className="text-xs text-slate-500">Generate with ACE-Step</p>
                </div>
              </button>
            </Card>
          </div>
        </div>

      </div>

    </>
  );
}
