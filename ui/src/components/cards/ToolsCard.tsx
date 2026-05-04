import { useEffect, useState } from 'react';
import { Wrench, Save, Check, Globe, Database, HelpCircle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { toast } from 'sonner';
import { api, apiChatTools } from '../../services/comfyui';
import type { TemplateSummary } from '../../types';
import { Button } from '../ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../ui/card';
import InputField from '../forms/InputField';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../forms/SelectField';

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
  const [imageTemplates, setImageTemplates] = useState<TemplateSummary[]>([]);
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
    api.getTemplatesList()
      .then(rows => {
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
    <Card>
      <CardHeader className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Wrench className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
          <div>
            <h2 className="text-sm font-semibold text-slate-900 leading-tight">Tools / Integrations</h2>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Optional tools the chat LLM can call. Each is disabled until its
              URL / key is set.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <InputField
          label="SearXNG URL"
          tooltip="Enables the web_search tool. Requires formats: [html, json] in the instance's settings.yml."
          value={state.searxngUrl}
          onChange={v => setState(s => ({ ...s, searxngUrl: v }))}
          placeholder="https://searxng.example.com"
          disabled={!loaded}
          leftIcon={<Globe />}
          rightSlot={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={handleTestSearxng}
              disabled={!loaded || state.searxngUrl.trim().length === 0}
            >
              Test
            </Button>
          }
        />
        <InputField
          label="RAGFlow URL"
          tooltip="Base URL of a RAGFlow instance. Combined with the API key below, enables the rag_search + rag_upload tools."
          value={state.ragflowUrl}
          onChange={v => setState(s => ({ ...s, ragflowUrl: v }))}
          placeholder="https://ragflow.example.com"
          disabled={!loaded}
          leftIcon={<Database />}
        />
        <InputField
          label="RAGFlow API key"
          tooltip="Sent as Authorization: Bearer on every RAGFlow call. Stored server-side in the same 0o600 config file as the rest of the secrets."
          type="password"
          value={state.ragflowApiKey}
          onChange={v => setState(s => ({ ...s, ragflowApiKey: v }))}
          placeholder="ragflow-XXXXXXXX"
          disabled={!loaded}
          leftIcon={<Database />}
          configured={
            state.ragflowApiKeyConfigured
              ? { onClear: handleClearKey, clearDisabled: busy }
              : undefined
          }
        />
        <div>
          <div className="mb-1 flex items-center gap-1.5">
            <label className="field-label">Default image template</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="cursor-help text-slate-400 transition-colors hover:text-slate-600"
                  aria-label="Default image template info"
                >
                  <HelpCircle className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Enables the generate_image tool. The chat LLM will submit this template when it decides an image is the best answer; the prompt arg lands on the template's primary text input.
              </TooltipContent>
            </Tooltip>
          </div>
          <SelectField
            value={state.defaultImageTemplate || '__none__'}
            onValueChange={v => setState(s => ({ ...s, defaultImageTemplate: v === '__none__' ? '' : v }))}
            disabled={!loaded}
          >
            <SelectTrigger className="mt-1 w-full">
              <SelectValue placeholder="— disabled —" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— disabled —</SelectItem>
              {imageTemplates.map(t => (
                <SelectItem key={t.name} value={t.name}>{t.title || t.name}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
        </div>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes apply immediately to new chats.</p>
        <Button onClick={handleSave} disabled={busy || !loaded}>
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? 'Saved' : 'Save'}
        </Button>
      </CardFooter>
    </Card>
  );
}
