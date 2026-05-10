// Composer footer: model picker pill on the LEFT next to icon-only tool
// toggles (image / web / preview / tool-details) and the attach button.
// Send stays on the right. Soul lives in <ContextSettings>; tools and model
// each have their own popover (<ChatModelPopover>) — no separate dialog.

import { useEffect, useRef, useState, useCallback, type MutableRefObject } from 'react';
import {
  ArrowUp, StopCircle, Paperclip, X, FileText, Image as ImageIcon, Globe, Code2, Eye,
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
import type {
  OllamaInstalledModel, ChatUsageState,
} from '../../services/comfyui';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  ALLOWED_ACCEPT, MAX_ATTACHMENTS, formatBytes, modelIsVisionCapable,
  listVisionCapableBaseNames,
  processFile, type PendingAttachment,
} from './attachments';
import ChatModelPopover from './ChatModelPopover';
import SlashMenu from './SlashMenu';
import type { DraftOverrides } from '../../pages/Chat';

const TOOL_IMAGE = 'generate_image';
const TOOL_WEB = 'web_search';

interface Props {
  installed: OllamaInstalledModel[];
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
  showToolDetails: boolean;
  onShowToolDetailsChange: (next: boolean) => void;
  /** Inline iframe previews of plain URLs in assistant replies. */
  webPreviews: boolean;
  onWebPreviewsChange: (next: boolean) => void;
  /** null = no filter (every configured tool). string[] = explicit allow-list. */
  enabledTools: string[] | null;
  onEnabledToolsChange: (next: string[] | null) => void;
  centered?: boolean;
  /** Forwarded to ChatModelPopover. */
  conversationId: string | null;
  initialUsage: ChatUsageState | null;
  usageVersion: number;
  draftOverrides: DraftOverrides;
  onDraftOverrideChange: (patch: DraftOverrides) => void;
}

