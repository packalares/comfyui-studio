// Training configuration form: base model + architecture, trigger word, and
// the core ai-toolkit hyperparameters (steps, learning rate, rank/alpha,
// batch size, resolution, save-every). Submits via
// `services/aiToolkit.ts#startTrainingJob`.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Play } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Slider } from '../../components/ui/slider';
import { Checkbox } from '../../components/ui/checkbox';
import { Spinner } from '../../components/ui/spinner';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectGroup, SelectLabel, SelectSeparator,
} from '../../components/forms/SelectField';
import * as api from '../../services/aiToolkit';
import type { AiToolkitArch, HfBaseModelPreset, LocalBaseModel } from '../../services/aiToolkit';

const ARCH_LABELS: Record<AiToolkitArch, string> = {
  flux: 'Flux',
  sdxl: 'SDXL',
  sd35: 'Stable Diffusion 3.5',
  other: 'Other (SD1.5-compatible)',
};

interface TrainFormProps {
  datasetName: string;
  onStarted: (jobId: string) => void;
}

export default function TrainForm({ datasetName, onStarted }: TrainFormProps) {
  const [localModels, setLocalModels] = useState<LocalBaseModel[]>([]);
  const [presets, setPresets] = useState<HfBaseModelPreset[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);

  const [baseModel, setBaseModel] = useState('');
  const [arch, setArch] = useState<AiToolkitArch>('flux');
  const [customBaseModel, setCustomBaseModel] = useState(false);

  const [jobName, setJobName] = useState('');
  const [triggerWord, setTriggerWord] = useState('');
  const [steps, setSteps] = useState(2000);
  const [learningRate, setLearningRate] = useState(0.0001);
  const [rank, setRank] = useState(16);
  const [alpha, setAlpha] = useState(16);
  // Alpha defaults to tracking rank (ai-toolkit's own example config uses
  // linear == linear_alpha) until the user explicitly drags the Alpha
  // slider themselves — an equality check (`alpha === rank`) can't drive
  // this because it goes stale for exactly one render every time rank
  // changes (the alpha state hasn't caught up yet), silently breaking the
  // "follow" behavior on every adjustment.
  const [alphaTouched, setAlphaTouched] = useState(false);
  const [batchSize, setBatchSize] = useState(1);
  const [resolution, setResolution] = useState(1024);
  const [saveEvery, setSaveEvery] = useState(250);
  const [lowVram, setLowVram] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const result = await api.listBaseModels();
        setLocalModels(result.local);
        setPresets(result.presets);
        if (!baseModel && result.local.length > 0) {
          setBaseModel(result.local[0].id);
        } else if (!baseModel && result.presets.length > 0) {
          setBaseModel(result.presets[0].id);
          setArch(result.presets[0].arch);
        }
      } catch (err) {
        toast.error('Failed to load base models', { description: err instanceof Error ? err.message : String(err) });
      } finally {
        setLoadingModels(false);
      }
    })();
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!alphaTouched) setAlpha(rank);
    // alphaTouched intentionally omitted: this effect's job is to react to
    // rank changes, not to re-run when the user starts touching alpha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rank]);

  const handleSelectBaseModel = (value: string) => {
    if (value === '__custom__') {
      setCustomBaseModel(true);
      setBaseModel('');
      return;
    }
    setCustomBaseModel(false);
    setBaseModel(value);
    const preset = presets.find((p) => p.id === value);
    if (preset) setArch(preset.arch);
  };

  const canSubmit = datasetName.trim() !== '' && baseModel.trim() !== '' && jobName.trim() !== '' && !starting;

  const handleStart = async () => {
    if (!canSubmit) return;
    setStarting(true);
    try {
      const { jobId } = await api.startTrainingJob({
        name: jobName.trim(),
        baseModel: baseModel.trim(),
        arch,
        datasetName,
        triggerWord: triggerWord.trim() || undefined,
        steps,
        learningRate,
        rank,
        alpha,
        batchSize,
        resolution,
        saveEvery,
        lowVram,
      });
      toast.success('Training started', { description: `Job ${jobId.slice(0, 8)} queued for the GPU` });
      onStarted(jobId);
    } catch (err) {
      toast.error('Failed to start training', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Train a LoRA</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">LoRA name</label>
          <Input value={jobName} onChange={(e) => setJobName(e.target.value)} placeholder="my_character_v1" />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Base model</label>
          {loadingModels ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner size="xs" /> Loading…</div>
          ) : customBaseModel ? (
            <div className="flex gap-2">
              <Input
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value)}
                placeholder="org/repo (HuggingFace id)"
                className="flex-1"
              />
              <Button variant="ghost" size="sm" onClick={() => { setCustomBaseModel(false); setBaseModel(localModels[0]?.id ?? presets[0]?.id ?? ''); }}>
                Cancel
              </Button>
            </div>
          ) : (
            <SelectField value={baseModel || undefined} onValueChange={handleSelectBaseModel}>
              <SelectTrigger><SelectValue placeholder="Select a base model" /></SelectTrigger>
              <SelectContent>
                {localModels.length > 0 && (
                  <>
                    {/* Radix requires SelectLabel to live inside a SelectGroup;
                        without it the Select throws and the page fails to render. */}
                    <SelectGroup>
                      <SelectLabel>Installed checkpoints</SelectLabel>
                      {localModels.map((m) => (
                        <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectSeparator />
                  </>
                )}
                <SelectGroup>
                  <SelectLabel>HuggingFace presets</SelectLabel>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.label}{p.note ? ` (${p.note})` : ''}</SelectItem>
                  ))}
                </SelectGroup>
                <SelectSeparator />
                <SelectItem value="__custom__">Custom HuggingFace repo id…</SelectItem>
              </SelectContent>
            </SelectField>
          )}
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Architecture</label>
          <SelectField value={arch} onValueChange={(v) => setArch(v as AiToolkitArch)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(ARCH_LABELS) as AiToolkitArch[]).map((a) => (
                <SelectItem key={a} value={a}>{ARCH_LABELS[a]}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Trigger word (optional)</label>
          <Input value={triggerWord} onChange={(e) => setTriggerWord(e.target.value)} placeholder="sks_person" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <ParamSlider label="Rank (network dim)" value={rank} min={1} max={128} step={1} onChange={setRank} />
          <ParamSlider
            label="Alpha"
            value={alpha}
            min={1}
            max={256}
            step={1}
            onChange={(v) => { setAlpha(v); setAlphaTouched(true); }}
          />
          <ParamSlider label="Resolution" value={resolution} min={256} max={1536} step={64} onChange={setResolution} />
          <ParamSlider label="Batch size" value={batchSize} min={1} max={8} step={1} onChange={setBatchSize} />
          <ParamSlider label="Steps" value={steps} min={100} max={20_000} step={100} onChange={setSteps} />
          <ParamSlider label="Save every (steps)" value={saveEvery} min={50} max={5000} step={50} onChange={setSaveEvery} />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Learning rate</label>
          <Input
            type="number"
            step={0.00001}
            value={learningRate}
            onChange={(e) => setLearningRate(parseFloat(e.target.value) || 0.0001)}
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={lowVram} onCheckedChange={(v) => setLowVram(v === true)} />
          Low VRAM mode (slower, uses less GPU memory)
        </label>

        <div className="flex justify-end border-t border-border pt-3">
          <Button size="lg" onClick={() => void handleStart()} disabled={!canSubmit}>
            {starting ? <Spinner size="sm" /> : <Play className="h-4 w-4" />}
            Start training
          </Button>
        </div>
        {!datasetName && (
          <p className="text-xs text-muted-foreground">Select or create a dataset above before starting.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ParamSlider({
  label, value, min, max, step, onChange,
}: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="rounded-lg bg-muted p-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}
