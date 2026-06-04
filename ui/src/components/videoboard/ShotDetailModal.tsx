// Shot Detail Modal.
//
// Replaces the old single-textarea PromptEditor. Layout matches the design ref
// (workflows/videostoryboard/Screenshot 2026-05-23 165222.png):
//   ┌─────────────────────────────────────────────────────────────────────┐
//   │ ▶ Shot N  (0:00 – 0:04)                                          [X]│
//   ├──────────────────────────────────┬──────────────────────────────────┤
//   │                                  │ Shot Images                      │
//   │  [ big image preview ]           │   <textarea: shot.imagePrompt>   │
//   │                                  │                          n / 1000│
//   │  [thumb][thumb][thumb]           │ Shot Video                       │
//   │                                  │   <textarea: shot.videoPrompt>   │
//   │                                  │                          n / 1000│
//   ├──────────────────────────────────┴──────────────────────────────────┤
//   │                          [ Generate Images ] [ Generate Video ]     │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Persistence: textarea edits debounced ~400 ms then PUT /shots/:idx. The
// caller's `onSave` is reused so the existing optimistic-update path in
// VideoboardProject.tsx still works. Generate buttons reuse the existing
// /shots/:idx/image and /shots/:idx/animate routes (still mock today; the
// real ComfyUI image/video gen is the next phase).

import { useState, useEffect, useRef, useCallback } from 'react';
import { ImageIcon, Loader2, Play, Sparkles, Video } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { Shot } from '../../api/videoboard';

export interface ShotDetailModalProps {
  shot: Shot | null;
  open: boolean;
  onClose: () => void;
  onSave: (next: Partial<Shot>) => void;
  /** POST /shots/:idx/image — kicks off image gen for this shot. */
  onGenerateImage?: (idx: number, templateName?: string) => void;
  /** POST /shots/:idx/animate — kicks off video gen for this shot. */
  onGenerateVideo?: (idx: number) => void;
  /** Project-level fallback for the image template when the shot has no
   *  per-shot override. Comes from `project.settings.imageTemplateName`. */
  defaultTemplateName?: string;
}

const SAVE_DEBOUNCE_MS = 400;
const PROMPT_SOFT_CAP = 1000;

