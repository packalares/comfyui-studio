// VideoBuilder — Studio's Easy-mode UI for video generation.
//
// Renders when Studio's top-level tab strip selects "Video". Drives any
// template tagged `studioBuilder: 'video'` in its TemplateData JSON via a
// minimal model dropdown + opinionated form (prompt, resolution preset,
// duration in seconds, optional image/audio/last-frame).
//
// All heavy lifting (workflow muting, switch-widget update, dependency
// check) happens server-side via the existing `/api/generate` endpoint
// extended with a `mode?: string` field — see generate.routes.ts. Prompt
// enhancement goes through the existing `/api/llm/generate` endpoint with
// the template's `promptEnhancer.systemPrompt`.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import { Wand2, Sparkles, Image as ImageIcon, Music, Film, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, ApiError } from '../services/comfyui';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import type { TemplateSummary } from '../types';

/** Resolution presets exposed in the Easy UI. Tied to common LTX/Wan
 *  capabilities. Adding a new preset = one line. */
const RESOLUTION_PRESETS = [
  { id: 'landscape-1080p', label: '1080p Landscape (16:9)',   width: 1920, height: 1080 },
  { id: 'landscape-720p',  label: '720p Landscape (16:9)',    width: 1280, height: 720 },
  { id: 'landscape-540p',  label: '540p Landscape (16:9)',    width: 960,  height: 540 },
  { id: 'portrait-1080p',  label: '1080p Portrait (9:16)',    width: 1080, height: 1920 },
  { id: 'portrait-720p',   label: '720p Portrait (9:16)',     width: 720,  height: 1280 },
  { id: 'square-768',      label: 'Square 768 (1:1)',         width: 768,  height: 768 },
  { id: 'square-1024',     label: 'Square 1024 (1:1)',        width: 1024, height: 1024 },
] as const;

/** Wider TemplateData fetched via /api/template-bundle/:name. Carries the
 *  Easy-mode metadata (modes + promptEnhancer) the server route uses too. */
interface BuilderTemplateBundle {
  name: string;
  title?: string;
  modelDisplayName?: string;
  modes?: Record<string, {
    requires?: string[];
    mute?: number[];
    switchNodeId?: number;
    switchSlot?: number;
  }>;
  promptEnhancer?: {
    systemPrompt: string;
    preferredModel?: string;
  };
}

const STORAGE_KEY = 'studio:video:lastForm';

interface PersistedForm {
  templateName: string;
  prompt: string;
  resolutionId: string;
  duration: number;
  seed: number;
}

/** Read the last form values from localStorage so re-entering the tab
 *  doesn't lose state. We persist after every Generate. */
function loadPersistedForm(): PersistedForm | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedForm) : null;
  } catch { return null; }
}

/** Match the inputs the user has filled against the template's per-mode
 *  `requires` array. Returns the mode whose required set is exactly the
 *  filled set; falls back to the smallest requires that's a subset. */
function inferMode(
  filled: Set<string>,
  modes: BuilderTemplateBundle['modes'],
): string | null {
  if (!modes) return null;
  // First pass: exact match
  for (const [name, cfg] of Object.entries(modes)) {
    const req = new Set(cfg.requires ?? []);
    if (req.size === filled.size && [...req].every((k) => filled.has(k))) {
      return name;
    }
  }
  // Second pass: best subset (smallest requires that's contained in filled)
  let best: { name: string; size: number } | null = null;
  for (const [name, cfg] of Object.entries(modes)) {
    const req = cfg.requires ?? [];
    if (req.every((k) => filled.has(k))) {
      const size = req.length;
      if (!best || size > best.size) best = { name, size };
    }
  }
  return best?.name ?? null;
}

