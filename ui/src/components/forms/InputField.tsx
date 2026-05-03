// Reusable label + tooltip + helper + input composition. Replaces the
// hand-rolled `field-label / field-wrap / field-input / field-helper`
// stacks scattered across Settings, ToolsCard, AdvancedSettings, etc.
//
// Built on the existing `.field-*` CSS classes (ui/src/index.css) so the
// visual language is unchanged — this just centralises the JSX. Shadcn's
// `<Input>` is intentionally NOT used here because every consumer in this
// codebase wraps the input in a `field-wrap` row to host left/right
// addons; using the shadcn primitive would mean re-implementing the addon
// row anyway.
//
// Built-in shortcuts:
//  - `type="password"` auto-renders an Eye/EyeOff toggle on the right.
//    Caller does not own the show/hide state.
//  - `configured={{ onClear }}` switches to the Secrets-card visual
//    (emerald border + bg, "Configured" disabled italic, Trash button).
//  - `leftIcon` slots a non-interactive icon on the left (search, etc).
//  - `rightAction` slots a custom right-side button (overridden by both
//    the password toggle and the configured-clear). Use this for
//    inline actions like "Clear" on a search input.

import { useId, useState, type ReactNode } from 'react';
import { HelpCircle, Eye, EyeOff, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export interface InputFieldAction {
  icon: ReactNode;
  onClick: () => void;
  tooltip?: string;
  ariaLabel?: string;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

export interface InputFieldProps {
  // ---- label group ----
  label?: string;
  /** Body text for the (?)tooltip rendered next to the label. */
  tooltip?: string;
  /** Slot pinned to the right of the label row (e.g. slider value, "* required"). */
  labelRight?: ReactNode;

  // ---- input ----
  type?: 'text' | 'password' | 'number' | 'email' | 'url' | 'search';
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Default true — most fields in this app are key/url/path-ish content. */
  monospace?: boolean;
  autoComplete?: string;
  spellCheck?: boolean;
  // number-only
  min?: number;
  max?: number;
  step?: number;

  // ---- helpers ----
  helper?: string;

  // ---- addons ----
  leftIcon?: ReactNode;
  rightAction?: InputFieldAction;
  /**
   * Arbitrary JSX rendered inside the field-wrap on the right (e.g. a Test
   * button next to a URL). Overrides `rightAction` AND the password eye
   * toggle when set — caller takes full responsibility for the right side.
   * Use this when `rightAction` (icon-only) isn't enough.
   */
  rightSlot?: ReactNode;

  /**
   * Secrets-style "configured" mask. When set:
   *  - field-wrap gets emerald border + light emerald bg
   *  - input is disabled, displays the literal "Configured"
   *  - right side renders a Trash button wired to `onClear`
   * Overrides `rightAction`, `rightSlot`, and the password Eye toggle.
   */
  configured?: { onClear: () => void; clearDisabled?: boolean };
}

export default function InputField({
  label,
  tooltip,
  labelRight,
  type = 'text',
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  monospace = true,
  autoComplete = 'off',
  spellCheck = false,
  min,
  max,
  step,
  helper,
  leftIcon,
  rightAction,
  rightSlot,
  configured,
}: InputFieldProps) {
  const [showPwd, setShowPwd] = useState(false);
  const inputId = useId();
  const isPassword = type === 'password';
  const effectiveType = isPassword ? (showPwd ? 'text' : 'password') : type;

  const wrapClass = configured
    ? 'field-wrap !border-emerald-300 !bg-emerald-50/50 focus-within:!border-emerald-400'
    : invalid
    ? 'field-wrap !border-rose-400 focus-within:!border-rose-500'
    : 'field-wrap';

  const inputClass = configured
    ? 'field-input font-medium text-emerald-700'
    : monospace
    ? 'field-input font-mono'
    : 'field-input';

  const action: ReactNode = configured ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={configured.onClear}
          disabled={configured.clearDisabled}
          className="cursor-pointer text-emerald-600 transition-colors hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Clear"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Clear</TooltipContent>
    </Tooltip>
  ) : rightSlot ? (
    rightSlot
  ) : isPassword ? (
    <button
      type="button"
      onClick={() => setShowPwd(s => !s)}
      className="cursor-pointer text-slate-400 transition-colors hover:text-slate-700"
      aria-label={showPwd ? 'Hide' : 'Show'}
    >
      {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  ) : rightAction ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={rightAction.onClick}
          disabled={rightAction.disabled}
          aria-label={rightAction.ariaLabel ?? rightAction.tooltip ?? 'Action'}
          className={`cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
            rightAction.tone === 'danger'
              ? 'text-slate-400 hover:text-rose-600'
              : 'text-slate-400 hover:text-slate-700'
          }`}
        >
          {rightAction.icon}
        </button>
      </TooltipTrigger>
      {rightAction.tooltip && <TooltipContent>{rightAction.tooltip}</TooltipContent>}
    </Tooltip>
  ) : null;

  return (
    <div>
      {(label || labelRight) && (
        <div className="mb-1 flex items-center gap-1.5">
          {label && (
            <label htmlFor={inputId} className="field-label">
              {label}
            </label>
          )}
          {tooltip && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="cursor-help text-slate-400 transition-colors hover:text-slate-600"
                  aria-label={`${label ?? 'field'} info`}
                >
                  <HelpCircle className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
            </Tooltip>
          )}
          {labelRight && <span className="ml-auto">{labelRight}</span>}
        </div>
      )}
      <div className={wrapClass}>
        {leftIcon && <span className="text-slate-400 [&>*]:h-4 [&>*]:w-4">{leftIcon}</span>}
        <input
          id={inputId}
          type={effectiveType}
          value={configured ? 'Configured' : value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled || Boolean(configured)}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          min={min}
          max={max}
          step={step}
          aria-invalid={invalid || undefined}
          className={inputClass}
        />
        {action}
      </div>
      {helper && <p className="field-helper mt-1">{helper}</p>}
    </div>
  );
}
