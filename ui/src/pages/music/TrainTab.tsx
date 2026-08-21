// Train — the voice-clone / LoRA training wizard. Ported from ace-step-ui's
// `TrainingPanel.tsx` (category → upload → label → preprocess → train),
// rebuilt on comfy's Card/Button/Input/Slider primitives.
//
// Deliberate trims vs ace-step-ui's version (see the final report for the
// full list): no dataframe preview table, no SVG loss chart, no post-training
// cleanup-artifacts step, no manual "load tensors" step and no "save dataset"
// step — comfy's training contract doesn't expose `/save-dataset` or
// `/load-tensors` (see the TODO at the bottom of
// `server/src/routes/ace/training.routes.ts`); `build-dataset`/`load-dataset`
// already persist the dataset JSON server-side, and `/start` resolves its own
// tensor dir default, so those steps have no backend counterpart here.
// Sample audio preview is also not wired (no streaming route for training
// sample paths yet — see `trainingSampleAudioSrc` in `services/ace.ts`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Check, Edit3, FileAudio, FolderOpen, Info, Layers, Loader2, Play, Square,
  Upload, Wand2, X, Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Checkbox } from '../../components/ui/checkbox';
import { Spinner } from '../../components/ui/spinner';
import { Slider } from '../../components/ui/slider';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/forms/SelectField';
import { cn } from '../../lib/utils';
import * as api from '../../services/ace';
import { aceEvents } from '../../services/aceEvents';
import { useApp } from '../../context/AppContext';
import { TrainingCategorySelector } from './TrainingCategorySelector';
import { useTrainingCategory, type ResolvedCategoryConfig, type TrainingCategoryId } from './trainingCategories';
import type { TrainingSample } from '../../types/ace';

const LANGUAGES: { value: string; label: string }[] = [
  { value: 'instrumental', label: 'Instrumental' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ru', label: 'Russian' },
  { value: 'unknown', label: 'Unknown' },
];

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'opus'];

const PIPELINE_STEPS = [
  { key: 'category', label: 'Category', icon: Layers },
  { key: 'upload', label: 'Upload', icon: Upload },
  { key: 'label', label: 'Label', icon: Wand2 },
  { key: 'preprocess', label: 'Preprocess', icon: Zap },
  { key: 'train', label: 'Train', icon: Play },
] as const;

type StepKey = typeof PIPELINE_STEPS[number]['key'];

const NAME_STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'feat', 'ft', 'official', 'video', 'audio',
  'live', 'studio', 'recording', 'session', 'cover', 'remix', 'remaster',
  'final', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus', 'song', 'track', 'lyrics',
]);

/** Pick a persona slug from a set of uploaded filenames — e.g. three tracks
 *  by "Nicolae Guta" suggest "guta". Falls back to a date stamp. */
