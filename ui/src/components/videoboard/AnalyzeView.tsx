// AnalyzeView — full Analyze tab.
// Layout: Audio + Lyrics (2-col row) → Summary / Genre / Rhythm 3-card grid →
// Director Notes (conditional) → Shot Settings (slim) → Characters strip →
// Fixed bottom action bar with the "Generate Storyboard" CTA.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Check,
  FileText,
  Film,
  Loader2,
  MoreVertical,
  Music,
  Pause,
  Play,
  Sparkles,
  UserCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Slider } from '../ui/slider';
import { Textarea } from '../ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Waveform } from './Waveform';
import ConfirmDialog from '../modals/ConfirmDialog';
import { cn } from '../../lib/utils';
import {
  generateStoryboard,
  listCharacters,
  updateProjectSettings,
  type Analysis,
  type Character,
  type Project,
  type ProjectSettings,
} from '../../api/videoboard';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AnalyzeViewProps {
  project: Project;
  analysis: Analysis | null;
  /** Incremented by the parent whenever audio is replaced; busts the browser cache. */
  audioVersion: number;
  onReplaceAudio: () => void;
  onRemoveAudio: () => void;
  onSettingsChange: (partial: Partial<Project>) => void;
  onCharacterChange: (ids: string[]) => void;
  onStoryboardGenerated: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border bg-muted/40 px-3 py-2.5">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="text-lg font-semibold text-foreground leading-tight">{value}</span>
    </div>
  );
}

// `[Verse 1]`, `[Chorus]`, `[Drum fill]` etc. on their own line — the
// transcriber emits these inline with the lyrics. Render them as a small
// uppercase label so the lyric body becomes scannable.
const SECTION_LABEL_RE = /^\s*\[[^\]]+\]\s*$/;

