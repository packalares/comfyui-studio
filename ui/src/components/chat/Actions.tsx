// Per-message action row. Renders Copy on every message; Regenerate (last
// assistant only) and Delete (any message) are wired in via optional props
// so the call site decides which buttons surface.
//
// Layout: rendered as a sibling of `<MessageContent>` (NOT inside the
// bubble) so the bubble's bottom padding isn't disturbed. Visibility uses
// `opacity-0 group-hover:opacity-100` — keeps the row reserved (so layout
// doesn't flicker between hover/unhover) and only fades the icons in on
// row hover. Tooltips work because the plain `<button>` triggers below
// forward refs to Radix correctly (the previous shadcn `<Button>` did
// not, which was the original tooltip-not-firing bug).
//
// User vs assistant alignment: `<Message>` adds `is-user` to its wrapper
// for user messages, so the bubble pushes right. We mirror that by
// right-aligning the actions under the user bubble via the
// `group-[.is-user]:justify-end` selector.

import { useState } from 'react';
import { Check, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import ConfirmDialog from '../modals/ConfirmDialog';

interface Props {
  text: string;
  onRegenerate?: () => void;
  onDelete?: () => void;
}

export default function Actions({ text, onRegenerate, onDelete }: Props) {
  const [copied, setCopied] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

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
    <>
      <div className="chat-actions-row">
        {text.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCopy}
                aria-label={copied ? 'Copied' : 'Copy'}
                className="chat-action-btn"
              >
                {copied
                  ? <Check className="h-3.5 w-3.5 text-success" />
                  : <Copy className="h-3.5 w-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{copied ? 'Copied' : 'Copy'}</TooltipContent>
          </Tooltip>
        )}
        {onRegenerate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onRegenerate}
                aria-label="Regenerate"
                className="chat-action-btn"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Regenerate</TooltipContent>
          </Tooltip>
        )}
        {onDelete && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                aria-label="Delete message"
                className="chat-action-btn is-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Delete message</TooltipContent>
          </Tooltip>
        )}
      </div>
      {onDelete && (
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          title="Delete this message?"
          description="The message will be permanently removed from this conversation. This cannot be undone."
          confirmLabel="Delete"
          confirmTone="danger"
          onConfirm={() => {
            onDelete();
            setConfirmOpen(false);
          }}
        />
      )}
    </>
  );
}
