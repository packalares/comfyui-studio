// ImageBuilder — Studio's Easy-mode UI for image generation.
//
// Mirrors VideoBuilder's chrome (model select, dependency check, prompt card
// with Enhance/AutoEnhance/Clear, format + resolution chip row, registerAction
// for the shared bottom Generate button, persisted form blob) and adds the
// two image-specific bits:
//
//   - Multi-reference grid (1-8 image refs picked from MediaLibraryModal).
//     The first slot is a Character placeholder; the rest open the picker.
//   - Camera detail chip → 4-column CameraSettingsModal (data lives in
//     `data/cameraOptions.json` so the options grow without touching code).
//
// Duration / audio / last-frame are removed (image-only). Resolution options
// reflect the practical image targets (1 MP / 2 MP / 4 MP). Aspect ratio
// (FORMAT_OPTIONS) and ChipSelect / dimsFor / viewUrlFor are reused from
// VideoBuilder so the visual style and helper logic stay byte-identical.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Wand2, Eraser, Gauge, AlertTriangle, CheckCircle2,
  ArrowRight, Image as ImageIcon, Camera as CameraIcon, Sparkles, Info,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../services/comfyui';
import type { MediaLibraryItem } from '../services/comfyui';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import MediaLibraryModal from '../components/modals/MediaLibraryModal';
import { PromptComposer, type PromptComposerMention } from '../components/forms/PromptComposer';
import { resolvePromptTemplate } from '../lib/promptTemplate';
import { usePromptRegistry } from '../hooks/usePromptRegistry';
import CameraSettingsModal, {
  resolveCameraLabels,
  type CameraSelection,
} from '../components/modals/CameraSettingsModal';
import {
  ChipSelect, FORMAT_OPTIONS, visibleFormatsForMode, viewUrlFor, blobToBase64,
  AddMediaPill, RefSlot,
  TogglesRow, resolveToggles, runEnhancePrompt, buildImageEnhancerInput,
  groupModesByTaskType, pickResolution,
  useBuilderTemplates, useTemplateSelection, useTemplateBundle,
  useDependencyCheck, useDebouncedPersist, usePresetApply,
  type QualityTier,
  type EasyBuilderAction, type BuilderTemplateBundle,
} from './builder.shared';

/** Quality tiers. Concrete pixel dimensions come from the active mode's
 *  `image_format` (or `image_format_faster` when the Faster toggle is on)
 *  via `pickResolution`. The chip is purely an SD/HD selector. */
const QUALITY_OPTIONS: Array<{ id: QualityTier; label: string }> = [
  { id: 'standard', label: 'SD' },
  { id: 'hd',       label: 'HD' },
];

const MAX_REFS = 8;

interface Props {
  registerAction: (action: EasyBuilderAction | null) => void;
  onSwitchToAdvanced?: () => void;
  /** Bubbles the active builder template up to Studio so the shared right
   *  panel (preset grid, Result header) can react to the same selection
   *  without duplicating the picker logic here. Fires with '' when the
   *  builder has nothing selected. Optional — passing-through hosts that
   *  don't need it can omit. */
  onTemplateChange?: (templateName: string) => void;
  /** Latest preset the user clicked in the right-panel grid (Studio holds
   *  the state; we apply it to our form fields when it changes). Null means
   *  no preset has been applied yet. Identity (object reference) drives the
   *  apply effect, so re-clicking the same preset re-applies cleanly. */
  presetApply?: {
    id: string;
    parent: string;
    settings: Record<string, unknown>;
    card: { id: string; title: string } | null;
  } | null;
}

const STORAGE_KEY = 'studio:image:lastForm';

interface PersistedForm {
  templateName: string;
  prompt: string;
  formatId: string;
  qualityId: QualityTier;
  selectedMode: string | null;
  toggles: Record<string, boolean>;
  camera: CameraSelection;
  /** Snapshot of the references panel. Each entry is a serialised
   *  `MediaLibraryItem` — refs survive a reload because the items still
   *  live on disk (the modal serves them by `ref`); we just remember which
   *  were attached. */
  references: MediaLibraryItem[];
}

