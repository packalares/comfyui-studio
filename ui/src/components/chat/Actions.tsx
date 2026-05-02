// Hand-rolled per-assistant-message action row (copy for now). ai-elements
// doesn't ship `<Actions>`, so we compose shadcn primitives directly.
//
// Future: regenerate / delete need server-side endpoints (`POST
// /chat/messages/:id/regenerate`, `DELETE /chat/messages/:id`) that don't
// exist yet — when they land, extend this row with matching ghost-icon
// buttons. Keeping the component tiny means that's an additive change.

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';

interface Props {
  text: string;
}

export default function Actions({ text }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard not available');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error('Copy failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        type="button"
        onClick={onCopy}
        variant="ghost"
        size="icon"
        aria-label={copied ? 'Copied' : 'Copy'}
        title={copied ? 'Copied' : 'Copy'}
        className="h-7 w-7"
      >
        {copied
          ? <Check className="h-3.5 w-3.5 text-emerald-600" />
          : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}
