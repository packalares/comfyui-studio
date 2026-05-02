import { memo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Trash2,
  Download,
  MoreVertical,
  GitBranch,
} from 'lucide-react';
import { Switch } from '../ui/switch';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
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
    return <Badge variant="slate">Not installed</Badge>;
  }
  if (p.disabled) {
    return <Badge variant="amber">Disabled</Badge>;
  }
  if (p.status === 'NodeStatusBanned' || p.status === 'NodeStatusDeprecated') {
    return (
      <Badge variant="rose">
        {p.status.replace('NodeStatus', '').toLowerCase()}
      </Badge>
    );
  }
  return <Badge variant="emerald">Installed</Badge>;
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
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const repoUrl = plugin.repository || plugin.github || '';

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div
        className="flex items-start gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <button
          className="mt-0.5 text-slate-400 hover:text-slate-700 shrink-0"
          aria-label={expanded ? 'Collapse' : 'Expand'}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((x) => !x);
          }}
        >
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-slate-900 truncate" title={plugin.name}>
              {plugin.name || plugin.id}
            </p>
            <span className="text-[11px] text-slate-500 font-mono">{plugin.version}</span>
            {statusBadge(plugin)}
            {plugin.github_stars ? (
              <span className="text-[11px] text-slate-400">★ {plugin.github_stars}</span>
            ) : null}
          </div>
          {plugin.author && (
            <p className="text-[11px] text-slate-500 mt-0.5 truncate">
              by {plugin.author}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
          {plugin.installed ? (
            <>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <Switch
                  checked={!plugin.disabled}
                  onCheckedChange={(checked) => onToggle(plugin, checked)}
                  aria-label={plugin.disabled ? 'Enable plugin' : 'Disable plugin'}
                />
              </label>
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
                      className="absolute right-0 top-full mt-1 z-30 w-48 rounded-md border border-slate-200 bg-white shadow-lg py-1"
                    >
                      <button
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          onSwitchVersion(plugin);
                        }}
                        disabled={!plugin.versions || plugin.versions.length === 0}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50"
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
      </div>

      {expanded && (
        <div className="px-8 pb-3 pt-0 space-y-2">
          {plugin.description && (
            <p className="text-[12px] text-slate-600 whitespace-pre-line">{plugin.description}</p>
          )}
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-slate-500">
            {repoUrl && (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-teal-600 hover:text-teal-700 hover:underline font-mono truncate"
              >
                <ExternalLink className="w-3 h-3" />
                {repoUrl.replace(/^https?:\/\//, '')}
              </a>
            )}
            {plugin.license && plugin.license !== '{}' && (
              <span>License: {plugin.license}</span>
            )}
            {plugin.installedOn && (
              <span>Installed: {new Date(plugin.installedOn).toLocaleDateString()}</span>
            )}
          </div>
          {plugin.tags && plugin.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {plugin.tags.map((t) => (
                <Badge key={t} variant="slate" className="!text-[10px]">
                  {t}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTaskId && (
        <div className="px-8 pb-3">
          <TaskProgress
            taskId={activeTaskId}
            onComplete={(success) => onTaskComplete(plugin.id, success)}
          />
        </div>
      )}
    </div>
  );
}

const PluginRow = memo(PluginRowInner);
export default PluginRow;
