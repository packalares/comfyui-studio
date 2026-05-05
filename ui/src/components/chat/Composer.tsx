// Composer redesigned to match ChatGPT-style polish: a single rounded card
// with the textarea on top, and a footer that runs across the bottom with
// `+` attach + Tools popover + Web-preview toggle on the LEFT and the model
// picker pill + round Send arrow on the RIGHT. The ai-elements <PromptInput>
// gives the rounded surface + has-disabled cascade; we keep ownership of the
// `attachments` array (drag-drop on the thread shares this list) and feed it
// into the standard ai-elements layout primitives only for visual polish.

import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  ArrowUp, StopCircle, Paperclip, X, FileText, Image as ImageIcon, Globe, Code2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '../ai-elements/prompt-input';
import type { OllamaInstalledModel } from '../../services/comfyui';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import {
  ALLOWED_ACCEPT, MAX_ATTACHMENTS, formatBytes, modelIsVisionCapable,
  listVisionCapableBaseNames,
  processFile, type PendingAttachment,
} from './attachments';
import ChatModelPickerModal from './ChatModelPickerModal';
import ChatToolsPopover from './ChatToolsPopover';

interface Props {
  installed: OllamaInstalledModel[];
  /** True while the first installed-models fetch is in flight; the model
   *  picker pill renders a skeleton during this window. */
  installedLoading?: boolean;
  model: string;
  onModelChange: (model: string) => void;
  busy: boolean;
  onSend: (text: string, attachments: PendingAttachment[]) => void;
  onStop: () => void;
  focusRef?: MutableRefObject<() => void>;
  libraryCapabilities?: Record<string, string[]>;
  attachments: PendingAttachment[];
  onAttachmentsChange: (next: PendingAttachment[]) => void;
  webPreviews: boolean;
  onWebPreviewsChange: (next: boolean) => void;
  showToolDetails: boolean;
  onShowToolDetailsChange: (next: boolean) => void;
  /** null = use every configured tool. string[] = explicit allow-list. */
  enabledTools: string[] | null;
  onEnabledToolsChange: (next: string[] | null) => void;
  /** When true the composer renders without docked-bottom chrome (border-t /
   *  white bg). Used by the centered empty-state hero in `Chat.tsx` so the
   *  composer floats inside its own column instead of pinning the page. */
  centered?: boolean;
}