export default function VideoBuilder() {
  const { templates, submitGeneration, connected, uploadMaxBytes } = useApp();

  // ---- Pool of video-builder templates ----
  // The templates list endpoint doesn't (yet) surface the `studioBuilder`
  // field from the on-disk TemplateData JSON, so we filter by mediaType
  // first and then per-selection verify the template actually carries
  // Easy-mode metadata (modes + promptEnhancer) via getTemplateBundle.
  // Templates without that metadata still appear in the dropdown but the
  // mode-aware bits stay hidden until you pick one that has them.
  const builderTemplates = useMemo(
    () => templates.filter((t) => {
      const tx = t as TemplateSummary & { studioBuilder?: string };
      // Prefer explicit studioBuilder tag when present (future-proof for
      // when the list endpoint surfaces it).
      if (tx.studioBuilder) return tx.studioBuilder === 'video';
      // Fallback: any video-category template can drive the UI in MVP.
      const mt = (t.mediaType || '').toLowerCase();
      return mt === 'video';
    }),
    [templates],
  );

  // ---- Selected template + its full bundle (modes + promptEnhancer) ----
  const persisted = useMemo(() => loadPersistedForm(), []);
  const [selectedName, setSelectedName] = useState<string>(() => {
    if (persisted?.templateName && builderTemplates.some((t) => t.name === persisted.templateName)) {
      return persisted.templateName;
    }
    return builderTemplates[0]?.name ?? '';
  });

  // If templates load after first paint and we still have no selection,
  // pick the first one.
  useEffect(() => {
    if (!selectedName && builderTemplates.length > 0) {
      setSelectedName(builderTemplates[0].name);
    }
  }, [selectedName, builderTemplates]);

  const [bundle, setBundle] = useState<BuilderTemplateBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  useEffect(() => {
    if (!selectedName) { setBundle(null); return; }
    let cancelled = false;
    setBundleLoading(true);
    api.getTemplateBundle(selectedName)
      .then((res) => {
        if (cancelled) return;
        // `builderMeta` is populated on the server side from the TemplateData
        // JSON (see templateWidgets.routes.ts). Templates without Easy-mode
        // metadata still resolve — `meta` will be undefined and we hide the
        // mode-driven UI bits.
        const meta = res.builderMeta;
        setBundle(meta ? {
          name: selectedName,
          modelDisplayName: meta.modelDisplayName,
          modes: meta.modes,
          promptEnhancer: meta.promptEnhancer,
        } : null);
      })
      .catch(() => { if (!cancelled) setBundle(null); })
      .finally(() => { if (!cancelled) setBundleLoading(false); });
    return () => { cancelled = true; };
  }, [selectedName]);

  // ---- Form state ----
  const [prompt, setPrompt] = useState<string>(persisted?.prompt ?? '');
  const [resolutionId, setResolutionId] = useState<string>(persisted?.resolutionId ?? 'landscape-720p');
  const [duration, setDuration] = useState<number>(persisted?.duration ?? 5);
  const [seed, setSeed] = useState<number>(persisted?.seed ?? Math.floor(Math.random() * 1000000));

  // Optional inputs (files). The form auto-detects what the chosen mode
  // requires from the bundle's `modes[*].requires` array.
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [lastFrameFile, setLastFrameFile] = useState<File | null>(null);

  const [enhancing, setEnhancing] = useState(false);
  const [generating, setGenerating] = useState(false);

  // ---- Mode inference ----
  const filledInputs = useMemo(() => {
    const s = new Set<string>();
    if (imageFile) s.add('image');
    if (audioFile) s.add('audio');
    if (lastFrameFile) s.add('lastFrame');
    return s;
  }, [imageFile, audioFile, lastFrameFile]);

  const inferredMode = useMemo(
    () => inferMode(filledInputs, bundle?.modes),
    [filledInputs, bundle?.modes],
  );

  const resolution = useMemo(
    () => RESOLUTION_PRESETS.find((p) => p.id === resolutionId) ?? RESOLUTION_PRESETS[1],
    [resolutionId],
  );

  // ---- Client-side validation ----
  // Runs BEFORE submit so ComfyUI never sees a guaranteed-invalid request.
  const validationError = useMemo<string | null>(() => {
    if (!selectedName) return 'Pick a model';
    if (!bundle) return null; // still loading metadata; let the button spin
    if (!prompt.trim()) return 'Write a prompt';
    if (!inferredMode) {
      const allowed = Object.entries(bundle.modes ?? {})
        .map(([m, c]) => `${m} (${(c.requires ?? []).join('+') || 'no inputs'})`)
        .join(' · ');
      return allowed
        ? `Input combo doesn't match any mode. Try one of: ${allowed}`
        : 'Template has no modes declared';
    }
    if (duration <= 0 || duration > 60) return 'Duration must be between 1 and 60 seconds';
    if (resolution.width <= 0 || resolution.height <= 0) return 'Invalid resolution';
    return null;
  }, [selectedName, bundle, prompt, inferredMode, duration, resolution]);

  // ---- Prompt enhance via existing /api/llm/generate ----
  const handleEnhance = useCallback(async () => {
    if (!prompt.trim()) {
      toast.warning('Write a prompt first');
      return;
    }
    if (!bundle?.promptEnhancer?.systemPrompt) {
      toast.error('This model has no prompt enhancer configured');
      return;
    }
    setEnhancing(true);
    try {
      // Compose: system prompt + user prompt → Ollama generate. We use the
      // non-streaming form by parsing the NDJSON ourselves and concatenating
      // the `response` fields. Simpler than wiring a streaming hook for now.
      const model = bundle.promptEnhancer.preferredModel ?? 'qwen2.5:7b';
      const system = bundle.promptEnhancer.systemPrompt;
      const res = await fetch('/api/llm/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          model,
          system,
          prompt: prompt.trim(),
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `LLM generate failed (${res.status})`);
      }
      const data = await res.json() as { response?: string };
      const enhanced = (data.response ?? '').trim();
      if (enhanced) {
        setPrompt(enhanced);
        toast.success('Prompt enhanced');
      } else {
        toast.warning('LLM returned an empty response');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Enhance failed';
      toast.error('Prompt enhance failed', { description: msg });
    } finally {
      setEnhancing(false);
    }
  }, [prompt, bundle]);

  // ---- Submit ----
  const handleGenerate = useCallback(async () => {
    if (validationError || !inferredMode) {
      toast.error(validationError ?? 'Cannot submit');
      return;
    }
    setGenerating(true);
    try {
      // Build the inputs map that maps to the workflow's form-field keys.
      // The combined workflow uses well-known widget node titles like
      // "Width (px)", "Height (px)", "Duration (seconds)", "Seed", "Text
      // Multiline" (the prompt). The server's formInput resolver maps
      // these to the right proxy slots on the active subgraph.
      const inputs: Record<string, unknown> = {
        // Text prompt — the combined workflow exposes a Text Multiline widget.
        text: prompt.trim(),
        // Numeric widgets (PrimitiveInt / PrimitiveFloat). Names match the
        // titles we wrote into ltx_combined.json's PrimitiveInt nodes.
        width: resolution.width,
        height: resolution.height,
        duration,
        seed,
      };

      // Upload files; the server reads file names from inputs.image etc.
      // and the LoadImage/LoadAudio nodes pick them up.
      const uploads: Array<{ key: string; file: File }> = [];
      if (imageFile) uploads.push({ key: 'image', file: imageFile });
      if (audioFile) uploads.push({ key: 'audio', file: audioFile });
      if (lastFrameFile) uploads.push({ key: 'lastFrame', file: lastFrameFile });

      const maxBytes = uploadMaxBytes ?? 50 * 1024 * 1024;
      for (const u of uploads) {
        if (u.file.size > maxBytes) {
          const sizeMb = (u.file.size / (1024 * 1024)).toFixed(1);
          const maxMb = Math.round(maxBytes / (1024 * 1024));
          throw new ApiError(`"${u.file.name}" is ${sizeMb} MB; max upload ${maxMb} MB`, 413, null);
        }
        const result = await api.uploadImage(u.file);
        inputs[u.key] = result.name;
      }

      // Persist form for re-entry.
      try {
        const blob: PersistedForm = {
          templateName: selectedName, prompt, resolutionId, duration, seed,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      } catch { /* ignore */ }

      await submitGeneration(selectedName, inputs, undefined, inferredMode);
      toast.success('Submitted to GPU queue');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Submit failed';
      toast.error('Generate failed', { description: msg });
    } finally {
      setGenerating(false);
    }
  }, [
    validationError, inferredMode, prompt, resolution, duration, seed,
    imageFile, audioFile, lastFrameFile, uploadMaxBytes, selectedName, submitGeneration,
    resolutionId,
  ]);

  // ---- Empty state ----
  if (builderTemplates.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-12">
        <div className="text-center max-w-md">
          <Film className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
          <h2 className="text-lg font-semibold mb-1.5">No video models installed</h2>
          <p className="text-sm text-muted-foreground">
            Import a video workflow (e.g. <code>ltx_combined</code>) through Templates and add{' '}
            <code>studioBuilder: "video"</code> + a <code>modes</code> block to its TemplateData
            JSON. It'll appear in this dropdown.
          </p>
        </div>
      </div>
    );
  }

  // ---- Render ----
  return (
    <div className="flex flex-col gap-5 p-5 max-w-2xl w-full mx-auto">

      {/* MODEL */}
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
          Model
        </label>
        <SelectField value={selectedName} onValueChange={setSelectedName}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {builderTemplates.map((t) => {
              const t2 = t as TemplateSummary & { modelDisplayName?: string };
              return (
                <SelectItem key={t.name} value={t.name}>
                  {t2.modelDisplayName || t.title || t.name}
                </SelectItem>
              );
            })}
          </SelectContent>
        </SelectField>
        {bundleLoading && (
          <p className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1">
            <Spinner size="xs" /> Loading model metadata…
          </p>
        )}
      </div>

      {/* PROMPT + ENHANCE */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
            Prompt
          </label>
          {bundle?.promptEnhancer && (
            <button
              type="button"
              onClick={handleEnhance}
              disabled={enhancing || !prompt.trim()}
              className="text-[11px] inline-flex items-center gap-1 text-brand hover:text-brand/80 disabled:opacity-50 disabled:cursor-not-allowed"
              title={`Rewrite your prompt for ${bundle.modelDisplayName || 'this model'} using ${bundle.promptEnhancer.preferredModel ?? 'Ollama'}`}
            >
              {enhancing ? <Spinner size="xs" /> : <Sparkles className="w-3.5 h-3.5" />}
              {enhancing ? 'Enhancing…' : 'Enhance with AI'}
            </button>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what you want the video to show…"
          rows={5}
          className="field-input w-full resize-vertical min-h-[7rem]"
        />
      </div>

      {/* RESOLUTION + DURATION */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
            Resolution
          </label>
          <SelectField value={resolutionId} onValueChange={setResolutionId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {resolution.width} × {resolution.height} px
          </p>
        </div>
        <div>
          <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
            Duration
          </label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-sm font-mono text-foreground min-w-[3.5rem] text-right">
              {duration} sec
            </span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            Longer clips take more VRAM and time.
          </p>
        </div>
      </div>

      {/* OPTIONAL INPUTS — image / audio / last-frame.
          Visible always; the user adds whichever they want and the mode
          gets inferred from the combination. */}
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
          Optional inputs <span className="font-normal normal-case text-muted-foreground">— add any combination; mode is auto-detected</span>
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <FileSlot
            icon={ImageIcon}
            label="Reference image"
            accept="image/*"
            file={imageFile}
            onPick={setImageFile}
          />
          <FileSlot
            icon={Music}
            label="Audio"
            accept="audio/*"
            file={audioFile}
            onPick={setAudioFile}
          />
          <FileSlot
            icon={ImageIcon}
            label="Last frame"
            accept="image/*"
            file={lastFrameFile}
            onPick={setLastFrameFile}
          />
        </div>
      </div>

      {/* SEED */}
      <div>
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-2 block">
          Seed
        </label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            className="field-input w-40 font-mono"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSeed(Math.floor(Math.random() * 1000000))}
            title="Randomize"
          >
            <Wand2 className="w-3.5 h-3.5" />
            Random
          </Button>
        </div>
      </div>

      {/* MODE PREVIEW + VALIDATION + GENERATE */}
      <div className="border-t pt-4 space-y-3">
        <div className="flex items-center gap-2 text-xs">
          {inferredMode && !validationError ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
              <span className="text-foreground">
                Mode: <strong className="font-mono">{inferredMode}</strong>
              </span>
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
              <span className="text-muted-foreground">
                {validationError ?? 'Add inputs to pick a mode'}
              </span>
            </>
          )}
        </div>
        <Button
          type="button"
          onClick={handleGenerate}
          disabled={!!validationError || generating || !connected}
          className="w-full justify-center"
        >
          {generating ? <Spinner size="xs" /> : <Film className="w-3.5 h-3.5" />}
          {generating ? 'Submitting…' : 'Generate'}
        </Button>
        {!connected && (
          <p className="text-[11px] text-warning text-center">
            ComfyUI is not connected. Open Settings to configure.
          </p>
        )}
      </div>
    </div>
  );
}

/** Compact file picker — clickable label that opens the OS picker, shows
 *  the chosen filename, lets the user clear. Mirrors the look of the
 *  Studio "Reference image" inputs without dragging in the full Dropzone
 *  component (which expects a parent grid we don't have here). */
function FileSlot({
  icon: Icon, label, accept, file, onPick,
}: {
  icon: React.ElementType;
  label: string;
  accept: string;
  file: File | null;
  onPick: (f: File | null) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3 text-center">
      <Icon className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
      <p className="text-[11px] font-medium text-foreground mb-1.5">{label}</p>
      {file ? (
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground truncate" title={file.name}>
            {file.name}
          </p>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="text-[10px] text-muted-foreground hover:text-foreground underline"
          >
            Clear
          </button>
        </div>
      ) : (
        <label className="block">
          <span className="text-[11px] text-brand hover:text-brand/80 cursor-pointer">Choose…</span>
          <input
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
    </div>
  );
}
