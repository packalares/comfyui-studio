// Train LoRA — image/video LoRA training (Flux, SDXL, SD3.5, ...) via the
// AI-Toolkit (ostris/ai-toolkit) capability pack. Gated behind that pack's
// install state (see AppSidebar's nav entry); this page also self-guards in
// case someone deep-links here directly before the pack is installed —
// same pattern `pages/music/Music.tsx` uses for `ace-step`.

import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { PackagePlus } from 'lucide-react';
import { useApp } from '../context/AppContext';
import PageSubbar from '../components/layout/PageSubbar';
import { Button } from '../components/ui/button';
import DatasetPanel from './loraTrain/DatasetPanel';
import TrainForm from './loraTrain/TrainForm';
import JobsPanel from './loraTrain/JobsPanel';
import GpuBusyBanner from './loraTrain/GpuBusyBanner';

function NotInstalled() {
  return (
    <>
      <PageSubbar title="Train LoRA" description="Image-LoRA training powered by AI-Toolkit" />
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <PackagePlus className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">Image LoRA Training isn&apos;t installed yet</h2>
        <p className="max-w-sm text-xs text-muted-foreground">
          Install the AI-Toolkit capability pack to train LoRAs for Flux, SDXL, and other image models, then use
          them straight from ComfyUI generation.
        </p>
        <Button asChild size="sm" className="mt-1">
          <NavLink to="/packs">Open Packs</NavLink>
        </Button>
      </div>
    </>
  );
}

export default function TrainLora() {
  const { capabilities } = useApp();
  const [selectedDataset, setSelectedDataset] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  if (!capabilities['ai-toolkit']) return <NotInstalled />;

  const handleStarted = (jobId: string) => {
    setSelectedJobId(jobId);
    setRefreshSignal((n) => n + 1);
  };

  return (
    <>
      <PageSubbar title="Train LoRA" description="Image-LoRA training powered by AI-Toolkit" />
      <div className="space-y-4 p-4 sm:p-6">
        <GpuBusyBanner />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-4">
            <DatasetPanel selectedDataset={selectedDataset} onSelectDataset={setSelectedDataset} />
            <TrainForm datasetName={selectedDataset} onStarted={handleStarted} />
          </div>
          <JobsPanel
            refreshSignal={refreshSignal}
            selectedJobId={selectedJobId}
            onSelectJob={setSelectedJobId}
          />
        </div>
      </div>
    </>
  );
}
