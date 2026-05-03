// Composer redesigned to match ChatGPT-style polish: a single rounded card
// with the textarea on top, and a footer that runs across the bottom with
// `+` attach + Tools popover + Web-preview toggle on the LEFT and the model
// picker pill + round Send arrow on the RIGHT. The ai-elements <PromptInput>
// gives the rounded surface + has-disabled cascade; we keep ownership of the
// `attachments` array (drag-drop on the thread shares this list) and feed it
// into the standard ai-elements layout primitives only for visual polish.

import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  ArrowUp, StopCircle, Plus, X, FileText, Image as ImageIcon, Globe,
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
  /** null = use every configured tool. string[] = explicit allow-list. */
  enabledTools: string[] | null;
  onEnabledToolsChange: (next: string[] | null) => void;
  /** When true the composer renders without docked-bottom chrome (border-t /
   *  white bg). Used by the centered empty-state hero in `Chat.tsx` so the
   *  composer floats inside its own column instead of pinning the page. */
  centered?: boolean;
}

export default function Composer({
  installed, model, onModelChange, busy, onSend, onStop, focusRef,
  libraryCapabilities, attachments, onAttachmentsChange,
  webPreviews, onWebPreviewsChange,
  enabledTools, onEnabledToolsChange,
  centered = false,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = () => taRef.current?.focus();
    return () => { if (focusRef) focusRef.current = () => {}; };
  }, [focusRef]);

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

  return (
    <div className={centered ? '' : 'border-t border-slate-200 bg-white'}>
      <div className="mx-auto max-w-4xl px-4 py-3">
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
              ref={taRef}
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
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach files</TooltipContent>
                </Tooltip>
                <ChatToolsPopover
                  enabled={enabledTools}
                  onChange={onEnabledToolsChange}
                />
                <WebPreviewToggle enabled={webPreviews} onToggle={onWebPreviewsChange} />
              </PromptInputTools>
              <PromptInputTools>
                <ChatModelPickerModal
                  installed={installed}
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
                        className="!h-9 !w-9 !rounded-full !p-0 !text-rose-600 hover:!bg-rose-50"
                        aria-label="Stop"
                      >
                        <StopCircle className="h-4 w-4" />
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
                        className="!h-9 !w-9 !rounded-full !p-0 !bg-blue-600 hover:!bg-blue-700 !text-white"
                        onClick={(e) => {
                          if (noModel) {
                            e.preventDefault();
                            toast.error('Pick a model first');
                          }
                        }}
                      >
                        <ArrowUp className="h-4 w-4" />
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
    <div className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
      {att.kind === 'image' && att.dataUrl ? (
        <img
          src={att.dataUrl}
          alt={att.filename}
          className="h-7 w-7 rounded object-cover ring-1 ring-slate-200"
        />
      ) : att.kind === 'image' ? (
        <ImageIcon className="h-4 w-4 text-slate-400" />
      ) : (
        <FileText className="h-4 w-4 text-slate-400" />
      )}
      <div className="flex flex-col leading-tight">
        <span className="font-medium text-slate-800 max-w-[180px] truncate">{att.filename}</span>
        <span className="text-[10px] text-slate-500">{formatBytes(att.size)}</span>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${att.filename}`}
        className="text-slate-400 hover:text-slate-700"
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
          className={enabled ? 'text-teal-700 bg-teal-50 hover:bg-teal-100' : ''}
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
