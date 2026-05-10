import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Compass, Wand2, Image, Box, Package, Settings,
  Wifi, WifiOff, Play, ExternalLink, MessageSquare, Sun, Moon,
} from 'lucide-react';
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

export default function Sidebar() {
  const { connected, launcherStatus, loading } = useApp();
  const { theme, toggleTheme } = useTheme();
  const [starting, setStarting] = useState(false);

  // `loading` covers the initial /system fetch; once any launcher-status has
  // arrived we trust that. Both being satisfied flips the pill out of the
  // neutral "Checking…" placeholder.
  const statusKnown = !loading || launcherStatus !== null;

  useEffect(() => {
    if (starting && launcherStatus?.running) setStarting(false);
  }, [starting, launcherStatus]);

  const handleStart = async () => {
    setStarting(true);
    try { await api.startComfyUI(); }
    catch { setStarting(false); }
  };

  const PILL_BASE = 'inline-flex items-center gap-1.5 text-xs font-medium h-7 px-2.5 transition-colors';

  const statusPill = (() => {
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
    <aside className="w-56 shrink-0 border-r bg-card flex flex-col sticky top-0 h-screen">
      {/* Brand */}
      <NavLink to="/" className="flex items-center gap-2 px-4 h-14 border-b font-semibold text-lg text-foreground">
        <Wand2 className="w-5 h-5 text-brand" />
        <span>ComfyUI Studio</span>
      </NavLink>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
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
      </nav>

      {/* Footer: status + actions + theme */}
      <div className="border-t p-3 space-y-2">
        <div className="flex items-center">
          {statusPill}
          <ComfyUIActions />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="w-full justify-start gap-2"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              <span className="text-xs">{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  );
}
