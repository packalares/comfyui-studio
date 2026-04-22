// Lists every editable widget in a template's workflow grouped by node and lets the user
// check which ones should appear in the Advanced Settings panel for that template.
// Persists per-template selection via PUT /api/template-widgets/:name; on save the parent
// re-fetches /api/workflow-settings so the Advanced Settings panel refreshes immediately.

import { useEffect, useMemo, useState } from 'react';
import { Loader2, X, Check } from 'lucide-react';
import type { EnumeratedWidget } from '../types';
import { api } from '../services/comfyui';
import AppModal from './AppModal';
import { Checkbox } from './ui/checkbox';

interface Props {
  templateName: string;
  onClose: () => void;
  onSaved: () => void;
}

interface NodeGroup {
  nodeId: string;
  nodeType: string;
  nodeTitle?: string;
  widgets: EnumeratedWidget[];
}

interface ScopeSection {
  // `""` for top-level; otherwise the compound-id prefix (`267`, `267:mid`, ...).
  scopeKey: string;
  // Human label for the divider; `"Top-level"` or the subgraph's display name.
  heading: string;
  groups: NodeGroup[];
}

// Extract the compound-id prefix (everything before the last `:`), or `""`
// for top-level nodeIds without any `:`.
function scopeKeyOf(nodeId: string): string {
  const lastColon = nodeId.lastIndexOf(':');
  return lastColon < 0 ? '' : nodeId.slice(0, lastColon);
}

function formatValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string') {
    const trimmed = v.length > 60 ? v.slice(0, 60) + '…' : v;
    return `"${trimmed}"`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 60);
}

export default function ExposeWidgetsModal({ templateName, onClose, onSaved }: Props) {
  const [widgets, setWidgets] = useState<EnumeratedWidget[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-widget checkbox state keyed as `<nodeId>|<widgetName>`.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getTemplateWidgets(templateName)
      .then(res => {
        if (cancelled) return;
        // The backend returns every editable widget, including those already driven
        // by the main form (prompt textarea, image/audio/video uploads) flagged
        // `formClaimed: true`. Hide those from the modal — the user can't expose
        // duplicates of controls they already have.
        const visible = res.widgets.filter(w => !w.formClaimed);
        setWidgets(visible);
        const initial = new Set<string>();
        for (const w of visible) if (w.exposed) initial.add(`${w.nodeId}|${w.widgetName}`);
        setSelected(initial);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [templateName]);

  const sections: ScopeSection[] = useMemo(() => {
    // Partition by scope prefix first, then by node inside each scope.
    // Preserves server enumeration order (top-level first, subgraphs second).
    const byScope = new Map<string, { heading: string; byNode: Map<string, NodeGroup> }>();
    for (const w of widgets) {
      const scopeKey = scopeKeyOf(w.nodeId);
      const heading = scopeKey === '' ? 'Top-level' : (w.scopeName || 'Subgraph');
      let scope = byScope.get(scopeKey);
      if (!scope) {
        scope = { heading, byNode: new Map() };
        byScope.set(scopeKey, scope);
      }
      let g = scope.byNode.get(w.nodeId);
      if (!g) {
        g = { nodeId: w.nodeId, nodeType: w.nodeType, nodeTitle: w.nodeTitle, widgets: [] };
        scope.byNode.set(w.nodeId, g);
      }
      g.widgets.push(w);
    }
    return Array.from(byScope.entries()).map(([scopeKey, scope]) => ({
      scopeKey,
      heading: scope.heading,
      groups: Array.from(scope.byNode.values()),
    }));
  }, [widgets]);

  const totalGroups = useMemo(() => sections.reduce((n, s) => n + s.groups.length, 0), [sections]);

  const toggle = (nodeId: string, widgetName: string) => {
    const key = `${nodeId}|${widgetName}`;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const exposed = Array.from(selected).map(k => {
        const [nodeId, widgetName] = k.split('|');
        return { nodeId, widgetName };
      });
      await api.saveExposedWidgets(templateName, exposed);
      setSaving(false);
      onSaved();
      onClose();
    } catch (err) {
      setSaving(false);
      setError(String(err));
    }
  };

  const selectedCount = selected.size;

  return (
    <AppModal
      open={true}
      onClose={onClose}
      title="Edit advanced fields"
      subtitle="Check the widgets you want surfaced in the Advanced Settings panel for this template."
      size="md"
      disableClose={saving}
      footer={
        <>
          <span className="text-xs text-slate-500">
            {selectedCount} {selectedCount === 1 ? 'field' : 'fields'} selected
          </span>
          <div className="btn-group">
            <button onClick={onClose} className="btn-secondary" disabled={saving}>
              <X className="w-3.5 h-3.5" />
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={loading || saving}
              className="btn-primary"
            >
              {saving
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Check className="w-3.5 h-3.5" />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading widgets…</span>
        </div>
      ) : error ? (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">{error}</div>
      ) : totalGroups === 0 ? (
        <div className="text-sm text-gray-500 py-8 text-center">
          No editable widgets found for this template.
        </div>
      ) : (
        <div className="space-y-6">
          {sections.map(section => (
            <div key={section.scopeKey || '__top__'}>
              <div className="panel-header !px-0 !py-2 !border-b-0 flex items-baseline gap-2">
                <span className="panel-header-title">{section.heading}</span>
                {section.scopeKey && (
                  <span className="stat-label">#{section.scopeKey}</span>
                )}
              </div>
              <div className="space-y-5">
                {section.groups.map(g => (
                  <div key={g.nodeId}>
                    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                      {g.nodeTitle || g.nodeType}
                      <span className="text-gray-300 font-normal normal-case tracking-normal ml-2">
                        #{g.nodeId}
                      </span>
                    </div>
                    <div className="space-y-0.5 border border-gray-100 rounded overflow-hidden">
                      {g.widgets.map(w => {
                        const key = `${w.nodeId}|${w.widgetName}`;
                        const checked = selected.has(key);
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm"
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggle(w.nodeId, w.widgetName)}
                            />
                            <span className="font-mono text-xs text-gray-700 flex-1 truncate">
                              {w.widgetName}
                            </span>
                            <span className="text-xs text-gray-400 truncate max-w-[40%]">
                              {formatValue(w.value)}
                            </span>
                            <span className="text-[10px] text-gray-300 uppercase w-12 text-right">
                              {w.type}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </AppModal>
  );
}
