// Topbar theme picker. Click the palette icon to open a popover with the
// alternate palette chips shipped in `themes.css`. Toggles `data-theme` on
// <html> and persists the selection in localStorage so a reload keeps it.
//
// Dark mode is owned by ThemeContext (next to this in the topbar) — this
// component only swaps the palette name.
//
// This is a dev affordance — once a winning theme is chosen, drop the
// component, drop its mount in <TopBar>, and copy the chosen tokens into
// `index.css` as the default.

import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { cn } from '../../lib/utils';

const THEMES = [
  'default',
  // shadcn/ui canonical zinc/neutral default palette (oklch)
  'shadcn',
  // Opus-agent round 3 — blank-slate "clean professional SaaS", no references
  'slate-cobalt', 'paper-moss', 'graphite-plum',
  // Opus-agent round 2 — clean professional, Linear/Untitled-UI/Stripe lane
  'lattice', 'mineral', 'quartz',
  // Opus-agent round 1 — diversified semantic trios (mostly rejected as
  // too varied; kept for comparison until a winner is picked)
  'halcyon', 'kiln', 'obsidian', 'voltage', 'ashfield',
  // My-eye: built by directly observing each PNG
  'rust', 'graphite', 'clinic', 'flush', 'walnut',
  // Strict-agent per-PNG themes (hex literals)
  'coral', 'charcoal', 'mint', 'salmon', 'moody',
  // Earlier OKLCH-derived clustering (kept for comparison)
  'slate', 'emerald', 'terra',
  // 2026-05 round — clean/readable: warm-neutral, cool-neutral, monochrome, blue-accent, green-accent
  'linen', 'nordic', 'ink', 'cobalt', 'grove',
  // 2026-05 round — refined neutral / monochrome: achromatic, shadcn-but-better set
  'zinc', 'stone', 'pewter', 'chalk', 'cement',
] as const;
type Theme = (typeof THEMES)[number];

const THEME_KEY = 'studio.theme';

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'default';
  const raw = localStorage.getItem(THEME_KEY);
  return (THEMES as readonly string[]).includes(raw ?? '')
    ? (raw as Theme)
    : 'default';
}

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'default') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        type="button"
        aria-label="Choose palette"
        title="Palette"
        className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground hover:bg-muted transition-colors"
      >
        <Palette className="w-4 h-4" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-2">
        <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Palette
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {THEMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTheme(t)}
              aria-pressed={theme === t}
              className={cn(
                'cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
                theme === t
                  ? 'bg-brand text-brand-foreground'
                  : 'text-foreground hover:bg-muted',
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
