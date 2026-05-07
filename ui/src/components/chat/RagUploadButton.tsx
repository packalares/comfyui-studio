// Composer toolbar button that opens a popover with a knowledge-base
// picker + file input. Uploads the file via `/api/rag/upload` (which
// forwards to RAGFlow). Distinct from the chat-attachment paperclip:
// these files become long-lived RAG documents, not turn-scoped context.

import { useEffect, useState, useCallback } from 'react';
import { BookPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { listRagKbs, uploadFileToKb, type RagflowKb } from '../../api/rag';

interface Props {
  /** Disabled when ragflowUrl + ragflowApiKey aren't both set in settings. */
  disabled?: boolean;
}

export default function RagUploadButton({ disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [kbs, setKbs] = useState<RagflowKb[] | null>(null);
  const [kbsError, setKbsError] = useState<string | null>(null);
  const [selectedKb, setSelectedKb] = useState<string>('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  // Lazy-load the KB list the first time the popover opens. Re-fetch on
  // every open so a freshly-created KB appears without a page reload.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setKbsError(null);
    listRagKbs()
      .then((list) => {
        if (cancelled) return;
        setKbs(list);
        if (list.length > 0 && !selectedKb) setSelectedKb(list[0].id);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setKbsError(msg);
        setKbs([]);
      });
    return () => { cancelled = true; };
  }, [open, selectedKb]);

  const reset = useCallback(() => {
    setFile(null);
    setSelectedKb('');
  }, []);

  const submit = useCallback(async () => {
    if (!file || !selectedKb) return;
    setUploading(true);
    try {
      const result = await uploadFileToKb(file, selectedKb);
      const kbName = kbs?.find(k => k.id === selectedKb)?.name ?? selectedKb;
      toast.success(`Indexing started in ${kbName}`, {
        description: result.documentIds.length > 0
          ? `Document ids: ${result.documentIds.join(', ')}`
          : 'RAGFlow accepted the file. Embeddings build in the background.',
      });
      setOpen(false);
      reset();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error('Upload failed', { description: msg });
    } finally {
      setUploading(false);
    }
  }, [file, selectedKb, kbs, reset]);

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Add file to knowledge base (RAG not configured)"
            disabled
            className="!h-8 !w-8 !rounded-md !bg-muted/50 !text-muted-foreground"
          >
            <BookPlus className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Configure RAGFlow URL + API key in Settings → Tools to enable.</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Add file to knowledge base"
              className="!h-8 !w-8 !rounded-md !bg-muted !text-foreground hover:!bg-secondary hover:!text-foreground"
            >
              <BookPlus className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Index a file into a RAG knowledge base</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80 space-y-3 p-3" align="start">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Index to knowledge base</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            File is forwarded to RAGFlow. Indexing happens asynchronously in the background.
          </p>
        </div>

        {/* KB picker */}
        <div className="space-y-1">
          <label className="field-label">Knowledge base</label>
          {kbs === null && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading…
            </div>
          )}
          {kbsError && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {kbsError}
            </div>
          )}
          {kbs && kbs.length === 0 && !kbsError && (
            <div className="empty-box text-xs">
              No knowledge bases yet. Create one in RAGFlow first.
            </div>
          )}
          {kbs && kbs.length > 0 && (
            <select
              className="field-textarea h-9 w-full !min-h-0 !py-1.5 !leading-none"
              value={selectedKb}
              onChange={(e) => setSelectedKb(e.target.value)}
              disabled={uploading}
            >
              {kbs.map(kb => (
                <option key={kb.id} value={kb.id}>
                  {kb.name}{kb.documentCount !== undefined ? ` (${kb.documentCount} docs)` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* File picker */}
        <div className="space-y-1">
          <label className="field-label">File</label>
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={uploading}
            className="text-xs file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium file:text-foreground hover:file:bg-secondary"
          />
          {file && (
            <p className="text-[11px] text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>

        {/* Submit */}
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => { setOpen(false); reset(); }}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={uploading || !file || !selectedKb}
          >
            {uploading ? <><Spinner size="sm" /> Uploading…</> : 'Add to KB'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
