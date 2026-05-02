import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { Send, StopCircle, HelpCircle, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { OllamaInstalledModel } from '../../services/comfyui';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Badge } from '../ui/badge';
import {
  ALLOWED_ACCEPT,
  MAX_ATTACHMENTS,
  formatBytes,
  modelIsVisionCapable,
  processFile,
  type PendingAttachment,
} from './attachments';

interface Props {
  installed: OllamaInstalledModel[];
  model: string;
  onModelChange: (model: string) => void;
  busy: boolean;
  onSend: (text: string, attachments: PendingAttachment[]) => void;
  onStop: () => void;
  // Parent passes a mutable ref slot it can call to focus the textarea from
  // the global Cmd/Ctrl+K shortcut.
  focusRef?: MutableRefObject<() => void>;
  // Capabilities map keyed by base library name (`gemma3` -> ['vision']).
  // Sourced from `/api/chat/models/library` so we can authoritatively flag
  // vision support before falling back to the name-pattern heuristic.
  libraryCapabilities?: Record<string, string[]>;
  // Controlled attachments — owned by the parent so the drag-drop overlay on
  // the message thread can append into the same list.
  attachments: PendingAttachment[];
  onAttachmentsChange: (next: PendingAttachment[]) => void;
}

export default function Composer({
  installed, model, onModelChange, busy, onSend, onStop, focusRef,
  libraryCapabilities, attachments, onAttachmentsChange,
}: Props) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = () => taRef.current?.focus();
    return () => { if (focusRef) focusRef.current = () => {}; };
  }, [focusRef]);

  const noModel = !model;
  const noInstalled = installed.length === 0;

  // Vision check uses the library capability if we have it for this model's
  // base name, else falls back to pattern matching. The library keys by base
  // name (`llama3.2-vision`); installed models keep their tag (`...:8b`).
  const baseName = model.split(':')[0];
  const caps = libraryCapabilities?.[baseName] ?? null;
  const visionCapable = modelIsVisionCapable(model, caps);

  const hasImageAttachment = attachments.some(a => a.kind === 'image');

  const submit = () => {
    if (busy || !model) return;
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    if (hasImageAttachment && !visionCapable) {
      toast.error("Current model can't see images", {
        description: 'Switch to a vision-capable model (e.g. gemma3, llava, qwen2.5vl).',
      });
      return;
    }
    onSend(trimmed, attachments);
    setText('');
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
        {/* Hidden picker — the visible Paperclip button below proxies its click. */}
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
            // Reset so re-picking the same file re-fires onChange.
            e.target.value = '';
          }}
        />

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map(a => (
              <AttachmentChip key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}

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

        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy || noModel || attachments.length >= MAX_ATTACHMENTS}
            className="btn-icon shrink-0 self-end mb-0.5"
            aria-label="Attach files"
            title="Attach files"
          >
            <Paperclip className="w-4 h-4" />
          </button>
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === 'Escape' && busy) {
                e.preventDefault();
                onStop();
              }
            }}
            placeholder={
              busy ? 'Generating... (Esc to stop)'
                : noModel ? 'Pick a model above to start chatting'
                  : 'Type a message. Shift+Enter for newline. Drop files to attach.'
            }
            className="field-textarea flex-1 max-h-[200px] resize-none"
            disabled={busy || noModel}
          />
          {busy ? (
            <button onClick={onStop} className="btn-secondary !text-red-600 hover:!bg-red-50">
              <StopCircle className="w-4 h-4" />
              Stop
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={(!text.trim() && attachments.length === 0) || !model}
              className="btn-primary"
              aria-label="Send"
            >
              <Send className="w-4 h-4" />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ChipProps { att: PendingAttachment; onRemove: () => void }
function AttachmentChip({ att, onRemove }: ChipProps) {
  // Larger pill (small thumbnail or icon + filename + remove button), purely
  // composed from neutral utilities so it sits comfortably alongside the rest
  // of Studio.
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
