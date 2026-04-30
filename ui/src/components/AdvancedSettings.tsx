import { useState } from 'react';
import { ChevronDown, Shuffle, Minus, Plus, Info } from 'lucide-react';
import type { AdvancedSetting } from '../types';
import { Slider } from './ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Combobox, COMBOBOX_SEARCH_THRESHOLD } from './ui/combobox';
import { Switch } from './ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

interface Props {
  settings: AdvancedSetting[];
  values: Record<string, { proxyIndex: number; value: unknown }>;
  onChange: (values: Record<string, { proxyIndex: number; value: unknown }>) => void;
}

export default function AdvancedSettings({ settings, values, onChange }: Props) {
  const [open, setOpen] = useState(false);

  if (settings.length === 0) return null;

  const handleChange = (setting: AdvancedSetting, newValue: unknown) => {
    onChange({
      ...values,
      [setting.id]: { proxyIndex: setting.proxyIndex, value: newValue },
    });
  };

  const getValue = (setting: AdvancedSetting): unknown => {
    const override = values[setting.id];
    if (override !== undefined) return override.value;
    return setting.value;
  };

  return (
    <div className="border-t border-gray-100 pt-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        <ChevronDown
          className={`w-3.5 h-3.5 text-gray-400 transition-transform ${
            open ? '' : '-rotate-90'
          }`}
        />
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider group-hover:text-gray-600 transition-colors">
          Advanced Settings
        </span>
        <span className="text-[10px] text-gray-300 ml-auto">
          {settings.length} {settings.length === 1 ? 'option' : 'options'}
        </span>
      </button>

      {open && (
        <NodeGroupedSettings
          settings={settings}
          getValue={getValue}
          handleChange={handleChange}
        />
      )}
    </div>
  );
}

