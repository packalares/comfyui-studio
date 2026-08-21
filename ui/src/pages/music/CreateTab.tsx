// Create — a composer, not a form. The prompt (Simple) / style+lyrics
// (Custom) is the hero; duration/persona/model are supporting; inference
// steps/guidance/seed/batch are tucked under "Advanced". Layout mirrors
// `Studio.tsx`'s own Easy-mode chrome — a sticky composer aside on the left
// (mode tabs pinned top, scrollable fields, sticky Generate footer) and a
// result panel on the right — which happens to be exactly Suno's
// composer-left / song-feed-right shape, so leaning on comfy's own idiom
// here gets both "native to comfy" and "feels like Suno" for free.
//
// The aside below is a local copy of `components/layout/PageAside`'s class
// list (same rounded-xl/border/bg-card/sticky shape every other builder
// page uses) rather than that component directly: this page also renders a
// sticky bottom `PlayerBar` once a song is playing, which the shared
// component's fixed `calc(100vh-140px)` sizing doesn't know how to leave
// room for. The `--pb` custom property below reserves that space so the
// aside's own sticky Generate footer never ends up hidden behind the player.
//
// Ported from ace-step-ui's `CreatePanel.tsx`, then extended past it: the
// form is PROGRESSIVE — you pick a generation mode first and only that mode's
// controls render. Modes mirror ACE-Step's own catalog (`generationModes.ts`,
// derived from the installed package's `constants.py`), so Remix/Repaint/
// Extract/Lego/Complete are real task types rather than invented ones, and
// the offered list is filtered by the selected checkpoint (Extract/Lego/
// Complete need a base model). Source/reference tracks are picked through
// comfy's shared `MediaLibraryModal` in audio mode — the same picker the
// Studio page uses for images — so generated songs (now gallery rows) show up
// as pickable inputs for free.
//
// The persona/LoRA picker (originally deferred — see the previous version of
// this comment) is now wired: `GET /ace/training/lora-checkpoints` (added
// alongside the Train tab) backs a Select here, and picking a persona loads
// that adapter into the resident ACE-Step FastAPI via `POST /ace/lora/load`
// immediately before submitting generation (there's no `lora` field on
// `GenerationParams` — the adapter is process-resident state, not a per-job
// param — see `generate.contract.ts` + `lora.contract.ts`).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { NavLink } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, Dice5, Loader2, Mic2, Music2, Sparkles, Wand2, X,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Slider } from '../../components/ui/slider';
import { Spinner } from '../../components/ui/spinner';
import { Badge } from '../../components/ui/badge';
import { ProgressCircle } from '../../components/ui/progress-circle';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/forms/SelectField';
import { SongCard } from './SongCard';
import { useMusic } from './MusicContext';
import {
  MODE_BY_ID, MODE_GROUP_LABEL, TRACK_NAMES, hasExpertModes, modesForModel,
  modesInGroup, type ModeGroup, type ModeId,
} from './generationModes';
import MediaLibraryModal from '../../components/modals/MediaLibraryModal';
import { modelDescription, modelLabel } from './aceModelInfo';
import { tuningForModel } from './aceModelTuning';
import { cn } from '../../lib/utils';
import * as api from '../../services/ace';
import type {
  AceModelInfo, GenerationParams, GenerationStatusResponse, Song,
} from '../../types/ace';

const VOCAL_LANGUAGES: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'ru', label: 'Russian' },
];

/** Quick-start chips under the hero textarea — click to fill the
 *  description, same "inspire me" affordance Suno's own composer has.
 *  Only shown while the field is still empty so they don't clutter an
 *  in-progress draft. */
const EXAMPLE_PROMPTS = [
  'Dreamy synthwave, driving at night, nostalgic',
  'Upbeat pop anthem, empowering, female vocals',
  'Lo-fi hip-hop, rainy afternoon, chill study beats',
  'Epic orchestral trailer, cinematic, heroic',
];

function StyleTagInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  // ace-step-ui's `style` field is free-form comma-separated text (not a
  // structured tag list server-side) — this renders it as removable chips
  // for a nicer editing feel while keeping the wire value a plain string.
  const tags = useMemo(() => value.split(',').map((t) => t.trim()).filter(Boolean), [value]);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const t = draft.trim();
    if (!t) return;
    onChange([...tags, t].join(', '));
    setDraft('');
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag, i) => (
          <Badge key={`${tag}-${i}`} variant="brand" className="gap-1">
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => onChange(tags.filter((_, idx) => idx !== i).join(', '))}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          if (e.key === 'Backspace' && !draft && tags.length > 0) onChange(tags.slice(0, -1).join(', '));
        }}
        onBlur={commit}
        placeholder="synth-pop, upbeat, female vocals…"
      />
    </div>
  );
}

/** Turn a trained-LoRA checkpoint's absolute filesystem path (e.g.
 *  `<lora-output>/voice/voice_guta/final/adapter`) into a friendly label:
 *  strip the known output-dir prefix and the trainer's fixed `final/adapter`
 *  suffix, leaving `voice/voice_guta`. Falls back to the path's basename if
 *  the prefix doesn't match (e.g. `?dir=` was used to look elsewhere). */
function personaLabel(checkpointPath: string, outputDir?: string): string {
  let rel = checkpointPath;
  if (outputDir && checkpointPath.startsWith(outputDir)) {
    rel = checkpointPath.slice(outputDir.length).replace(/^[/\\]+/, '');
  }
  rel = rel.replace(/[/\\]+final[/\\]+adapter$/, '').replace(/[/\\]+final$/, '');
  if (!rel) rel = checkpointPath.split(/[/\\]/).filter(Boolean).pop() ?? checkpointPath;
  return rel;
}

/** Compact "pick a track" control: shows the chosen file's name with a clear
 *  button, or a dashed placeholder that opens the media picker. Selection
 *  itself goes through comfy's shared `MediaLibraryModal` (audio mode) so the
 *  music page doesn't grow its own browser — and so generated songs, which are
 *  gallery rows now, are pickable inputs without any extra plumbing. */
