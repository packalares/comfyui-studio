// ApiExportModal — shows the ComfyUI /api/prompt payload our converter
// would produce for a given template. Useful for diffing against what
// ComfyUI's native "Save (API)" outputs, so regressions in our flatten/
// emit pipeline are easy to spot.
//
// Loads lazily on open. The server returns the prompt with per-submission
// randomness (seeds) zeroed so two consecutive opens produce identical
// payloads — safe to paste into external diff tools.

import { useEffect, useState } from 'react';
import { Copy, Download, Loader2, Braces, Check } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../services/comfyui';
import AppModal from './AppModal';

interface Props {
  open: boolean;
  templateName: string;
  onClose: () => void;
}

export default function ApiExportModal({ open, templateName, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setPayload('');
      setError(null);
      setCopied(false);
      return;
    }
    // AbortController stops the in-flight fetch when the modal closes
    // before the response arrives — avoids a wasted request and keeps
    // the AbortError visible so its own `.catch` filter can swallow it
    // cleanly. The `cancelled` flag is still useful as a belt-and-
    // suspenders guard against state writes mid-resolve when React's
    // cleanup races the promise chain.
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getTemplateApiPrompt(templateName, ctrl.signal)
      .then(res => {
        if (cancelled) return;
        setPayload(JSON.stringify(res.apiPrompt, null, 2));
      })
      .catch(err => {
        if (cancelled) return;
        // AbortError comes back when we intentionally cancel — don't
        // surface it as a user-visible error toast.
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
  }, [open, templateName]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Copy failed', { description: 'Clipboard write was rejected.' });
    }
  };

  const handleDownload = () => {
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${templateName}.api.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      size="xl"
      scrollBody
      icon={<Braces className="w-4 h-4 text-slate-500" />}
      title="API Prompt"
      subtitle={templateName}
      footer={
        <div className="btn-group">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleDownload}
            disabled={!payload}
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleCopy}
            disabled={!payload}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      }
    >
      {loading && (
        <div className="flex items-center gap-2 text-xs text-slate-500 p-4">
          <Loader2 className="w-4 h-4 animate-spin" />
          Converting workflow…
        </div>
      )}
      {error && (
        <div className="rounded-md bg-rose-50 border border-rose-100 px-3 py-2 text-[12px] text-rose-700">
          {error}
        </div>
      )}
      {!loading && !error && payload && (
        <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded-lg p-4 ring-1 ring-inset ring-slate-200 min-h-[200px] max-h-[60vh] overflow-auto">
          {payload}
        </pre>
      )}
    </AppModal>
  );
}