/** Migrate older PersistedForm shapes (qualityId was `'1024' | '1440' |
 *  '2048'`, selectedMode didn't exist). Old draft → Standard/HD: short
 *  side 2048 maps to HD, anything smaller to Standard. */
function migratePersistedForm(raw: unknown): PersistedForm | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const legacyQ = typeof r.qualityId === 'string' ? r.qualityId : '1024';
  const qualityId: QualityTier =
    legacyQ === 'hd' || legacyQ === '2048' ? 'hd' : 'standard';
  const refs = Array.isArray(r.references)
    ? (r.references as unknown[]).filter((x): x is MediaLibraryItem => {
        return !!x && typeof x === 'object' && typeof (x as MediaLibraryItem).ref === 'string';
      })
    : [];
  return {
    templateName: typeof r.templateName === 'string' ? r.templateName : '',
    prompt: typeof r.prompt === 'string' ? r.prompt : '',
    formatId: typeof r.formatId === 'string' ? r.formatId : '1:1',
    qualityId,
    selectedMode: typeof r.selectedMode === 'string' ? r.selectedMode : null,
    toggles: (r.toggles && typeof r.toggles === 'object') ? r.toggles as Record<string, boolean> : {},
    camera: (r.camera && typeof r.camera === 'object') ? r.camera as CameraSelection : EMPTY_CAMERA,
    references: refs,
  };
}

const EMPTY_CAMERA: CameraSelection = {
  cameraId: null,
  lensId: null,
  focalLengthId: null,
  apertureId: null,
};

function loadPersistedForm(): PersistedForm | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migratePersistedForm(JSON.parse(raw));
  } catch { return null; }
}

