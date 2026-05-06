import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Compass, Wand2, Image, Box, Package, Settings, Wifi, WifiOff, Menu, X, Play, ExternalLink, MessageSquare, Sun, Moon } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api } from '../../services/comfyui';
import ComfyUIActions from '../ComfyUIActions';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { useTheme } from '../../context/ThemeContext';

function editorHref(): string {
  const { protocol, host } = window.location;
  const parts = host.split('.');
  if (parts.length <= 1) return `${protocol}//comfyuieditor`;
  return `${protocol}//comfyuieditor.${parts.slice(1).join('.')}`;
}

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/explore', label: 'Explore', icon: Compass },
  { to: '/studio', label: 'Studio', icon: Wand2 },
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/gallery', label: 'Gallery', icon: Image },
  { to: '/models', label: 'Models', icon: Box },
  { to: '/plugins', label: 'Plugins', icon: Package },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Navbar() {
  const { connected, launcherStatus, loading } = useApp();
  const { theme, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  // Did we already receive a definitive status signal? `loading` covers the
  // initial `/system` fetch; once any `launcher-status` has arrived we also
  // trust that. Both being satisfied flips the pill out of the neutral
  // "Checking…" placeholder that avoids the Disconnected → Connected flicker
  // on page load.
  const statusKnown = !loading || launcherStatus !== null;

  // Clear optimistic "starting" once the real state catches up
  useEffect(() => {
    if (starting && launcherStatus?.running) setStarting(false);
  }, [starting, launcherStatus]);

  const handleStart = async () => {
    setStarting(true);
    try {
      await api.startComfyUI();
    } catch {
      setStarting(false);
    }
  };

  // Base pill classes — shared across every state so the hover ring, padding,
  // and typography stay consistent whether we're showing Connected / Starting
  // / Start / Checking. State-specific color is layered on top per branch.
  // Explicit `h-7` so the pill + chevron dropdown match pixel-for-pixel when
  // grouped. Text-bearing pills and icon-only chevrons have different natural
  // heights otherwise (line-height vs icon size), which shows as a 4px jog.
  const PILL_BASE = 'inline-flex items-center gap-1.5 text-xs font-medium h-7 px-2.5 transition-colors';

  const statusPill = (() => {
    // Initial placeholder while we don't yet know ComfyUI's state — stops the
    // red "Disconnected" flash on page load that used to precede the first
    // /system response.
    if (!statusKnown) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`${PILL_BASE} rounded-full bg-muted text-muted-foreground border`}>
              <Spinner size="xs" />
              Checking…
            </div>
          </TooltipTrigger>
          <TooltipContent>Checking ComfyUI status</TooltipContent>
        </Tooltip>
      );
    }
    if (starting) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className={`${PILL_BASE} rounded-full bg-warning/10 text-warning border border-warning/30`}>
              <Spinner size="xs" />
              Starting…
            </div>
          </TooltipTrigger>
          <TooltipContent>Booting ComfyUI</TooltipContent>
        </Tooltip>
      );
    }
    if (connected) {
      // Connected state visually joins the Actions dropdown — this pill gets
      // the LEFT half of the group; the chevron button lives in the RIGHT
      // half (see ComfyUIActions via the `inGroup` wrapper below).
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <a
              href={editorHref()}
              target="_blank"
              rel="noopener noreferrer"
              className={`${PILL_BASE} rounded-l-full rounded-r-none bg-success/10 text-success border border-success/30 border-r-0 hover:bg-success/20`}
            >
              <Wifi className="w-3 h-3" />
              Connected
              <ExternalLink className="w-3 h-3 opacity-60" />
            </a>
          </TooltipTrigger>
          <TooltipContent>Open the ComfyUI editor in a new tab</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleStart}
            className={`${PILL_BASE} rounded-full bg-destructive/10 text-destructive border border-destructive/30 hover:bg-destructive/20 cursor-pointer`}
          >
            <WifiOff className="w-3 h-3" />
            Start ComfyUI
          </button>
        </TooltipTrigger>
        <TooltipContent>ComfyUI isn't running — click to start</TooltipContent>
      </Tooltip>
    );
  })();

  return (
    <nav className="sticky top-0 z-50 bg-card border-b">
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-14">
          <div className="flex items-center gap-8">
            <NavLink to="/" className="flex items-center gap-2 font-semibold text-lg text-foreground">
              <Wand2 className="w-5 h-5 text-brand" />
              <span>ComfyUI Studio</span>
            </NavLink>
            <div className="hidden md:flex items-center gap-1">
              {links.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-brand/10 text-brand'
                        : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                    }`
                  }
                >
                  <Icon className="w-4 h-4" />
                  {label}
                </NavLink>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Theme toggle — icon-button matching the ghost/icon button style */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                  className="hidden md:inline-flex"
                >
                  {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}</TooltipContent>
            </Tooltip>
            {/* Desktop: status pill + actions share a zero-gap group so the
                connected-state pill and the chevron dropdown read as one
                segmented control. */}
            <div className="hidden md:flex items-center">
              {statusPill}
              <ComfyUIActions />
            </div>
            {/* Mobile: hamburger button */}
            <Button
              onClick={() => setMenuOpen(o => !o)}
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Menu"
            >
              {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Mobile drawer — overlays content, fades in */}
      <div
        className={`md:hidden absolute left-0 right-0 top-full border-t bg-card shadow-lg transition-all duration-200 ${
          menuOpen ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 -translate-y-2 pointer-events-none'
        }`}
      >
        <div className="px-3 py-3 border-b flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">Status</span>
          {statusPill}
        </div>
        <div className="px-2 py-2 space-y-1">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-brand/10 text-brand'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </div>
      </div>

      {/* Backdrop when menu open */}
      {menuOpen && (
        <div
          className="md:hidden fixed inset-0 top-14 bg-black/20 z-[-1]"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </nav>
  );
}