export default function Composer({
  installed, installedLoading, model, onModelChange, busy, onSend, onStop, focusRef,
  libraryCapabilities, attachments, onAttachmentsChange,
  webPreviews, onWebPreviewsChange,
  showToolDetails, onShowToolDetailsChange,
  enabledTools, onEnabledToolsChange,
  centered = false,
}: Props) {
  // The ref attached to <PromptInputTextarea> won't actually land on the
  // underlying <textarea> because the ai-elements wrapper is a plain
  // function component (not React.forwardRef) and we're on React 18 where
  // refs on function components are silently dropped. Instead we hold a
  // ref on the surrounding container and locate the textarea by DOM query
  // when we need to focus it. The `name="message"` attribute is set by
  // ai-elements' `<InputGroupTextarea>` and is stable.
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const focusTextarea = () => {
    const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    ta?.focus();
  };

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = focusTextarea;
    return () => { if (focusRef) focusRef.current = () => {}; };
  }, [focusRef]);

  // Re-focus the textarea when the assistant finishes streaming so the user
  // can keep typing without clicking back into the input. We only fire on
  // the busy:true→false transition (`prevBusy` ref) — focusing on every
  // render or on mount would steal focus from any other element the user
  // legitimately clicked while the response was still streaming.
  // `requestAnimationFrame` waits one paint so the `disabled` prop has
  // settled to `false` on the DOM node before we call focus() — focusing
  // a still-disabled <textarea> is a no-op in every browser.
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    if (prevBusyRef.current && !busy) {
      requestAnimationFrame(focusTextarea);
    }
    prevBusyRef.current = busy;
  }, [busy]);

  const noModel = !model;
  const baseName = model.split(':')[0];
  const caps = libraryCapabilities?.[baseName] ?? null;
  const visionCapable = modelIsVisionCapable(model, caps);
  const hasImageAttachment = attachments.some(a => a.kind === 'image');
  const attachFull = attachments.length >= MAX_ATTACHMENTS;

  const submit = (m: PromptInputMessage) => {
    if (busy || !model) return;
    const trimmed = m.text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (hasImageAttachment && !visionCapable) {
      const visionList = listVisionCapableBaseNames(libraryCapabilities).slice(0, 3);
      const hint = visionList.length > 0
        ? `Switch to a vision-capable model (e.g. ${visionList.join(', ')}).`
        : 'Switch to a vision-capable model.';
      toast.error("Current model can't see images", { description: hint });
      return;
    }
    onSend(trimmed, attachments);
    onAttachmentsChange([]);
  };

  const addFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (attachments.length + arr.length > MAX_ATTACHMENTS) {
      toast.error(`Up to ${MAX_ATTACHMENTS} attachments per message`);
      return;
    }
    const next: PendingAttachment[] = [...attachments];
    for (const f of arr) {
      const result = await processFile(f);
      if (!result.ok) {
        toast.error(result.filename, { description: result.reason });
        continue;
      }
      next.push(result.attachment);
    }
    onAttachmentsChange(next);
  };

  const removeAttachment = (id: string) => {
    onAttachmentsChange(attachments.filter(a => a.id !== id));
  };

  const openFilePicker = () => {
    if (busy || noModel) return;
    if (attachFull) {
      toast.error(`Max ${MAX_ATTACHMENTS} attachments`);
      return;
    }
    fileInputRef.current?.click();
  };

  // While the first installed-models fetch is in flight, render a skeleton
  // in place of the entire composer so the user doesn't see "Pick a model" /
  // disabled chrome flicker before Ollama responds. The silhouette mirrors
  // the real composer (textarea block on top, footer row of chips beneath)
  // so the layout doesn't jump on swap. `animate-shimmer` keyframe ships
  // globally in `index.css`.
  if (installedLoading) {
    return (
      <div className={centered ? '' : 'border-t bg-card'}>
        <div className="mx-auto max-w-4xl px-4 py-3">
          <div
            role="status"
            aria-label="Loading chat composer"
            className="relative overflow-hidden rounded-lg border bg-muted"
          >
            {/* Diagonal shine band — same effect we use on the generated-
                image placeholder. Sits behind the silhouette blocks. */}
            <div className="skeleton-shimmer" />
            {/* Textarea silhouette */}
            <div className="relative space-y-2 px-4 pt-4">
              <div className="h-3 w-2/3 rounded bg-secondary" />
              <div className="h-3 w-1/2 rounded bg-secondary" />
              <div className="h-3 w-2/5 rounded bg-secondary" />
            </div>
            {/* Footer silhouette — left chips + right (model + send) */}
            <div className="relative mt-6 flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-md bg-secondary" />
                <div className="h-8 w-20 rounded-md bg-secondary" />
                <div className="h-8 w-24 rounded-md bg-secondary" />
              </div>
              <div className="flex items-center gap-2">
                <div className="h-8 w-32 rounded-md bg-secondary" />
                <div className="h-8 w-8 rounded-full bg-secondary" />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={centered ? '' : 'border-t bg-card'}>
      <div ref={wrapRef} className="mx-auto max-w-4xl px-4 py-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ALLOWED_ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void addFiles(e.target.files);
            }
            e.target.value = '';
          }}
        />

        {/* PromptInputBody (display:contents) is intentionally NOT used —
            it puts a wrapper between InputGroup and its children, breaking
            the `:has(> textarea)` selector that expands the group from h-8
            to h-auto/flex-col. Children must be direct DOM kids of the
            InputGroup for the layout to lift to two-row mode. */}
        <PromptInput onSubmit={submit}>
            {attachments.length > 0 && (
              <PromptInputHeader>
                {attachments.map(a => (
                  <AttachmentChip key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
                ))}
              </PromptInputHeader>
            )}
            <PromptInputTextarea
              placeholder={
                busy ? 'Generating... (Esc to stop)'
                  : noModel ? 'Pick a model below to start chatting'
                    : 'Ask anything...'
              }
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && busy) {
                  e.preventDefault();
                  onStop();
                }
              }}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={openFilePicker}
                      aria-disabled={busy || noModel || attachFull}
                      variant="ghost"
                      size="icon"
                      aria-label="Attach files"
                      // Persistent slate-50 surface so the attach affordance
                      // reads as a tappable chip even at rest, not a ghost
                      // icon that only appears on hover. Slightly darker on
                      // hover keeps the standard "press" feedback.
                      className="!h-8 !w-8 !rounded-md !bg-muted !text-foreground hover:!bg-secondary hover:!text-foreground"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach files</TooltipContent>
                </Tooltip>
                <ChatToolsPopover
                  enabled={enabledTools}
                  onChange={onEnabledToolsChange}
                />
                <WebPreviewToggle enabled={webPreviews} onToggle={onWebPreviewsChange} />
                <ToolDetailsToggle enabled={showToolDetails} onToggle={onShowToolDetailsChange} />
              </PromptInputTools>
              <PromptInputTools>
                <ChatModelPickerModal
                  installed={installed}
                  loading={!!installedLoading}
                  model={model}
                  disabled={busy}
                  libraryCapabilities={libraryCapabilities}
                  onChange={onModelChange}
                />
                {busy ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={onStop}
                        variant="secondary"
                        size="icon"
                        className="!h-8 !w-8 !rounded-full !p-0 !text-destructive hover:!bg-destructive/10"
                        aria-label="Stop"
                      >
                        <StopCircle className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop (Esc)</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="submit"
                        size="icon"
                        aria-disabled={noModel}
                        aria-label="Send"
                        className="!h-8 !w-8 !rounded-full !p-0 !bg-brand hover:!bg-brand/90 !text-brand-foreground"
                        onClick={(e) => {
                          if (noModel) {
                            e.preventDefault();
                            toast.error('Pick a model first');
                          }
                        }}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Send (Enter)</TooltipContent>
                  </Tooltip>
                )}
              </PromptInputTools>
            </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

