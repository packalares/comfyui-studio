// VideoBuilder — Studio's Easy-mode UI for video generation.
//
// Renders inside the Studio left pane when the top-level tab strip is on
// "Video". Owns prompt/resolution/duration form state, exposes its submit
// + reset + validation to Studio via the `registerAction` prop so the
// single shared bottom Generate / Reset buttons drive it (no duplicate
// CTA in the form body).
//
// Heavy lifting lives server-side: workflow muting, switch-widget update
// and dependency check go through the existing `/api/generate` and
// `/api/check-deps` endpoints. Prompt enhancement uses `/api/llm/generate`
// with the template's `promptEnhancer.systemPrompt`.

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import {
  Wand2, Image as ImageIcon, Music, Film,
  AlertTriangle, CheckCircle2, X as XIcon, ArrowRight,
  Clock, Eraser, Gauge, Info,
  Play as PlayIcon, Pause as PauseIcon,
} from 'lucide-react';
import { Popover, PopoverContent, PopoverAnchor } from '../components/ui/popover';
import {
  ChipSelect, FORMAT_OPTIONS, dimsFor, viewUrlFor, blobToBase64,
  inferMode, nearestModeHints, AddMediaPill, RefSlot,
  TogglesRow, resolveToggles, runEnhancePrompt,
  type EasyBuilderAction, type BuilderTemplateBundle,
} from './builder.shared';

// Re-export so existing `import { type EasyBuilderAction } from './VideoBuilder'`
// callers (Studio.tsx) keep working without an extra refactor.
export type { EasyBuilderAction };
import { useApp } from '../context/AppContext';
import { api, ApiError } from '../services/comfyui';
import { Button } from '../components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import MediaLibraryModal from '../components/modals/MediaLibraryModal';
import type { MediaLibraryItem } from '../services/comfyui';
import { Input } from '../components/ui/input';
import { Textarea } from '../components/ui/textarea';
import { Spinner } from '../components/ui/spinner';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import { Slider } from '../components/ui/slider';
import type { TemplateSummary } from '../types';

/** Duration presets — value is the duration in seconds; label is a friendly
 *  sense-of-length name shown to the right of the value in the dropdown. */
const DURATION_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 3,  label: 'Quick' },
  { value: 6,  label: 'Short' },
  { value: 10, label: 'Medium' },
  { value: 15, label: 'Long' },
  { value: 20, label: 'Extended' },
];

/** Quality = the short-side resolution in pixels. Combined with the active
 *  format's ratio to compute the final width × height. */
const QUALITY_OPTIONS: Array<{ id: string; base: number; label: string }> = [
  { id: '540',  base: 540,  label: 'Draft' },
  { id: '720',  base: 720,  label: 'Standard' },
  { id: '1080', base: 1080, label: 'HD' },
];

interface Props {
  registerAction: (a: EasyBuilderAction | null) => void;
  onSwitchToAdvanced?: () => void;
}

const STORAGE_KEY = 'studio:video:lastForm';

interface PersistedForm {
  templateName: string;
  prompt: string;
  formatId: string;
  qualityId: string;
  duration: number;
  durationMode: 'preset' | 'custom';
  toggles: Record<string, boolean>;
}

function loadPersistedForm(): PersistedForm | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedForm) : null;
  } catch { return null; }
}

// Internal input keys → labels matching the UI slots / pill, so validation
// hints read like the form does. Passed to nearestModeHints from the shared
// module; unknown keys fall back to the raw key.
const INPUT_LABELS: Record<string, string> = {
  image: 'Start image',
  lastFrame: 'End image',
  audio: 'Audio',
};

