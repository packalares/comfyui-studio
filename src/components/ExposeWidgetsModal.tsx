// Lists every editable widget in a template's workflow grouped by node and lets the user
// check which ones should appear in the Advanced Settings panel for that template.
// Persists per-template selection via PUT /api/template-widgets/:name; on save the parent
// re-fetches /api/workflow-settings so the Advanced Settings panel refreshes immediately.

import { useEffect, useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { EnumeratedWidget } from '../types';
import { api } from '../services/comfyui';

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

  const groups: NodeGroup[] = useMemo(() => {
    const byNode = new Map<string, NodeGroup>();
    for (const w of widgets) {
      let g = byNode.get(w.nodeId);
      if (!g) {
        g = { nodeId: w.nodeId, nodeType: w.nodeType, nodeTitle: w.nodeTitle, widgets: [] };
        byNode.set(w.nodeId, g);
      }
      g.widgets.push(w);
    }
    return Array.from(byNode.values());
  }, [widgets]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Edit advanced fields</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Check the widgets you want surfaced in the Advanced Settings panel for this template.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-400 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading widgets…</span>
            </div>
          ) : error ? (
            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-3">{error}</div>
          ) : groups.length === 0 ? (
            <div className="text-sm text-gray-500 py-8 text-center">
              No editable widgets found for this template.
            </div>
          ) : (
            <div className="space-y-5">
              {groups.map(g => (
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
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(w.nodeId, w.widgetName)}
                            className="h-4 w-4 rounded border-gray-300"
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
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-200 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {selectedCount} {selectedCount === 1 ? 'field' : 'fields'} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={loading || saving}
              className="px-4 py-1.5 text-sm font-medium bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
