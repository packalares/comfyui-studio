// Per-message action row. Renders Copy on every message; Regenerate (last
// assistant only) and Delete (any message) are wired in via optional props
// so the call site decides which buttons surface.
//
// Two layouts via `variant`:
//   'row' (default) — assistant messages. Sibling of <MessageContent>; sits
//     below the bubble, fades in on row hover.
//   'floating' — user messages. Absolutely positioned at the right edge of
//     the bubble, vertically centered. Caller MUST wrap the bubble in a
//     `relative` container so positioning anchors correctly. Buttons get
//     a card surface + shadow so they pop above the bubble fill.
//
// Tooltips work because the plain `<button>` triggers below forward refs to
// Radix correctly (the previous shadcn `<Button>` dropped refs through the
// `asChild` Slot, which silently broke the popover-style tooltip trigger).

import { useState } from 'react';
import { Check, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import ConfirmDialog from '../modals/ConfirmDialog';
import { useTransientFlag } from '../../hooks/useTransientFlag';

interface Props {
  text: string;
  onRegenerate?: () => void;
  onDelete?: () => void;
  variant?: 'row' | 'floating';
}

// Translucent card surface + backdrop-blur — only the bubble text directly
// behind the icons softens, while the rest of the message stays sharp.
// (Earlier iteration tried blurring the whole bubble on hover; user
// preferred this localised effect.)
const FLOATING_BTN =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border bg-card/60 backdrop-blur-sm text-muted-foreground shadow-sm hover:bg-card/80 hover:text-foreground cursor-pointer transition-colors';
const FLOATING_BTN_DANGER =
  'inline-flex h-7 w-7 items-center justify-center rounded-md border bg-card/60 backdrop-blur-sm text-muted-foreground shadow-sm hover:bg-destructive/15 hover:text-destructive cursor-pointer transition-colors';

export default function Actions({ text, onRegenerate, onDelete, variant = 'row' }: Props) {
  const [copied, markCopied] = useTransientFlag(1500);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const onCopy = async () => {
    if (!navigator.clipboard?.writeText) {
      toast.error('Clipboard not available');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      markCopied();
    } catch (err) {
      toast.error('Copy failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isFloating = variant === 'floating';
  const wrapperCls = isFloating
    ? 'absolute right-2 bottom-1.5 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'
    : 'chat-actions-row';
  const btnCls = isFloating ? FLOATING_BTN : 'chat-action-btn';
  const dangerBtnCls = isFloating ? FLOATING_BTN_DANGER : 'chat-action-btn is-danger';

  return (
    <>
      <div className={wrapperCls}>
        {text.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCopy}
                aria-label={copied ? 'Copied' : 'Copy'}
                className={btnCls}
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
                className={btnCls}
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
                className={dangerBtnCls}
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