// Group settings by source node (preserving first-appearance order so the
// per-node sections line up with the workflow's document order). Inside
// each section the existing type-bucketed layout still runs — keeps the
// "textareas full-width / numbers in a 2-col grid / toggles compact" UX.
// Settings without a `nodeId` (legacy persisted entries) collect under an
// untitled "Other" section at the bottom.
function NodeGroupedSettings({
  settings, getValue, handleChange,
}: {
  settings: AdvancedSetting[];
  getValue: (s: AdvancedSetting) => unknown;
  handleChange: (s: AdvancedSetting, v: unknown) => void;
}) {
  const groups: Array<{ key: string; title: string | null; items: AdvancedSetting[] }> = [];
  const byKey = new Map<string, AdvancedSetting[]>();
  for (const s of settings) {
    const key = s.nodeId ?? '__other__';
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
      groups.push({
        key,
        title: s.nodeId ? (s.nodeTitle ?? s.nodeId) : null,
        items: bucket,
      });
    }
    bucket.push(s);
  }

  // Single-group fallback: when every setting lives under one node (or none
  // are attributed), the per-node heading is noise. Render the legacy
  // type-bucketed layout directly.
  if (groups.length <= 1) {
    return (
      <GroupedSettings
        settings={settings}
        getValue={getValue}
        handleChange={handleChange}
      />
    );
  }

  return (
    <div className="mt-3 space-y-5">
      {groups.map(g => (
        <div key={g.key}>
          {g.title && (
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
              {g.title}
            </div>
          )}
          <GroupedSettings
            settings={g.items}
            getValue={getValue}
            handleChange={handleChange}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Bucket settings by widget shape and render each bucket with a layout
 * that fits its width needs:
 *
 *   textarea  → full width, stacked (each one its own row).
 *   select | number | slider | seed | text  → 2-col grid (1-col on mobile).
 *   toggle    → 2-col grid on mobile, 3-col on md+ (compact pills).
 *
 * Kept in document order within each bucket so related fields that live
 * near each other in the source workflow stay adjacent. Prevents the
 * old mixed-column jank where a narrow toggle sat next to a wide
 * number stepper.
 */
function GroupedSettings({
  settings, getValue, handleChange,
}: {
  settings: AdvancedSetting[];
  getValue: (s: AdvancedSetting) => unknown;
  handleChange: (s: AdvancedSetting, v: unknown) => void;
}) {
  const buckets = {
    textarea: [] as AdvancedSetting[],
    input: [] as AdvancedSetting[], // number | slider | seed | select | text
    toggle: [] as AdvancedSetting[],
  };
  for (const s of settings) {
    if (s.type === 'textarea') buckets.textarea.push(s);
    else if (s.type === 'toggle') buckets.toggle.push(s);
    else buckets.input.push(s);
  }

  return (
    <div className="mt-3 space-y-4">
      {buckets.textarea.length > 0 && (
        <div className="space-y-3">
          {buckets.textarea.map(s => (
            <SettingField
              key={s.id}
              setting={s}
              value={getValue(s)}
              onChange={(v) => handleChange(s, v)}
            />
          ))}
        </div>
      )}
      {buckets.input.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-3">
          {buckets.input.map(s => (
            <SettingField
              key={s.id}
              setting={s}
              value={getValue(s)}
              onChange={(v) => handleChange(s, v)}
            />
          ))}
        </div>
      )}
      {buckets.toggle.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-slate-100">
          {buckets.toggle.map(s => (
            <SettingField
              key={s.id}
              setting={s}
              value={getValue(s)}
              onChange={(v) => handleChange(s, v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: AdvancedSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  // Toggle renders inline: label left, switch right, no control row below.
  if (setting.type === 'toggle') {
    return (
      <div className="flex items-center">
        <SettingLabel setting={setting} />
        <span className="ml-auto">
          <Switch size="sm" checked={!!value} onCheckedChange={onChange} />
        </span>
      </div>
    );
  }

  let labelRight: React.ReactNode = null;
  if (setting.type === 'slider') {
    const step = setting.step ?? 1;
    const min = setting.min ?? 0;
    const num = (value as number) ?? min;
    const precision = Math.max(0, -Math.floor(Math.log10(step)));
    labelRight = <span className="text-xs font-medium tabular-nums text-slate-700">{num.toFixed(precision)}</span>;
  }
  return (
    <div>
      <div className="flex items-center mb-1">
        <SettingLabel setting={setting} />
        {labelRight && <span className="ml-auto">{labelRight}</span>}
      </div>
      <SettingControl setting={setting} value={value} onChange={onChange} />
    </div>
  );
}

/**
 * Renders the field label plus an Info tooltip when scope disclosure is
 * available. Kept inline (not a flex container) so the outer row layout —
 * `ml-auto` right-side readouts, toggle switches — still anchors off the
 * parent `<div>` without extra wrapping.
 */
function SettingLabel({ setting }: { setting: AdvancedSetting }) {
  return (
    <span className="inline-flex items-center gap-1">
      <label className="text-[11px] font-medium text-gray-600">{setting.label}</label>
      {setting.scopeLabel && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="w-3 h-3 text-slate-400 hover:text-slate-600 cursor-help" />
          </TooltipTrigger>
          <TooltipContent>{setting.scopeLabel}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

function SettingControl({
  setting,
  value,
  onChange,
}: {
  setting: AdvancedSetting;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (setting.type) {
    case 'number': {
      const step = setting.step && setting.step > 0 ? setting.step : 1;
      const raw = (value as number | undefined) ?? setting.min ?? 0;
      const num = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw) || 0;
      const clamp = (n: number) => {
        if (!Number.isFinite(n)) n = setting.min ?? 0;
        if (setting.min !== undefined) n = Math.max(setting.min, n);
        if (setting.max !== undefined) n = Math.min(setting.max, n);
        // Guard: Math.log10 of a non-positive number is NaN; clamp precision to 0 in that case
        // so toFixed() doesn't throw and blow up the whole Advanced Settings render.
        const rawPrec = -Math.floor(Math.log10(step));
        const precision = Number.isFinite(rawPrec) ? Math.max(0, rawPrec) : 0;
        return parseFloat(n.toFixed(precision));
      };
      const atMin = setting.min !== undefined && num <= setting.min;
      const atMax = setting.max !== undefined && num >= setting.max;
      return (
        <div className="field-wrap">
          <button type="button" onClick={() => onChange(clamp(num - step))} disabled={atMin} className="field-stepper" aria-label="Decrease">
            <Minus className="w-3.5 h-3.5" />
          </button>
          <input
            type="number"
            value={num}
            onChange={e => {
              const n = parseFloat(e.target.value);
              onChange(Number.isNaN(n) ? 0 : clamp(n));
            }}
            min={setting.min}
            max={setting.max}
            step={step}
            className="field-input text-center tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button type="button" onClick={() => onChange(clamp(num + step))} disabled={atMax} className="field-stepper" aria-label="Increase">
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    }

    case 'slider': {
      const min = setting.min ?? 0;
      const max = setting.max ?? 100;
      const step = setting.step ?? 1;
      const numValue = (value as number) ?? min;
      return (
        <Slider
          value={[numValue]}
          onValueChange={([v]) => onChange(v)}
          min={min}
          max={max}
          step={step}
        />
      );
    }

    case 'seed': {
      const seedValue = value as number | null | undefined;
      return (
        <div className="field-wrap">
          <input
            type="number"
            value={seedValue ?? ''}
            onChange={e => {
              const v = e.target.value;
              onChange(v === '' ? null : parseInt(v, 10));
            }}
            placeholder="Random"
            className="field-input tabular-nums [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={() => onChange(Math.floor(Math.random() * 2147483647))}
            className="field-stepper"
            title="Randomize seed"
          >
            <Shuffle className="w-3.5 h-3.5" />
          </button>
        </div>
      );
    }

    case 'select': {
      const options = setting.options ?? [];
      const current = (value as string) ?? '';
      if (options.length > COMBOBOX_SEARCH_THRESHOLD) {
        return (
          <Combobox
            value={current}
            onValueChange={v => onChange(v)}
            options={options}
            searchPlaceholder={`Search ${setting.label.toLowerCase()}…`}
            emptyMessage="No matching option"
          />
        );
      }
      return (
        <Select value={current} onValueChange={v => onChange(v)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }

    case 'text':
      return (
        <div className="field-wrap">
          <input
            type="text"
            value={(value as string) ?? ''}
            onChange={e => onChange(e.target.value)}
            className="field-input"
          />
        </div>
      );

    case 'textarea':
      return (
        <textarea
          value={(value as string) ?? ''}
          onChange={e => onChange(e.target.value)}
          rows={4}
          className="field-textarea"
        />
      );

    default:
      return null;
  }
}
