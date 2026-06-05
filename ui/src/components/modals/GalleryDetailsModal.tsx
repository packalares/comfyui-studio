// Structured metadata modal for a gallery item.
// Opened via the "Details" button in GalleryDetailModal's action toolbar.
// Sections: Prompt, File, Media, Generation, Models — each rendered only when
// it has at least one non-null value.

import { useCallback } from 'react';
import { toast } from 'sonner';
import {
  File, Image as ImageIcon, Video, Music,
  Sparkles, Type, Package, Copy,
} from 'lucide-react';
import type { GalleryItem } from '../../types';
import { isThreeDFilename } from '../../lib/media';
import { formatBytes, formatRelativeTime } from '../../lib/utils';
import AppModal from './AppModal';

// formatDuration: "12.3s" or "2m 14s"
function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

interface Props {
  item: GalleryItem;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Layout helpers

interface Row {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
  /** When true, renders a copy-to-clipboard button on wide rows. */
  copyable?: boolean;
}

function SectionHeader({ icon: Icon, label }: { icon: typeof File; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text).then(() => {
      toast.success(label);
    });
  }, [text, label]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`Copy ${label}`}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer transition-colors shrink-0"
    >
      <Copy className="w-3.5 h-3.5" />
    </button>
  );
}

function RowsGrid({ rows }: { rows: Row[] }) {
  const wide = rows.filter(r => r.wide);
  const compact = rows.filter(r => !r.wide);
  return (
    <>
      {wide.map(r => (
        <div key={r.label} className="px-3 py-2 border-b last:border-b-0">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</div>
            {r.copyable && <CopyButton text={r.value} label={r.label} />}
          </div>
          <div className={`text-xs text-foreground whitespace-pre-wrap break-words${r.mono ? ' font-mono' : ''}`}>
            {r.value}
          </div>
        </div>
      ))}
      {compact.length > 0 && (
        <dl className={`grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-xs${wide.length > 0 ? ' border-t' : ''}`}>
          {compact.map(r => (
            <div key={r.label} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</dt>
              <dd className={`mt-0.5 truncate text-foreground${r.mono ? ' font-mono' : ''}`}>
                {r.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

function Section({ icon, label, rows }: { icon: typeof File; label: string; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border bg-card overflow-hidden mb-3 last:mb-0">
      <SectionHeader icon={icon} label={label} />
      <RowsGrid rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Source link helper — wraps templateName in a /studio/:name link when set.

function SourceCell({ item }: { item: GalleryItem }) {
  if (item.promptId === '') return <span>Disk import</span>;
  if (!item.templateName) return <span>—</span>;
  return (
    <a
      href={`/studio/${encodeURIComponent(item.templateName)}`}
      className="font-mono text-primary hover:underline"
    >
      {item.templateName}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Main modal

export default function GalleryDetailsModal({ item, onClose }: Props): JSX.Element {
  const mi = item.mediaInfo ?? null;
  const is3D = isThreeDFilename(item.filename);

  // --- File section ---
  const mediaTypeLabel = item.mediaType === 'video' ? 'Video'
    : item.mediaType === 'audio' ? 'Audio'
    : is3D ? '3D'
    : 'Image';

  const absoluteDate = item.createdAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))
    : null;

  // Build compact rows for file section; source gets a JSX cell below via a
  // separate wide-ish div so we can linkify it.
  const fileCompactRows: Row[] = [
    { label: 'Type', value: mediaTypeLabel },
    ...(item.sizeBytes != null ? [{ label: 'Size', value: formatBytes(item.sizeBytes) }] : []),
    ...(item.createdAt != null ? [{
      label: 'Created',
      value: `${formatRelativeTime(item.createdAt)}${absoluteDate ? ` · ${absoluteDate}` : ''}`,
    }] : []),
    ...(item.subfolder ? [{ label: 'Subfolder', value: item.subfolder, mono: true }] : []),
  ];

  // --- Media section ---
  const hasMedia = mi != null || item.mediaDurationMs != null;
  const mediaSectionIcon = item.mediaType === 'video' ? Video
    : item.mediaType === 'audio' ? Music
    : ImageIcon;

  const mediaRows: Row[] = [];
  if (hasMedia) {
    if (item.mediaType === 'image' && mi) {
      if (mi.width != null && mi.height != null) mediaRows.push({ label: 'Dimensions', value: `${mi.width} × ${mi.height}` });
      if (mi.format) mediaRows.push({ label: 'Format', value: String(mi.format).toUpperCase() });
      if (mi.channels != null) mediaRows.push({ label: 'Channels', value: String(mi.channels) });
    } else if (item.mediaType === 'video') {
      if (mi?.width != null && mi?.height != null) mediaRows.push({ label: 'Dimensions', value: `${mi.width} × ${mi.height}` });
      const dur = formatDuration(item.mediaDurationMs);
      if (dur) mediaRows.push({ label: 'Duration', value: dur });
      if (mi?.fps != null) mediaRows.push({ label: 'FPS', value: Number(mi.fps).toFixed(1) });
      if (mi?.codec_name) mediaRows.push({ label: 'Codec', value: String(mi.codec_name) });
    } else if (item.mediaType === 'audio') {
      const dur = formatDuration(item.mediaDurationMs);
      if (dur) mediaRows.push({ label: 'Duration', value: dur });
      if (mi?.sample_rate != null) mediaRows.push({ label: 'Sample rate', value: `${Math.round(Number(mi.sample_rate) / 1000)} kHz` });
      if (mi?.channels != null) {
        const ch = Number(mi.channels);
        mediaRows.push({ label: 'Channels', value: ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : String(ch) });
      }
      if (mi?.bit_rate != null) mediaRows.push({ label: 'Bit rate', value: `${Math.round(Number(mi.bit_rate) / 1000)} kbps` });
    }
  }

  // --- Generation section ---
  const wd = item.workflowDetail ?? null;
  const genRows: Row[] = [];
  if (wd?.seed != null) genRows.push({ label: 'Seed', value: String(wd.seed), mono: true });
  if (wd?.sampler) genRows.push({ label: 'Sampler', value: wd.sampler, mono: true });
  if (wd?.scheduler) genRows.push({ label: 'Scheduler', value: wd.scheduler, mono: true });
  if (wd?.steps != null) genRows.push({ label: 'Steps', value: String(wd.steps) });
  if (wd?.cfg != null) genRows.push({ label: 'CFG', value: String(wd.cfg) });
  if (wd?.denoise != null) genRows.push({ label: 'Denoise', value: String(wd.denoise) });
  if (wd?.batchSize != null) genRows.push({ label: 'Batch size', value: String(wd.batchSize) });
  if (wd?.lengthFrames != null) genRows.push({ label: 'Length', value: String(wd.lengthFrames) });
  const jobDur = formatDuration(item.jobDurationMs);
  if (jobDur) genRows.push({ label: 'Job duration', value: jobDur });

  // --- Prompt section ---
  const promptRows: Row[] = [];
  if (wd?.promptText) promptRows.push({ label: 'Prompt', value: wd.promptText, wide: true, copyable: true });
  if (wd?.negativeText) promptRows.push({ label: 'Negative prompt', value: wd.negativeText, wide: true, copyable: true });

  // --- Models section ---
  const modelList = wd && wd.models.length > 0
    ? wd.models
    : wd?.model ? [wd.model] : [];

  const hasAnySections =
    fileCompactRows.length > 0 || mediaRows.length > 0 || genRows.length > 0 ||
    promptRows.length > 0 || modelList.length > 0;

  return (
    <AppModal open={true} onClose={onClose} title="Details" size="lg" scrollBody>
      {!hasAnySections ? (
        <div className="rounded-lg border border-dashed bg-muted px-3 py-3 text-[11px] text-muted-foreground">
          No metadata captured. Regenerate is unavailable until you re-import from ComfyUI.
        </div>
      ) : (
        <div className="space-y-0">
          {/* Prompt first */}
          <Section icon={Type} label="Prompt" rows={promptRows} />

          {/* File section — compact grid + linkified Source row */}
          {(fileCompactRows.length > 0 || true) && (
            <div className="rounded-lg border bg-card overflow-hidden mb-3 last:mb-0">
              <SectionHeader icon={File} label="File" />
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-2 text-xs">
                {fileCompactRows.map(r => (
                  <div key={r.label} className="min-w-0">
                    <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{r.label}</dt>
                    <dd className={`mt-0.5 truncate text-foreground${r.mono ? ' font-mono' : ''}`}>
                      {r.value}
                    </dd>
                  </div>
                ))}
                {/* Source always rendered */}
                <div className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Source</dt>
                  <dd className="mt-0.5 truncate text-foreground text-xs">
                    <SourceCell item={item} />
                  </dd>
                </div>
              </dl>
            </div>
          )}

          <Section icon={mediaSectionIcon} label="Media" rows={mediaRows} />
          <Section icon={Sparkles} label="Generation" rows={genRows} />
          {modelList.length > 0 && (
            <div className="rounded-lg border bg-card overflow-hidden mb-3 last:mb-0">
              <SectionHeader icon={Package} label="Models" />
              <div className="divide-y divide-border">
                {modelList.map((m: string) => (
                  <div key={m} className="px-3 py-2 text-xs font-mono text-foreground truncate">{m}</div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </AppModal>
  );
}