export default function VideoBuilder({ registerAction, onSwitchToAdvanced }: Props) {
  const { templates, submitGeneration, connected, uploadMaxBytes } = useApp();

  // ---- Pool of video-builder templates ----
  // Strict: must declare `studioBuilder: "video"` in its metadata. The
  // earlier mediaType fallback let every catalog template with
  // `mediaType: "video"` (e.g. WAN i2v / FLF2V / starter examples) slip
  // into the dropdown — only templates the author intentionally wires for
  // the Easy-mode UI belong here.
  const builderTemplates = useMemo(
    () => templates.filter((t) => {
      const tx = t as TemplateSummary & { studioBuilder?: string };
      return tx.studioBuilder === 'video';
    }),
    [templates],
  );

  // ---- Selected template + bundle ----
  const persisted = useMemo(() => loadPersistedForm(), []);
  const [selectedName, setSelectedName] = useState<string>(() => {
    if (persisted?.templateName && builderTemplates.some((t) => t.name === persisted.templateName)) {
      return persisted.templateName;
    }
    return builderTemplates[0]?.name ?? '';
  });

  useEffect(() => {
    if (!selectedName && builderTemplates.length > 0) {
      setSelectedName(builderTemplates[0].name);
    }
  }, [selectedName, builderTemplates]);

  // Per-model dependency check.
  const [depCheck, setDepCheck] = useState<{ ready: boolean; missing: Array<{ kind?: string; name?: string; filename?: string }> } | null>(null);
  const [depLoading, setDepLoading] = useState(false);
  useEffect(() => {
    if (!selectedName) { setDepCheck(null); return; }
    let cancelled = false;
    setDepLoading(true);
    setDepCheck(null);
    api.checkDependencies(selectedName)
      .then((res) => { if (!cancelled) setDepCheck(res); })
      .catch(() => { if (!cancelled) setDepCheck({ ready: true, missing: [] }); })
      .finally(() => { if (!cancelled) setDepLoading(false); });
    return () => { cancelled = true; };
  }, [selectedName]);

  const [bundle, setBundle] = useState<BuilderTemplateBundle | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  useEffect(() => {
    if (!selectedName) { setBundle(null); return; }
    let cancelled = false;
    setBundleLoading(true);
    api.getTemplateBundle(selectedName)
      .then((res) => {
        if (cancelled) return;
        const meta = res.builderMeta;
        setBundle(meta ? {
          name: selectedName,
          title: meta.title,
          studioModes: meta.studioModes,
          promptEnhancer: meta.promptEnhancer,
          prompt_toggles: meta.prompt_toggles,
        } : null);
      })
      .catch(() => { if (!cancelled) setBundle(null); })
      .finally(() => { if (!cancelled) setBundleLoading(false); });
    return () => { cancelled = true; };
  }, [selectedName]);

  // ---- Form state ----
  const [prompt, setPrompt] = useState<string>(persisted?.prompt ?? '');
  const [formatId, setFormatId] = useState<string>(persisted?.formatId ?? '16:9');
  const [qualityId, setQualityId] = useState<string>(persisted?.qualityId ?? '720');
  const [duration, setDuration] = useState<number>(persisted?.duration ?? 6);
  const [durationMode, setDurationMode] = useState<'preset' | 'custom'>(persisted?.durationMode ?? 'preset');
  const [audioStart, setAudioStart] = useState<number>(0);
  // Toggle for the workflow's built-in LLM prompt enhancer (PrimitiveBoolean
  // wired into the Inputs subgraph's switch). Distinct from the one-shot
  // wand button which rewrites the textarea via /api/llm/generate.
  const [toggles, setToggles] = useState<Record<string, boolean>>(persisted?.toggles ?? {});

  // Media inputs are now references to pre-uploaded library items, not raw
  // File handles. Selection happens in MediaLibraryModal; submit just passes
  // the `<subfolder>/<filename>` ref through — no per-submit upload step.
  const [imageRef, setImageRef] = useState<MediaLibraryItem | null>(null);
  const [audioRef, setAudioRef] = useState<MediaLibraryItem | null>(null);
  const [lastFrameRef, setLastFrameRef] = useState<MediaLibraryItem | null>(null);
  const [pickerKind, setPickerKind] = useState<'image' | 'audio' | 'video' | null>(null);
  const [pickerOnSelect, setPickerOnSelect] = useState<((item: MediaLibraryItem) => void) | null>(null);

  const [enhancing, setEnhancing] = useState(false);
  const [generating, setGenerating] = useState(false);

  // ---- Mode inference ----
  const filledInputs = useMemo(() => {
    const s = new Set<string>();
    if (imageRef) s.add('image');
    if (audioRef) s.add('audio');
    if (lastFrameRef) s.add('lastFrame');
    return s;
  }, [imageRef, audioRef, lastFrameRef]);

  // Open the library modal for a given kind, with a callback that stores the
  // pick into the right slot's state.
  const openPicker = useCallback((kind: 'image' | 'audio' | 'video', setter: (item: MediaLibraryItem | null) => void) => {
    setPickerKind(kind);
    setPickerOnSelect(() => (item: MediaLibraryItem) => setter(item));
  }, []);
  const closePicker = useCallback(() => {
    setPickerKind(null);
    setPickerOnSelect(null);
  }, []);

  const inferredMode = useMemo(
    () => inferMode(filledInputs, bundle?.studioModes),
    [filledInputs, bundle?.studioModes],
  );

  const quality = useMemo(
    () => QUALITY_OPTIONS.find((q) => q.id === qualityId) ?? QUALITY_OPTIONS[1],
    [qualityId],
  );
  const resolution = useMemo(
    () => dimsFor(formatId, quality.base),
    [formatId, quality.base],
  );

  // ---- Client-side validation ----
  const validationError = useMemo<string | null>(() => {
    if (!selectedName) return 'Pick a model';
    if (depCheck && !depCheck.ready && depCheck.missing.length > 0) {
      return `Model is missing ${depCheck.missing.length} dependency/dependencies — install them first`;
    }
    if (!bundle) return null; // still loading metadata; let the button spin
    // Empty prompt does NOT raise a visible error — the textarea placeholder
    // is the cue. It's enforced silently via the disabled state below.
    if (!inferredMode) {
      const hints = nearestModeHints(filledInputs, bundle.studioModes, INPUT_LABELS);
      return hints.length
        ? `Your inputs don't match any mode. ${hints.join(' · ')}`
        : 'Template has no studioModes declared';
    }
    if (duration <= 0 || duration > 60) return 'Duration must be between 1 and 60 seconds';
    if (resolution.width <= 0 || resolution.height <= 0) return 'Invalid resolution';
    return null;
  }, [selectedName, bundle, depCheck, prompt, inferredMode, duration, resolution]);

  // ---- Prompt enhance via /api/llm/chat ----
  //
  // Switched from /api/llm/generate to /api/llm/chat because chat is the
  // endpoint that carries `images[]` on user messages — generate is
  // text-only. Per-mode we attach whichever frames the active flow uses
  // (first frame for i2v/ia2v, first+last for flf2v, none for t2v). Audio
  // is intentionally NOT sent — Ollama's chat API has no audio field yet
  // and our template's audio influences the diffusion pass directly, not
  // the LLM. If the user picks a non-vision model and attaches images,
  // newer Ollama returns a "model does not support image input" error
  // that surfaces as the toast below.
  const handleEnhance = useCallback(async () => {
    if (!prompt.trim()) return; // button is disabled in this state; no toast
    if (!bundle?.promptEnhancer?.systemPrompt) {
      toast.error('This model has no prompt enhancer configured');
      return;
    }
    setEnhancing(true);
    try {
      // Pick images based on the active mode. ia2v/i2v send the first frame;
      // flf2v additionally sends the last frame so the LLM sees both
      // endpoints. t2v sends nothing — Ollama happily processes the text-only
      // chat against the same model.
      const imageItems: MediaLibraryItem[] = [];
      if (inferredMode === 'i2v' || inferredMode === 'ia2v' || inferredMode === 'flf2v') {
        if (imageRef) imageItems.push(imageRef);
      }
      if (inferredMode === 'flf2v' && lastFrameRef) imageItems.push(lastFrameRef);
      const images: string[] = await Promise.all(
        imageItems.map(async (it) => {
          const r = await fetch(viewUrlFor(it), { credentials: 'include' });
          if (!r.ok) throw new Error(`Failed to fetch ${it.filename} (${r.status})`);
          const blob = await r.blob();
          return await blobToBase64(blob);
        }),
      );

      const result = await runEnhancePrompt({ prompt: prompt.trim(), images, bundle });
      if (result.prompt) { setPrompt(result.prompt); toast.success('Prompt enhanced'); }
      else if (result.sawThinking) {
        toast.warning('Model never finalized — try a higher num_predict or disable thinking on the template');
      } else { toast.warning('LLM returned an empty response'); }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Enhance failed';
      toast.error('Prompt enhance failed', { description: msg });
    } finally {
      setEnhancing(false);
    }
  }, [prompt, bundle, inferredMode, imageRef, lastFrameRef]);


  // ---- Submit ----
  const handleGenerate = useCallback(async () => {
    if (validationError || !inferredMode) {
      toast.error(validationError ?? 'Cannot submit');
      return;
    }
    setGenerating(true);
    try {
      const inputs: Record<string, unknown> = {
        text: prompt.trim(),
        width: resolution.width,
        height: resolution.height,
        duration,
        // Seed is always random per-submit — no UI exposure. Users who
        // need a fixed seed can drive the template through Advanced.
        seed: Math.floor(Math.random() * 1_000_000),
      };
      // Dynamic toggles declared by the template's `prompt_toggles`. Each
      // key is sent verbatim — the server routes via studioInputMap or the
      // title-search fallback (case-insensitive switch title match).
      for (const [k, v] of Object.entries(toggles)) inputs[k] = v;
      // Media refs are already on disk in ComfyUI's input/ — no upload step.
      // Just pass the `<subfolder>/<filename>` ref through; ComfyUI's
      // LoadImage / LoadAudio nodes resolve it against the recursive scan.
      if (imageRef) inputs.image = imageRef.ref;
      if (audioRef) inputs.audio = audioRef.ref;
      if (inferredMode === 'ia2v') inputs.audioStart = audioStart;
      if (lastFrameRef) inputs.lastFrame = lastFrameRef.ref;

      try {
        const blob: PersistedForm = {
          templateName: selectedName, prompt, formatId, qualityId, duration, durationMode, toggles,
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
    validationError, inferredMode, prompt, resolution, duration,
    imageRef, audioRef, lastFrameRef, selectedName,
    submitGeneration, formatId, qualityId, toggles, audioStart,
  ]);

  // Debounced persist of the editable form blob. Covers Clear-prompt,
  // manual prompt edits, Enhance overwrites, format/quality/duration changes
  // — anything that mutates a persisted field is captured here, not only on
  // submit. 300ms debounce avoids hammering localStorage on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        const blob: PersistedForm = {
          templateName: selectedName, prompt, formatId, qualityId,
          duration, durationMode, toggles,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      } catch { /* ignore */ }
    }, 300);
    return () => clearTimeout(t);
  }, [selectedName, prompt, formatId, qualityId, duration, durationMode, toggles]);

  // ---- Reset: clear the form to first-run defaults ----
  const handleReset = useCallback(() => {
    setPrompt('');
    setFormatId('16:9');
    setQualityId('720');
    setDuration(6);
    setToggles({});
    setImageRef(null);
    setAudioRef(null);
    setLastFrameRef(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  // ---- Publish to Studio so the shared bottom Reset/Generate drive us ----
  useEffect(() => {
    registerAction({
      onSubmit: handleGenerate,
      onReset: handleReset,
      // Empty-prompt gating is silent (no validation message) — the
      // disabled button is the only signal.
      disabled: !!validationError || !prompt.trim() || generating || !connected,
      label: generating ? 'Submitting…' : 'Generate',
    });
    return () => registerAction(null);
  }, [registerAction, handleGenerate, handleReset, validationError, prompt, generating, connected]);

  // ---- Empty state ----
  if (builderTemplates.length === 0) {
    return (
      <div className="min-h-[55vh] flex items-center justify-center">
        <div className="flex flex-col items-center text-center rounded-xl border border-dashed border-border/70 bg-card/40 px-6 py-10 max-w-sm">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Film className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-semibold text-foreground mb-1">
            Video easy mode isn't ready
          </p>
          <p className="text-xs text-muted-foreground max-w-xs mb-4">
            No curated video workflow is set up yet. You can still drive any compatible template from the Advanced tab.
          </p>
          {onSwitchToAdvanced && (
            <Button variant="outline" size="sm" onClick={onSwitchToAdvanced}>
              Switch to Advanced
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* MODEL */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="field-label">Model</label>
          {/* Inline dependency status — sits to the right of the label,
              above the select. Detailed missing list still expands below. */}
          {depLoading && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Spinner size="xs" /> Checking…
            </span>
          )}
          {!depLoading && depCheck?.ready && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-success">
              <CheckCircle2 className="w-3.5 h-3.5" /> Model ready
            </span>
          )}
          {!depLoading && depCheck && !depCheck.ready && depCheck.missing.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-warning">
              <AlertTriangle className="w-3.5 h-3.5" />
              Not ready · {depCheck.missing.length} missing
            </span>
          )}
        </div>
        <SelectField value={selectedName} onValueChange={setSelectedName}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {builderTemplates.map((t) => (
              <SelectItem key={t.name} value={t.name}>
                {t.title || t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectField>
        {bundleLoading && (
          <p className="field-helper mt-1.5 flex items-center gap-1">
            <Spinner size="xs" /> Loading model metadata…
          </p>
        )}

        {/* Detailed missing-dependency list — only renders when something is
            actually missing. The inline badge above is the compact summary. */}
        {!depLoading && depCheck && !depCheck.ready && depCheck.missing.length > 0 && (
          <div className="info-box mt-2 border border-warning/40 bg-warning/10 ring-0">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0 mt-px" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-warning">
                  Missing {depCheck.missing.length}{' '}
                  {depCheck.missing.length === 1 ? 'dependency' : 'dependencies'} for this model
                </p>
                <ul className="mt-1 space-y-0.5">
                  {depCheck.missing.slice(0, 6).map((m, i) => (
                    <li key={i} className="truncate">
                      <span className="opacity-70">{m.kind ?? '?'}:</span>{' '}
                      <code className="font-mono">{m.filename ?? m.name ?? '(unnamed)'}</code>
                    </li>
                  ))}
                  {depCheck.missing.length > 6 && (
                    <li className="opacity-70">+ {depCheck.missing.length - 6} more</li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* REFERENCES — labeled image slots + an "Add media" pill for the
          rest. Clicking any slot opens the MediaLibraryModal scoped to the
          slot's kind. Files are already on disk in ComfyUI's input/ — we
          just store the picked ref and pass it through at submit time. */}
      <div>
        <p className="eyebrow mb-2">References</p>
        <div className="grid grid-cols-2 gap-2.5">
          <RefSlot icon={ImageIcon} label="Start image"
                   item={imageRef}
                   onOpen={() => openPicker('image', setImageRef)}
                   onClear={() => setImageRef(null)} />
          <RefSlot icon={ImageIcon} label="End image"
                   item={lastFrameRef}
                   onOpen={() => openPicker('image', setLastFrameRef)}
                   onClear={() => setLastFrameRef(null)} />
        </div>
        <AddMediaPill slots={[
          { kind: 'image',     disabled: true, tooltip: 'Image (coming soon)' },
          { kind: 'video',     disabled: true, tooltip: 'Video (coming soon)' },
          { kind: 'audio',     active: !!audioRef,
            tooltip: audioRef ? `Replace audio (${audioRef.filename})` : 'Add audio',
            onClick: () => openPicker('audio', setAudioRef) },
          { kind: 'character', disabled: true, tooltip: 'Character (coming soon)' },
          { kind: 'effect',    disabled: true, tooltip: 'Effect (coming soon)' },
        ]} />
        {audioRef && (
          <div className="mt-2.5">
            <AudioThumbWithSliderChip
              item={audioRef}
              tag="@aud1"
              value={audioStart}
              onChange={setAudioStart}
              onRemove={() => setAudioRef(null)}
            />
          </div>
        )}
      </div>

      {/* PROMPT — textarea in a card, with inline Enhance + Clear icon
          buttons in the footer (no big external button). While enhancing,
          the textarea + footer are blurred and a centered spinner overlays
          the whole card. */}
      <div>
        <p className="eyebrow mb-2">Prompt</p>
        <div className="relative rounded-xl border bg-card">
          <div className={enhancing ? 'pointer-events-none blur-[1px] opacity-60 transition' : 'transition'}>
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want the video to show…"
              rows={4}
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 resize-none max-h-72 overflow-y-auto"
              readOnly={enhancing}
            />
            <div className="flex justify-end gap-1 px-2 pb-2">
              {bundle?.promptEnhancer && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleEnhance}
                      disabled={enhancing || !prompt.trim()}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    >
                      <Wand2 className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Enhance with AI ({bundle.promptEnhancer.preferredModel ?? 'Ollama'})
                  </TooltipContent>
                </Tooltip>
              )}
            <TogglesRow
              toggles={resolveToggles(bundle?.prompt_toggles, inferredMode)}
              values={toggles}
              onChange={setToggles}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setPrompt('')}
                  disabled={!prompt}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                >
                  <Eraser className="w-3.5 h-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Clear prompt</TooltipContent>
            </Tooltip>
          </div>
          </div>
          {enhancing && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Spinner size="lg" className="text-brand" />
            </div>
          )}
        </div>
      </div>

      {/* DURATION · FORMAT · RESOLUTION chip row.
          - Custom duration replaces the duration chip with an inline slider
            chip that takes the leftover space (`flex-1`); Format stays tight,
            Resolution stays tight and is pushed to the right (`ml-auto`).
          - The pixel dimensions (`1280×720`) are folded into the Resolution
            chip's value rather than living as a separate trailing label —
            keeps the row aligned and the dimensions visible at a glance. */}
      <div className="flex items-center gap-2 flex-nowrap min-w-0">
        {durationMode === 'preset' ? (
          <ChipSelect
            icon={Clock}
            value={`${duration}s`}
            options={[
              ...DURATION_OPTIONS.map((d) => ({ id: String(d.value), left: `${d.value}s`, right: d.label })),
              { id: '__custom__', left: 'Custom…', right: '' },
            ]}
            selectedId={String(duration)}
            onChange={(id) => {
              if (id === '__custom__') { setDurationMode('custom'); }
              else { setDuration(Number(id)); }
            }}
          />
        ) : (
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 h-8 flex-1 min-w-0">
            <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Slider
              min={1}
              max={60}
              step={1}
              value={[duration]}
              onValueChange={([v]) => setDuration(v)}
              className="flex-1 h-1"
            />
            <span className="text-xs tabular-nums font-medium text-foreground w-8 text-right shrink-0">{duration}s</span>
            <button
              type="button"
              onClick={() => setDurationMode('preset')}
              className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 whitespace-nowrap shrink-0"
            >
              Presets
            </button>
          </div>
        )}
        <ChipSelect
          icon={(FORMAT_OPTIONS.find((f) => f.id === formatId) ?? FORMAT_OPTIONS[1]).Icon}
          value={formatId}
          options={FORMAT_OPTIONS.map((f) => ({ id: f.id, left: f.id, right: f.label, Icon: f.Icon }))}
          selectedId={formatId}
          onChange={setFormatId}
        />
        <div className="ml-auto shrink-0">
          <ChipSelect
            icon={Gauge}
            value={durationMode === 'custom'
              ? quality.label
              : `${quality.label} · ${resolution.width}×${resolution.height}`}
            options={QUALITY_OPTIONS.map((q) => ({ id: q.id, left: `${q.base}p`, right: q.label }))}
            selectedId={qualityId}
            onChange={setQualityId}
            trailing={durationMode === 'custom' ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground cursor-help"
                    aria-label="Show resolution"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {resolution.width} × {resolution.height}
                </TooltipContent>
              </Tooltip>
            ) : undefined}
          />
        </div>
      </div>

      {/* Validation hint — only renders on error. Success state stays
          silent; the active mode is implicit in the inputs the user filled. */}
      {(!inferredMode || validationError) && (
        <div className="info-box flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
          <span>{validationError ?? 'Add inputs to pick a mode'}</span>
        </div>
      )}

      {/* Library picker — same modal serves all three media slots; the
          `kind` + `onSelect` are swapped when openPicker is called. */}
      {pickerKind && pickerOnSelect && (
        <MediaLibraryModal
          open
          kind={pickerKind}
          onClose={closePicker}
          onSelect={(item) => { pickerOnSelect(item); closePicker(); }}
        />
      )}
    </div>
  );
}

// Small picked-media thumbnail with an @tag overlay. Images show the preview
// from /api/view; audio/video fall back to a kind icon. Audio items get an
// inline play/pause button overlay.
function MediaThumb({
  item, tag, onRemove,
}: {
  item: MediaLibraryItem;
  tag: string;
  onRemove: () => void;
}) {
  const Icon = item.kind === 'audio' ? Music : item.kind === 'video' ? Film : ImageIcon;
  const isImage = item.kind === 'image';
  const [thumbPlaying, setThumbPlaying] = useState(false);
  const thumbAudioRef = useRef<HTMLAudioElement>(null);
  return (
    <div className="group relative h-20 w-20 overflow-hidden rounded-xl border bg-card shadow-sm">
      {isImage ? (
        <img src={viewUrlFor(item)} alt={item.filename} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground">
          <Icon className="h-6 w-6" />
        </div>
      )}
      {item.kind === 'audio' && (
        <>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              const el = thumbAudioRef.current;
              if (!el) return;
              if (el.paused) void el.play(); else el.pause();
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const el = thumbAudioRef.current; if (!el) return; if (el.paused) void el.play(); else el.pause(); } }}
            className="absolute inset-0 z-10 flex items-center justify-center cursor-pointer"
            aria-label={thumbPlaying ? 'Pause' : 'Play'}
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border hover:scale-105 transition-transform">
              {thumbPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5 translate-x-[1px]" />}
            </span>
          </span>
          <audio
            ref={thumbAudioRef}
            src={viewUrlFor(item)}
            preload="none"
            onPlay={() => setThumbPlaying(true)}
            onPause={() => setThumbPlaying(false)}
            onEnded={() => setThumbPlaying(false)}
            className="hidden"
          />
        </>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow ring-1 ring-border opacity-0 transition-opacity group-hover:opacity-100 z-20"
        aria-label={`Remove ${item.filename}`}
      >
        <XIcon className="h-3 w-3" />
      </button>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/70 to-transparent px-1.5 py-0.5">
        <p className="truncate text-[10px] font-medium text-background">{tag}</p>
      </div>
    </div>
  );
}

// AudioThumbWithSliderChip — the audio chip with its play button wired
// to open an A-style floating Popover (anchored bottom-start) containing
// just a slider. Pause closes the popover. The slider both updates the
// parent `value` AND seeks the audio. Probes audio duration internally
// via `<audio preload="metadata">` (falls back to 600s until ready).
function AudioThumbWithSliderChip({
  item, tag, value, onChange, onRemove,
}: {
  item: MediaLibraryItem;
  tag: string;
  value: number;
  onChange: (v: number) => void;
  onRemove: () => void;
}) {
  const audioElRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const max = duration ?? 600;

  // Clamp + round to 1-decimal granularity (LTX wants float; user gets
  // sub-second precision for matching beats or syllables).
  const setStart = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(max, Math.round(next * 10) / 10));
    onChange(clamped);
    const el = audioElRef.current;
    if (el) { try { el.currentTime = clamped; } catch { /* ignore */ } }
  }, [max, onChange]);

  const togglePlay = useCallback(() => {
    const el = audioElRef.current;
    if (!el) return;
    if (el.paused) {
      try { el.currentTime = value; } catch { /* ignore */ }
      if (activeAudioEl && activeAudioEl !== el) activeAudioEl.pause();
      activeAudioEl = el;
      void el.play();
    } else {
      el.pause();
    }
  }, [value]);

  useEffect(() => () => {
    const el = audioElRef.current;
    if (el && activeAudioEl === el) { el.pause(); activeAudioEl = null; }
  }, []);

  return (
    <Popover
      open={playing}
      onOpenChange={(open) => {
        if (!open) {
          const el = audioElRef.current;
          if (el && !el.paused) el.pause();
        }
      }}
    >
      <PopoverAnchor asChild>
        <div className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-xl border bg-card shadow-sm inline-block">
          <div className="flex h-full w-full items-center justify-center bg-muted/40 text-muted-foreground">
            <Music className="h-6 w-6" />
          </div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePlay(); } }}
            className="absolute inset-0 z-10 flex items-center justify-center cursor-pointer"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm ring-1 ring-border hover:scale-105 transition-transform">
              {playing ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5 translate-x-[1px]" />}
            </span>
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background/80 text-foreground shadow ring-1 ring-border opacity-0 transition-opacity group-hover:opacity-100 z-20"
            aria-label={`Remove ${item.filename}`}
          >
            <XIcon className="h-3 w-3" />
          </button>
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-foreground/70 to-transparent px-1.5 py-0.5">
            <p className="truncate text-[10px] font-medium text-background">{tag}</p>
          </div>
          <audio
            ref={audioElRef}
            src={viewUrlFor(item)}
            preload="metadata"
            className="hidden"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={(e) => {
              const d = (e.currentTarget as HTMLAudioElement).duration;
              if (Number.isFinite(d) && d > 0) {
                setDuration(d);
                if (value > d) onChange(0);
              }
            }}
          />
        </div>
      </PopoverAnchor>
      {/* Floating popover, exactly like Design A's — default bottom-start.
          Body is slider-only (no numeric input). */}
      <PopoverContent className="w-64 p-3" align="start">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Start offset</span>
          <span className="text-xs font-mono tabular-nums">{value.toFixed(1)}s / {max.toFixed(1)}s</span>
        </div>
        <Slider
          min={0} max={max} step={0.1}
          value={[value]}
          onValueChange={([v]) => setStart(v)}
          className="h-1"
        />
      </PopoverContent>
    </Popover>
  );
}

// Module-level singleton: only one audio element plays at a time across
// every AudioThumbWithSliderChip instance on the page.
let activeAudioEl: HTMLAudioElement | null = null;

