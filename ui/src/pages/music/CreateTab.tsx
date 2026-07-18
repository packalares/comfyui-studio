// Create — the generation form. Ported from ace-step-ui's `CreatePanel.tsx`
// (trimmed to the core Suno-style flow: Simple vs Custom mode, style/lyrics,
// title, instrumental, duration, model pick, and a handful of advanced
// knobs). Cover/audio2audio, repainting, and expert LM-sampling tuning are
// deliberately NOT ported — see the Music page TODOs in the final report;
// they're a distinct feature (cover mode) not attempted here.
//
// The persona/LoRA picker (originally deferred — see the previous version of
// this comment) is now wired: `GET /ace/training/lora-checkpoints` (added
// alongside the Train tab) backs a Select here, and picking a persona loads
// that adapter into the resident ACE-Step FastAPI via `POST /ace/lora/load`
// immediately before submitting generation (there's no `lora` field on
// `GenerationParams` — the adapter is process-resident state, not a per-job
// param — see `generate.contract.ts` + `lora.contract.ts`).

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Dice5, Loader2, Mic2, Music2, Sparkles, Wand2, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Slider } from '../../components/ui/slider';
import { Spinner } from '../../components/ui/spinner';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import {
  SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/forms/SelectField';
import { SongRow } from './SongRow';
import { useMusic } from './MusicContext';
import { modelDescription, modelLabel } from './aceModelInfo';
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

const NO_PERSONA = '__none__';

export function CreateTab() {
  const { playSong, refreshSongs } = useMusic();

  const [mode, setMode] = useState<'simple' | 'custom'>('simple');
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
        const active = list.find((m) => m.is_active) ?? list.find((m) => m.is_preloaded) ?? list[0];
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

  const isGenerating = submitting || (jobStatus !== null && jobStatus.status !== 'succeeded' && jobStatus.status !== 'failed');

  const canSubmit = mode === 'simple'
    ? description.trim().length > 0
    : (style.trim().length > 0 || lyrics.trim().length > 0);

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
      toast.error('Enhance failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setEnhancing(false);
    }
  };

  const runSubmit = async (params: GenerationParams) => {
    setSubmitting(true);
    setJobStatus(null);
    setRecentSongs([]);
    try {
      const { jobId } = await api.submitGeneration(params);
      setJobStatus({ jobId, status: 'queued' });
      // Supersede any previous poll before starting a new one, so two
      // submissions can't race to write `jobStatus`.
      pollRef.current?.cancel();
      pollRef.current = api.pollGenerationStatus(jobId, async (status) => {
        setJobStatus(status);
        if (status.status === 'succeeded' && status.result) {
          const expected = status.result.audioUrls.length;
          const fresh = await refreshSongs();
          const newest = fresh.slice(0, expected);
          setRecentSongs(newest);
          if (newest.length > 0) playSong(newest[0], newest);
          toast.success(expected > 1 ? `${expected} variations ready` : 'Song ready');
        } else if (status.status === 'failed') {
          toast.error('Generation failed', { description: status.error ?? undefined });
        }
      });
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
    const base: GenerationParams = {
      ...api.defaultGenerationParams(),
      customMode: mode === 'custom',
      instrumental,
      duration: duration >= 0 ? duration : undefined,
      inferenceSteps,
      guidanceScale,
      batchSize,
      randomSeed,
      seed: randomSeed ? undefined : seed,
      ditModel: selectedModel || undefined,
    };
    if (mode === 'simple') {
      await runSubmit({ ...base, songDescription: description.trim() });
    } else {
      await runSubmit({
        ...base,
        style: style.trim(),
        lyrics: instrumental ? '' : lyrics,
        title: title.trim(),
        vocalLanguage,
      });
    }
  };

  const progressPercent = jobStatus?.progress !== undefined ? Math.round(jobStatus.progress * 100) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Music2 className="h-4 w-4 text-brand" /> Create
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'simple' | 'custom')}>
            <TabsList>
              <TabsTrigger value="simple">Simple</TabsTrigger>
              <TabsTrigger value="custom">Custom</TabsTrigger>
            </TabsList>

            <TabsContent value="simple" className="mt-4 space-y-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Describe your song</label>
                  <Button variant="ghost" size="sm" onClick={() => void rollDescription()} disabled={rolling}>
                    {rolling ? <Spinner size="xs" /> : <Dice5 className="h-3.5 w-3.5" />}
                    Surprise me
                  </Button>
                </div>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="A dreamy synthwave track about driving at night, female vocals, nostalgic mood…"
                  className="h-28 resize-none"
                />
              </div>
            </TabsContent>

            <TabsContent value="custom" className="mt-4 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Title</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" />
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Style</label>
                  <Button variant="ghost" size="sm" onClick={() => void handleEnhance()} disabled={enhancing || !style.trim()}>
                    {enhancing ? <Spinner size="xs" /> : <Sparkles className="h-3.5 w-3.5" />}
                    Enhance
                  </Button>
                </div>
                <StyleTagInput value={style} onChange={setStyle} />
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
                    className="h-40 resize-none font-mono text-xs"
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
            </TabsContent>
          </Tabs>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
            <div>
              <div className="text-sm font-medium text-foreground">Instrumental</div>
              <div className="text-xs text-muted-foreground">No vocals — skip the lyrics entirely.</div>
            </div>
            <Switch checked={instrumental} onCheckedChange={setInstrumental} />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Duration</label>
              <span className="font-mono text-xs text-muted-foreground">{duration < 0 ? 'Auto' : `${duration}s`}</span>
            </div>
            <Slider value={[duration]} min={-1} max={240} step={5} onValueChange={([v]) => setDuration(v)} />
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
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">Inference steps</label>
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
                  <Input
                    type="number"
                    step={0.5}
                    value={guidanceScale ?? ''}
                    placeholder="Auto"
                    onChange={(e) => setGuidanceScale(e.target.value ? Number(e.target.value) : undefined)}
                  />
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
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Model</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
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
            {selectedModel && modelDescription(selectedModel) && (
              <p className="text-xs text-muted-foreground">{modelDescription(selectedModel)}</p>
            )}
            {models.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No checkpoints found — install the Music (ACE-Step) pack from the Packs page.
              </p>
            )}

            <div className="border-t border-border pt-3">
              <div className="mb-1 flex items-center gap-1.5">
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
              {personas.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  No trained LoRAs yet — train one on the Train tab to activate a cloned voice here.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Loaded into the generator right before you hit Generate.
                </p>
              )}
            </div>

            <Button className="w-full" size="lg" onClick={() => void handleSubmit()} disabled={!canSubmit || isGenerating}>
              {isGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Music2 className="h-4 w-4" />}
              {isGenerating ? 'Generating…' : 'Generate'}
            </Button>

            {jobStatus && jobStatus.status !== 'succeeded' && jobStatus.status !== 'failed' && (
              <div className="space-y-1.5">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand transition-all"
                    style={{ width: `${progressPercent ?? 8}%` }}
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  {jobStatus.stage || (jobStatus.status === 'queued' ? 'Queued…' : 'Generating…')}
                  {progressPercent !== null ? ` · ${progressPercent}%` : ''}
                </p>
              </div>
            )}
            {jobStatus?.status === 'failed' && (
              <p className="text-xs text-destructive">{jobStatus.error || 'Generation failed'}</p>
            )}
          </CardContent>
        </Card>

        {recentSongs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Just generated</CardTitle>
            </CardHeader>
            <CardContent className="space-y-0.5">
              <RecentSongs songs={recentSongs} />
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function RecentSongs({ songs }: { songs: Song[] }) {
  const {
    currentSong, isPlaying, playSong, toggleFavorite, openAddToPlaylist, renameSong, removeSong,
  } = useMusic();
  return (
    <>
      {songs.map((song) => (
        <SongRow
          key={song.id}
          song={song}
          isCurrent={currentSong?.id === song.id}
          isPlaying={isPlaying}
          onPlay={() => playSong(song, songs)}
          onToggleFavorite={() => void toggleFavorite(song)}
          onAddToPlaylist={() => openAddToPlaylist(song)}
          onRename={(title) => void renameSong(song, title)}
          onDelete={() => void removeSong(song)}
        />
      ))}
    </>
  );
}

export default CreateTab;
