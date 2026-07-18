// TTS — voice-clone speech synthesis (IndexTTS2). Ported from ace-step-ui's
// `TTSPanel.tsx`, rebuilt on comfy's Card/Button/Input/Slider primitives.
// Trimmed vs ace-step-ui: no "Save to library" action — comfy's songs
// contract has no `POST /ace/songs` (songs are only created as a side effect
// of `/ace/generate`; see the final report's TODO list) — so results stay
// download/play-only, backed by a local `<audio>` element rather than the
// Music page's shared player (TTS clips aren't `Song` rows).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDown, ChevronRight, Dice5, Download, Loader2, Mic2, Play, Pause,
  RotateCcw, Sparkles, Upload, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/textarea';
import { Slider } from '../../components/ui/slider';
import { Switch } from '../../components/ui/switch';
import { Input } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';
import { cn } from '../../lib/utils';
import * as api from '../../services/ace';
import type { TtsStatus } from '../../types/ace';

const MAX_TEXT = 5000;
const EMOTION_LABELS = ['Happy', 'Angry', 'Sad', 'Afraid', 'Disgust', 'Sad-Low', 'Surprise', 'Calm'];

type EmotionMode = 'none' | 'audio' | 'text' | 'vector';

export function TtsTab() {
  // Reference voice
  const [refFile, setRefFile] = useState<File | null>(null);
  const [refUrl, setRefUrl] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const refInputRef = useRef<HTMLInputElement>(null);

  // Text
  const [text, setText] = useState('');

  // Emotion controls
  const [emotionExpanded, setEmotionExpanded] = useState(false);
  const [emoMode, setEmoMode] = useState<EmotionMode>('none');
  const [emoFile, setEmoFile] = useState<File | null>(null);
  const [emoText, setEmoText] = useState('');
  const [emoVector, setEmoVector] = useState<number[]>(() => Array(8).fill(0));
  const [emoAlpha, setEmoAlpha] = useState(1.0);
  const emoInputRef = useRef<HTMLInputElement>(null);

  // Advanced
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const [fp16, setFp16] = useState(true);
  const [seed, setSeed] = useState('');
  const [randomSeed, setRandomSeed] = useState(true);
  const [intervalSilence, setIntervalSilence] = useState(200);

  // Job state
  const [job, setJob] = useState<TtsStatus | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<{ cancel: () => void } | null>(null);

  // Player
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const [resultPlaying, setResultPlaying] = useState(false);

  useEffect(() => () => {
    if (refUrl) URL.revokeObjectURL(refUrl);
    pollRef.current?.cancel();
  }, [refUrl]);

  const handleRefFileSelected = useCallback((file: File) => {
    if (refUrl) URL.revokeObjectURL(refUrl);
    setRefFile(file);
    setRefUrl(URL.createObjectURL(file));
  }, [refUrl]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('audio/')) handleRefFileSelected(file);
  }, [handleRefFileSelected]);

  const clearRef = () => {
    if (refUrl) URL.revokeObjectURL(refUrl);
    setRefFile(null);
    setRefUrl(null);
    if (refInputRef.current) refInputRef.current.value = '';
  };

  const updateEmoVector = (idx: number, value: number) => {
    setEmoVector((prev) => { const next = [...prev]; next[idx] = value; return next; });
  };

  const emoVectorSum = useMemo(() => emoVector.reduce((a, b) => a + b, 0), [emoVector]);

  const canGenerate = !!refFile && text.trim().length > 0 && !submitting && job?.status !== 'running' && job?.status !== 'queued';

  const handleGenerate = async () => {
    if (!refFile || !text.trim()) return;
    setErrorMsg(null);
    setJob(null);
    setSubmitting(true);
    try {
      const { jobId } = await api.submitTtsClone({
        refAudio: refFile,
        text: text.trim(),
        emoAudio: emoMode === 'audio' ? (emoFile ?? undefined) : undefined,
        emoText: emoMode === 'text' && emoText.trim() ? emoText.trim() : undefined,
        emoVector: emoMode === 'vector' ? emoVector : undefined,
        emoAlpha: emoMode !== 'none' ? emoAlpha : undefined,
        fp16,
        seed: !randomSeed && seed.trim() ? Number(seed.trim()) : undefined,
        intervalSilence,
      });
      setJob({
        id: jobId, status: 'running', progress: 0.05, log: [], createdAt: Date.now(), updatedAt: Date.now(),
      });
      pollRef.current?.cancel();
      pollRef.current = api.pollTtsStatus(jobId, (j) => {
        setJob(j);
        if (j.status === 'failed') setErrorMsg(j.error || 'Generation failed');
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generation failed';
      setErrorMsg(message);
      toast.error('Voice-clone generation failed', { description: message });
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    pollRef.current?.cancel();
    setJob(null);
    setErrorMsg(null);
    setResultPlaying(false);
  };

  const toggleResultPlay = () => {
    const audio = playerRef.current;
    if (!audio) return;
    if (audio.paused) { void audio.play(); setResultPlaying(true); } else { audio.pause(); setResultPlaying(false); }
  };

  const downloadResult = () => {
    const url = job?.result?.audioUrl;
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `tts-${job?.id ?? 'output'}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const charCount = text.length;
  const charsOver = charCount > MAX_TEXT;
  const lastLog = job?.log?.[job.log.length - 1];
  const progressPct = Math.max(0, Math.min(100, Math.round((job?.progress ?? 0) * 100)));
  const isRunning = job?.status === 'running' || job?.status === 'queued';
  const isDone = job?.status === 'completed' && !!job.result?.audioUrl;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mic2 className="h-4 w-4 text-brand" /> Reference voice</CardTitle>
        </CardHeader>
        <CardContent>
          {!refFile ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => refInputRef.current?.click()}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 transition-colors',
                isDragOver ? 'border-brand bg-brand/5' : 'border-border hover:border-ring',
              )}
            >
              <Upload className="h-5 w-5 text-muted-foreground" />
              <span className="text-xs text-foreground">Drop an audio file or click to upload</span>
              <span className="text-xs text-muted-foreground">mp3, wav, flac, m4a, ogg — up to 25 MB</span>
              <span className="text-xs text-muted-foreground">5–15s of clean speech in the target voice works best.</span>
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-xl bg-muted p-3">
              <Mic2 className="h-4 w-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{refFile.name}</div>
                <div className="text-xs text-muted-foreground">{(refFile.size / 1024).toFixed(1)} KB</div>
                {refUrl && <audio src={refUrl} controls className="mt-2 h-8 w-full" />}
              </div>
              <button type="button" onClick={clearRef} className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Remove">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <input
            ref={refInputRef} type="file" accept="audio/*" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleRefFileSelected(f); }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Text to speak</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type or paste the text you want spoken in the cloned voice…"
            className="h-32 resize-y"
          />
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className={cn('text-muted-foreground', charsOver && 'text-destructive')}>
              {charCount} / {MAX_TEXT} characters
            </span>
            {charsOver && <span className="text-destructive">Exceeds recommended limit</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <Collapsible open={emotionExpanded} onOpenChange={setEmotionExpanded}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center justify-between rounded-t-xl border-b border-border bg-muted px-3 py-2 text-left">
              <div className="flex items-center gap-2">
                <Sparkles className="h-3 w-3 text-brand" />
                <span className="text-xs font-medium text-muted-foreground">Emotion</span>
                {emoMode !== 'none' && <span className="text-xs font-semibold uppercase text-brand">{emoMode}</span>}
              </div>
              {emotionExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {(['none', 'audio', 'text', 'vector'] as EmotionMode[]).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setEmoMode(mode)}
                    className={cn(
                      'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                      emoMode === mode ? 'border-brand bg-brand text-brand-foreground' : 'border-border bg-muted text-muted-foreground hover:bg-accent',
                    )}
                  >
                    {mode === 'none' ? 'No emotion' : mode === 'audio' ? 'From audio' : mode === 'text' ? 'From text' : 'Manual vector'}
                  </button>
                ))}
              </div>

              {emoMode === 'audio' && (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={() => emoInputRef.current?.click()}>
                    {emoFile ? 'Replace file' : 'Choose emotion audio'}
                  </Button>
                  {emoFile && <span className="flex-1 truncate text-xs text-muted-foreground">{emoFile.name}</span>}
                  <input ref={emoInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => setEmoFile(e.target.files?.[0] || null)} />
                </div>
              )}

              {emoMode === 'text' && (
                <Input value={emoText} onChange={(e) => setEmoText(e.target.value)} placeholder="e.g. excited and slightly nervous" />
              )}

              {emoMode === 'vector' && (
                <div className="space-y-2">
                  {EMOTION_LABELS.map((label, idx) => (
                    <div key={label} className="flex items-center gap-2">
                      <span className="w-16 truncate text-xs text-muted-foreground">{label}</span>
                      <Slider value={[emoVector[idx]]} min={0} max={1} step={0.01} onValueChange={([v]) => updateEmoVector(idx, v)} className="flex-1" />
                      <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{emoVector[idx].toFixed(2)}</span>
                    </div>
                  ))}
                  <p className={cn('text-xs', emoVectorSum > 1.5 ? 'text-amber-500' : 'text-muted-foreground')}>
                    Sum: {emoVectorSum.toFixed(2)} (recommend ≤ 1.5)
                  </p>
                </div>
              )}

              {emoMode !== 'none' && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="w-24 text-xs text-muted-foreground">Strength</span>
                  <Slider value={[emoAlpha]} min={0} max={2} step={0.05} onValueChange={([v]) => setEmoAlpha(v)} className="flex-1" />
                  <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{emoAlpha.toFixed(2)}</span>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <Card>
        <Collapsible open={advancedExpanded} onOpenChange={setAdvancedExpanded}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center justify-between rounded-t-xl border-b border-border bg-muted px-3 py-2 text-left">
              <span className="text-xs font-medium text-muted-foreground">Advanced</span>
              {advancedExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between py-1">
                <div>
                  <div className="text-xs font-medium text-foreground">FP16</div>
                  <p className="text-xs text-muted-foreground">Faster inference, slightly lower precision.</p>
                </div>
                <Switch checked={fp16} onCheckedChange={setFp16} />
              </div>
              <div className="flex items-center gap-3 py-1">
                <div className="flex-1">
                  <div className="text-xs font-medium text-foreground">Seed</div>
                  <p className="text-xs text-muted-foreground">Deterministic output. Random if blank.</p>
                </div>
                <Switch checked={randomSeed} onCheckedChange={setRandomSeed} />
                <Input
                  type="number" value={seed} disabled={randomSeed} onChange={(e) => setSeed(e.target.value)}
                  placeholder="auto" className="w-24"
                />
                <Button variant="ghost" size="icon-sm" disabled={randomSeed} onClick={() => setSeed(String(Math.floor(Math.random() * 2 ** 31)))} title="Roll a seed">
                  <Dice5 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-2 py-1">
                <div className="flex-1">
                  <div className="text-xs font-medium text-foreground">Sentence pause</div>
                  <p className="text-xs text-muted-foreground">Silence between sentences (ms).</p>
                </div>
                <Slider value={[intervalSilence]} min={50} max={1000} step={10} onValueChange={([v]) => setIntervalSilence(v)} className="flex-1" />
                <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{intervalSilence}ms</span>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      <Card>
        <CardContent className="space-y-3 pt-4">
          {!isDone && (
            <Button size="lg" className="w-full" onClick={() => void handleGenerate()} disabled={!canGenerate}>
              {submitting || isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic2 className="h-4 w-4" />}
              {isRunning ? 'Generating…' : 'Generate speech'}
            </Button>
          )}

          {isRunning && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size="xs" />
                <span className="truncate">{lastLog || 'Running IndexTTS2…'}</span>
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{errorMsg}</div>
          )}

          {isDone && job?.result?.audioUrl && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 rounded-xl bg-muted p-3">
                <button
                  type="button"
                  onClick={toggleResultPlay}
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-brand-foreground shadow-sm hover:opacity-90"
                >
                  {resultPlaying ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="ml-0.5 h-4 w-4" fill="currentColor" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-foreground">{text.trim().slice(0, 60) || 'Generated voice'}</div>
                  <div className="text-xs text-muted-foreground">
                    {job.result.durationSeconds > 0 ? `${job.result.durationSeconds.toFixed(2)}s` : 'audio ready'}
                  </div>
                </div>
                <audio
                  ref={playerRef}
                  src={job.result.audioUrl}
                  onPause={() => setResultPlaying(false)}
                  onPlay={() => setResultPlaying(true)}
                  className="hidden"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={downloadResult}>
                  <Download className="h-3.5 w-3.5" /> Download
                </Button>
                <Button variant="ghost" onClick={resetForm}>
                  <RotateCcw className="h-3.5 w-3.5" /> Generate again
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default TtsTab;