function LyricsRenderer({ lyrics }: { lyrics: string }) {
  const lines = lyrics.split('\n');
  return (
    <div className="max-h-[280px] overflow-y-auto px-4 py-3 text-xs leading-relaxed text-foreground font-sans">
      {lines.map((line, idx) => {
        if (SECTION_LABEL_RE.test(line)) {
          return (
            <div
              key={idx}
              className="text-[10px] font-bold uppercase tracking-wider text-brand mt-3 first:mt-0 mb-0.5"
            >
              {line.trim()}
            </div>
          );
        }
        if (line.trim() === '') {
          return <div key={idx} className="h-2" />;
        }
        return (
          <div key={idx} className="leading-snug">
            {line}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolution presets
// ---------------------------------------------------------------------------

interface ResolutionPreset {
  label: string
  width: number
  height: number
}

const RESOLUTION_PRESETS: ResolutionPreset[] = [
  { label: '1024 × 1024 (square)', width: 1024, height: 1024 },
  { label: '1328 × 1328 (Qwen native)', width: 1328, height: 1328 },
  { label: '1080 × 1920 (vertical 9:16)', width: 1080, height: 1920 },
  { label: '1920 × 1080 (horizontal 16:9)', width: 1920, height: 1080 },
  { label: '832 × 1216 (portrait 2:3)', width: 832, height: 1216 },
  { label: '1216 × 832 (landscape 3:2)', width: 1216, height: 832 },
]

const CUSTOM_VALUE = 'custom'

function matchPreset(w?: number, h?: number): string {
  if (!w || !h) return RESOLUTION_PRESETS[0].label
  const match = RESOLUTION_PRESETS.find((p) => p.width === w && p.height === h)
  return match ? match.label : CUSTOM_VALUE
}

// ---------------------------------------------------------------------------

const EMPTY_ANALYSIS_STATE = (
  <p className="text-xs text-muted-foreground">
    No analysis data yet. Run the audio through{' '}
    <strong className="font-medium text-foreground">Analyze</strong> to populate this card.
  </p>
);

// ---------------------------------------------------------------------------
// Settings helpers (debounced emitter)
// ---------------------------------------------------------------------------

function useDebouncedEmitter(
  project: Project,
  onChange: (partial: Partial<Project>) => void,
  delay = 300,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<ProjectSettings>>({});
  const settingsRef = useRef(project.settings);
  settingsRef.current = project.settings;

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (Object.keys(pendingRef.current).length === 0) return;
    const patch = pendingRef.current;
    pendingRef.current = {};
    onChange({ settings: { ...settingsRef.current, ...patch } });
  }, [onChange]);

  const emit = useCallback(
    (patch: Partial<ProjectSettings>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, delay);
    },
    [flush, delay],
  );

  useEffect(() => () => void flush(), [flush]);

  return emit;
}

// ---------------------------------------------------------------------------
// Character strip
// ---------------------------------------------------------------------------

interface CharacterStripProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

function CharacterStrip({ selectedIds, onChange }: CharacterStripProps) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listCharacters()
      .then(setCharacters)
      .catch(() => setCharacters([]))
      .finally(() => setLoading(false));
  }, []);

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading characters…
      </div>
    );
  }

  if (characters.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">
        No characters yet. Create one in the{' '}
        <a href="/videoboard/characters" className="text-brand hover:underline">
          Characters library
        </a>
        .
      </p>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {characters.map((c) => {
        const selected = selectedIds.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => toggle(c.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-left text-xs transition-colors cursor-pointer',
              selected
                ? 'border-brand bg-brand/10 text-brand'
                : 'border-border bg-card text-foreground hover:bg-muted',
            )}
          >
            {c.refPhotoUrls[0] ? (
              <img
                src={c.refPhotoUrls[0]}
                alt={c.name}
                className="w-5 h-5 rounded-full object-cover shrink-0"
              />
            ) : (
              <UserCircle2 className="w-5 h-5 shrink-0 text-muted-foreground" />
            )}
            <span className="font-medium whitespace-nowrap">{c.name}</span>
            {selected && <Check className="w-3 h-3 shrink-0 text-brand" />}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AnalyzeView({
  project,
  analysis,
  audioVersion,
  onReplaceAudio,
  onRemoveAudio,
  onSettingsChange,
  onCharacterChange,
  onStoryboardGenerated,
}: AnalyzeViewProps) {
  // Audio playback state
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Seek cross-sync guard (avoid waveform feedback loop)
  const skipNextSyncRef = useRef(false);


  // Settings
  const settings = project.settings;
  const debouncedEmit = useDebouncedEmitter(project, onSettingsChange);
  const [localFixedSec, setLocalFixedSec] = useState(settings.fixedShotSeconds);
  const [localStyleHint, setLocalStyleHint] = useState(settings.styleHint);

  // Resolution state
  const [selectedPreset, setSelectedPreset] = useState(() => matchPreset(settings.imageWidth, settings.imageHeight));
  const [customWidth, setCustomWidth] = useState(settings.imageWidth ?? 1024);
  const [customHeight, setCustomHeight] = useState(settings.imageHeight ?? 1024);

  // Keep local resolution state in sync with external changes
  useEffect(() => {
    setSelectedPreset(matchPreset(settings.imageWidth, settings.imageHeight));
    if (settings.imageWidth) setCustomWidth(settings.imageWidth);
    if (settings.imageHeight) setCustomHeight(settings.imageHeight);
  }, [settings.imageWidth, settings.imageHeight]);

  // Generate storyboard
  //
  // Two truths get OR'd together so the button stays disabled across the
  // entire job lifetime, not just the HTTP call:
  //  - `clicking` flips true on click and false once POST returns (~ms).
  //    Bridges the gap between click and the WS broadcast confirming the
  //    backend flipped project.status.
  //  - `project.status === 'generating'` is the durable backend state.
  //    Backend sets it to 'generating' at job start, back to 'draft' on
  //    done/error; the WS bus (videoboardEvents → setProject in
  //    VideoboardProject.tsx:93) keeps it in sync — no polling.
  // Same shape as the Analyze pattern at VideoboardProject.tsx:61.
  const [clicking, setClicking] = useState(false);
  const analysisReady = project.analysisStatus === 'ready';
  const generating = clicking || project.status === 'generating';

  // Keep local slider/textarea state in sync with external changes
  useEffect(() => { setLocalFixedSec(settings.fixedShotSeconds); }, [settings.fixedShotSeconds]);
  useEffect(() => { setLocalStyleHint(settings.styleHint); }, [settings.styleHint]);

  // Reset audio state when src changes (audioVersion increments on replace)
  const audioSrc = `/api/videoboard/projects/${project.id}/audio?v=${audioVersion}`;
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [audioSrc]);

  const handlePlayPause = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  const handleWaveformSeek = useCallback((t: number) => {
    skipNextSyncRef.current = true;
    const el = audioRef.current;
    if (el) el.currentTime = t;
    setCurrentTime(t);
  }, []);

  // Sync external currentTime into waveform — handled inside Waveform via prop

  const handleFixedSecChange = useCallback(
    ([v]: number[]) => {
      const val = v ?? settings.fixedShotSeconds;
      setLocalFixedSec(val);
      debouncedEmit({ fixedShotSeconds: val });
    },
    [debouncedEmit, settings.fixedShotSeconds],
  );

  const handleStyleHintChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setLocalStyleHint(val);
      debouncedEmit({ styleHint: val });
    },
    [debouncedEmit],
  );

  const saveResolution = useCallback(
    async (w: number, h: number) => {
      try {
        const updated = await updateProjectSettings(project.id, { imageWidth: w, imageHeight: h }, settings);
        onSettingsChange({ settings: updated.settings });
      } catch (err) {
        toast.error('Failed to save resolution', {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [project.id, settings, onSettingsChange],
  );

  const handlePresetChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      setSelectedPreset(val);
      if (val === CUSTOM_VALUE) return;
      const preset = RESOLUTION_PRESETS.find((p) => p.label === val);
      if (!preset) return;
      setCustomWidth(preset.width);
      setCustomHeight(preset.height);
      await saveResolution(preset.width, preset.height);
    },
    [saveResolution],
  );

  const handleCustomDimBlur = useCallback(async () => {
    if (selectedPreset !== CUSTOM_VALUE) return;
    const w = Math.max(64, Math.min(8192, customWidth || 1024));
    const h = Math.max(64, Math.min(8192, customHeight || 1024));
    setCustomWidth(w);
    setCustomHeight(h);
    await saveResolution(w, h);
  }, [selectedPreset, customWidth, customHeight, saveResolution]);

  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);

  const doGenerateStoryboard = useCallback(async () => {
    setClicking(true);
    try {
      await generateStoryboard(project.id);
      // Done — backend has flipped project.status to 'generating' and the WS
      // event is already inbound; from here on, `project.status` keeps the
      // button disabled until the run completes.
      onStoryboardGenerated();
    } catch (err) {
      toast.error('Could not generate storyboard', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClicking(false);
    }
  }, [project.id, onStoryboardGenerated]);

  const handleGenerateStoryboard = useCallback(() => {
    if (!analysisReady || generating) return;
    const existingCount = project.shots?.length ?? 0;
    if (existingCount > 0) {
      setConfirmReplaceOpen(true);
      return;
    }
    void doGenerateStoryboard();
  }, [analysisReady, generating, project.shots, doGenerateStoryboard]);

  const handleConfirmReplace = useCallback(async () => {
    setConfirmReplaceOpen(false);
    await doGenerateStoryboard();
  }, [doGenerateStoryboard]);

  const replaceStats = (() => {
    const shots = project.shots ?? [];
    const total = shots.length;
    const withImages = shots.filter(s => !!s.imageUrl).length;
    const withVideos = shots.filter(s => !!s.videoUrl).length;
    return { total, withImages, withVideos };
  })();

  // Derived data
  const meta = analysis?.audio_meta;
  const fileName = project.audioPath?.split('/').pop() ?? project.name;
  const totalDuration = duration || (project.audioDurationMs ?? 0) / 1000;

  const bpm = analysis?.bpm != null ? Math.round(analysis.bpm).toString() : '—';
  const tempoRange =
    analysis?.bpm_min != null && analysis?.bpm_max != null
      ? `${Math.round(analysis.bpm_min)}–${Math.round(analysis.bpm_max)} BPM`
      : '—';
  const timeSig = analysis?.time_signature ?? '—';
  const tempoTag = analysis?.tempo_tag ?? '—';

  const hasGenreStyle =
    (analysis?.keywords?.length ?? 0) > 0 ||
    analysis?.genre != null ||
    analysis?.mood != null ||
    analysis?.style != null;

  const lyrics = analysis?.lyrics ?? '';

  return (
    // pb-28 reserves space for the fixed bottom action bar so the last card
    // (Characters strip) doesn't get visually clipped while scrolling.
    <div className="space-y-4 pb-28">
      {/* ------------------------------------------------------------------ */}
      {/* Row 1: Audio (left) + Lyrics (right) on same row                   */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Music className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="flex-1">Audio</CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="shrink-0 rounded p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                aria-label="Audio options"
              >
                <MoreVertical className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onReplaceAudio}>Replace audio</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onRemoveAudio}>
                  Remove audio
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Compact metadata row */}
          <p className="text-[11px] text-muted-foreground mt-1 flex flex-wrap items-center gap-1">
            <span className="font-medium text-foreground">{fileName}</span>
            {meta?.format && (
              <>
                <span className="opacity-40">·</span>
                <span>{meta.format.toUpperCase()}</span>
              </>
            )}
            {meta?.size_bytes != null && (
              <>
                <span className="opacity-40">·</span>
                <span>{formatBytes(meta.size_bytes)}</span>
              </>
            )}
            {meta?.bitrate_kbps != null && (
              <>
                <span className="opacity-40">·</span>
                <span>{meta.bitrate_kbps} Kbps</span>
              </>
            )}
            {meta?.channels != null && (
              <>
                <span className="opacity-40">·</span>
                <span>{meta.channels === 1 ? 'Mono' : meta.channels === 2 ? 'Stereo' : `${meta.channels}ch`}</span>
              </>
            )}
            {meta?.sample_rate != null && (
              <>
                <span className="opacity-40">·</span>
                <span>{(meta.sample_rate / 1000).toFixed(1)} kHz</span>
              </>
            )}
          </p>
        </CardHeader>

        <CardContent>
          {/* Hidden audio element */}
          <audio
            ref={audioRef}
            src={audioSrc}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={() => {
              const el = audioRef.current;
              if (el) setCurrentTime(el.currentTime);
            }}
            onLoadedMetadata={() => {
              const el = audioRef.current;
              if (el) setDuration(el.duration);
            }}
            preload="metadata"
          />

          {/* Play row */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePlayPause}
              className="shrink-0 rounded-full p-2 hover:bg-muted transition-colors text-foreground"
              aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
            </button>

            <span className="shrink-0 font-mono text-xs text-muted-foreground w-20 text-center">
              {formatTime(currentTime)} / {formatTime(totalDuration)}
            </span>

            <div className="flex-1 min-w-0">
              <Waveform
                src={audioSrc}
                height={60}
                currentTime={currentTime}
                onSeek={handleWaveformSeek}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Card E — Lyrics (right column of row 1)                            */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Lyrics
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {lyrics.length > 0 ? (
            <LyricsRenderer lyrics={lyrics} />
          ) : (
            <div className="px-4 py-4 text-xs text-muted-foreground">
              No lyrics data yet. Run analysis to extract lyrics.
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Cards B/C/D — Summary / Genre & Style / Rhythm & Tempo              */}
      {/* ------------------------------------------------------------------ */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card B: Analysis Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            {analysis?.short_description ? (
              <>
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                  {analysis.short_description}
                </p>
                {analysis.full_description && (
                  <details className="mt-2">
                    <summary className="text-xs text-brand cursor-pointer select-none hover:underline">
                      Show full description
                    </summary>
                    <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {analysis.full_description}
                    </p>
                  </details>
                )}
              </>
            ) : (
              EMPTY_ANALYSIS_STATE
            )}
          </CardContent>
        </Card>

        {/* Card C: Genre & Style */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Music className="h-4 w-4 text-muted-foreground" />
              Genre &amp; Style
            </CardTitle>
          </CardHeader>
          <CardContent>
            {hasGenreStyle ? (
              <div className="space-y-3">
                {(analysis?.keywords?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Keywords
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {analysis!.keywords!.map((k) => (
                        <Badge key={k} variant="neutral" treatment="soft">
                          {k}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {(analysis?.instruments?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Instruments
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {analysis!.instruments!.map((i) => (
                        <Badge key={i} variant="brand" treatment="soft">
                          {i}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {(analysis?.color_palette?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Color Palette
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {analysis!.color_palette!.map((c) => (
                        <div
                          key={c}
                          title={c}
                          className="h-6 w-6 rounded-full border border-border shrink-0"
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                  </div>
                )}
                {(analysis?.genre || analysis?.mood || analysis?.style) && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground pt-1 border-t">
                    {analysis?.genre && (
                      <span>
                        Genre:{' '}
                        <span className="text-foreground font-medium">{analysis.genre}</span>
                      </span>
                    )}
                    {analysis?.mood && (
                      <span>
                        Mood:{' '}
                        <span className="text-foreground font-medium">{analysis.mood}</span>
                      </span>
                    )}
                    {analysis?.style && (
                      <span>
                        Style:{' '}
                        <span className="text-foreground font-medium">{analysis.style}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            ) : (
              EMPTY_ANALYSIS_STATE
            )}
          </CardContent>
        </Card>

        {/* Card D: Rhythm & Tempo */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Rhythm &amp; Tempo
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <StatTile label="BPM" value={bpm} />
              <StatTile label="Tempo Range" value={tempoRange} />
              <StatTile label="Time Signature" value={timeSig} />
              <StatTile label="Tempo Tag" value={tempoTag} />
              <StatTile label="Key" value={analysis?.keyscale ?? '—'} />
              <StatTile label="Language" value={analysis?.language ?? analysis?.lang_code ?? '—'} />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Director Notes — vocals / era / arc / subject / setting             */}
      {/* (only when the captioner produced any of them)                      */}
      {/* ------------------------------------------------------------------ */}
      {analysis && (
        analysis.vocals
          || analysis.era_feel
          || analysis.narrative_arc
          || analysis.subject
          || analysis.setting_hint
      ) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-muted-foreground" />
              Director Notes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
              {analysis.vocals && <StatTile label="Vocals" value={analysis.vocals} />}
              {analysis.era_feel && <StatTile label="Era" value={analysis.era_feel} />}
              {analysis.narrative_arc && <StatTile label="Narrative Arc" value={analysis.narrative_arc} />}
              {analysis.subject && <StatTile label="Subject" value={analysis.subject} />}
              {analysis.setting_hint && <StatTile label="Setting" value={analysis.setting_hint} />}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Shot Settings — minimal: target shot length + free-form style hint  */}
      {/* (BPM mode + snap switches removed — TODO.md §2 has the deferred set) */}
      {/* ------------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Film className="h-4 w-4 text-muted-foreground" />
            Shot Settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {/* Target shot length */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">Target shot length</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {localFixedSec.toFixed(1)} s
                </span>
              </div>
              <Slider
                min={3}
                max={30}
                step={0.5}
                value={[localFixedSec]}
                onValueChange={handleFixedSecChange}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>3 s</span>
                <span>30 s</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-snug">
                The Director rounds to whole shots that fit each 30 s audio window.
              </p>
            </div>

            {/* Style hint */}
            <div className="space-y-2">
              <label htmlFor="style-hint" className="text-xs font-medium text-foreground block">
                Style hint <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Textarea
                id="style-hint"
                value={localStyleHint}
                onChange={handleStyleHintChange}
                placeholder="e.g. 1970s grindhouse, neon-saturated, anamorphic, handheld — references, palettes, era cues."
                className="min-h-[88px] text-xs leading-relaxed resize-none"
              />
              <p className="text-[11px] text-muted-foreground leading-snug">
                Free-form direction passed to the Director. Leave blank for model-led choice.
              </p>
            </div>

            {/* Image resolution */}
            <div className="space-y-2">
              <label htmlFor="image-resolution" className="text-xs font-medium text-foreground block">
                Image resolution
              </label>
              <select
                id="image-resolution"
                value={selectedPreset}
                onChange={(e) => void handlePresetChange(e)}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {RESOLUTION_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>{p.label}</option>
                ))}
                <option value={CUSTOM_VALUE}>Custom…</option>
              </select>
              {selectedPreset === CUSTOM_VALUE && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    step={8}
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    onBlur={() => void handleCustomDimBlur()}
                    className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Custom width"
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                  <input
                    type="number"
                    min={64}
                    max={8192}
                    step={8}
                    value={customHeight}
                    onChange={(e) => setCustomHeight(Number(e.target.value))}
                    onBlur={() => void handleCustomDimBlur()}
                    className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    aria-label="Custom height"
                  />
                </div>
              )}
              <p className="text-[11px] text-muted-foreground leading-snug">
                Resolution used when generating shot images.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------------ */}
      {/* Characters horizontal strip                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="border-t pt-4 pb-2">
        <p className="mb-2 text-xs font-semibold text-muted-foreground">Characters</p>
        <CharacterStrip
          selectedIds={project.characterIds}
          onChange={onCharacterChange}
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Floating Generate button — single centered pill above the page.    */}
      {/* `pointer-events-none` on the wrapper keeps the surrounding area    */}
      {/* click-through; the button re-enables its own pointer events.       */}
      {/* ------------------------------------------------------------------ */}
      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center">
        <Button
          size="lg"
          onClick={() => void handleGenerateStoryboard()}
          disabled={generating || !analysisReady}
          className="pointer-events-auto gap-2 px-8 shadow-xl"
          aria-disabled={generating || !analysisReady}
        >
          {generating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {generating ? 'Generating Storyboard…' : 'Generate Storyboard'}
        </Button>
      </div>

      <ConfirmDialog
        open={confirmReplaceOpen}
        onClose={() => setConfirmReplaceOpen(false)}
        title="Replace existing storyboard?"
        description={
          `This will delete ${replaceStats.total} existing shot${replaceStats.total === 1 ? '' : 's'}`
          + (replaceStats.withImages > 0 ? `, ${replaceStats.withImages} generated image${replaceStats.withImages === 1 ? '' : 's'}` : '')
          + (replaceStats.withVideos > 0 ? `, ${replaceStats.withVideos} generated video${replaceStats.withVideos === 1 ? '' : 's'}` : '')
          + ` immediately, then run the Director with your current settings (shot length, style hint). This cannot be undone.`
        }
        confirmLabel="Delete and regenerate"
        confirmTone="danger"
        onConfirm={handleConfirmReplace}
      />
    </div>
  );
}