interface ChipProps { att: PendingAttachment; onRemove: () => void }
function AttachmentChip({ att, onRemove }: ChipProps) {
  return (
    <div className="chat-attachment-chip">
      {att.kind === 'image' && att.dataUrl ? (
        <img
          src={att.dataUrl}
          alt={att.filename}
          className="h-7 w-7 rounded object-cover ring-1 ring-border"
        />
      ) : att.kind === 'image' ? (
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
      ) : (
        <FileText className="h-4 w-4 text-muted-foreground" />
      )}
      <div className="flex flex-col leading-tight">
        <span className="font-medium text-foreground max-w-[180px] truncate">{att.filename}</span>
        <span className="text-[10px] text-muted-foreground">{formatBytes(att.size)}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${att.filename}`}
        className="text-muted-foreground hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface ToggleProps { enabled: boolean; onToggle: (next: boolean) => void }
function WebPreviewToggle({ enabled, onToggle }: ToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={enabled}
          aria-label="Inline URL previews"
          onClick={() => onToggle(!enabled)}
          className={enabled ? 'text-brand bg-brand/10 hover:bg-brand/20' : ''}
        >
          <Globe className="h-3.5 w-3.5" />
          <span>Previews</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Render iframe previews for URLs in assistant replies. Off by default — enable when you want to see the linked page directly under the message.
      </TooltipContent>
    </Tooltip>
  );
}

function ToolDetailsToggle({ enabled, onToggle }: ToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={enabled}
          aria-label="Show tool call details"
          onClick={() => onToggle(!enabled)}
          className={enabled ? 'text-brand bg-brand/10 hover:bg-brand/20' : ''}
        >
          <Code2 className="h-3.5 w-3.5" />
          <span>Tool details</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Show the parameters and raw JSON result for each tool call inline. Off by default — for image generation you already see the rendered image, so the JSON is mostly useful for debugging.
      </TooltipContent>
    </Tooltip>
  );
}
