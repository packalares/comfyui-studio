import { useEffect, useState } from 'react';
import { Wrench, Eye, EyeOff, Save, Check, Trash2, Globe, Database, Image as ImageIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api, apiChatTools } from '../../services/comfyui';
import type { Template } from '../../types';

// Settings card for chat-tool integrations: SearXNG, RAGFlow, default image
// template. Sits BELOW the existing Chat / LLM card; never modifies it.
//
// Each tool's enable-state is implicit: empty URL/key = tool hidden from the
// LLM. The server enforces this in `services/chat/tools/index.ts`.

interface ToolsState {
  searxngUrl: string;
  ragflowUrl: string;
  ragflowApiKey: string;
  ragflowApiKeyConfigured: boolean;
  defaultImageTemplate: string;
}

const EMPTY_STATE: ToolsState = {
  searxngUrl: '',
  ragflowUrl: '',
  ragflowApiKey: '',
  ragflowApiKeyConfigured: false,
  defaultImageTemplate: '',
};

export default function ToolsCard() {
  const [state, setState] = useState<ToolsState>(EMPTY_STATE);
  const [imageTemplates, setImageTemplates] = useState<Template[]>([]);
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    apiChatTools.getSettings()
      .then(s => {
        setState({
          searxngUrl: s.searxngUrl,
          ragflowUrl: s.ragflowUrl,
          ragflowApiKey: '',
          ragflowApiKeyConfigured: s.ragflowApiKeyConfigured,
          defaultImageTemplate: s.defaultImageTemplate,
        });
      })
      .catch(() => { /* fall back to empty placeholders */ })
      .finally(() => setLoaded(true));
    api.getTemplates()
      .then(rows => {
        // The image-gen tool routes the prompt to a template's first
        // text/textarea field, so any template tagged as the `image` Studio
        // category is a valid pick. Filter strictly so the dropdown isn't
        // polluted with video / audio / 3d workflows.
        const imgs = rows.filter(t => t.studioCategory === 'image');
        setImageTemplates(imgs);
      })
      .catch(() => setImageTemplates([]));
  }, []);

  const handleSave = async () => {
    setBusy(true);
    try {
      const next = await apiChatTools.setSettings({
        searxngUrl: state.searxngUrl.trim(),
        ragflowUrl: state.ragflowUrl.trim(),
        // Send the API key only when the user typed a value; an empty string
        // would be treated as "clear" by the server.
        ...(state.ragflowApiKey.trim()
          ? { ragflowApiKey: state.ragflowApiKey.trim() }
          : {}),
        defaultImageTemplate: state.defaultImageTemplate.trim(),
      });
      setState(prev => ({
        ...prev,
        searxngUrl: next.searxngUrl,
        ragflowUrl: next.ragflowUrl,
        ragflowApiKey: '',
        ragflowApiKeyConfigured: next.ragflowApiKeyConfigured,
        defaultImageTemplate: next.defaultImageTemplate,
      }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error('Failed to save tools settings', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleClearKey = async () => {
    setBusy(true);
    try {
      const next = await apiChatTools.setSettings({ ragflowApiKey: '' });
      setState(prev => ({
        ...prev,
        ragflowApiKey: '',
        ragflowApiKeyConfigured: next.ragflowApiKeyConfigured,
      }));
    } finally {
      setBusy(false);
    }
  };

  const handleTestSearxng = async () => {
    const url = state.searxngUrl.trim();
    if (!url) { toast.error('Set a SearXNG URL first'); return; }
    const result = await apiChatTools.testSearxng(url);
    if (result.ok) {
      toast.success(`SearXNG OK — got ${result.resultCount} results`);
    } else {
      toast.error('SearXNG probe failed', { description: result.error });
    }
  };

  return (
    <section className="panel">
      <div className="panel-header-row">
        <div className="flex items-start gap-2">
          <Wrench className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="panel-header-title leading-tight">Tools / Integrations</h2>
            <p className="panel-header-desc">
              Optional tools the chat LLM can call. Each is disabled until its
              URL / key is set.
            </p>
          </div>
        </div>
      </div>
      <div className="space-y-3 panel-body">
        <div>
          <label className="field-label flex items-center gap-1">
            <Globe className="h-3.5 w-3.5 text-slate-400" /> SearXNG URL
          </label>
          <div className="field-wrap">
            <input
              type="text"
              value={state.searxngUrl}
              onChange={e => setState(s => ({ ...s, searxngUrl: e.target.value }))}
              className="field-input font-mono"
              placeholder="https://searxng.example.com"
              spellCheck={false}
              disabled={!loaded}
            />
            <button
              type="button"
              onClick={handleTestSearxng}
              disabled={!loaded || state.searxngUrl.trim().length === 0}
              className="btn-secondary btn-sm"
            >
              Test
            </button>
          </div>
          <p className="field-helper">
            Enables the <code>web_search</code> tool. Requires
            <code> formats: [html, json]</code> in the instance's
            <code> settings.yml</code>.
          </p>
        </div>
        <div>
          <label className="field-label flex items-center gap-1">
            <Database className="h-3.5 w-3.5 text-slate-400" /> RAGFlow URL
          </label>
          <div className="field-wrap">
            <input
              type="text"
              value={state.ragflowUrl}
              onChange={e => setState(s => ({ ...s, ragflowUrl: e.target.value }))}
              className="field-input font-mono"
              placeholder="https://ragflow.example.com"
              spellCheck={false}
              disabled={!loaded}
            />
          </div>
          <p className="field-helper">
            Base URL of a RAGFlow instance. Combined with the API key below,
            enables the <code>rag_search</code> + <code>rag_upload</code> tools.
          </p>
        </div>
        <div>
          <label className="field-label">RAGFlow API key</label>
          <div className="field-wrap">
            <input
              type={showKey ? 'text' : 'password'}
              value={state.ragflowApiKey}
              onChange={e => setState(s => ({ ...s, ragflowApiKey: e.target.value }))}
              className="field-input font-mono"
              placeholder={state.ragflowApiKeyConfigured
                ? 'Key is set — type a new one to replace'
                : 'ragflow-XXXXXXXX'}
              autoComplete="off"
              spellCheck={false}
              disabled={!loaded}
            />
            <button
              type="button"
              onClick={() => setShowKey(v => !v)}
              className="text-slate-400 transition hover:text-slate-700"
              aria-label={showKey ? 'Hide key' : 'Show key'}
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="field-helper">
            Sent as <code>Authorization: Bearer</code> on every RAGFlow call.
            Stored server-side in the same 0o600 config file as the rest of
            the secrets.
          </p>
        </div>
        <div>
          <label className="field-label flex items-center gap-1">
            <ImageIcon className="h-3.5 w-3.5 text-slate-400" /> Default image template
          </label>
          <div className="field-wrap">
            <select
              value={state.defaultImageTemplate}
              onChange={e => setState(s => ({ ...s, defaultImageTemplate: e.target.value }))}
              className="field-input"
              disabled={!loaded}
            >
              <option value="">— disabled —</option>
              {imageTemplates.map(t => (
                <option key={t.name} value={t.name}>{t.title || t.name}</option>
              ))}
            </select>
          </div>
          <p className="field-helper">
            Enables the <code>generate_image</code> tool. The chat LLM will
            submit this template when it decides an image is the best
            answer; the prompt arg lands on the template's primary text input.
          </p>
        </div>
      </div>
      <div className="panel-footer">
        <p className="panel-footer-note">Changes apply immediately to new chats.</p>
        <div className="btn-group">
          {state.ragflowApiKeyConfigured && (
            <button
              onClick={handleClearKey}
              disabled={busy}
              className="btn-secondary !text-red-600 hover:!bg-red-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear RAGFlow key
            </button>
          )}
          <button onClick={handleSave} disabled={busy || !loaded} className="btn-primary">
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  );
}