function suggestPersonaSlug(files: File[]): string | null {
  if (files.length === 0) return null;
  const counts = new Map<string, number>();
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '');
    const seen = new Set<string>();
    for (const w of base.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      if (w.length < 3 || NAME_STOP_WORDS.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return sorted[0]?.[0] ?? null;
}

function suggestDatasetName(categoryId: TrainingCategoryId, subTypeId: string | null, files: File[] = []): string {
  const base = subTypeId ? `${categoryId}_${subTypeId}` : categoryId;
  const slug = suggestPersonaSlug(files);
  if (slug) return `${base}_${slug}`;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${base}_${today}`;
}

/** Best-effort "still running" probe over an arbitrary FastAPI status-passthrough
 *  object — the exact field names aren't confirmed against a live ACE-Step
 *  instance (see the server-side `looksActive` this mirrors), so this checks
 *  a handful of plausible flags/strings and lets the caller cap total wait
 *  time as a backstop. */
function looksDone(raw: Record<string, unknown>): { done: boolean; failed: boolean; text: string } {
  const d = (raw.data ?? raw) as Record<string, unknown>;
  const status = typeof d.status === 'string' ? d.status : '';
  const failed = d.status === 'failed' || d.status === 'error' || status.includes('❌') || status.toLowerCase().includes('fail');
  const done = d.is_processing === false || d.is_running === false || d.is_training === false
    || d.status === 'completed' || d.status === 'success' || d.status === 'finished' || d.status === 'idle'
    || d.status === 'not_running' || status.toLowerCase().includes('complete');
  const current = d.current ?? d.current_epoch ?? d.epoch;
  const total = d.total ?? d.total_epochs;
  const loss = d.current_loss ?? d.loss;
  const parts: string[] = [];
  if (status) parts.push(status);
  if (current !== undefined || total !== undefined) parts.push(`${current ?? '?'}/${total ?? '?'}`);
  if (loss !== undefined) parts.push(`loss ${Number(loss).toFixed(4)}`);
  return { done: done && !failed, failed, text: parts.join(' · ') || (done ? 'Done' : 'Working…') };
}

/** Conservative "is ACE-Step's FastAPI definitely mid-task right now" check —
 *  mirrors the server's own `looksActive` (`routes/ace/training.routes.ts`)
 *  rather than the fuzzier `looksDone` above. Used only to decide whether to
 *  auto-resume watching a status on mount (reconciliation): unlike
 *  `looksDone` (which treats "no recognizable field" as "still going" —
 *  fine for a loop that's about to actively watch it), a false positive here
 *  would show a "training in progress" banner over nothing, so this only
 *  answers yes when an explicit boolean flag says so. */
function looksActiveRaw(raw: Record<string, unknown>): boolean {
  const d = (raw.data ?? raw) as Record<string, unknown>;
  const flags = ['is_processing', 'is_running', 'processing', 'running', 'is_active', 'is_training'];
  return flags.some((k) => d[k] === true);
}

/**
 * Watches one ACE-Step training-pipeline status (`kind`) until it reaches a
 * terminal state, or the caller cancels via `isCancelled`.
 *
 * The server already polls ACE-Step's FastAPI on an interval to know when to
 * release the GPU slot (`pollUntilInactive` in
 * `routes/ace/training.routes.ts`) and now pushes each fetch over WS as
 * `{type:'ace:training', data:{kind, raw}}` — this subscribes to that
 * instead of running its own `fetchStatus` poll loop for the common case.
 * `fetchStatus` (the same REST status route as before) is still used once
 * immediately for reconciliation and, while the socket is down/reconnecting,
 * as a bounded fallback poll (same iteration cap as the old `pollGeneric`,
 * so a permanently-dead socket still times out rather than looping forever).
 */
function watchTraining(
  kind: 'preprocess' | 'autoLabel' | 'train',
  fetchStatus: () => Promise<Record<string, unknown>>,
  onTick: (text: string) => void,
  maxIterations: number,
  intervalMs: number,
  // Checked every iteration so the loop stops when the component unmounts.
  // The training watch can run for hours/days; without this, navigating away
  // leaves the fallback poll (and the WS subscription) running indefinitely,
  // calling onTick -> setState on an unmounted component.
  isCancelled: () => boolean,
  wsConnectedRef: { current: boolean },
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let iterations = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: { ok: boolean; error?: string; cancelled?: boolean }) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const handleRaw = (raw: Record<string, unknown>) => {
      if (settled) return;
      if (isCancelled()) { finish({ ok: false, cancelled: true }); return; }
      const { done, failed, text } = looksDone(raw);
      onTick(text);
      if (failed) {
        const d = (raw.data ?? raw) as Record<string, unknown>;
        finish({ ok: false, error: typeof d.error === 'string' ? d.error : text });
        return;
      }
      if (done) finish({ ok: true });
    };

    const unsubscribe = aceEvents.onTraining((event) => {
      if (event.kind === 'whisper' || event.kind !== kind) return;
      handleRaw(event.raw);
    });

    const scheduleFallback = () => {
      if (settled) return;
      timer = setTimeout(() => {
        void (async () => {
          if (settled) return;
          if (isCancelled()) { finish({ ok: false, cancelled: true }); return; }
          iterations += 1;
          if (iterations > maxIterations) {
            finish({ ok: false, error: 'Timed out waiting for completion' });
            return;
          }
          if (!wsConnectedRef.current) {
            try {
              handleRaw(await fetchStatus());
            } catch {
              // transient — keep polling
            }
          }
          scheduleFallback();
        })();
      }, intervalMs);
    };

    // Reconciliation — always fetch once immediately (regardless of socket
    // state) so a caller that just attached sees current state without
    // waiting for the next push.
    void (async () => {
      if (settled) return;
      try {
        handleRaw(await fetchStatus());
      } catch {
        // transient — the fallback loop below will retry
      }
    })();

    scheduleFallback();
  });
}

export function TrainTab() {
  // Flipped on unmount; every watchTraining loop checks it each iteration so
  // long-running training watches don't outlive the component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Mirrors the shared page-level WS's open/closed state — watchTraining's
  // fallback poll only does real network work while this is false (socket
  // down/reconnecting); when true it relies on the `ace:training` WS push.
  const { wsConnected } = useApp();
  const wsConnectedRef = useRef(wsConnected);
  wsConnectedRef.current = wsConnected;
  const {
    categories, category: selectedCategory, subType: selectedSubType, config: categoryConfig,
    allInstrumental: derivedAllInstrumental, setCategory, setSubType, buildOutputDir, outputRoot,
  } = useTrainingCategory();

  const [activeStep, setActiveStep] = useState<StepKey>(() => (selectedCategory ? 'upload' : 'category'));
  const [completedSteps, setCompletedSteps] = useState<Set<StepKey>>(() => new Set(selectedCategory ? ['category' as StepKey] : []));

  const markStep = useCallback((step: StepKey) => setCompletedSteps((prev) => new Set([...prev, step])), []);
  const canGoToStep = useCallback((step: StepKey) => {
    const idx = PIPELINE_STEPS.findIndex((s) => s.key === step);
    if (idx <= 0) return true;
    for (let i = 0; i < idx; i += 1) if (!completedSteps.has(PIPELINE_STEPS[i].key)) return false;
    return true;
  }, [completedSteps]);
  const goToStep = useCallback((step: StepKey) => { if (canGoToStep(step)) setActiveStep(step); }, [canGoToStep]);
  const advanceToNext = useCallback((from: StepKey) => {
    const idx = PIPELINE_STEPS.findIndex((s) => s.key === from);
    if (idx < PIPELINE_STEPS.length - 1) setActiveStep(PIPELINE_STEPS[idx + 1].key);
  }, []);

  useEffect(() => {
    if (selectedCategory) markStep('category');
  }, [selectedCategory, markStep]);

  // ---- Upload state ---------------------------------------------------------
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [uploadDatasetName, setUploadDatasetName] = useState('my_lora_dataset');
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Dataset state ---------------------------------------------------------
  const [datasetPath, setDatasetPath] = useState('');
  const [datasetLoading, setDatasetLoading] = useState(false);
  const [sampleCount, setSampleCount] = useState(0);
  const [currentSampleIdx, setCurrentSampleIdx] = useState(0);
  const [currentSample, setCurrentSample] = useState<TrainingSample | null>(null);
  const [datasetSettings, setDatasetSettings] = useState({
    datasetName: 'my_lora_dataset', customTag: '', tagPosition: 'prepend' as 'prepend' | 'append',
    allInstrumental: true,
  });
  const [datasetStatus, setDatasetStatus] = useState('');

  useEffect(() => {
    setDatasetSettings((prev) => (prev.allInstrumental === derivedAllInstrumental ? prev : { ...prev, allInstrumental: derivedAllInstrumental }));
  }, [derivedAllInstrumental]);

  // ---- Auto-label state ---------------------------------------------------------
  const [autoLabeling, setAutoLabeling] = useState(false);
  const [autoLabelStatus, setAutoLabelStatus] = useState('');
  const [skipMetas, setSkipMetas] = useState(false);
  const [formatLyrics, setFormatLyrics] = useState(false);
  const [transcribeLyrics, setTranscribeLyrics] = useState(false);
  const [onlyUnlabeled, setOnlyUnlabeled] = useState(false);

  const [modelInitializing, setModelInitializing] = useState(false);
  const [modelInitStatus, setModelInitStatus] = useState('');
  const [modelInitDone, setModelInitDone] = useState(false);

  // ---- Sample editor state ---------------------------------------------------------
  const [editCaption, setEditCaption] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editLyrics, setEditLyrics] = useState('');
  const [editBpm, setEditBpm] = useState(120);
  const [editKey, setEditKey] = useState('');
  const [editTimeSig, setEditTimeSig] = useState('');
  const [editLanguage, setEditLanguage] = useState('instrumental');
  const [editInstrumental, setEditInstrumental] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editSaveStatus, setEditSaveStatus] = useState('');

  // ---- Preprocess (tensor) state ---------------------------------------------------------
  const [preprocessOutputDir, setPreprocessOutputDir] = useState('');
  const [preprocessing, setPreprocessing] = useState(false);
  const [preprocessStatus, setPreprocessStatus] = useState('');

  // ---- Training state ---------------------------------------------------------
  const [trainingParams, setTrainingParams] = useState({
    tensorDir: '', rank: 64, alpha: 128, dropout: 0.1, learningRate: 0.0003, epochs: 1000,
    batchSize: 1, gradientAccumulation: 1, saveEvery: 200, shift: 3.0, seed: 42,
    outputDir: '', resumeCheckpoint: '',
  });
  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState('');

  const showLyricsField = useMemo(() => {
    if (!categoryConfig) return true;
    const keep = categoryConfig.preprocessing?.keepStems ?? [];
    if (keep.includes('vocals')) return true;
    if (categoryConfig.autoLabel?.transcribeLyrics) return true;
    return categoryConfig.preprocessing?.enabled === false;
  }, [categoryConfig]);

  const showMetadataRow = useMemo(() => !categoryConfig || !categoryConfig.autoLabel?.skipMetas, [categoryConfig]);

  // Apply category defaults once per (category, subType) change.
  const lastAppliedCategoryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!categoryConfig) return;
    const key = `${categoryConfig.id}::${categoryConfig.subTypeId ?? ''}`;
    if (lastAppliedCategoryRef.current === key) return;
    lastAppliedCategoryRef.current = key;

    const d = categoryConfig.training;
    setTrainingParams((prev) => ({
      ...prev, rank: d.rank, alpha: d.alpha, dropout: d.dropout, learningRate: d.learningRate,
      epochs: d.epochs, batchSize: d.batchSize, gradientAccumulation: d.gradientAccumulation, saveEvery: d.saveEvery,
    }));
    setSkipMetas(categoryConfig.autoLabel.skipMetas);
    setFormatLyrics(categoryConfig.autoLabel.formatLyrics);
    setTranscribeLyrics(categoryConfig.autoLabel.transcribeLyrics);
    setUploadDatasetName((prev) => {
      if (!prev || prev === 'my_lora_dataset' || prev.startsWith(`${categoryConfig.id}_`)) {
        return suggestDatasetName(categoryConfig.id, categoryConfig.subTypeId, queuedFiles);
      }
      return prev;
    });
    setDatasetSettings((prev) => ({ ...prev, customTag: categoryConfig.autoLabel.customTag, tagPosition: categoryConfig.autoLabel.tagPosition }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryConfig]);

  // Resolve `__PERSONA_TRIGGER__` to a real per-LoRA trigger word.
  useEffect(() => {
    if (!categoryConfig || categoryConfig.autoLabel.customTag !== '__PERSONA_TRIGGER__') return;
    const stripped = uploadDatasetName.replace(new RegExp(`^${categoryConfig.id}_+`), '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const slug = stripped || uploadDatasetName.replace(/[^a-z0-9]/gi, '').toLowerCase();
    const trigger = `${slug}${categoryConfig.id}, `;
    setDatasetSettings((prev) => (prev.customTag === trigger ? prev : { ...prev, customTag: trigger }));
  }, [categoryConfig, uploadDatasetName]);

  useEffect(() => {
    if (!categoryConfig || queuedFiles.length === 0) return;
    setUploadDatasetName((prev) => {
      const isPlaceholder = !prev || prev === 'my_lora_dataset' || /^[a-z_]+_\d{8}$/.test(prev)
        || prev === categoryConfig.id || (!!categoryConfig.subTypeId && prev === `${categoryConfig.id}_${categoryConfig.subTypeId}`);
      return isPlaceholder ? suggestDatasetName(categoryConfig.id, categoryConfig.subTypeId, queuedFiles) : prev;
    });
  }, [categoryConfig, queuedFiles]);

  // Keep the training output dir in sync with dataset name unless the user
  // has typed something that no longer matches the last auto-computed value.
  const lastAutoOutputDirRef = useRef('');
  useEffect(() => {
    if (!categoryConfig) return;
    const computed = buildOutputDir(uploadDatasetName);
    setTrainingParams((prev) => {
      if (prev.outputDir !== lastAutoOutputDirRef.current && prev.outputDir !== '') return prev;
      lastAutoOutputDirRef.current = computed;
      return { ...prev, outputDir: computed };
    });
  }, [categoryConfig, uploadDatasetName, buildOutputDir]);

  useEffect(() => {
    if (formatLyrics && transcribeLyrics) setTranscribeLyrics(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatLyrics]);
  useEffect(() => {
    if (transcribeLyrics && formatLyrics) setFormatLyrics(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transcribeLyrics]);

  const populateSampleFields = (sample: TrainingSample) => {
    setEditCaption(sample.caption || '');
    setEditGenre(sample.genre || '');
    setEditLyrics(sample.lyrics || '');
    setEditBpm(sample.bpm || 120);
    setEditKey(sample.key || '');
    setEditTimeSig(sample.timeSignature || '');
    setEditLanguage(sample.language || 'instrumental');
    setEditInstrumental(sample.instrumental ?? true);
  };

  // ---- Drop zone ---------------------------------------------------------
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => AUDIO_EXTENSIONS.includes((f.name.split('.').pop() || '').toLowerCase()));
    if (files.length > 0) setQueuedFiles((prev) => [...prev, ...files]);
  }, []);
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) setQueuedFiles((prev) => [...prev, ...Array.from(e.target.files!)]);
    e.target.value = '';
  }, []);
  const removeQueuedFile = (idx: number) => setQueuedFiles((prev) => prev.filter((_, i) => i !== idx));

  // ---- Upload + (optional) stem extraction + build dataset ---------------------------------------------------------
  const handleUploadAndBuild = useCallback(async () => {
    if (queuedFiles.length === 0) return;
    setUploading(true);
    setUploadStatus('Uploading files…');
    try {
      await api.uploadTrainingAudio(queuedFiles, uploadDatasetName);

      let buildDatasetName = uploadDatasetName;
      const pre = categoryConfig?.preprocessing;
      if (pre?.enabled && pre.model && selectedCategory) {
        setUploadStatus(`Extracting stems with ${pre.model}…`);
        const job = await api.preprocessStems({
          datasetName: uploadDatasetName,
          category: selectedCategory,
          subType: selectedSubType ?? null,
          preprocessing: { model: pre.model, keepStems: pre.keepStems, chain: pre.chain, extraArgs: pre.extraArgs },
        });
        buildDatasetName = job.outputDatasetName;

        const deadline = Date.now() + 60 * 60 * 1000;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (Date.now() > deadline) throw new Error('Stem extraction timed out after 60 minutes');
          await new Promise((r) => setTimeout(r, 2000));
          const status = await api.getPreprocessStemsStatus(job.jobId);
          setUploadStatus(`Extracting stems: ${status.progress}% (${status.current}/${status.total})`);
          if (status.status === 'completed') break;
          if (status.status === 'failed') throw new Error(status.error || 'Stem extraction failed');
        }
        setUploadStatus('Stems ready. Building dataset…');
      } else {
        setUploadStatus(`Uploaded ${queuedFiles.length} files. Building dataset…`);
      }

      const result = await api.buildDataset({
        datasetName: buildDatasetName,
        customTag: datasetSettings.customTag,
        tagPosition: datasetSettings.tagPosition,
        allInstrumental: datasetSettings.allInstrumental,
      });
      setSampleCount(result.sampleCount);
      setCurrentSampleIdx(0);
      if (result.sample) { setCurrentSample(result.sample); populateSampleFields(result.sample); }
      if (result.settings) {
        setDatasetSettings({
          datasetName: result.settings.datasetName,
          customTag: result.settings.customTag,
          tagPosition: (result.settings.tagPosition === 'append' ? 'append' : 'prepend'),
          allInstrumental: result.settings.allInstrumental,
        });
      }
      setDatasetPath(result.datasetPath);
      setDatasetStatus(result.status);
      setQueuedFiles([]);
      markStep('upload');
      setUploadStatus('Dataset built successfully!');
      setTimeout(() => advanceToNext('upload'), 500);
    } catch (err) {
      setUploadStatus(`Error: ${err instanceof Error ? err.message : 'Upload failed'}`);
      toast.error('Upload / build dataset failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setUploading(false);
    }
  }, [queuedFiles, uploadDatasetName, categoryConfig, selectedCategory, selectedSubType, datasetSettings, markStep, advanceToNext]);

  const handleLoadDataset = useCallback(async () => {
    if (!datasetPath.trim()) return;
    setDatasetLoading(true);
    setDatasetStatus('Loading dataset…');
    try {
      const result = await api.loadDataset(datasetPath.trim());
      setSampleCount(result.sampleCount);
      setCurrentSampleIdx(0);
      if (result.sample) { setCurrentSample(result.sample); populateSampleFields(result.sample); }
      setDatasetSettings({
        datasetName: result.settings.datasetName,
        customTag: result.settings.customTag,
        tagPosition: (result.settings.tagPosition === 'append' ? 'append' : 'prepend'),
        allInstrumental: result.settings.allInstrumental,
      });
      setDatasetStatus(result.status);
      markStep('upload');
      setTimeout(() => advanceToNext('upload'), 500);
    } catch (err) {
      setDatasetStatus(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
      toast.error('Load dataset failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setDatasetLoading(false);
    }
  }, [datasetPath, markStep, advanceToNext]);

  // ---- Model init on entering Label step ---------------------------------------------------------
  useEffect(() => {
    if (activeStep !== 'label' || modelInitDone || modelInitializing) return;
    let cancelled = false;
    (async () => {
      setModelInitializing(true);
      setModelInitStatus('Initializing model for labeling…');
      try {
        await api.initTrainingModel({ reinitialize: true, initLlm: true });
        if (!cancelled) { setModelInitStatus('Model ready'); setModelInitDone(true); }
      } catch (err) {
        if (!cancelled) setModelInitStatus(err instanceof Error ? err.message : 'Init failed');
      } finally {
        if (!cancelled) setModelInitializing(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeStep, modelInitDone, modelInitializing]);

  const handleAutoLabel = useCallback(async () => {
    setAutoLabeling(true);
    setAutoLabelStatus('Starting auto-label…');
    try {
      const result = await api.startAutoLabel({ skipMetas, formatLyrics, transcribeLyrics, onlyUnlabeled });
      if (!result.task_id) {
        setAutoLabelStatus(result.status || 'No task started');
        return;
      }
      setAutoLabelStatus(`Labeling samples… (0/${result.total ?? '?'})`);
      const outcome = await watchTraining('autoLabel', api.getAutoLabelStatus, setAutoLabelStatus, 120, 5000, () => cancelledRef.current, wsConnectedRef);
      if (outcome.cancelled) return;
      if (outcome.ok) {
        setAutoLabelStatus('Done labeling.');
        if (sampleCount > 0) {
          try {
            const sample = await api.getSamplePreview(currentSampleIdx);
            setCurrentSample(sample);
            populateSampleFields(sample);
          } catch { /* best-effort refresh */ }
        }
      } else {
        setAutoLabelStatus(`Failed: ${outcome.error}`);
      }
    } catch (err) {
      setAutoLabelStatus(err instanceof Error ? err.message : 'Failed');
    } finally {
      setAutoLabeling(false);
    }
  }, [skipMetas, formatLyrics, transcribeLyrics, onlyUnlabeled, sampleCount, currentSampleIdx]);

  const handleSampleNavigate = useCallback(async (idx: number) => {
    if (idx < 0 || idx >= sampleCount) return;
    setCurrentSampleIdx(idx);
    try {
      const sample = await api.getSamplePreview(idx);
      setCurrentSample(sample);
      populateSampleFields(sample);
    } catch (err) {
      toast.error('Failed to load sample', { description: err instanceof Error ? err.message : String(err) });
    }
  }, [sampleCount]);

  const handleSaveSample = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveSample({
        sampleIdx: currentSampleIdx, caption: editCaption, genre: editGenre, lyrics: editLyrics,
        bpm: editBpm, key: editKey, timeSignature: editTimeSig, language: editLanguage, instrumental: editInstrumental,
      });
      setEditSaveStatus('Saved.');
    } catch (err) {
      setEditSaveStatus(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
    } finally {
      setSaving(false);
    }
  }, [currentSampleIdx, editCaption, editGenre, editLyrics, editBpm, editKey, editTimeSig, editLanguage, editInstrumental]);

  // ---- Preprocess (tensors) ---------------------------------------------------------
  const handlePreprocess = useCallback(async () => {
    setPreprocessing(true);
    setPreprocessStatus('Starting preprocessing…');
    try {
      const result = await api.startPreprocess({ datasetPath, outputDir: preprocessOutputDir.trim() || undefined });
      if (!result.task_id) {
        setPreprocessStatus(result.status || 'No task started');
        return;
      }
      setPreprocessStatus('Preprocessing audio samples…');
      const outcome = await watchTraining('preprocess', api.getPreprocessStatus, setPreprocessStatus, 360, 5000, () => cancelledRef.current, wsConnectedRef);
      if (outcome.cancelled) return;
      if (outcome.ok) {
        setPreprocessStatus('Preprocessing complete!');
        markStep('preprocess');
        setTimeout(() => advanceToNext('preprocess'), 500);
      } else {
        setPreprocessStatus(`Failed: ${outcome.error}`);
      }
    } catch (err) {
      setPreprocessStatus(`Error: ${err instanceof Error ? err.message : 'Preprocessing failed'}`);
    } finally {
      setPreprocessing(false);
    }
  }, [datasetPath, preprocessOutputDir, markStep, advanceToNext]);

  // ---- Training ---------------------------------------------------------
  // Shared by a fresh "Start training" click and the mount-time
  // reconciliation effect below, so a run that completes while this
  // component is actually mounted (either way) gets the same
  // toast/markStep treatment.
  const awaitTrainingCompletion = useCallback(async () => {
    try {
      const outcome = await watchTraining('train', api.getTrainingStatus, setTrainingProgress, 3600, 5000, () => cancelledRef.current, wsConnectedRef);
      if (outcome.cancelled) return;
      if (outcome.ok) {
        setTrainingProgress('Training complete!');
        markStep('train');
        toast.success('LoRA training complete', { description: 'Find it in the persona picker on the Create tab.' });
      } else {
        setTrainingProgress(`Training failed: ${outcome.error}`);
        toast.error('Training failed', { description: outcome.error });
      }
    } finally {
      setIsTraining(false);
    }
  }, [markStep]);

  const handleStartTraining = useCallback(async () => {
    setIsTraining(true);
    setTrainingProgress('Starting training…');
    try {
      await api.startTraining({
        datasetName: uploadDatasetName,
        tensorDir: trainingParams.tensorDir.trim() || undefined,
        rank: trainingParams.rank, alpha: trainingParams.alpha, dropout: trainingParams.dropout,
        learningRate: trainingParams.learningRate, epochs: trainingParams.epochs, batchSize: trainingParams.batchSize,
        gradientAccumulation: trainingParams.gradientAccumulation, saveEvery: trainingParams.saveEvery,
        shift: trainingParams.shift, seed: trainingParams.seed,
        outputDir: trainingParams.outputDir.trim() || undefined,
        resumeCheckpoint: trainingParams.resumeCheckpoint.trim() || null,
      });
      await awaitTrainingCompletion();
    } catch (err) {
      setTrainingProgress(`Error: ${err instanceof Error ? err.message : 'Failed'}`);
      setIsTraining(false);
    }
  }, [uploadDatasetName, trainingParams, awaitTrainingCompletion]);

  // Refresh must not lose track of an in-flight training run — unlike a
  // per-job id (generation/TTS), ACE-Step's training-status endpoint is a
  // singleton (one run at a time), so no client-side bookkeeping is needed
  // to know *what* to reconcile against: just ask it once on mount. Uses the
  // conservative `looksActiveRaw` check (not the fuzzier `looksDone` the
  // ongoing watch itself uses) so an idle/unknown-shape response never shows
  // a false "training in progress" banner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await api.getTrainingStatus();
        if (cancelled || !looksActiveRaw(raw)) return;
        setIsTraining(true);
        setTrainingProgress('Reconnected to an in-progress training run…');
        void awaitTrainingCompletion();
      } catch {
        // best-effort — worst case, a resumed run just doesn't show its
        // progress card until the user revisits the Train step manually.
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStopTraining = useCallback(async () => {
    try {
      await api.stopTraining();
      setTrainingProgress('Training stopped.');
    } catch (err) {
      toast.error('Failed to stop training', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsTraining(false);
    }
  }, []);

  const handleConfirmCategory = useCallback(() => {
    if (!selectedCategory) return;
    markStep('category');
    advanceToNext('category');
  }, [selectedCategory, markStep, advanceToNext]);

  return (
    <div className="grid gap-4 lg:grid-cols-[160px_1fr]">
      {/* Step nav */}
      <div className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {PIPELINE_STEPS.map((step) => {
          const Icon = step.icon;
          const done = completedSteps.has(step.key);
          const isCurrent = activeStep === step.key;
          const canClick = canGoToStep(step.key);
          return (
            <button
              key={step.key}
              type="button"
              onClick={() => goToStep(step.key)}
              disabled={!canClick}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors',
                isCurrent ? 'border border-brand/30 bg-brand/10 text-brand'
                  : done ? 'text-foreground hover:bg-muted'
                    : canClick ? 'text-muted-foreground hover:bg-muted' : 'cursor-not-allowed text-muted-foreground/50',
              )}
            >
              {done ? <Check className="h-3 w-3 text-emerald-500" /> : <Icon className="h-3 w-3" />}
              {step.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-4">
        {activeStep === 'category' && (
          <Card>
            <CardHeader><CardTitle>Step 1 · Choose what you&apos;re training</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <TrainingCategorySelector
                categories={categories}
                selectedCategory={selectedCategory}
                selectedSubType={selectedSubType}
                onSelectCategory={setCategory}
                onSelectSubType={setSubType}
              />
              {categoryConfig && (
                <div className="space-y-2 border-t border-border pt-3">
                  <CategorySummary config={categoryConfig} outputRoot={outputRoot} />
                  <div className="flex justify-end">
                    <Button onClick={handleConfirmCategory}>Continue with {categoryConfig.displayName}</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {activeStep === 'upload' && (
          <>
            {categoryConfig && <DatasetGuidanceCard config={categoryConfig} />}

            <Card>
              <CardHeader><CardTitle>Upload audio files</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                  onDragLeave={() => setIsDragOver(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    'cursor-pointer rounded-xl border-2 border-dashed p-4 text-center transition-colors',
                    isDragOver ? 'border-brand bg-brand/10' : 'border-border hover:border-ring',
                  )}
                >
                  <Upload className={cn('mx-auto mb-1.5 h-6 w-6', isDragOver ? 'text-brand' : 'text-muted-foreground')} />
                  <p className="text-xs font-medium text-foreground">Drop audio files here or click to browse</p>
                  <p className="mt-1 text-xs text-muted-foreground">.wav, .mp3, .flac, .ogg, .opus</p>
                  <input ref={fileInputRef} type="file" multiple accept=".wav,.mp3,.flac,.ogg,.opus" onChange={handleFileSelect} className="hidden" />
                </div>

                {queuedFiles.length > 0 && (
                  <div className="space-y-2">
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {queuedFiles.map((f, i) => (
                        <div key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg bg-muted px-2 py-1.5">
                          <FileAudio className="h-3 w-3 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate text-xs text-foreground">{f.name}</span>
                          <span className="text-xs text-muted-foreground">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                          <button type="button" onClick={() => removeQueuedFile(i)} className="text-muted-foreground hover:text-destructive">
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Dataset name</label>
                      <Input value={uploadDatasetName} onChange={(e) => setUploadDatasetName(e.target.value)} placeholder="my_lora_dataset" />
                    </div>
                    <div className="flex justify-end">
                      <Button onClick={() => void handleUploadAndBuild()} disabled={uploading || !uploadDatasetName.trim()}>
                        {uploading ? <Spinner size="sm" /> : <Upload className="h-3.5 w-3.5" />}
                        Upload &amp; build dataset ({queuedFiles.length})
                      </Button>
                    </div>
                  </div>
                )}

                {uploadStatus && (
                  <p className={cn('rounded-lg px-3 py-2 text-xs', uploadStatus.startsWith('Error') ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}>
                    {uploadStatus}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Or load an existing dataset</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex gap-2">
                  <Input value={datasetPath} onChange={(e) => setDatasetPath(e.target.value)} placeholder="my_dataset.json" className="flex-1" />
                  <Button variant="secondary" onClick={() => void handleLoadDataset()} disabled={datasetLoading || !datasetPath.trim()}>
                    {datasetLoading ? <Spinner size="sm" /> : <FolderOpen className="h-3.5 w-3.5" />}
                    Load
                  </Button>
                </div>
                {datasetStatus && <p className="break-words text-xs text-muted-foreground">{datasetStatus}</p>}
              </CardContent>
            </Card>
          </>
        )}

        {activeStep === 'label' && (
          <>
            {(modelInitializing || modelInitStatus) && (
              <div className={cn(
                'flex items-center gap-2 rounded-lg px-3 py-2 text-xs',
                modelInitializing ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                  : /ready/i.test(modelInitStatus) ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
              )}
              >
                {modelInitializing && <Spinner size="xs" />}
                {modelInitStatus}
              </div>
            )}

            <Card>
              <CardHeader><CardTitle>Auto-label with AI</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Automatically label all samples with genre, BPM, key, and lyrics using ACE-Step&apos;s 5Hz LM.
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  <LabelCheckbox label="Skip metas" checked={skipMetas} onChange={setSkipMetas} />
                  <LabelCheckbox label="Format lyrics" checked={formatLyrics} onChange={setFormatLyrics} />
                  <LabelCheckbox label="Transcribe lyrics" checked={transcribeLyrics} onChange={setTranscribeLyrics} />
                  <LabelCheckbox label="Only unlabeled" checked={onlyUnlabeled} onChange={setOnlyUnlabeled} />
                </div>
                <div className="flex justify-end border-t border-border pt-3">
                  <Button variant="secondary" onClick={() => void handleAutoLabel()} disabled={autoLabeling || modelInitializing}>
                    {autoLabeling ? <Spinner size="sm" /> : <Wand2 className="h-3.5 w-3.5" />}
                    Auto-label all samples
                  </Button>
                </div>
                {autoLabelStatus && <p className="break-words text-xs text-muted-foreground">{autoLabelStatus}</p>}
              </CardContent>
            </Card>

            {sampleCount > 0 && (
              <Card>
                <CardHeader><CardTitle>Edit sample ({currentSampleIdx + 1}/{sampleCount})</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => void handleSampleNavigate(currentSampleIdx - 1)} disabled={currentSampleIdx <= 0}>Prev</Button>
                    <Input
                      type="number" min={1} max={sampleCount} value={currentSampleIdx + 1}
                      onChange={(e) => { const v = parseInt(e.target.value, 10) - 1; if (v >= 0 && v < sampleCount) void handleSampleNavigate(v); }}
                      className="w-16 text-center"
                    />
                    <Button variant="ghost" size="sm" onClick={() => void handleSampleNavigate(currentSampleIdx + 1)} disabled={currentSampleIdx >= sampleCount - 1}>Next</Button>
                    <span className="ml-auto max-w-[160px] truncate text-xs text-muted-foreground">{currentSample?.filename || ''}</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Caption</label>
                      <Input value={editCaption} onChange={(e) => setEditCaption(e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Genre</label>
                      <Input value={editGenre} onChange={(e) => setEditGenre(e.target.value)} />
                    </div>
                  </div>

                  {showLyricsField && (
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Lyrics</label>
                      <Textarea value={editLyrics} onChange={(e) => setEditLyrics(e.target.value)} className="h-20 resize-none font-mono text-xs" />
                    </div>
                  )}

                  {showMetadataRow && (
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">BPM</label>
                        <Input type="number" value={editBpm} onChange={(e) => setEditBpm(parseInt(e.target.value, 10) || 0)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Key</label>
                        <Input value={editKey} onChange={(e) => setEditKey(e.target.value)} />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Language</label>
                        <SelectField value={editLanguage} onValueChange={setEditLanguage}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {LANGUAGES.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}
                          </SelectContent>
                        </SelectField>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between border-t border-border pt-3">
                    <span className="text-xs text-muted-foreground">{editSaveStatus}</span>
                    <Button variant="secondary" onClick={() => void handleSaveSample()} disabled={saving}>
                      {saving ? <Spinner size="sm" /> : <Edit3 className="h-3.5 w-3.5" />}
                      Save sample
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {sampleCount > 0 && (
              <div className="flex justify-end">
                <Button onClick={() => { markStep('label'); advanceToNext('label'); }}>Continue to Preprocess</Button>
              </div>
            )}
          </>
        )}

        {activeStep === 'preprocess' && (
          <div className="max-w-lg space-y-3">
            {categoryConfig?.preprocessing.enabled && <PreprocessingNoticeCard config={categoryConfig} />}
            <Card>
              <CardHeader><CardTitle>Preprocess to tensors</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">Convert your labeled dataset into training-ready tensors.</p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Dataset</label>
                  <div className="truncate rounded-lg border border-border bg-muted px-3 py-1.5 text-xs text-foreground">{datasetPath || '(none built yet)'}</div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Tensor output dir (optional override)</label>
                  <Input value={preprocessOutputDir} onChange={(e) => setPreprocessOutputDir(e.target.value)} placeholder="preprocessed_tensors" />
                </div>
                <div className="flex justify-end border-t border-border pt-3">
                  <Button onClick={() => void handlePreprocess()} disabled={preprocessing || !datasetPath}>
                    {preprocessing ? <Spinner size="sm" /> : <Zap className="h-3.5 w-3.5" />}
                    {preprocessing ? 'Preprocessing…' : 'Start preprocessing'}
                  </Button>
                </div>
                {preprocessStatus && (
                  <p className={cn('rounded-lg px-3 py-2 text-xs', preprocessStatus.startsWith('Error') || preprocessStatus.startsWith('Failed') ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400')}>
                    {preprocessStatus}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {activeStep === 'train' && (
          <>
            <Card>
              <CardHeader><CardTitle>LoRA settings</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-3 gap-3">
                <ParamSlider label="Rank" value={trainingParams.rank} min={4} max={256} step={4} onChange={(v) => setTrainingParams((p) => ({ ...p, rank: v }))} />
                <ParamSlider label="Alpha" value={trainingParams.alpha} min={4} max={512} step={4} onChange={(v) => setTrainingParams((p) => ({ ...p, alpha: v }))} />
                <ParamSlider label="Dropout" value={trainingParams.dropout} min={0} max={0.5} step={0.05} onChange={(v) => setTrainingParams((p) => ({ ...p, dropout: v }))} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Training parameters</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Learning rate</label>
                  <Input type="number" step={0.0001} value={trainingParams.learningRate} onChange={(e) => setTrainingParams((p) => ({ ...p, learningRate: parseFloat(e.target.value) || 0.0003 }))} />
                </div>
                <ParamSlider label="Max epochs" value={trainingParams.epochs} min={1} max={4000} step={1} onChange={(v) => setTrainingParams((p) => ({ ...p, epochs: v }))} />
                <ParamSlider label="Batch size" value={trainingParams.batchSize} min={1} max={8} step={1} onChange={(v) => setTrainingParams((p) => ({ ...p, batchSize: v }))} />
                <ParamSlider label="Gradient accum." value={trainingParams.gradientAccumulation} min={1} max={16} step={1} onChange={(v) => setTrainingParams((p) => ({ ...p, gradientAccumulation: v }))} />
                <ParamSlider label="Save every (epochs)" value={trainingParams.saveEvery} min={50} max={1000} step={50} onChange={(v) => setTrainingParams((p) => ({ ...p, saveEvery: v }))} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Output</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Output dir (relative)</label>
                  <Input value={trainingParams.outputDir} onChange={(e) => setTrainingParams((p) => ({ ...p, outputDir: e.target.value }))} />
                  {categoryConfig && <p className="mt-1 text-xs text-muted-foreground">From category: <span className="font-mono">{categoryConfig.training.outputSubdir}/&lt;dataset&gt;</span></p>}
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Resume checkpoint (optional)</label>
                  <Input value={trainingParams.resumeCheckpoint} onChange={(e) => setTrainingParams((p) => ({ ...p, resumeCheckpoint: e.target.value }))} placeholder="checkpoints/epoch_200" />
                </div>
              </CardContent>
            </Card>

            <div className="flex justify-end">
              {!isTraining ? (
                <Button size="lg" onClick={() => void handleStartTraining()}>
                  <Play className="h-4 w-4" /> Start training
                </Button>
              ) : (
                <Button size="lg" variant="destructive" onClick={() => void handleStopTraining()}>
                  <Square className="h-4 w-4" /> Stop training
                </Button>
              )}
            </div>

            {trainingProgress && (
              <Card>
                <CardHeader><CardTitle>Training progress</CardTitle></CardHeader>
                <CardContent>
                  {isTraining && (
                    <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
                    </div>
                  )}
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground">{trainingProgress}</p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LabelCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

function ParamSlider({
  label, value, min, max, step, onChange,
}: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="rounded-lg bg-muted p-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{step < 1 ? value.toFixed(2) : value}</span>
      </div>
      <Slider value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)} />
    </div>
  );
}

function CategorySummary({ config, outputRoot }: { config: ResolvedCategoryConfig; outputRoot: string }) {
  const { dataset, training, preprocessing } = config;
  return (
    <div className="grid grid-cols-2 gap-2 text-xs">
      <div className="rounded-lg border border-border bg-muted p-2">
        <div className="mb-1 text-xs text-muted-foreground">Dataset target</div>
        <div className="text-foreground">{dataset.minSamples}-{dataset.recommendedSamples} clips, {dataset.minSampleSeconds}-{dataset.maxSampleSeconds}s each</div>
      </div>
      <div className="rounded-lg border border-border bg-muted p-2">
        <div className="mb-1 text-xs text-muted-foreground">Training defaults</div>
        <div className="text-foreground">rank {training.rank} · α {training.alpha} · {training.epochs} epochs · lr {training.learningRate}</div>
      </div>
      <div className="col-span-2 rounded-lg border border-border bg-muted p-2">
        <div className="mb-1 text-xs text-muted-foreground">Output path</div>
        <div className="break-all font-mono text-xs text-foreground">{outputRoot}/{training.outputSubdir}/&lt;datasetName&gt;</div>
      </div>
      {preprocessing.enabled && (
        <div className="col-span-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-2">
          <div className="mb-1 text-xs text-amber-600 dark:text-amber-400">Preprocessing</div>
          <div className="text-xs text-amber-700 dark:text-amber-300">
            {preprocessing.chain ? `Chained: ${preprocessing.chain.join(' → ')}` : preprocessing.model}
            {preprocessing.keepStems.length > 0 && ` · keep [${preprocessing.keepStems.join(', ')}]`}
          </div>
        </div>
      )}
    </div>
  );
}

function DatasetGuidanceCard({ config }: { config: ResolvedCategoryConfig }) {
  return (
    <Card className="border-brand/20 bg-brand/5">
      <CardContent className="flex items-start gap-2 pt-4">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
        <div className="space-y-1">
          <div className="text-xs font-semibold text-brand">{config.displayName} dataset</div>
          <p className="text-xs leading-relaxed text-foreground">{config.dataset.instructions}</p>
          <p className="text-xs text-muted-foreground">
            Recommended: {config.dataset.recommendedSamples} clips · {config.dataset.minSampleSeconds}-{config.dataset.maxSampleSeconds}s each (min {config.dataset.minSamples}).
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function PreprocessingNoticeCard({ config }: { config: ResolvedCategoryConfig }) {
  const { preprocessing } = config;
  return (
    <Card className="border-amber-500/20 bg-amber-500/5">
      <CardContent className="flex items-start gap-2 pt-4">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <div className="text-xs font-semibold text-amber-600 dark:text-amber-400">Stem extraction required</div>
          <p className="text-xs leading-relaxed text-foreground">
            This ran automatically during Upload — before encoding to tensors, only the relevant stem was kept.
          </p>
          <p className="font-mono text-xs text-muted-foreground">
            {preprocessing.chain ? `chain: ${preprocessing.chain.join(' → ')}` : `model: ${preprocessing.model}`}
            {preprocessing.keepStems.length > 0 && ` · keep [${preprocessing.keepStems.join(', ')}]`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default TrainTab;
