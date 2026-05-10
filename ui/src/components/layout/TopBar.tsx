// Sticky top bar — pins at top-0 of SidebarInset's scroll context. Holds
// the sidebar collapse trigger on the left and the theme toggle on the
// right. backdrop-blur lets content faintly bleed through when scrolled.

import { Sun, Moon } from 'lucide-react';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { SidebarTrigger } from '../ui/sidebar';
import { useTheme } from '../../context/ThemeContext';
import ThemeSwitcher from './ThemeSwitcher';

export default function TopBar() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="sticky top-0 z-50 flex items-center justify-between h-12 px-3 border-b bg-background/95 backdrop-blur shrink-0 rounded-t-xl">
      <div className="flex items-center gap-2">
        <SidebarTrigger />
      </div>
      <div className="flex items-center gap-1">
        <ThemeSwitcher />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
