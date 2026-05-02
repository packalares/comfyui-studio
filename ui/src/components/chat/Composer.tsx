// Composer rebuilt on top of ai-elements <PromptInput>. ai-elements ships its
// own file-attachment context but Studio's Chat page owns the canonical
// `attachments` array (so the drag-drop overlay on the thread can append into
// the same list); we therefore bypass PromptInput's file state entirely and
// drive submit/stop/textarea through it for the layout polish only.
//
// Ported from the hand-rolled composer:
//   * vision-capability gate (toast on image-attached + non-vision model);
//   * paperclip / Cmd-Ctrl-K focus / Enter / Shift+Enter / Esc keybindings;
//   * controlled `attachments` list, including chip remove + paperclip add;
//   * shortcut help bubble.

import { useEffect, useRef, type MutableRefObject } from 'react';
import { Send, StopCircle, HelpCircle, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '../ai-elements/prompt-input';
import type { OllamaInstalledModel } from '../../services/comfyui';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  ALLOWED_ACCEPT, MAX_ATTACHMENTS, formatBytes, modelIsVisionCapable,
  processFile, type PendingAttachment,
} from './attachments';

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
}

export default function Composer({
  installed, model, onModelChange, busy, onSend, onStop, focusRef,
  libraryCapabilities, attachments, onAttachmentsChange,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = () => taRef.current?.focus();
    return () => { if (focusRef) focusRef.current = () => {}; };
  }, [focusRef]);

  const noModel = !model;
  const noInstalled = installed.length === 0;
  const baseName = model.split(':')[0];
  const caps = libraryCapabilities?.[baseName] ?? null;
  const visionCapable = modelIsVisionCapable(model, caps);
  const hasImageAttachment = attachments.some(a => a.kind === 'image');

  const submit = (m: PromptInputMessage) => {
    if (busy || !model) return;
    const trimmed = m.text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (hasImageAttachment && !visionCapable) {
      toast.error("Current model can't see images", {
        description: 'Switch to a vision-capable model (e.g. gemma3, llava, qwen2.5vl).',
      });
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

  return (
    <div className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-3xl px-4 py-3">
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

        <div className="mb-2 flex items-center justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <label className={`flex items-center gap-2 text-xs ${
                noModel ? 'text-rose-600' : 'text-slate-500'
              }`}>
                <span>Model</span>
                <select
                  value={model}
                  onChange={(e) => onModelChange(e.target.value)}
                  className={`field-input !py-1 !px-2 !text-xs !w-auto font-mono ${
                    noModel ? '!border-rose-300 ring-1 ring-rose-200' : ''
                  }`}
                  disabled={busy}
                >
                  {noInstalled && <option value="">No models installed</option>}
                  {!installed.some(m => m.name === model) && model && (
                    <option value={model}>{model}</option>
                  )}
                  {installed.map(m => (
                    <option key={m.name} value={m.name}>{m.name}</option>
                  ))}
                </select>
                {visionCapable && (
                  <Badge variant="teal" title="Can see images">vision</Badge>
                )}
              </label>
            </TooltipTrigger>
            {noModel && <TooltipContent>Pick a model first</TooltipContent>}
          </Tooltip>
          <ShortcutsHelp />
        </div>

        <PromptInput onSubmit={submit}>
          <PromptInputBody>
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
                  : noModel ? 'Pick a model above to start chatting'
                    : 'Type a message. Shift+Enter for newline. Drop files to attach.'
              }
              disabled={busy || noModel}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && busy) {
                  e.preventDefault();
                  onStop();
                }
              }}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <Button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy || noModel || attachments.length >= MAX_ATTACHMENTS}
                  variant="ghost"
                  size="icon"
                  aria-label="Attach files"
                  title="Attach files"
                >
                  <Paperclip className="w-4 h-4" />
                </Button>
              </PromptInputTools>
              {busy ? (
                <Button type="button" onClick={onStop} variant="secondary" className="!text-red-600 hover:!bg-red-50">
                  <StopCircle className="w-4 h-4" />
                  Stop
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={noModel}
                  aria-label="Send"
                >
                  <Send className="w-4 h-4" />
                  Send
                </Button>
              )}
            </PromptInputFooter>
          </PromptInputBody>
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

function ShortcutsHelp() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Keyboard shortcuts"
          className="text-slate-400 hover:text-slate-600 transition-colors"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="space-y-1 text-left">
          <div><kbd className="font-mono">Enter</kbd> send</div>
          <div><kbd className="font-mono">Shift+Enter</kbd> newline</div>
          <div><kbd className="font-mono">Esc</kbd> stop streaming</div>
          <div><kbd className="font-mono">Ctrl/Cmd+K</kbd> focus composer</div>
          <div><kbd className="font-mono">Drop files</kbd> attach</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