function AudioPickerField({
  value, onPick, onClear, placeholder,
}: {
  value: string;
  onPick: () => void;
  onClear: () => void;
  placeholder: string;
}) {
  // Values are `/api/view?...` URLs; show the filename rather than the query
  // string. Falls back to the raw value if it isn't shaped as expected.
  const label = useMemo(() => {
    if (!value) return '';
    try {
      return new URL(value, window.location.origin).searchParams.get('filename') || value;
    } catch {
      return value;
    }
  }, [value]);

  if (!value) {
    return (
      <button
        type="button"
        onClick={onPick}
        className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:border-brand hover:text-brand"
      >
        <Music2 className="h-3.5 w-3.5 shrink-0" />
        {placeholder}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
      <Music2 className="h-3.5 w-3.5 shrink-0 text-brand" />
      <span className="min-w-0 flex-1 truncate text-xs text-foreground">{label}</span>
      <button type="button" onClick={onPick} className="text-[11px] text-muted-foreground hover:text-foreground">
        Change
      </button>
      <button type="button" onClick={onClear} aria-label="Clear track" className="text-muted-foreground hover:text-destructive">
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

const NO_PERSONA = '__none__';

// Remembers the in-flight generation jobId across a page reload. There is no
// `GET /ace/generate/jobs` list endpoint (only per-jobId status), so a
// refresh needs *some* way to know which job to reconcile against — this is
// the minimal client-side bookkeeping for that; the actual state lives
// server-side (the `ace_generation_jobs` row) and `GET
// /ace/generate/status/:jobId` (used by `api.pollGenerationStatus`) remains
// the single source of truth.
const ACTIVE_JOB_STORAGE_KEY = 'comfy:ace:create:activeJobId';

export function CreateTab() {
  const {
    songs, currentSong, isPlaying, playSong, refreshSongs,
    toggleFavorite, openAddToPlaylist, renameSong, removeSong,
  } = useMusic();

  // Mode drives the whole form: pick what you're making first, then only that
  // mode's controls appear. Mirrors ACE-Step's own mode catalog (see
  // `generationModes.ts`) rather than a bespoke set, and the available list is
  // filtered by the selected checkpoint — Extract/Lego/Complete need a base
  // model and fail opaquely inside ACE-Step on a turbo one.
  const [mode, setMode] = useState<ModeId>('Simple');
  // Off by default: the stem-level modes (Continue/Extract/Lego) need a source
  // track, a base checkpoint and some idea of what a stem is, so they'd make
  // the first screen read as a DAW rather than a prompt box.
  const [expertModes, setExpertModes] = useState(false);
  const [models, setModels] = useState<AceModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');

  // Persona / voice-LoRA picker — populated from the training pack's
  // lora-checkpoints list (trained adapters live at `.../final/adapter`).
  const [personas, setPersonas] = useState<{ path: string; label: string }[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<string>(NO_PERSONA);
  const [loadingLora, setLoadingLora] = useState(false);
  // Tracks which adapter path is actually loaded in the resident ACE-Step
  // process right now, so re-submitting with the same persona doesn't
  // re-issue a redundant load call.
  const loadedLoraRef = useRef<string | null>(null);
  // Handle for the in-flight generation poller. Without cancelling it, the
  // poll survives unmount (navigating away from /music) and keeps setting
  // state, firing toasts, and even auto-playing the finished song for a job
  // the user walked away from — and a second submit would leave two pollers
  // racing to write the same `jobStatus`.
  const pollRef = useRef<{ cancel: () => void } | null>(null);

  useEffect(() => () => {
    pollRef.current?.cancel();
    pollRef.current = null;
  }, []);

  // Simple mode
  const [description, setDescription] = useState('');
  const [rolling, setRolling] = useState(false);

  // Custom mode
  const [style, setStyle] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [title, setTitle] = useState('');
  const [vocalLanguage, setVocalLanguage] = useState('en');
  const [generatingLyrics, setGeneratingLyrics] = useState(false);
  const [enhancing, setEnhancing] = useState(false);

  // Shared
  const [instrumental, setInstrumental] = useState(false);
  const [duration, setDuration] = useState(-1); // -1 = auto
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Expert sampler / LM controls ──────────────────────────────────────────
  // All optional: `undefined` means "don't send it" so ACE-Step applies its own
  // default rather than us hardcoding a second set that could drift from it.
  const [inferMethod, setInferMethod] = useState<'ode' | 'sde' | undefined>(undefined);
  const [useAdg, setUseAdg] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [lmTemperature, setLmTemperature] = useState<number | undefined>(undefined);
  const [lmNegativePrompt, setLmNegativePrompt] = useState('');

  // ── Mode-specific inputs ──────────────────────────────────────────────────
  // Kept as one block so it's obvious which state belongs to the progressive
  // section rather than the always-visible composer. Each is only read when
  // the active mode's `fields` declares it (see `runSubmit` below), so
  // switching modes never silently smuggles a stale value into the request.
  const [sourceAudioUrl, setSourceAudioUrl] = useState('');
  const [referenceAudioUrl, setReferenceAudioUrl] = useState('');
  const [audioPicker, setAudioPicker] = useState<'source' | 'reference' | 'soundLike' | null>(null);

  // ── "Sound like…" — style capture via ACE-Step audio codes ────────────────
  // Audio codes are the model's own semantic fingerprint of a track, so
  // handing them to a generation is a far stronger "sound like this" than any
  // words the user could type. The capture is a separate, quick round-trip
  // (encode + tokenize, no diffusion), which is why it has its own pending
  // state rather than riding along with Generate.
  const [soundLikeUrl, setSoundLikeUrl] = useState('');
  const [soundLikeCodes, setSoundLikeCodes] = useState('');
  const [soundLikeCount, setSoundLikeCount] = useState(0);
  /** The LM's plain-language reading of the dropped track. Undefined when only
   *  codes came back — style transfer still works, we just can't describe it. */
  const [soundLikeInfo, setSoundLikeInfo] = useState<{
    bpm?: number; keyScale?: string; genre?: string; caption?: string;
  } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);

  // ── Stem separation ───────────────────────────────────────────────────────
  // The real separator, not ACE-Step's generative `extract`. Kept separate
  // from the mode system because it isn't a generation: it produces files, and
  // its output feeds BACK into the picker as a new source track.
  const [splitting, setSplitting] = useState(false);
  const [stems, setStems] = useState<{ name: string; url: string }[]>([]);
  const [stemError, setStemError] = useState<string | null>(null);
  // ACE-Step's raw defaults are audio_cover_strength=1.0 / cover_noise_strength=0.0,
  // but those are NOT sensible defaults for a "Remix" action: per upstream's own
  // slider help, cover strength 1.0 means "output sounds closest to the
  // original", so a remix at 1.0 returns essentially the input track back.
  // 0.65 leaves the structure recognisable while allowing the caption to change
  // the sound. Melody retention starts at 0.15 — the middle of the 0.1-0.25
  // range upstream explicitly recommends.
  /*
   * BOTH of these trade "sounds like my track" against "sounds like my text",
   * and both point the same way: HIGHER = closer to the source.
   *
   *   audio_cover_strength — blends the text conditioning between the cover
   *     instruction and the plain text2music one. Documented bands:
   *       0.3-0.5 dramatic genre change | 0.5-0.7 moderate restyle
   *       0.7-0.9 subtle                | 0.9-1.0 performance detail only
   *   cover_noise_strength — how much of the source LATENT survives:
   *       effective_noise_level = 1.0 - cover_noise_strength
   *
   * This was briefly set to 1.0 to "match upstream's default", which is the
   * performance-detail-only end: covers came back as the input track, barely
   * touched. Upstream's default is right for a faithful cover and wrong for a
   * genre flip, which is what this UI is actually for.
   *
   * 0.4 / 0.5 targets "recognisably my song, clearly a different genre".
   * Reasoned from the documented bands, NOT measured — both sliders are
   * exposed precisely because this needs ears.
   */
  const [coverStrength, setCoverStrength] = useState(0.4);
  const [coverNoiseStrength, setCoverNoiseStrength] = useState(0.5);
  const [repaintStart, setRepaintStart] = useState(0);
  const [repaintEnd, setRepaintEnd] = useState(30);
  const [trackName, setTrackName] = useState<string>(TRACK_NAMES[0]);
  const [trackClasses, setTrackClasses] = useState<string[]>([]);
  const [inferenceSteps, setInferenceSteps] = useState<number | undefined>(undefined);
  const [guidanceScale, setGuidanceScale] = useState<number | undefined>(undefined);
  const [batchSize, setBatchSize] = useState(1);
  const [randomSeed, setRandomSeed] = useState(true);
  const [seed, setSeed] = useState(0);

  // Submission / progress
  const [submitting, setSubmitting] = useState(false);
  const [jobStatus, setJobStatus] = useState<GenerationStatusResponse | null>(null);
  const [recentSongs, setRecentSongs] = useState<Song[]>([]);

  useEffect(() => {
    api.listModels()
      .then((list) => {
        setModels(list);
        // Preference order matters: `is_default` (the registry's generation
        // checkpoint, xl-turbo) must outrank `is_preloaded`, because ALL
        // downloaded checkpoints are preloaded and the previous fallback
        // therefore resolved to whatever sorted first — `acestep-v15-xl-base`,
        // a fine-tuning starting point that generates noticeably worse songs.
        //
        // `is_active` used to win, to avoid forcing a ~19 GB reload when
        // ACE-Step already had a checkpoint resident. That traded audio
        // quality for load time and it was the wrong trade: any operation that
        // happened to load SFT (an analysis call, a previous experiment)
        // silently became the default generation model for every subsequent
        // song, with different steps, different CFG and different DCW
        // behaviour. Reloading is slow; quietly generating on a checkpoint the
        // user never chose is worse.
        const active = list.find((m) => m.is_default && m.is_preloaded)
          ?? list.find((m) => m.is_default)
          ?? list.find((m) => m.is_preloaded)
          ?? list[0];
        if (active) setSelectedModel(active.name);
      })
      .catch(() => { /* model list is best-effort — submit still works without a pick */ });
  }, []);

  useEffect(() => {
    api.listLoraCheckpoints()
      .then((r) => {
        setPersonas(r.checkpoints.map((path) => ({ path, label: personaLabel(path, r.outputDir) })));
      })
      .catch(() => { /* persona list is best-effort — generation still works without one */ });
  }, []);

  /** Make the resident ACE-Step process' loaded LoRA match `personaPath`
   *  (`null` = no persona / instrument voice). No-ops if it's already the
   *  active adapter. Throws on failure so the caller can abort submission
   *  rather than silently generating with the wrong (or no) voice. */
  const ensureLoraForPersona = async (personaPath: string | null): Promise<void> => {
    if (personaPath === loadedLoraRef.current) return;
    setLoadingLora(true);
    try {
      if (personaPath === null) {
        await api.unloadLora();
      } else {
        await api.loadLora(personaPath);
      }
      loadedLoraRef.current = personaPath;
    } finally {
      setLoadingLora(false);
    }
  };

  const isGenerating = submitting || (jobStatus !== null
    && jobStatus.status !== 'succeeded' && jobStatus.status !== 'failed' && jobStatus.status !== 'cancelled');

  // Cancel is only actionable once a jobId exists — during the brief window
  // between clicking Generate and the POST /ace/generate response landing
  // (`submitting`), there's nothing server-side to cancel yet.
  const canCancel = !submitting && jobStatus !== null
    && (jobStatus.status === 'queued' || jobStatus.status === 'running');

  // Availability is model-dependent, so a mode that was valid a moment ago can
  // vanish when the checkpoint changes; fall back to Simple rather than leaving
  // the form stuck on an unrunnable mode.
  const selectedModelInfo = useMemo(
    () => models.find((m) => m.name === selectedModel) ?? null,
    [models, selectedModel],
  );
  const availableModes = useMemo(
    () => modesForModel(selectedModelInfo?.is_turbo, selectedModel, { expert: expertModes }),
    [selectedModelInfo, selectedModel, expertModes],
  );
  // Covers both directions: switching to a checkpoint that can't run the
  // current mode, AND switching expert modes off while sitting on one.
  useEffect(() => {
    if (!availableModes.some((m) => m.id === mode)) setMode('Simple');
  }, [availableModes, mode]);

  // Only offered when the checkpoint actually has expert modes to reveal — a
  // switch that visibly does nothing reads as broken rather than inapplicable.
  const expertAvailable = useMemo(
    () => hasExpertModes(selectedModelInfo?.is_turbo, selectedModel),
    [selectedModelInfo, selectedModel],
  );

  // Inference settings are NOT portable between checkpoints: turbo runs 8
  // steps with CFG disabled, base/SFT need 32/50 steps WITH CFG. Sending one
  // set to all three is what made base sound broken. Applying the selected
  // model's own regime whenever it changes keeps the two in step; the Advanced
  // drawer still overrides afterwards, it just starts from sane values.
  const tuning = useMemo(() => tuningForModel(selectedModel), [selectedModel]);
  useEffect(() => {
    setInferenceSteps(tuning.steps);
    setGuidanceScale(tuning.usesCfg ? tuning.guidanceScale : undefined);
    if (!tuning.supportsAdg) setUseAdg(false);
  }, [tuning]);

  const activeMode = MODE_BY_ID[mode];
  const fields = activeMode.fields;

  // The group is derived from the active mode rather than held as its own
  // state — two sources of truth for "which half am I in" is exactly how a
  // picker ends up highlighting Create while showing Remix's fields.
  const activeGroup = activeMode.group;
  const groupModes = useMemo(
    () => modesInGroup(availableModes, activeGroup),
    [availableModes, activeGroup],
  );
  const selectGroup = (g: ModeGroup) => {
    if (g === activeGroup) return;
    const first = modesInGroup(availableModes, g)[0];
    if (first) setMode(first.id);
  };

  // Each mode has its own minimum viable input. Requiring source audio up front
  // (rather than letting the server reject it) keeps the failure at the button
  // instead of 30s into a queued job.
  const canSubmit = (() => {
    if (fields.sourceAudio && !sourceAudioUrl) return false;
    // A "Sound like…" track that hasn't produced codes yet (still analyzing,
    // or failed) blocks Generate. Letting it through would silently drop the
    // style the user explicitly asked for and look like the feature not working.
    if (fields.soundLike && soundLikeUrl && !soundLikeCodes) return false;
    if (fields.description) return description.trim().length > 0;
    if (fields.composer) return style.trim().length > 0 || lyrics.trim().length > 0;
    // Extract needs only a source track + a chosen instrument.
    return true;
  })();

  const rollDescription = async () => {
    setRolling(true);
    try {
      const r = await api.randomDescription();
      setDescription(r.description);
      setInstrumental(r.instrumental);
    } catch (err) {
      toast.error('Could not fetch a random description', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setRolling(false);
    }
  };

  /**
   * Capture the style of a picked track.
   *
   * Runs immediately on pick rather than deferring to Generate: it needs the
   * GPU and takes a few seconds, so doing it up front means the user learns
   * whether the capture worked while they're still choosing, instead of having
   * a generation fail minutes later. On failure the track selection is kept so
   * Retry is one click, not a re-pick.
   */
  const captureStyle = async (url: string) => {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const r = await api.analyzeAudio(url, selectedModel || undefined);
      setSoundLikeCodes(r.audioCodes);
      setSoundLikeCount(r.codeCount);
      const info = {
        bpm: r.bpm, keyScale: r.keyScale, genre: r.genre, caption: r.caption,
      };
      setSoundLikeInfo(Object.values(info).some((v) => v !== undefined && v !== '') ? info : null);
    } catch (err) {
      setSoundLikeCodes('');
      setSoundLikeCount(0);
      setSoundLikeInfo(null);
      setAnalyzeError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const clearSoundLike = () => {
    setSoundLikeUrl('');
    setSoundLikeCodes('');
    setSoundLikeCount(0);
    setSoundLikeInfo(null);
    setAnalyzeError(null);
  };

  const splitIntoStems = async () => {
    setSplitting(true);
    setStemError(null);
    setStems([]);
    try {
      const r = await api.separateStems(sourceAudioUrl);
      setStems(r.stems);
    } catch (err) {
      setStemError(err instanceof Error ? err.message : String(err));
    } finally {
      setSplitting(false);
    }
  };

  const handleGenerateLyrics = async () => {
    setGeneratingLyrics(true);
    try {
      const generated = await api.generateLyrics({ genre: style, topic: title || style });
      setLyrics(generated);
    } catch (err) {
      toast.error('Lyrics generation failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setGeneratingLyrics(false);
    }
  };

  const handleEnhance = async () => {
    if (!style.trim()) { toast.error('Add a style first'); return; }
    setEnhancing(true);
    try {
      const r = await api.formatInput({ caption: style, lyrics });
      setStyle(r.caption);
      if (r.lyrics) setLyrics(r.lyrics);
    } catch (err) {
      // The route now starts ACE-Step on demand (it goes through the GPU
      // scheduler), so "unreachable" here means the backend genuinely failed
      // to come up — not merely that it was idle. Say that, rather than
      // surfacing the raw endpoint path the user can't act on.
      const raw = err instanceof Error ? err.message : String(err);
      const unreachable = /unreachable|ECONNREFUSED|not running/i.test(raw);
      toast.error('Enhance failed', {
        description: unreachable
          ? 'The ACE-Step backend could not be started. Check the pack is installed and its logs.'
          : raw,
      });
    } finally {
      setEnhancing(false);
    }
  };

  // Shared by a fresh submit and the mount-time reconciliation effect below,
  // so a job that finishes while this component is actually mounted (either
  // one) gets the same toast/refresh/auto-play treatment.
  const handleJobUpdate = useCallback(async (status: GenerationStatusResponse) => {
    setJobStatus(status);
    if (status.status === 'succeeded' && status.result) {
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      const expected = status.result.audioUrls.length;
      const fresh = await refreshSongs();
      const newest = fresh.slice(0, expected);
      setRecentSongs(newest);
      if (newest.length > 0) playSong(newest[0], newest);
      toast.success(expected > 1 ? `${expected} variations ready` : 'Song ready');
    } else if (status.status === 'failed') {
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      toast.error('Generation failed', { description: status.error ?? undefined });
    } else if (status.status === 'cancelled') {
      // User-initiated — no error toast, no auto-play of whatever the
      // abandoned job might still produce server-side (ACE-Step has no
      // cancel endpoint; it keeps computing, comfy just stops waiting on it).
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
    }
  }, [refreshSongs, playSong]);

  // Refresh must not lose track of an in-flight job: the jobId otherwise only
  // ever lived in React state, so a reload mid-generation would abandon a
  // job the server is still running. `ACTIVE_JOB_STORAGE_KEY` survives the
  // reload; reconcile against the server's real status once on mount rather
  // than assuming it's still going. A job that already finished while this
  // tab was closed intentionally does NOT replay its toast/auto-play here —
  // only a still-in-flight job resumes live tracking.
  useEffect(() => {
    const storedJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
    if (!storedJobId) return;
    let cancelled = false;
    (async () => {
      try {
        const status = await api.getGenerationStatus(storedJobId);
        if (cancelled) return;
        if (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled') {
          localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
          return;
        }
        setJobStatus(status);
        pollRef.current?.cancel();
        pollRef.current = api.pollGenerationStatus(storedJobId, handleJobUpdate);
      } catch {
        localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSubmit = async (params: GenerationParams) => {
    setSubmitting(true);
    setJobStatus(null);
    setRecentSongs([]);
    try {
      const { jobId } = await api.submitGeneration(params);
      localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
      setJobStatus({ jobId, status: 'queued' });
      // Supersede any previous poll before starting a new one, so two
      // submissions can't race to write `jobStatus`.
      pollRef.current?.cancel();
      pollRef.current = api.pollGenerationStatus(jobId, handleJobUpdate);
    } catch (err) {
      toast.error('Could not start generation', { description: err instanceof Error ? err.message : String(err) });
      setJobStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || isGenerating) return;
    try {
      await ensureLoraForPersona(selectedPersona === NO_PERSONA ? null : selectedPersona);
    } catch (err) {
      toast.error('Could not load persona voice', { description: err instanceof Error ? err.message : String(err) });
      return;
    }
    const params: GenerationParams = {
      ...api.defaultGenerationParams(),
      // `customMode` still gates the server's Simple-mode orchestration
      // (description -> style/lyrics via ollama), which is keyed to Simple
      // specifically, not to "any mode that isn't Simple".
      customMode: mode !== 'Simple',
      taskType: activeMode.taskType,
      instrumental,
      duration: duration >= 0 ? duration : undefined,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed: randomSeed ? undefined : seed,
      ditModel: selectedModel || undefined,
      inferMethod,
      useAdg: useAdg || undefined,
      thinking: thinking || undefined,
      lmTemperature,
      lmNegativePrompt: lmNegativePrompt.trim() || undefined,
    };

    // Only send what this mode actually declares. Reading state unconditionally
    // would smuggle stale values (a source track picked in Remix, then switched
    // to Simple) into a request the mode never showed a control for.
    if (fields.description) params.songDescription = description.trim();
    if (fields.composer) {
      params.style = style.trim();
      params.lyrics = instrumental ? '' : lyrics;
      params.title = title.trim();
      params.vocalLanguage = vocalLanguage;
    }
    if (fields.sourceAudio) params.sourceAudioUrl = sourceAudioUrl;
    if (fields.referenceAudio && referenceAudioUrl) params.referenceAudioUrl = referenceAudioUrl;
    // Only send codes we actually captured. A picked track whose analysis
    // failed or is still running must NOT quietly generate without the style
    // the user asked for — `canSubmit` blocks that case rather than letting it
    // through as a silently plain generation.
    if (fields.soundLike && soundLikeCodes) params.audioCodes = soundLikeCodes;
    if (fields.coverStrength) {
      params.audioCoverStrength = coverStrength;
      params.coverNoiseStrength = coverNoiseStrength;
    }
    if (fields.repaintRange) {
      params.repaintingStart = repaintStart;
      params.repaintingEnd = repaintEnd;
    }
    // ACE-Step's TASK_INSTRUCTIONS templates carry {TRACK_NAME}/{TRACK_CLASSES}
    // placeholders; the server fills the template, we just supply the choice.
    // Same prose/structured pairing as trackClasses below: only `instruction`
    // was being set, so `track_name` reached ACE-Step as null on every
    // Extract/Lego request.
    if (fields.trackName) {
      params.instruction = trackName;
      params.trackName = trackName;
    }
    // Both, deliberately. `instruction` is the prose ACE-Step substitutes
    // `{TRACK_CLASSES}` into; `completeTrackClasses` is the structured list it
    // reads as `track_classes`. Only the instruction was ever set, so the
    // structured field arrived empty even after the field-name fix — the chips
    // looked wired but half the request was missing.
    if (fields.trackClasses && trackClasses.length > 0) {
      params.instruction = trackClasses.join(', ');
      params.completeTrackClasses = trackClasses;
    }

    await runSubmit(params);
  };

  // The WS push (`ace:generation`, already subscribed via `pollRef`) is what
  // actually flips `jobStatus` to 'cancelled' and clears the stored jobId
  // (through `handleJobUpdate`) — this just tells the server to stop.
  const handleCancel = async () => {
    if (!jobStatus) return;
    try {
      await api.cancelGeneration(jobStatus.jobId);
    } catch (err) {
      toast.error('Could not cancel generation', { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const recentIds = useMemo(() => new Set(recentSongs.map((s) => s.id)), [recentSongs]);
  const feedSongs = useMemo(() => songs.slice(0, 12), [songs]);

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      {/* Composer — sticky left aside, same chrome as Studio's Easy-mode
          form (mode tabs pinned top, scrollable fields, sticky footer).
          `--pb` reserves room for the bottom PlayerBar when it's showing —
          see the file header comment for why this isn't the shared
          `PageAside` component. */}
      <aside
        className={cn(
          'flex-col rounded-xl border bg-card shadow-sm overflow-y-auto no-scrollbar',
          'flex w-full',
          'lg:sticky lg:top-[104px] lg:flex lg:h-[calc(100vh-140px-var(--pb,0px))] lg:w-[400px] lg:shrink-0',
        )}
        style={{ '--pb': currentSong ? '76px' : '0px' } as React.CSSProperties}
      >
        <div className="flex h-full flex-col">
          <div className="border-b p-2">
            {/* Two questions, asked in order, instead of one seven-way choice.
                First: are you making something new, or changing a track you
                already have? Only then: which flavour of that?

                This replaced a flat strip of all seven modes, which conflated
                two independent axes — what you're doing, and which checkpoint
                you're on — and left the user to infer that e.g. Remix wasn't a
                turbo-only feature. It also overflowed: seven triggers in a
                400px aside wrapped badly and clipped the last one out of sight.
                Modes the checkpoint can't run are filtered out entirely rather
                than shown-and-disabled; a greyed row invites a "why?" that the
                answer ("load a base checkpoint") can't fit in. */}
            <Tabs value={activeGroup} onValueChange={(v) => selectGroup(v as ModeGroup)}>
              <TabsList className="w-full gap-1">
                {(['create', 'transform'] as ModeGroup[]).map((g) => (
                  <TabsTrigger key={g} value={g} className="flex-1 text-xs">
                    {MODE_GROUP_LABEL[g]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {/* Create is ONE thing with a depth control, not two modes.
                Simple and Custom are the same `text2music` task differing only
                in how much of the form you fill in, so presenting them as
                sibling tabs asked the user to categorise their intent before
                they'd written anything. A switch says the real thing: start
                from a sentence, or take the controls. */}
            {activeGroup === 'create' && (
              <div className="mt-2 flex items-center justify-between px-1">
                <span className="text-[11px] text-muted-foreground">
                  Write it myself
                  <span className="opacity-70"> — style tags and lyrics instead of a description</span>
                </span>
                <Switch
                  checked={mode === 'Custom'}
                  onCheckedChange={(on) => setMode(on ? 'Custom' : 'Simple')}
                  size="sm"
                />
              </div>
            )}

            {/* The track comes BEFORE the verb.
                Every Transform mode operates on a source track, and choosing
                "what to do with it" is a question you can only really answer
                once you have the it. Asking for the verb first is what made
                Remix and Repaint feel like they belonged next to Create when
                they don't. Lifting the picker out of the body and above the
                verbs also means the required field can't be scrolled past. */}
            {activeGroup === 'transform' && (
              <div className="mt-2">
                <label className="mb-1.5 block px-1 text-[11px] font-medium text-muted-foreground">
                  The track <span className="text-destructive">*</span>
                </label>
                <AudioPickerField
                  value={sourceAudioUrl}
                  onPick={() => setAudioPicker('source')}
                  onClear={() => { setSourceAudioUrl(''); setStems([]); setStemError(null); }}
                  placeholder="Pick the song you want to change"
                />

                {/* Real separation, offered exactly where you already have a
                    track. Picking a resulting stem swaps it in as the source,
                    so "remix just the drums" is: split, click drums, choose
                    Remix. That loop is why the stems feed back into this same
                    picker instead of only downloading. */}
                {sourceAudioUrl && (
                  <div className="mt-1.5">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5 text-[11px]"
                        disabled={splitting}
                        onClick={() => void splitIntoStems()}
                      >
                        {splitting ? <Spinner size="xs" /> : null}
                        {splitting ? 'Splitting…' : 'Split into stems'}
                      </Button>
                      <span className="text-[11px] text-muted-foreground/70">
                        vocals, drums, bass… takes a few minutes
                      </span>
                    </div>
                    {stems.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {stems.map((s) => (
                          <button
                            key={s.url}
                            type="button"
                            onClick={() => setSourceAudioUrl(s.url)}
                            className={cn(
                              'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                              sourceAudioUrl === s.url
                                ? 'border-brand bg-brand/10 text-brand'
                                : 'border-dashed border-border text-muted-foreground hover:border-brand hover:text-brand',
                            )}
                          >
                            {s.name}
                          </button>
                        ))}
                      </div>
                    )}
                    {stemError && (
                      <p className="mt-1 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                        Couldn&apos;t split the track: {stemError}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Transform keeps real tabs — Remix / Repaint / Continue are
                genuinely different verbs, not depths of the same one.
                Suppressed at one option: a single-item tab strip is chrome
                that looks interactive and isn't. */}
            {activeGroup !== 'create' && groupModes.length > 1 && (
              <Tabs value={mode} onValueChange={(v) => setMode(v as ModeId)} className="mt-1.5">
                <TabsList className="w-full flex-wrap justify-start gap-1">
                  {groupModes.map((m) => (
                    <TabsTrigger key={m.id} value={m.id} className="flex-1 min-w-[74px] text-xs">
                      {m.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            <p className="mt-1.5 px-1 text-[11px] leading-snug text-muted-foreground">
              {activeMode.description}
            </p>

            {expertAvailable && (
              <div className="mt-2 flex items-center justify-between px-1">
                <span className="text-[11px] text-muted-foreground">
                  Expert modes
                  <span className="opacity-70"> — stems, layering, continuing a take</span>
                </span>
                <Switch checked={expertModes} onCheckedChange={setExpertModes} size="sm" />
              </div>
            )}
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
            {fields.description && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Describe your song</label>
                  <Button variant="ghost" size="sm" onClick={() => void rollDescription()} disabled={rolling}>
                    {rolling ? <Spinner size="xs" /> : <Dice5 className="h-3.5 w-3.5" />}
                    Surprise me
                  </Button>
                </div>
                {/* Hero input — the one thing on this screen that matters
                    most, so it gets the biggest type, the most room, and no
                    competing chrome around it. */}
                <Textarea
                  autoFocus
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A dreamy synthwave track about driving at night, female vocals, nostalgic mood…"
                  className="h-36 resize-none rounded-xl border-0 bg-muted/60 px-4 py-3 text-[15px] leading-relaxed focus-visible:ring-2 focus-visible:ring-brand"
                />
                {description.trim().length === 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {EXAMPLE_PROMPTS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setDescription(p)}
                        className="rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-brand hover:text-brand"
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {fields.composer && (
              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Style</label>
                    <Button variant="ghost" size="sm" onClick={() => void handleEnhance()} disabled={enhancing || !style.trim()}>
                      {enhancing ? <Spinner size="xs" /> : <Sparkles className="h-3.5 w-3.5" />}
                      Enhance
                    </Button>
                  </div>
                  {/* Hero input for Custom mode — style tags carry the most
                      creative weight, so they lead; title/lyrics/language
                      follow as supporting fields. */}
                  <div className="rounded-xl bg-muted/60 px-3 py-2.5">
                    <StyleTagInput value={style} onChange={setStyle} />
                  </div>
                  {/* This field is a DESCRIPTION of the target sound, not an
                      instruction to the model. Captions like "transform this
                      song into a house rock song" spend most of their tokens
                      on words that describe no sound; ACE-Step conditions on
                      genre/instrument/tempo terms, so naming those directly is
                      what actually moves the output. */}
                  {activeGroup === 'transform' && (
                    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                      Describe the <strong>target sound</strong>, not the instruction — “house
                      rock, driving four-on-the-floor drums, distorted guitars, 128 BPM” works
                      better than “turn this into a house rock song”.
                    </p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
                  <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
                </div>

                {!instrumental && (
                  <div>
                    <div className="mb-1 flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">Lyrics</label>
                      <Button variant="ghost" size="sm" onClick={() => void handleGenerateLyrics()} disabled={generatingLyrics}>
                        {generatingLyrics ? <Spinner size="xs" /> : <Wand2 className="h-3.5 w-3.5" />}
                        Generate
                      </Button>
                    </div>
                    <Textarea
                      value={lyrics}
                      onChange={(e) => setLyrics(e.target.value)}
                      placeholder="[Verse 1]&#10;Write your own lyrics, or use Generate…"
                      className="h-32 resize-none font-mono text-xs"
                    />
                  </div>
                )}

                <div>
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Vocal language</label>
                  <SelectField value={vocalLanguage} onValueChange={setVocalLanguage}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VOCAL_LANGUAGES.map((l) => (
                        <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </SelectField>
                </div>
              </div>
            )}

            {/* ── Mode-specific controls ──────────────────────────────
                Only the active mode's fields render. Each maps 1:1 onto an
                ACE-Step request param (see `generationModes.ts`). */}

            {/* Transform renders this above the verb picker instead (see the
                header block), so it only appears here for any non-Transform
                mode that still needs a source track. */}
            {fields.sourceAudio && activeGroup !== 'transform' && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Source track <span className="text-destructive">*</span>
                </label>
                <AudioPickerField
                  value={sourceAudioUrl}
                  onPick={() => setAudioPicker('source')}
                  onClear={() => setSourceAudioUrl('')}
                  placeholder="Pick the track to work from"
                />
              </div>
            )}

            {fields.referenceAudio && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Style reference <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <AudioPickerField
                  value={referenceAudioUrl}
                  onPick={() => setAudioPicker('reference')}
                  onClear={() => setReferenceAudioUrl('')}
                  placeholder="Borrow the sound of another track"
                />
              </div>
            )}

            {/* "Sound like…" — the strongest style transfer available to us.
                Deliberately states what it did in plain terms ("Style captured")
                rather than surfacing "audio codes", which means nothing to
                anyone who hasn't read ACE-Step's internals. The code count is
                shown because it's the one honest signal that the capture is
                substantive — a near-silent clip yields very few. */}
            {fields.soundLike && (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Sound like… <span className="text-muted-foreground/70">(optional)</span>
                </label>
                {/* States the boundary that confused people: this makes a NEW
                    song in the reference's style. Changing the reference track
                    itself is Remix, in Transform. Two adjacent features that
                    both begin "give it a song" need the difference said out
                    loud, not inferred from where they sit. */}
                <p className="mb-1.5 text-[11px] leading-snug text-muted-foreground/80">
                  Makes a <strong>new</strong> song with this track&apos;s vibe. To restyle the
                  track itself, use Transform → Remix.
                </p>
                <AudioPickerField
                  value={soundLikeUrl}
                  onPick={() => setAudioPicker('soundLike')}
                  onClear={clearSoundLike}
                  placeholder="Pick a song whose style you want"
                />
                {soundLikeUrl && (
                  <div className="mt-1.5 text-[11px] leading-snug">
                    {analyzing && (
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <Spinner size="xs" /> Listening to the track…
                      </span>
                    )}
                    {!analyzing && soundLikeCodes && (
                      <div className="space-y-1">
                        <span className="block text-emerald-600 dark:text-emerald-400">
                          Style captured — the new song will follow this track&apos;s sound.
                        </span>
                        {/* What the model actually heard, in words. Without
                            this the capture is a black box: you can't tell a
                            good read from a wrong one until the song is done.
                            Absent when only codes came back — the transfer
                            still works, we just can't describe it. */}
                        {soundLikeInfo && (
                          <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
                              <span className="font-medium text-foreground/80">Heard:</span>
                              {[
                                soundLikeInfo.bpm ? `${Math.round(soundLikeInfo.bpm)} BPM` : null,
                                soundLikeInfo.keyScale || null,
                                soundLikeInfo.genre || null,
                              ].filter(Boolean).map((bit, i) => (
                                <span key={i} className="after:ml-2 after:opacity-40 after:content-['·'] last:after:content-['']">
                                  {bit}
                                </span>
                              ))}
                            </div>
                            {soundLikeInfo.caption && (
                              <p className="mt-1 italic leading-snug text-muted-foreground">
                                “{soundLikeInfo.caption}”
                              </p>
                            )}
                            {(soundLikeInfo.caption || soundLikeInfo.genre) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="mt-1 h-5 px-1.5 text-[11px]"
                                onClick={() => {
                                  const text = soundLikeInfo.caption || soundLikeInfo.genre || '';
                                  if (fields.composer) setStyle(text);
                                  else setDescription(text);
                                }}
                              >
                                {fields.composer ? 'Use as my style' : 'Use as my description'}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {!analyzing && analyzeError && (
                      <span className="flex flex-wrap items-center gap-1.5 text-amber-600 dark:text-amber-400">
                        Couldn&apos;t capture the style: {analyzeError}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 px-1.5 text-[11px]"
                          onClick={() => void captureStyle(soundLikeUrl)}
                        >
                          Retry
                        </Button>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {fields.coverStrength && (
              <div className="space-y-3">
                {/* These two labels were previously swapped in meaning.
                    "Stay close to the original" sat on `audio_cover_strength`,
                    which blends the TEXT instruction between cover and
                    non-cover modes and has nothing to do with how much of your
                    recording survives. The dial that actually governs that is
                    `cover_noise_strength`, and the model's own source states
                    the direction outright:

                      # cover_noise_strength=1 means closest to src
                      effective_noise_level = 1.0 - cover_noise_strength

                    It was defaulted to 0.15 — an effective noise level of 0.85,
                    i.e. almost nothing of the source surviving — under a help
                    string recommending 0.10-0.25, which is backwards. That is
                    the most likely reason covers came back sounding unrelated
                    to the track they were made from. */}
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">Keep the original</label>
                    <span className="font-mono text-xs text-muted-foreground">{coverNoiseStrength.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[coverNoiseStrength]} min={0} max={1} step={0.05}
                    onValueChange={([v]) => setCoverNoiseStrength(v)}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    How much of the original recording survives. Higher keeps the performance;
                    0 turns the blend off entirely.
                  </p>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-foreground">How much to change it</label>
                    <span className="font-mono text-xs text-muted-foreground">{coverStrength.toFixed(2)}</span>
                  </div>
                  <Slider
                    value={[coverStrength]} min={0} max={1} step={0.05}
                    onValueChange={([v]) => setCoverStrength(v)}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    <strong>Lower changes more.</strong> 0.3–0.5 for a real genre change,
                    0.5–0.7 moderate, 0.9–1.0 barely touches the track.
                  </p>
                </div>
              </div>
            )}

            {fields.repaintRange && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Section to redo</label>
                  <span className="font-mono text-xs text-muted-foreground">
                    {repaintStart}s – {repaintEnd}s
                  </span>
                </div>
                <div className="space-y-2">
                  <Slider
                    value={[repaintStart]} min={0} max={240} step={1}
                    onValueChange={([v]) => { setRepaintStart(v); if (v >= repaintEnd) setRepaintEnd(v + 1); }}
                  />
                  <Slider
                    value={[repaintEnd]} min={0} max={240} step={1}
                    onValueChange={([v]) => { setRepaintEnd(v); if (v <= repaintStart) setRepaintStart(Math.max(0, v - 1)); }}
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Everything outside this range is left exactly as it was.
                </p>
              </div>
            )}

            {fields.trackName && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Instrument</label>
                <SelectField value={trackName} onValueChange={setTrackName}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRACK_NAMES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </SelectField>
              </div>
            )}

            {fields.trackClasses && (
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  Instruments to add <span className="text-muted-foreground/70">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {TRACK_NAMES.map((t) => {
                    const on = trackClasses.includes(t);
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setTrackClasses(
                          on ? trackClasses.filter((x) => x !== t) : [...trackClasses, t],
                        )}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                          on
                            ? 'border-brand bg-brand/10 text-brand'
                            : 'border-dashed border-border text-muted-foreground hover:border-brand hover:text-brand',
                        )}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Supporting controls — instrumental + duration apply to both
                modes and are common enough to stay visible (not buried in
                Advanced), but visually subordinate to the composer above. */}
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
              <div>
                <div className="text-sm font-medium text-foreground">Instrumental</div>
                <div className="text-xs text-muted-foreground">No vocals — skip the lyrics entirely.</div>
              </div>
              <Switch checked={instrumental} onCheckedChange={setInstrumental} />
            </div>

            {/* Length is dictated by the source track for cover/repaint —
                those modes re-record existing audio, so a requested duration is
                silently ignored (asking 240s of a 19s source still yields 19s).
                Showing the slider there promises control that doesn't exist. */}
            {fields.sourceAudio ? (
              <div className="rounded-lg border border-dashed px-3 py-2">
                <div className="text-xs font-medium text-muted-foreground">Duration</div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Matches your source track — {activeMode.label} re-records it, so the result is
                  the same length.
                </p>
              </div>
            ) : (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Duration</label>
                  <span className="font-mono text-xs text-muted-foreground">{duration < 0 ? 'Auto' : `${duration}s`}</span>
                </div>
                <Slider value={[duration]} min={-1} max={240} step={5} onValueChange={([v]) => setDuration(v)} />
              </div>
            )}

            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Voice &amp; model</p>
              <SelectField value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger><SelectValue placeholder="Select a model" /></SelectTrigger>
                <SelectContent>
                  {models.map((m) => (
                    <SelectItem key={m.name} value={m.name}>
                      {modelLabel(m.name)}{!m.is_preloaded ? ' (not downloaded)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              {selectedModel && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {tuning.note} <span className="opacity-70">({tuning.steps} steps{tuning.usesCfg ? ', guidance on' : ''})</span>
                </p>
              )}
              {/* Loud rather than subtle: this model cannot produce usable audio
                  through the API at any setting, so a muted hint would just
                  send someone down the same parameter-tuning dead end. */}
              {selectedModel && tuning.apiBroken && (
                <div className="mt-1.5 flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                  <p className="text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                    {tuning.apiBroken}
                  </p>
                </div>
              )}
              {selectedModel && modelDescription(selectedModel) && (
                <p className="text-xs text-muted-foreground">{modelDescription(selectedModel)}</p>
              )}
              {models.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No checkpoints found — install the Music (ACE-Step) pack from the Packs page.
                </p>
              )}

              <div className="flex items-center gap-1.5 pt-1">
                <Mic2 className="h-3.5 w-3.5 text-muted-foreground" />
                <label className="text-xs font-medium text-muted-foreground">Persona (trained voice)</label>
                {loadingLora && <Spinner size="xs" />}
              </div>
              <SelectField value={selectedPersona} onValueChange={setSelectedPersona}>
                <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PERSONA}>None</SelectItem>
                  {personas.map((p) => (
                    <SelectItem key={p.path} value={p.path}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </SelectField>
              {personas.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No trained LoRAs yet — train one on the Train tab to activate a cloned voice here.
                </p>
              )}
            </div>

            <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="w-full justify-start px-0">
                  {showAdvanced ? 'Hide' : 'Show'} advanced settings
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Inference steps <span className="opacity-60">(max {tuning.maxSteps})</span></label>
                    <Input
                      type="number"
                      min={1}
                      value={inferenceSteps ?? ''}
                      placeholder="Auto"
                      onChange={(e) => setInferenceSteps(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Guidance scale</label>
                    {/* Turbo bakes guidance into its distillation and forces
                        guidance_scale to 1.0 server-side, logging the override.
                        Showing an editable box there implies a control that
                        does nothing, so it's disabled with the reason inline. */}
                    <Input
                      type="number"
                      step={0.5}
                      disabled={!tuning.usesCfg}
                      value={tuning.usesCfg ? (guidanceScale ?? '') : ''}
                      placeholder={tuning.usesCfg ? 'Auto' : 'Not used by Turbo'}
                      onChange={(e) => setGuidanceScale(e.target.value ? Number(e.target.value) : undefined)}
                    />
                    {tuning.guidanceRange && (
                      <p className={cn(
                        'mt-1 text-[11px]',
                        guidanceScale !== undefined && guidanceScale > tuning.guidanceRange[1]
                          ? 'text-amber-500' : 'text-muted-foreground',
                      )}>
                        {/* Was "distorts into static" — that described DCW being
                            forced on, not over-guidance, and it wrongly framed
                            upstream's own default of 7 as a danger zone. */}
                        {guidanceScale !== undefined && guidanceScale > tuning.guidanceRange[1]
                          ? `Above ${tuning.guidanceRange[1]} guidance tends to over-constrain this model.`
                          : `Usual range ${tuning.guidanceRange[0]}–${tuning.guidanceRange[1]}; ${tuning.guidanceScale} is upstream's default.`}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Variations</label>
                    <SelectField value={String(batchSize)} onValueChange={(v) => setBatchSize(Number(v))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4].map((n) => (
                          <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </SelectField>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">Seed</label>
                    <Input
                      type="number"
                      disabled={randomSeed}
                      value={randomSeed ? '' : seed}
                      placeholder="Random"
                      onChange={(e) => setSeed(Number(e.target.value) || 0)}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">Random seed</span>
                  <Switch checked={randomSeed} onCheckedChange={setRandomSeed} size="sm" />
                </div>

                {/* Sampler + LM controls. Left unset by default so ACE-Step
                    applies its own tier-tuned defaults — sending our own
                    numbers here would silently override them and drift as the
                    upstream defaults change. */}
                <div className="border-t pt-3">
                  <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Sampler
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Method</label>
                      <SelectField
                        value={inferMethod ?? '__auto__'}
                        onValueChange={(v) => setInferMethod(v === '__auto__' ? undefined : v as 'ode' | 'sde')}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">Default</SelectItem>
                          <SelectItem value="ode">ODE</SelectItem>
                          <SelectItem value="sde">SDE</SelectItem>
                        </SelectContent>
                      </SelectField>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        LM temperature
                      </label>
                      <Input
                        type="number" step="0.05" min="0" max="2"
                        value={lmTemperature ?? ''}
                        placeholder="Default"
                        onChange={(e) => setLmTemperature(e.target.value === '' ? undefined : Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">Adaptive guidance</span>
                      <p className="text-[11px] text-muted-foreground">Varies guidance across the sample.</p>
                    </div>
                    {/* ADG only means anything when CFG is active — upstream
                        hides it entirely for turbo (`use_adg_visible: False`). */}
                    <Switch
                      checked={useAdg}
                      onCheckedChange={setUseAdg}
                      disabled={!tuning.supportsAdg}
                      size="sm"
                    />
                  </div>

                  <div className="mt-3 flex items-center justify-between">
                    <div>
                      <span className="text-xs font-medium text-muted-foreground">Thinking</span>
                      <p className="text-[11px] text-muted-foreground">
                        Let the LM reason about the prompt first. Slower.
                      </p>
                    </div>
                    <Switch checked={thinking} onCheckedChange={setThinking} size="sm" />
                  </div>

                  <div className="mt-3">
                    <label className="mb-1 block text-xs font-medium text-muted-foreground">
                      Negative prompt
                    </label>
                    <Input
                      value={lmNegativePrompt}
                      onChange={(e) => setLmNegativePrompt(e.target.value)}
                      placeholder="What to steer away from…"
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Footer — one obvious primary action, with live feedback
              surfacing in-place once a job is running. Flips to a Cancel
              affordance once there's a jobId to cancel. */}
          <div className="flex flex-col gap-2 border-t bg-muted px-4 py-3">
            <Button
              className="w-full"
              size="lg"
              variant={canCancel ? 'outline' : 'default'}
              onClick={() => void (canCancel ? handleCancel() : handleSubmit())}
              disabled={canCancel ? false : (!canSubmit || isGenerating)}
            >
              {canCancel
                ? <X className="h-4 w-4" />
                : isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Music2 className="h-4 w-4" />}
              {canCancel ? 'Cancel' : isGenerating ? 'Generating…' : 'Generate'}
            </Button>

            {jobStatus && jobStatus.status !== 'succeeded' && jobStatus.status !== 'failed' && jobStatus.status !== 'cancelled' && (
              <GenerationProgress status={jobStatus} />
            )}
            {jobStatus?.status === 'failed' && (
              <p className="text-center text-xs text-destructive">{jobStatus.error || 'Generation failed'}</p>
            )}
            {jobStatus?.status === 'cancelled' && (
              <p className="text-center text-xs text-muted-foreground">Generation cancelled</p>
            )}
          </div>
        </div>
      </aside>

      {/* Feed — the freshest generation lands here (via the shared
          `songs` list, refreshed by `handleJobUpdate` on success) without a
          manual reload, and is playable with a single click. */}
      <section className="flex flex-1 min-w-0 flex-col rounded-xl border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b bg-card px-4 py-3">
          <h3 className="text-sm font-semibold text-foreground">Your songs</h3>
          <Button variant="ghost" size="sm" asChild>
            <NavLink to="/music/library">
              View library <ArrowRight className="h-3.5 w-3.5" />
            </NavLink>
          </Button>
        </div>
        <div className="flex-1 p-4">
          {isGenerating && (
            <div className="mb-4">
              <InlineGenerationBanner status={jobStatus} />
            </div>
          )}

          {feedSongs.length === 0 && !isGenerating ? (
            <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand/10 text-brand">
                <Music2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Make your first song</h3>
                <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
                  Describe a vibe on the left and hit Generate — your track will show up here the moment it's ready.
                </p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {feedSongs.map((song) => (
                <SongCard
                  key={song.id}
                  song={song}
                  badge={recentIds.has(song.id) ? 'New' : undefined}
                  isCurrent={currentSong?.id === song.id}
                  isPlaying={isPlaying}
                  onPlay={() => playSong(song, feedSongs)}
                  onToggleFavorite={() => void toggleFavorite(song)}
                  onAddToPlaylist={() => openAddToPlaylist(song)}
                  onRename={(t) => void renameSong(song, t)}
                  onDelete={() => void removeSong(song)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Shared media picker in audio mode — the same component Studio uses
          for image inputs. Browses ComfyUI's input/output trees, which is
          where generated songs now live, so your own songs are selectable as
          source/reference material. The chosen `/api/view?...` URL resolves
          server-side via `resolveComfyViewUrl` in `services/ace/acestep.ts`. */}
      <MediaLibraryModal
        open={audioPicker !== null}
        onClose={() => setAudioPicker(null)}
        kind="audio"
        onSelect={(item) => {
          const url = `/api/view?filename=${encodeURIComponent(item.filename)}`
            + `&subfolder=${encodeURIComponent(item.subfolder)}`
            + `&type=${encodeURIComponent(item.source)}`;
          if (audioPicker === 'source') setSourceAudioUrl(url);
          else if (audioPicker === 'reference') setReferenceAudioUrl(url);
          else if (audioPicker === 'soundLike') {
            setSoundLikeUrl(url);
            void captureStyle(url);
          }
          setAudioPicker(null);
        }}
      />
    </div>
  );
}

/** Compact in-place status banner shown above the feed while a job runs —
 *  generation feedback stays visible without leaving the page or refreshing
 *  anything; the finished song simply appears in the grid below it. */
function InlineGenerationBanner({ status }: { status: GenerationStatusResponse | null }) {
  const percent = status?.progress !== undefined ? Math.round(status.progress * 100) : null;
  const stage = status?.stage || (status?.status === 'queued' ? 'Queued' : 'Generating');
  const extras = [
    status?.queuePosition !== undefined ? `queue #${status.queuePosition}` : null,
    status?.etaSeconds !== undefined ? `~${Math.round(status.etaSeconds)}s left` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-brand/40 bg-brand/5 px-3 py-2.5">
      <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand/10">
        <ProgressCircle percent={percent ?? 8} className="h-6 w-6" fillClassName="stroke-brand" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">Generating your song…</div>
        <div className="truncate text-xs text-muted-foreground">
          {stage}{percent !== null ? ` · ${percent}%` : ''}{extras ? ` · ${extras}` : ''}
        </div>
      </div>
    </div>
  );
}

/** Footer-local echo of the same progress, styled thin to fit under the
 *  Generate button. */
function GenerationProgress({ status }: { status: GenerationStatusResponse }) {
  const percent = status.progress !== undefined ? Math.round(status.progress * 100) : null;
  return (
    <div className="space-y-1.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-brand transition-all"
          style={{ width: `${percent ?? 8}%` }}
        />
      </div>
      <p className="text-center text-xs text-muted-foreground">
        {status.stage || (status.status === 'queued' ? 'Queued…' : 'Generating…')}
        {percent !== null ? ` · ${percent}%` : ''}
      </p>
    </div>
  );
}

export default CreateTab;