export default function ImageBuilder({ registerAction, onSwitchToAdvanced, onTemplateChange, presetApply }: Props) {
  const { templates, submitGeneration, connected } = useApp();

  const builderTemplates = useBuilderTemplates(templates, 'image');
  const persisted = useMemo(() => loadPersistedForm(), []);
  const [selectedName, setSelectedName] = useTemplateSelection(builderTemplates, persisted?.templateName);
  // Mirror the active template up to Studio so the shared right-panel can
  // fetch the bundle and render preset cards / output result against the
  // same selection without each tab maintaining its own picker state.
  useEffect(() => { onTemplateChange?.(selectedName); }, [selectedName, onTemplateChange]);

  const { check: depCheck, loading: depLoading } = useDependencyCheck(selectedName);
  const { bundle, loading: bundleLoading } = useTemplateBundle(selectedName);

  // ---- Form state ----
  const [prompt, setPrompt] = useState<string>(persisted?.prompt ?? '');
  // Negative prompt — populated by the enhancer's structured response on
  // real-CFG modes, and forwarded as `inputs.negative_prompt` at submit
  // time. Not persisted (lifetime = current Enhance result), and not
  // user-editable in the UI yet — a future textarea can wire to this.
  const [negativePrompt, setNegativePrompt] = useState<string>('');
  const [formatId, setFormatId] = useState<string>(persisted?.formatId ?? '1:1');
  const [qualityId, setQualityId] = useState<QualityTier>(persisted?.qualityId ?? 'standard');
  const [selectedMode, setSelectedMode] = useState<string | null>(persisted?.selectedMode ?? null);
  const [toggles, setToggles] = useState<Record<string, boolean>>(persisted?.toggles ?? {});
  const [camera, setCamera] = useState<CameraSelection>(persisted?.camera ?? EMPTY_CAMERA);
  /** Locked by `allow_user_select_aspect_ratio: false` in the active preset.
   *  Resets on every preset apply so a later one that omits the field
   *  releases the lock. */
  const [aspectLocked, setAspectLocked] = useState(false);

  usePresetApply(presetApply, { setPrompt, setFormatId, setSelectedMode, setAspectLocked });

  // Multi-reference: an ordered list (max MAX_REFS). MediaLibraryModal feeds
  // one pick at a time; dedupe by filename to make double-picks a no-op.
  const [references, setReferences] = useState<MediaLibraryItem[]>(() => persisted?.references ?? []);

  const [pickerOpen, setPickerOpen] = useState(false);
  // 'main' = picked item replaces references[0]; 'append' = picked is pushed
  // to the end. Set when opening the picker, consumed by handleAddReference.
  const [pickerTarget, setPickerTarget] = useState<'main' | 'append'>('append');
  const [cameraOpen, setCameraOpen] = useState(false);

  // @-mention picker: only image-reference mentions for now. Mode triggers
  // were removed from the picker — keep the dropdown focused on what the
  // user can immediately act on with the attached media.
  const mentionables = useMemo<PromptComposerMention[]>(() => {
    return references.map((_r, i) => ({
      key: `@reference${i + 1}`,
      label: 'reference image',
      category: 'reference' as const,
    }));
  }, [references]);
  const promptRegistry = usePromptRegistry();
  const knownMentionKeys = useMemo(
    () => mentionables.map((m) => m.key),
    [mentionables],
  );

  const [enhancing, setEnhancing] = useState(false);
  const [generating, setGenerating] = useState(false);

  // ---- Mode + resolution ----
  // Image picks the active mode EXPLICITLY via the Model chip (not by
  // counting filled inputs the way VideoBuilder does), so we don't run
  // `inferMode` here. `availableModes` powers the Model chip row;
  // `pickResolution` reads the template's per-mode `image_format` table
  // (or `image_format_faster` when the Faster toggle is on AND the mode
  // declared one).
  const taskGroups = useMemo(
    () => groupModesByTaskType(bundle?.studioModes),
    [bundle?.studioModes],
  );
  // Task type is driven by whether the user has attached any reference
  // media: empty → `t2i`, otherwise → `i2i`. When the active template
  // doesn't declare the wanted type, fall back to whatever it has so the
  // chip row never blanks out (covers older t2i-only templates and the
  // momentary state during template-switch).
  const wantedTaskType = references.length > 0 ? 'i2i' : 't2i';
  const availableModes = useMemo(() => {
    const matched = taskGroups.find((g) => g.taskType === wantedTaskType);
    if (matched) return matched.modes;
    return taskGroups[0]?.modes ?? [];
  }, [taskGroups, wantedTaskType]);

  // Auto-pick the first mode whenever the bundle changes and the persisted
  // selection isn't valid for it. Idempotent: if `selectedMode` is already
  // in the list, leaves it alone.
  useEffect(() => {
    if (availableModes.length === 0) return;
    if (selectedMode && availableModes.some((m) => m.name === selectedMode)) return;
    setSelectedMode(availableModes[0].name);
  }, [availableModes, selectedMode]);

  // Aspect-ratio chip row — filtered down to what the active mode declares
  // in `studioModes[mode].image_format`. Falls back to the full catalog when
  // the bundle or mode is missing so the chip row never blanks out.
  const visibleFormats = useMemo(
    () => visibleFormatsForMode(bundle?.studioModes, selectedMode),
    [bundle?.studioModes, selectedMode],
  );
  // Snap formatId back into the supported set whenever the visible list
  // changes (mode switch, bundle landed). Keeps the chip row + preset apply
  // from leaving an invalid ratio selected that `pickResolution` would
  // silently coerce to 1:1.
  useEffect(() => {
    if (visibleFormats.length === 0) return;
    if (visibleFormats.some((f) => f.id === formatId)) return;
    setFormatId(visibleFormats.some((f) => f.id === '1:1') ? '1:1' : visibleFormats[0].id);
  }, [visibleFormats, formatId]);

  const resolution = useMemo(
    () => pickResolution({
      mode: selectedMode ?? '',
      formatId,
      qualityId,
      toggles,
      studioModes: bundle?.studioModes,
    }),
    [selectedMode, formatId, qualityId, toggles, bundle?.studioModes],
  );

  // ---- Client-side validation ----
  const validationError = useMemo<string | null>(() => {
    if (!selectedName) return 'Pick a template';
    if (depCheck && !depCheck.ready && depCheck.missing.length > 0) {
      return `Model is missing ${depCheck.missing.length} dependency/dependencies — install them first`;
    }
    if (!bundle) return null;
    if (availableModes.length === 0) return 'Template has no studioModes declared';
    if (!selectedMode) return 'Pick a model';
    if (resolution.width <= 0 || resolution.height <= 0) return 'Invalid resolution';
    return null;
  }, [selectedName, bundle, depCheck, availableModes, selectedMode, resolution]);

  // ---- Reference list helpers ----
  // references[0] is the "main image" surfaced in the big slot above the
  // Add-media pill. It's the i2i edit target when the active mode is edit-y.
  // 'main' target replaces slot 0; 'append' pushes to end.
  const handleAddReference = useCallback((item: MediaLibraryItem) => {
    setReferences(prev => {
      if (pickerTarget === 'main') {
        const rest = prev.slice(1).filter(r => r.filename !== item.filename);
        return [item, ...rest].slice(0, MAX_REFS);
      }
      if (prev.some(r => r.filename === item.filename)) return prev;
      if (prev.length >= MAX_REFS) return prev;
      return [...prev, item];
    });
    setPickerOpen(false);
  }, [pickerTarget]);

  const handleRemoveReference = useCallback((filename: string) => {
    setReferences(prev => prev.filter(r => r.filename !== filename));
  }, []);

  const handleClearMain = useCallback(() => {
    setReferences(prev => prev.slice(1));
  }, []);

  const openPickerFor = useCallback((target: 'main' | 'append') => {
    setPickerTarget(target);
    setPickerOpen(true);
  }, []);

  // ---- Camera summary ----
  // useMemo is REQUIRED here: resolveCameraLabels returns a fresh object
  // every call, so without memoization handleGenerate's deps array sees a
  // new reference each render → registerAction's useEffect re-fires every
  // render → setEasyAction triggers another Studio re-render → infinite
  // loop that pre-empts tab navigation.
  const cameraLabels = useMemo(() => resolveCameraLabels(camera), [camera]);
  const cameraSubtitle = useMemo(
    () => [cameraLabels.lens, cameraLabels.focalLength, cameraLabels.aperture]
      .filter(Boolean)
      .join(', '),
    [cameraLabels],
  );

  // ---- Prompt enhance via /api/llm/chat ----
  //
  // Same path VideoBuilder uses; the streaming + JSON-aware response
  // extraction lives in builder.shared.runEnhancePrompt. We just decide
  // here what to send as the LLM's image input — for the Image tab that's
  // ALL references[], since the model is free to use any of them.
  const handleEnhance = useCallback(async () => {
    if (!prompt.trim()) return;
    if (!bundle?.promptEnhancer?.systemPrompt) {
      toast.error('This model has no prompt enhancer configured');
      return;
    }
    setEnhancing(true);
    try {
      const images: string[] = await Promise.all(
        references.map(async (it) => {
          const r = await fetch(viewUrlFor(it), { credentials: 'include' });
          if (!r.ok) throw new Error(`Failed to fetch ${it.filename} (${r.status})`);
          const blob = await r.blob();
          return await blobToBase64(blob);
        }),
      );

      // Build the structured JSON payload from existing UI state — mode name
      // passed verbatim as target_model (the template's system prompt teaches
      // the LLM the `t2i_flux_dev` / `i2i_*` / etc. convention), formatId is
      // already a "W:H" string, camera labels come from the picker modal.
      // Resolve choice chips before handing to the LLM — otherwise the
      // enhancer sees raw `{[A]|B|C}` syntax as literal text and either
      // passes it through or, worse, gets confused into hallucinating
      // about the alternatives.
      const resolvedPrompt = resolvePromptTemplate(prompt, promptRegistry, knownMentionKeys);
      const enhancerInput = buildImageEnhancerInput({
        prompt: resolvedPrompt,
        inferredMode: selectedMode ?? '',
        formatId,
        referenceCount: references.length,
        cameraLabels,
      });
      const result = await runEnhancePrompt({ prompt: enhancerInput, images, bundle, mode: selectedMode });
      // Route the parsed fields into their slots. `prompt` always goes into
      // the textarea. `negativePrompt` is captured into a separate state
      // slot (no UI yet) so it flows into the submit's inputs.negative_prompt
      // on the next Generate. Distilled modes return "" per the system
      // prompt's policy, which clears any prior value cleanly.
      if (result.prompt) { setPrompt(result.prompt); toast.success('Prompt enhanced'); }
      else if (result.sawThinking) {
        toast.warning('Model never finalized — try higher num_predict or disable thinking on the template');
      } else {
        toast.error('Enhancer returned empty');
      }
      // Update the negative-prompt slot whenever the LLM produced an explicit
      // value (including "" for distilled models — we WANT to clear stale
      // negatives from prior runs). Leave it alone if the field was absent
      // (older templates without structured JSON output).
      if (result.negativePrompt !== undefined) setNegativePrompt(result.negativePrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Enhance failed', { description: msg });
    } finally {
      setEnhancing(false);
    }
  }, [prompt, bundle, references, selectedMode, formatId, cameraLabels]);

  // ---- Submit ----
  const handleGenerate = useCallback(async () => {
    if (validationError || !selectedMode) {
      toast.error(validationError ?? 'Cannot submit');
      return;
    }
    setGenerating(true);
    try {
      // Resolve any `{…|[opt]|…}` chips, `@name(pick)` registry chips, and
      // strip unknown `@xxx`. References + modes pass through verbatim for
      // the downstream engine. localStorage keeps the raw template so
      // chips round-trip on reload.
      const finalPrompt = resolvePromptTemplate(prompt, promptRegistry, knownMentionKeys).trim();
      const inputs: Record<string, unknown> = {
        text: finalPrompt,
        width: resolution.width,
        height: resolution.height,
        seed: Math.floor(Math.random() * 1_000_000),
      };
      // Negative prompt populated by the LLM enhancer on real-CFG modes.
      // Always send it (even empty) so the template's negative node clears
      // when the user runs a distilled mode after a CFG one. Template's
      // studioInputMap routes `negative_prompt` → the right primitive node.
      inputs.negative_prompt = negativePrompt;
      // Dynamic toggles declared by the template's `prompt_toggles`. Each
      // key is sent verbatim — the server routes via studioInputMap or the
      // title-search fallback.
      for (const [k, v] of Object.entries(toggles)) inputs[k] = v;
      // Multi-reference: pass an array of `<subfolder>/<filename>` refs.
      // The image workflow's studioInputMap.images is expected to fan these
      // into N LoadImage nodes inside the multi-ref subgraph.
      if (references.length > 0) {
        inputs.images = references.map(r => r.ref);
      }
      // Camera detail labels are sent as a flat record — the template's
      // studioInputMap is expected to route these to PrimitiveString nodes
      // (matches the same pattern as VideoBuilder's `audioStart` routing).
      if (cameraLabels.camera || cameraLabels.lens || cameraLabels.focalLength || cameraLabels.aperture) {
        inputs.camera = {
          camera:      cameraLabels.camera ?? '',
          lens:        cameraLabels.lens ?? '',
          focalLength: cameraLabels.focalLength ?? '',
          aperture:    cameraLabels.aperture ?? '',
        };
      }

      try {
        const blob: PersistedForm = {
          templateName: selectedName, prompt, formatId, qualityId, selectedMode, toggles, camera, references,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
      } catch { /* ignore */ }

      await submitGeneration(selectedName, inputs, undefined, selectedMode);
      toast.success('Submitted to GPU queue');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Submit failed';
      toast.error('Generate failed', { description: msg });
    } finally {
      setGenerating(false);
    }
  }, [
    validationError, selectedMode, prompt, negativePrompt, resolution, references,
    selectedName, submitGeneration, formatId, qualityId, toggles,
    camera, cameraLabels,
  ]);

  const persistBlob = useMemo<PersistedForm>(
    () => ({ templateName: selectedName, prompt, formatId, qualityId, selectedMode, toggles, camera, references }),
    [selectedName, prompt, formatId, qualityId, selectedMode, toggles, camera, references],
  );
  useDebouncedPersist(STORAGE_KEY, persistBlob);

  // ---- Reset ----
  const handleReset = useCallback(() => {
    setPrompt('');
    setFormatId('1:1');
    setQualityId('standard');
    setToggles({});
    setReferences([]);
    setCamera(EMPTY_CAMERA);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  // ---- Publish to Studio so the shared bottom Reset/Generate drive us ----
  useEffect(() => {
    registerAction({
      onSubmit: handleGenerate,
      onReset: handleReset,
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
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          </div>
          <p className="text-sm font-semibold text-foreground mb-1">
            No image-builder templates yet
          </p>
          <p className="text-xs text-muted-foreground max-w-xs mb-4">
            Register a template with <code className="font-mono">studioBuilder: "image"</code> in
            its metadata to see it here. You can still drive any compatible template from the
            Advanced tab.
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

  const canAddMore = references.length < MAX_REFS;

  return (
    <div className="space-y-5">

      {/* MODEL */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <label className="field-label">Model</label>
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

      {/* CAMERA — clickable summary chip that opens the 4-column modal. */}
      <div>
        <div className="mb-2 flex items-center gap-1">
          <p className="eyebrow">Camera</p>
          <Tooltip>
            <TooltipTrigger asChild>
              <Info className="h-3 w-3 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent className="max-w-[240px]">
              Camera settings only shape the prompt when you run Enhance — they
              guide the AI's wording (lens, aperture, film look). They have no
              effect on a raw generation without Enhance.
            </TooltipContent>
          </Tooltip>
        </div>
        <button
          type="button"
          onClick={() => setCameraOpen(true)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/50 px-4 py-3 text-left transition hover:bg-muted"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {cameraLabels.camera ?? 'Choose camera'}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {cameraSubtitle || 'Lens · Focal · Aperture'}
            </div>
          </div>
          <CameraIcon className="h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.6} />
        </button>
      </div>

      {/* REFERENCES — the big slot hosts references[0] (the "main image" /
          i2i edit target) but is ONLY rendered once a reference is selected;
          the empty-state entry point is the Add-media pill (which appends, so
          the first pick lands at index 0). The Add-media pill appends to the
          end; the grid renders references[1..N] so the main never duplicates.
          Each tile is labelled @reference{absoluteIndex+1}. */}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <p className="eyebrow">References</p>
          <span className="text-[11px] text-muted-foreground">{references.length}/{MAX_REFS}</span>
        </div>
        {references.length > 0 && (
          <RefSlot icon={ImageIcon} label="Main image"
                   item={references[0]}
                   onOpen={() => openPickerFor('main')}
                   onClear={handleClearMain} />
        )}
        <AddMediaPill slots={[
          { kind: 'image',
            active: references.length > 0,
            tooltip: canAddMore
              ? 'Add reference image'
              : `Maximum ${MAX_REFS} references reached`,
            disabled: !canAddMore,
            onClick: () => openPickerFor('append') },
          { kind: 'character', disabled: true, tooltip: 'Character (coming soon)' },
          { kind: 'effect',    disabled: true, tooltip: 'Effect (coming soon)' },
        ]} />
        {references.length > 1 && (
          <div className="mt-3 grid grid-cols-5 gap-2">
            {references.slice(1).map((ref, i) => {
              const absoluteIndex = i + 1;
              return (
                <div
                  key={ref.filename}
                  className="group relative aspect-square overflow-hidden rounded-lg border border-border/60 bg-muted"
                >
                  <img
                    src={viewUrlFor(ref)}
                    alt={`@reference${absoluteIndex + 1}`}
                    className="h-full w-full object-cover"
                  />
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-1.5">
                    <div className="text-[10px] font-medium text-white">
                      @reference{absoluteIndex + 1}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveReference(ref.filename)}
                    className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[10px] text-white group-hover:flex"
                    aria-label={`Remove @reference${absoluteIndex + 1}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* PROMPT — same card layout as VideoBuilder: textarea + inline
          Enhance / AutoEnhance / Clear in the footer, spinner overlay while
          enhancing. */}
      <div>
        <p className="eyebrow mb-2">Prompt</p>
        <div className="relative rounded-xl border bg-card">
          <div className={enhancing ? 'pointer-events-none blur-[1px] opacity-60 transition' : 'transition'}>
            <PromptComposer
              value={prompt}
              onChange={setPrompt}
              mentionables={mentionables}
              registry={promptRegistry}
              placeholder="Describe the image you want to generate…"
              readOnly={enhancing}
              ariaLabel="Prompt"
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
                toggles={resolveToggles(bundle?.prompt_toggles, selectedMode)}
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

      {/* MODEL · FORMAT · QUALITY single chip row.
          Model on the left (one chip per available mode under the current
          task type — today only t2i). Format + Quality grouped on the
          right via `ml-auto`. Quality is resolved per-mode through
          `pickResolution`, honouring `image_format` / `image_format_faster`.
          Triggers like `@krea` still work inline in the prompt; server-side
          trigger override at submit takes precedence. */}
      <div className="flex items-center gap-2 flex-nowrap min-w-0">
        {availableModes.length > 0 && (
          <ChipSelect
            icon={Sparkles}
            value={availableModes.find((m) => m.name === selectedMode)?.label ?? 'Pick a model'}
            options={availableModes.map((m) => ({ id: m.name, left: m.label, right: m.trigger ?? '' }))}
            selectedId={selectedMode ?? ''}
            onChange={setSelectedMode}
          />
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ChipSelect
            icon={(visibleFormats.find((f) => f.id === formatId) ?? visibleFormats[0] ?? FORMAT_OPTIONS[0]).Icon}
            value={formatId}
            options={visibleFormats.map((f) => ({ id: f.id, left: f.id, right: f.label, Icon: f.Icon }))}
            selectedId={formatId}
            onChange={setFormatId}
            disabled={aspectLocked}
          />
          <ChipSelect
            icon={Gauge}
            value={`${QUALITY_OPTIONS.find((q) => q.id === qualityId)?.label ?? 'SD'} · ${resolution.width}×${resolution.height}`}
            options={QUALITY_OPTIONS.map((q) => ({ id: q.id, left: q.label, right: '' }))}
            selectedId={qualityId}
            onChange={(id) => setQualityId(id as QualityTier)}
          />
        </div>
      </div>

      {/* Validation hint */}
      {validationError && (
        <div className="info-box flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-warning shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      {/* Modals */}
      <MediaLibraryModal
        open={pickerOpen}
        kind="image"
        onClose={() => setPickerOpen(false)}
        onSelect={handleAddReference}
      />
      <CameraSettingsModal
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        value={camera}
        onApply={setCamera}
      />
    </div>
  );
}
