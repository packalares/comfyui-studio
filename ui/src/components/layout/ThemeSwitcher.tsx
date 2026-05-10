// Floating theme picker for testing the alternate palettes shipped in
// `themes.css`. Toggles `data-theme` + `.dark` on `<html>` and persists
// the selection in localStorage so a reload keeps the test theme.
//
// This is a dev affordance — once a winning theme is chosen, drop the
// component, drop its mount in <Layout>, and copy the chosen tokens into
// `index.css` as the default.

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '../../lib/utils';

const THEMES = ['default', 'slate', 'emerald', 'terra'] as const;
type Theme = (typeof THEMES)[number];

const THEME_KEY = 'studio.theme';
const DARK_KEY = 'studio.themeDark';

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'default';
  const raw = localStorage.getItem(THEME_KEY);
  return (THEMES as readonly string[]).includes(raw ?? '')
    ? (raw as Theme)
    : 'default';
}

function readDark(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(DARK_KEY) === '1';
}

export default function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [dark, setDark] = useState<boolean>(readDark);

  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'default') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem(DARK_KEY, dark ? '1' : '0'); } catch { /* ignore */ }
  }, [dark]);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-1 rounded-full border bg-card/90 p-1 shadow-lg backdrop-blur-sm">
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
      <span aria-hidden className="mx-1 h-4 w-px bg-border" />
      <button
        type="button"
        onClick={() => setDark((d) => !d)}
        aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-foreground hover:bg-muted transition-colors"
      >
        {dark
          ? <Sun className="h-3.5 w-3.5" />
          : <Moon className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
