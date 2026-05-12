import { memo, useState } from 'react';
import {
  ExternalLink,
  Trash2,
  Download,
  MoreVertical,
  GitBranch,
  Package,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { TableRow, TableCell } from '../ui/table';
import type { Plugin } from '../../types';
import TaskProgress from './TaskProgress';

interface Props {
  plugin: Plugin;
  /** Active taskId for this plugin, if any (keyed by pluginId in the parent). */
  activeTaskId?: string;
  onInstall: (p: Plugin) => void;
  onUninstall: (p: Plugin) => void;
  onToggle: (p: Plugin, enable: boolean) => void;
  onSwitchVersion: (p: Plugin) => void;
  onTaskComplete: (pluginId: string, success: boolean) => void;
}

function statusBadge(p: Plugin) {
  if (!p.installed) {
    return <Badge variant="neutral">Not installed</Badge>;
  }
  if (p.disabled) {
    return <Badge variant="warning">Disabled</Badge>;
  }
  if (p.status === 'NodeStatusBanned' || p.status === 'NodeStatusDeprecated') {
    return (
      <Badge variant="danger">
        {p.status.replace('NodeStatus', '').toLowerCase()}
      </Badge>
    );
  }
  return <Badge variant="success">Installed</Badge>;
}

function PluginRowInner({
  plugin,
  activeTaskId,
  onInstall,
  onUninstall,
  onToggle,
  onSwitchVersion,
  onTaskComplete,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  const repoUrl = plugin.repository || plugin.github || '';

  return (
    <>
      <TableRow>
        {/* Plugin name + thumbnail + description */}
        <TableCell>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-6 w-6 rounded shrink-0 overflow-hidden bg-muted flex items-center justify-center">
              {plugin.icon ? (
                <img
                  src={plugin.icon}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <Package className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="text-sm font-medium text-foreground truncate"
                  title={plugin.name || plugin.id}
                >
                  {plugin.name || plugin.id}
                </span>
                {plugin.version && (
                  <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                    {plugin.version}
                  </span>
                )}
                {repoUrl && (
                  <a
                    href={repoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    <ExternalLink className="w-3 h-3 text-muted-foreground hover:text-brand" />
                  </a>
                )}
              </div>
              {plugin.description && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="text-[11px] text-muted-foreground line-clamp-1 cursor-default">
                      {plugin.description}
                    </p>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {plugin.description}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
        </TableCell>

        {/* Author */}
        <TableCell className="text-xs text-muted-foreground">
          <span className="truncate block max-w-[160px]">
            {plugin.author || '—'}
          </span>
        </TableCell>

        {/* Stars */}
        <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
          {plugin.github_stars > 0 ? `★ ${plugin.github_stars}` : '—'}
        </TableCell>

        {/* Installed date */}
        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
          {plugin.installedOn
            ? new Date(plugin.installedOn).toLocaleDateString()
            : '—'}
        </TableCell>

        {/* Status badge */}
        <TableCell>{statusBadge(plugin)}</TableCell>

        {/* Actions */}
        <TableCell className="text-right whitespace-nowrap">
          <div
            className="flex items-center justify-end gap-2"
            onClick={(e) => e.stopPropagation()}
          >
            {plugin.installed ? (
              <>
                <Switch
                  checked={!plugin.disabled}
                  onCheckedChange={(checked) => onToggle(plugin, checked)}
                  aria-label={plugin.disabled ? 'Enable plugin' : 'Disable plugin'}
                />
                <div className="relative">
                  <Button
                    onClick={() => setMenuOpen((m) => !m)}
                    variant="ghost"
                    size="icon"
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                  >
                    <MoreVertical className="w-4 h-4" />
                  </Button>
                  {menuOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-20"
                        onClick={() => setMenuOpen(false)}
                        aria-hidden="true"
                      />
                      <div
                        role="menu"
                        className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border bg-popover shadow-lg py-1"
                      >
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            onSwitchVersion(plugin);
                          }}
                          disabled={!plugin.versions || plugin.versions.length === 0}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <GitBranch className="w-3.5 h-3.5" />
                          Switch version
                        </button>
                        <button
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            onUninstall(plugin);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-destructive/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Uninstall
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>
            ) : (
              <Button
                onClick={() => onInstall(plugin)}
                aria-label={`Install ${plugin.name || plugin.id}`}
              >
                <Download className="w-3.5 h-3.5" />
                Install
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>

      {activeTaskId && (
        <TableRow>
          <TableCell colSpan={6} className="py-1.5">
            <TaskProgress
              taskId={activeTaskId}
              onComplete={(success) => onTaskComplete(plugin.id, success)}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

const PluginRow = memo(PluginRowInner);
export default PluginRow;
