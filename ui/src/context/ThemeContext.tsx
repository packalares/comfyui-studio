// Theme provider — toggles `.dark` on <html> so the `:root` / `.dark` token
// blocks in `index.css` cascade through the entire app. Default is 'light'
// (per product decision); user override persists in localStorage.
//
// We deliberately don't read `prefers-color-scheme` for the initial value —
// the product wants light as the canonical default, dark as an opt-in.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from 'react';

export type Theme = 'light' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (next: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'studio:theme';

function readInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'dark' || raw === 'light') return raw;
  } catch { /* incognito / disabled storage — fall through to default */ }
  return 'light';
}

function applyThemeClass(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readInitialTheme);

  // Sync the .dark class to <html> on every theme change. Runs once on mount
  // too so a localStorage-restored 'dark' lights up the app immediately.
  useEffect(() => {
    applyThemeClass(theme);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch { /* see readInitialTheme */ }
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState(prev => prev === 'dark' ? 'light' : 'dark');
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, toggleTheme }),
    [theme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