export default function Composer({
  installed, installedLoading, model, onModelChange, busy, onSend, onStop, focusRef,
  libraryCapabilities, attachments, onAttachmentsChange,
  webPreviews, onWebPreviewsChange,
  showToolDetails, onShowToolDetailsChange,
  enabledTools, onEnabledToolsChange,
  centered = false,
  conversationId, initialUsage, usageVersion,
  draftOverrides, onDraftOverrideChange,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragDepth, setDragDepth] = useState(0);
  const isDragging = dragDepth > 0;

  const [textareaValue, setTextareaValue] = useState('');
  const slashMatch = /^\/(\w*)$/.exec(textareaValue.trimStart());
  const slashMenuOpen = !busy && slashMatch !== null;
  const slashQuery = slashMatch ? slashMatch[1] : '';

  const handleSlashSelect = useCallback((name: string) => {
    const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    if (!ta) return;
    const next = `/${name} `;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(ta, next);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setTextareaValue(next);
    ta.focus();
  }, []);

  const handleSlashClose = useCallback(() => {
    const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    ta?.focus();
  }, []);
  const focusTextarea = () => {
    const ta = wrapRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
    ta?.focus();
  };

  useEffect(() => {
    if (!focusRef) return;
    focusRef.current = focusTextarea;
    return () => { if (focusRef) focusRef.current = () => {}; };
  }, [focusRef]);

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

  // Tool toggles operate on the enabledTools allow-list. `null` legacy means
  // "all tools enabled" — treat as both Image+Web on for the toggle UI; the
  // first toggle action materializes an explicit array.
  const isToolOn = (name: string): boolean =>
    enabledTools === null || enabledTools.includes(name);
  const toggleTool = (name: string) => {
    const current = enabledTools === null
      ? [TOOL_IMAGE, TOOL_WEB]
      : [...enabledTools];
    const next = current.includes(name)
      ? current.filter(n => n !== name)
      : [...current, name];
    onEnabledToolsChange(next);
  };

  if (installedLoading) {
    return (
      <div className={centered ? '' : ' bg-card'}>
        <div className="mx-auto max-w-4xl px-2 pb-3">
          <div role="status" aria-label="Loading chat composer"
               className="relative overflow-hidden rounded-lg border bg-muted">
            <div className="skeleton-shimmer" />
            <div className="relative space-y-2 px-4 pt-4">
              <div className="h-3 w-2/3 rounded bg-secondary" />
              <div className="h-3 w-1/2 rounded bg-secondary" />
              <div className="h-3 w-2/5 rounded bg-secondary" />
            </div>
            <div className="relative mt-6 flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <div className="h-8 w-32 rounded-md bg-secondary" />
                <div className="h-8 w-8 rounded-md bg-secondary" />
                <div className="h-8 w-8 rounded-md bg-secondary" />
              </div>
              <div className="h-8 w-8 rounded-full bg-secondary" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={centered ? '' : 'bg-card'}>
      <div
        ref={wrapRef}
        className="relative mx-auto max-w-4xl px-2 pb-5"
        onDragEnter={(e) => {
          if (busy || noModel) return;
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragDepth(d => d + 1);
        }}
        onDragOver={(e) => {
          if (busy || noModel) return;
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (busy || noModel) return;
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragDepth(d => Math.max(0, d - 1));
        }}
        onDrop={(e) => {
          if (busy || noModel) return;
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragDepth(0);
          if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
        }}
      >
        {isDragging && (
          <div aria-hidden
               className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-brand/10 text-sm font-medium text-brand">
            Drop files to attach
          </div>
        )}
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

        <SlashMenu
          open={slashMenuOpen}
          query={slashQuery}
          onSelect={handleSlashSelect}
          onClose={handleSlashClose}
        >
          <div className="w-full">
        <PromptInput onSubmit={submit}>
            {attachments.length > 0 && (
              <PromptInputHeader>
                {attachments.map(a => (
                  <AttachmentChip key={a.id} att={a} onRemove={() => removeAttachment(a.id)} />
                ))}
              </PromptInputHeader>
            )}
            <PromptInputTextarea
              className={centered ? 'min-h-40 max-h-72' : 'min-h-14 max-h-48'}
              placeholder={
                busy ? 'Generating... (Esc to stop)'
                  : noModel ? 'Pick a model below to start chatting'
                    : 'Ask anything...'
              }
              disabled={busy}
              onChange={(e) => setTextareaValue(e.target.value)}
              onKeyDown={(e) => {
                if (slashMenuOpen && e.key === 'Enter') {
                  e.preventDefault();
                  return;
                }
                if (e.key === 'Escape' && busy) {
                  e.preventDefault();
                  onStop();
                }
                if (e.key === 'Escape' && slashMenuOpen) {
                  e.preventDefault();
                  handleSlashClose();
                }
              }}
            />
            <PromptInputFooter>
              <PromptInputTools>
                <ChatModelPopover
                  installed={installed}
                  loading={!!installedLoading}
                  model={model}
                  disabled={busy}
                  libraryCapabilities={libraryCapabilities}
                  onChange={onModelChange}
                  conversationId={conversationId}
                  initialUsage={initialUsage}
                  usageVersion={usageVersion}
                  draftOverrides={draftOverrides}
                  onDraftOverrideChange={onDraftOverrideChange}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      onClick={openFilePicker}
                      aria-disabled={busy || noModel || attachFull}
                      variant="ghost"
                      size="icon"
                      aria-label="Attach files"
                      className="!h-8 !w-8 !rounded-md !bg-muted !text-foreground hover:!bg-secondary !cursor-pointer"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach files</TooltipContent>
                </Tooltip>
                <ToolToggle
                  Icon={ImageIcon}
                  label="Image"
                  active={isToolOn(TOOL_IMAGE)}
                  onClick={() => toggleTool(TOOL_IMAGE)}
                  hint="Allow the model to generate images"
                />
                <ToolToggle
                  Icon={Globe}
                  label="Web"
                  active={isToolOn(TOOL_WEB)}
                  onClick={() => toggleTool(TOOL_WEB)}
                  hint="Allow the model to search the web"
                />
                <ToolToggle
                  Icon={Eye}
                  label="Preview"
                  active={webPreviews}
                  onClick={() => onWebPreviewsChange(!webPreviews)}
                  hint="Render iframe previews for URLs in assistant replies"
                />
                <ToolToggle
                  Icon={Code2}
                  label="Tool"
                  active={showToolDetails}
                  onClick={() => onShowToolDetailsChange(!showToolDetails)}
                  hint="Show tool call parameters and raw JSON output inline"
                />
              </PromptInputTools>
              <PromptInputTools>
                {busy ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        onClick={onStop}
                        variant="secondary"
                        size="icon"
                        className="!h-8 !w-8 !rounded-full !p-0 !text-destructive hover:!bg-destructive/10 !cursor-pointer"
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
                        className="!h-8 !w-8 !rounded-full !p-0 !bg-brand hover:!bg-brand/90 !text-brand-foreground !cursor-pointer"
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
        </SlashMenu>
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
          className="h-9 w-9 rounded object-cover ring-1 ring-border"
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

interface ToolToggleProps {
  Icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
  hint: string;
}
/** Icon-only by default with the same gray bg as the paperclip; when `active`,
 *  the label appears next to the icon and the bg flips to brand-tinted.
 *  Tooltip always shows the longer description on hover. */
function ToolToggle({ Icon, label, active, onClick, hint }: ToolToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-pressed={active}
          aria-label={label}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium cursor-pointer transition-colors',
            active
              ? 'bg-brand/10 text-brand hover:bg-brand/20'
              : 'bg-muted text-foreground hover:bg-secondary',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {active && <span className="hidden sm:inline">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