// Hardcoded for v1 — replace with a /api/templates/list?mediaType=image fetch
// once we ship more than one image template option.
const IMAGE_TEMPLATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'image_flux2_text_to_image_9b', label: 'FLUX.2 Klein 9B — Text to Image' },
];

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function ShotDetailModal({
  shot,
  open,
  onClose,
  onSave,
  onGenerateImage,
  onGenerateVideo,
  defaultTemplateName,
}: ShotDetailModalProps) {
  // Local editable state — independent of `shot` so typing isn't snap-back
  // on every WS shot:updated event for unrelated fields (status/imageUrl).
  // The seeded value falls back to shot.prompt for legacy/mock shots that
  // never had a Director run.
  const [imagePrompt, setImagePrompt] = useState('');
  const [videoPrompt, setVideoPrompt] = useState('');
  const [templateName, setTemplateName] = useState<string>('');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Partial<Shot>>({});

  // Re-seed local fields when the modal opens on a different shot. We compare
  // by idx so the WS-driven re-renders of the SAME shot don't blow away the
  // user's in-progress edit.
  const seededIdxRef = useRef<number | null>(null);
  useEffect(() => {
    if (!shot) return;
    if (seededIdxRef.current === shot.idx) return;
    seededIdxRef.current = shot.idx;
    setImagePrompt(shot.imagePrompt ?? shot.prompt ?? '');
    setVideoPrompt(shot.videoPrompt ?? '');
    // Resolution order matches the backend (runShotImageGen.ts):
    //   shot.imageTemplateName → project default → first option
    setTemplateName(
      shot.imageTemplateName
      || defaultTemplateName
      || IMAGE_TEMPLATE_OPTIONS[0]?.value
      || '',
    );
  }, [shot, defaultTemplateName]);

  // Flush any pending debounce on close so edits aren't lost.
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (Object.keys(pendingRef.current).length === 0) return;
    const patch = pendingRef.current;
    pendingRef.current = {};
    onSave(patch);
  }, [onSave]);

  // Cleanup on unmount/close to avoid orphan timers.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    flushSave();
    seededIdxRef.current = null;
    onClose();
  }, [flushSave, onClose]);

  const scheduleSave = useCallback(
    (patch: Partial<Shot>) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  const handleImagePromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setImagePrompt(val);
      // `prompt` is the canonical name image-gen routes read today — keep them
      // in sync so generation uses the user's latest text.
      scheduleSave({ imagePrompt: val, prompt: val });
    },
    [scheduleSave],
  );

  const handleVideoPromptChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      setVideoPrompt(val);
      scheduleSave({ videoPrompt: val });
    },
    [scheduleSave],
  );

  const handleTemplateChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      setTemplateName(val);
      // Per-shot override stored on the shot row. Empty string → "use project
      // default" (we still send the resolved value on submit so the backend
      // doesn't have to re-resolve).
      scheduleSave({ imageTemplateName: val });
    },
    [scheduleSave],
  );

  // Render guard for stale `open=true` after the shot was removed.
  if (!shot) return null;

  const timing = `${formatMs(shot.startMs)} – ${formatMs(shot.endMs)}`;
  const busy = shot.status === 'generating' || shot.status === 'queued';
  const imageReady = !!shot.imageUrl;
  const videoReady = !!shot.videoUrl;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent
        // Wider than the default sm:max-w-sm — the design ref is a two-pane
        // layout that needs real estate. lg:max-w-5xl caps at desktop sizes;
        // on mobile the calc(100%-2rem) base rule from the primitive holds.
        className="sm:max-w-2xl lg:max-w-5xl p-0 gap-0 overflow-hidden"
      >
        {/* Header */}
        <DialogHeader className="flex flex-row items-center gap-3 border-b px-5 py-3">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Play preview"
            disabled={!imageReady && !videoReady}
            className="shrink-0"
          >
            <Play className="h-4 w-4" />
          </Button>
          <DialogTitle className="flex items-baseline gap-2 text-sm">
            <span className="font-semibold">Shot {shot.idx + 1}</span>
            <span className="font-mono text-xs text-muted-foreground">({timing})</span>
          </DialogTitle>
          {busy && (
            <Badge variant="warning" treatment="soft" className="ml-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              {shot.status === 'generating' ? 'Generating…' : 'Queued'}
            </Badge>
          )}
        </DialogHeader>

        {/* Body — 2-column on lg, stacked on mobile */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 lg:gap-4 px-5 py-4">
          {/* LEFT — image preview + thumbnail strip */}
          <div className="flex flex-col gap-3 min-w-0">
            <div className="aspect-square rounded-lg overflow-hidden bg-muted border border-border flex items-center justify-center relative">
              {imageReady ? (
                <img
                  src={shot.imageUrl}
                  alt={`Shot ${shot.idx + 1}`}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : busy ? (
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-10 w-10 animate-spin text-brand" />
                  <p className="text-xs">
                    {shot.status === 'queued' ? 'Queued…' : 'Generating image…'}
                  </p>
                </div>
              ) : shot.status === 'error' ? (
                <div className="flex flex-col items-center gap-2 text-destructive">
                  <ImageIcon className="h-10 w-10 opacity-60" />
                  <p className="text-xs">Generation failed</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 text-muted-foreground">
                  <ImageIcon className="h-10 w-10 opacity-40" />
                  <p className="text-xs">No image yet</p>
                </div>
              )}
              {/* Overlay spinner during regen of an existing image */}
              {imageReady && busy && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
                  <Loader2 className="h-10 w-10 animate-spin text-brand" />
                </div>
              )}
            </div>

            {/* Placeholder thumbnail strip — real variant gallery wired by the
                image-gen phase that follows. Renders nothing today when there
                are no extra images. */}
            {imageReady && (
              <div className="flex gap-1.5 overflow-x-auto">
                <div className="aspect-square h-12 rounded-md overflow-hidden border border-brand ring-1 ring-brand/40 shrink-0">
                  <img
                    src={shot.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — Shot Images + Shot Video panels */}
          <div className="flex flex-col gap-3 min-w-0">
            <PromptPanel
              label="Shot Images"
              icon={<ImageIcon className="h-3.5 w-3.5" />}
              value={imagePrompt}
              onChange={handleImagePromptChange}
              softCap={PROMPT_SOFT_CAP}
              placeholder="Describe the still frame — subject, environment, lighting, lens, mood."
            />
            <PromptPanel
              label="Shot Video"
              icon={<Video className="h-3.5 w-3.5" />}
              value={videoPrompt}
              onChange={handleVideoPromptChange}
              softCap={PROMPT_SOFT_CAP}
              placeholder="Describe what changes over time — subject motion, camera move, atmosphere."
            />
          </div>
        </div>

        {/* Footer — template picker + CTAs */}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t bg-muted/30 px-5 py-3">
          <label className="flex items-center gap-2 mr-auto">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              Template
            </span>
            <select
              value={templateName}
              onChange={handleTemplateChange}
              disabled={busy}
              className="h-8 rounded-md border border-input bg-card px-2 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {IMAGE_TEMPLATE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>

          <Button
            type="button"
            variant="default"
            disabled={busy || !onGenerateImage}
            onClick={() => onGenerateImage?.(shot.idx, templateName || undefined)}
            className="gap-2"
          >
            <Sparkles className="h-4 w-4" />
            Generate Images
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={busy || !imageReady || !onGenerateVideo}
            onClick={() => onGenerateVideo?.(shot.idx)}
            className="gap-2"
            title={!imageReady ? 'Generate an image first — video animates from the frame.' : undefined}
          >
            <Video className="h-4 w-4" />
            Generate Video
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PromptPanel — one labeled scrollable textarea with a soft char counter.
// Counter goes amber past the soft cap; not a hard limit since the Director
// occasionally writes 1100+ char video prompts.
// ---------------------------------------------------------------------------

interface PromptPanelProps {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  softCap: number;
  placeholder?: string;
}

function PromptPanel({ label, icon, value, onChange, softCap, placeholder }: PromptPanelProps) {
  const length = value.length;
  const overCap = length > softCap;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3 min-h-0">
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-xs font-semibold text-foreground">{label}</h3>
      </div>
      <Textarea
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="min-h-[140px] flex-1 resize-none text-xs leading-relaxed"
      />
      <div className="flex justify-end">
        <span
          className={cn(
            'font-mono text-[10px]',
            overCap ? 'text-amber-500' : 'text-muted-foreground',
          )}
        >
          {length} / {softCap}
        </span>
      </div>
    </div>
  );
}
