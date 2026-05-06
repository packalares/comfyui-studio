import { useState, useEffect, useCallback, useMemo } from 'react';
import PageSubbar from '../components/layout/PageSubbar';
import { usePersistedState } from '../hooks/usePersistedState';
import ToolsCard from '../components/cards/ToolsCard';
import {
  Copy,
  Check,
  Save,
  RotateCcw,
  Eye,
  RefreshCw,
  Link2,
  GitBranch,
  Package,
  SlidersHorizontal,
  Key,
  Terminal,
  Globe,
  HardDrive,
  Image as ImageIcon,
  Shield,
  HelpCircle,
  Percent,
  Hash,
  Repeat,
  Timer,
  Server,
  MessageSquare,
  // Category icons for Launch Options sections
  Folder,
  Rocket,
  Cpu,
  Binary,
  Database,
  Focus,
  Wrench,
  MemoryStick,
  Bug,
  Layout,
  Zap,
  Settings as SettingsIcon,
  Plug,
  Cpu as CpuTabIcon,
  Sparkles,
  BookOpen,
  SlashSquare,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type ChatAdvancedSettings, type SecretName } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { Switch } from '../components/ui/switch';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../components/ui/card';
import ConfirmDialog from '../components/modals/ConfirmDialog';
import InputField from '../components/forms/InputField';
import McpServersSection from '../components/settings/McpServersSection';
import StudioMcpServerSection from '../components/settings/StudioMcpServerSection';
import IntegratedToolsSection from '../components/settings/IntegratedToolsSection';
import SoulsSection from '../components/settings/SoulsSection';
import MemorySection from '../components/settings/MemorySection';
import SkillsSection from '../components/settings/SkillsSection';
import CommandsSection from '../components/settings/CommandsSection';

/* ---------- types for launch options ---------- */

interface LaunchOptionItem {
  key: string;
  type: 'flag' | 'number' | 'string';
  category: string;
  description?: string;
  enabled: boolean;
  value?: string | number;
  readOnly?: boolean;
}

interface LaunchOptionsData {
  fullCommandLine?: string;
  items?: LaunchOptionItem[];
}

/* ---------- category display names ---------- */

const CATEGORY_LABELS: Record<string, string> = {
  network: 'Network',
  paths: 'Paths',
  startup: 'Startup',
  device: 'Device',
  precision: 'Precision',
  preview: 'Preview',
  cache: 'Cache',
  attention: 'Attention',
  manager: 'Manager',
  vram: 'VRAM Management',
  debug: 'Debug',
  frontend: 'Frontend',
  perf: 'Performance',
};

// Per-category icons for the Launch Options cards. Shown in place of the
// old collapse arrow. Falls back to Terminal when a new category slips
// through without a mapping.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  network: Globe,
  paths: Folder,
  startup: Rocket,
  device: Cpu,
  precision: Binary,
  preview: Eye,
  cache: Database,
  attention: Focus,
  manager: Wrench,
  vram: MemoryStick,
  debug: Bug,
  frontend: Layout,
  perf: Zap,
};

/* ---------- description translations ---------- */

const KEY_DESCRIPTIONS: Record<string, string> = {
  '--listen': 'Listen on all network interfaces (0.0.0.0)',
  '--port': 'Port number for the web server',
  '--tls-keyfile': 'TLS/SSL key file path (enables HTTPS)',
  '--tls-certfile': 'TLS/SSL cert file path (pair with --tls-keyfile)',
  '--enable-cors-header': 'Enable CORS headers for cross-origin requests',
  '--max-upload-size': 'Max upload size in megabytes',
  '--base-directory': 'ComfyUI base directory (models, custom_nodes, etc.)',
  '--extra-model-paths-config': 'Extra model paths configuration file',
  '--output-directory': 'Custom output directory path',
  '--input-directory': 'Custom input directory path',
  '--temp-directory': 'Custom temporary directory path',
  '--user-directory': 'Custom user directory (absolute path)',
  '--auto-launch': 'Auto-launch browser on startup',
  '--disable-auto-launch': 'Disable auto-launch of browser',
  '--cuda-device': 'CUDA device index to use',
  '--default-device': 'Default device index; other devices remain visible',
  '--cuda-malloc': 'Enable CUDA malloc for memory allocation',
  '--disable-cuda-malloc': 'Disable CUDA malloc',
  '--cpu': 'Run on CPU only (no GPU)',
  '--directml': 'Use DirectML backend',
  '--oneapi-device-selector': 'Intel oneAPI device selector string',
  '--disable-ipex-optimize': 'Disable Intel IPEX model-load optimizations',
  '--supports-fp8-compute': 'Assume device supports FP8 compute',
  '--force-fp32': 'Force FP32 precision (slower, more accurate)',
  '--force-fp16': 'Force FP16 precision (faster, less memory)',
  '--fp32-unet': 'Run diffusion model in FP32',
  '--fp64-unet': 'Run diffusion model in FP64',
  '--bf16-unet': 'Use BF16 precision for UNet',
  '--fp16-unet': 'Use FP16 precision for UNet',
  '--fp8_e4m3fn-unet': 'Use FP8 E4M3FN precision for UNet',
  '--fp8_e5m2-unet': 'Use FP8 E5M2 precision for UNet',
  '--fp8_e8m0fnu-unet': 'Use FP8 E8M0FNU precision for UNet',
  '--fp16-vae': 'Use FP16 precision for VAE (may cause black images)',
  '--fp32-vae': 'Use FP32 precision for VAE',
  '--bf16-vae': 'Use BF16 precision for VAE',
  '--cpu-vae': 'Run VAE on CPU',
  '--fp8_e4m3fn-text-enc': 'Use FP8 E4M3FN for text encoder',
  '--fp8_e5m2-text-enc': 'Use FP8 E5M2 for text encoder',
  '--fp16-text-enc': 'Use FP16 for text encoder',
  '--fp32-text-enc': 'Use FP32 for text encoder',
  '--bf16-text-enc': 'Use BF16 for text encoder',
  '--force-channels-last': 'Force channels-last memory layout at inference',
  '--preview-method': 'Sampler preview method (none, auto, latent2rgb, taesd)',
  '--preview-size': 'Max preview size at sampler',
  '--cache-classic': 'Use classic (aggressive) caching strategy',
  '--cache-lru': 'Use LRU cache; keep last N node results',
  '--cache-none': 'Disable cache; save RAM by re-running all nodes',
  '--cache-ram': 'Cache under RAM pressure; threshold in GB',
  '--use-split-cross-attention': 'Use split cross attention',
  '--use-quad-cross-attention': 'Use sub-quadratic cross attention',
  '--use-pytorch-cross-attention': 'Use PyTorch 2.0 native cross attention',
  '--use-sage-attention': 'Use sage attention',
  '--use-flash-attention': 'Use FlashAttention',
  '--disable-xformers': 'Disable xformers memory efficient attention',
  '--force-upcast-attention': 'Force upcast attention to FP32 (may fix black images)',
  '--dont-upcast-attention': 'Disable all attention upcasting',
  '--enable-manager': 'Enable ComfyUI-Manager',
  '--disable-manager-ui': 'Disable Manager UI only; background tasks still run',
  '--enable-manager-legacy-ui': 'Enable ComfyUI-Manager legacy UI',
  '--gpu-only': 'Keep all models on GPU (requires lots of VRAM)',
  '--highvram': 'Keep models in GPU memory between runs',
  '--normalvram': 'Force normal VRAM mode (overrides auto-lowvram)',
  '--lowvram': 'Split UNet to lower VRAM usage',
  '--novram': 'Minimal VRAM usage; use when --lowvram is insufficient',
  '--reserve-vram': 'Reserve VRAM (GB) for system and other applications',
  '--async-offload': 'Async weight offload stream count (default 2)',
  '--disable-async-offload': 'Disable async weight offload',
  '--disable-dynamic-vram': 'Disable dynamic VRAM; use estimated-load mode',
  '--force-non-blocking': 'Force non-blocking tensor operations',
  '--default-hashing-function': 'Duplicate/content hash: md5, sha1, sha256, sha512',
  '--disable-smart-memory': 'Force aggressive offload to RAM over VRAM',
  '--deterministic': 'Use PyTorch deterministic algorithms (slower)',
  '--fast': 'Enable experimental optimizations',
  '--disable-pinned-memory': 'Disable pinned (page-locked) host memory',
  '--mmap-torch-files': 'mmap when loading .ckpt / .pt files',
  '--disable-mmap': 'Disable mmap for safetensors',
  '--verbose': 'Log level: DEBUG, INFO, WARNING, ERROR, CRITICAL',
  '--dont-print-server': 'Suppress server output messages',
  '--quick-test-for-ci': 'CI quick test mode',
  '--windows-standalone-build': 'Windows standalone build convenience',
  '--disable-metadata': 'Disable saving metadata in output files',
  '--disable-all-custom-nodes': 'Disable all custom nodes on startup',
  '--whitelist-custom-nodes': 'Directories to still load when all nodes disabled',
  '--disable-api-nodes': 'Disable all API nodes and frontend network',
  '--multi-user': 'Enable per-user storage',
  '--log-stdout': 'Log to stdout instead of stderr',
  '--front-end-version': 'Specify frontend version to use',
  '--front-end-root': 'Local frontend directory (overrides --front-end-version)',
  '--enable-compress-response-body': 'Enable HTTP response body compression',
  '--comfy-api-base': 'ComfyUI API base URL',
  '--database-url': 'Database URL (e.g. sqlite:///:memory:)',
  '--enable-assets': 'Enable assets system (API, DB sync, scan)',
};

/* ---------- tiny helpers ---------- */

function SectionHeader({
  title,
  description,
  icon: Icon,
  right,
}: {
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  right?: React.ReactNode;
}) {
  return (
    <CardHeader className="flex items-start justify-between gap-3">
      <div className="flex items-start gap-2">
        <Icon className="w-3.5 h-3.5 text-muted-foreground mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-foreground leading-tight">{title}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{description}</p>
        </div>
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </CardHeader>
  );
}

/* =================================================================
   1. Secrets Card — Comfy Org / HF / CivitAI / GitHub / Pexels in one card
   ================================================================= */

interface SecretDef {
  name: SecretName;
  label: string;
  helper: string;
  tooltip: string;
  placeholder: string;
  configuredFlag:
    | 'apiKeyConfigured'
    | 'hfTokenConfigured'
    | 'civitaiTokenConfigured'
    | 'githubTokenConfigured'
    | 'pexelsApiKeyConfigured';
  // Some secrets need extra refresh side-effects after save (e.g. the
  // Comfy Org key is attached to every prompt, so the templates list
  // re-renders availability badges once it lands).
  refreshTemplates?: boolean;
}

const SECRETS: SecretDef[] = [
  {
    name: 'apiKeyComfyOrg',
    label: 'Comfy Org API Key',
    helper: 'Required for Gemini, Kling, Grok, Runway, and other provider workflows.',
    tooltip:
      'Stored server-side in a config file on the GPU (readable only by the process owner) and attached to every prompt as extra_data.api_key_comfy_org. Never returned to the browser after save.',
    placeholder: 'Enter your API key',
    configuredFlag: 'apiKeyConfigured',
    refreshTemplates: true,
  },
  {
    name: 'hfToken',
    label: 'HuggingFace Token',
    helper: 'Required to download gated models (e.g. FLUX.2-klein) and private repos.',
    tooltip:
      'Create a read token at huggingface.co/settings/tokens. Stored server-side; sent as Authorization: Bearer on HEAD/GET calls for gated HuggingFace URLs. Never returned to the browser after save.',
    placeholder: 'hf_…',
    configuredFlag: 'hfTokenConfigured',
  },
  {
    name: 'civitaiToken',
    label: 'CivitAI Token',
    helper: 'Adds authentication for civitai.com downloads (LoRAs, workflows) and gated items.',
    tooltip:
      'Create an API key on civitai.com/user/account. Stored server-side; attached as Authorization: Bearer to civitai.com HEAD/GET requests. Never echoed back to the browser.',
    placeholder: 'CivitAI API key',
    configuredFlag: 'civitaiTokenConfigured',
  },
  {
    name: 'githubToken',
    label: 'GitHub Token',
    helper: 'Adds authentication for github.com release downloads and lifts the unauthenticated 60/h API rate limit.',
    tooltip:
      'Create a fine-grained read token at github.com/settings/tokens. Stored server-side; attached as Authorization: Bearer to github.com release downloads + api.github.com calls. Never echoed back to the browser.',
    placeholder: 'github_pat_…',
    configuredFlag: 'githubTokenConfigured',
  },
  {
    name: 'pexelsApiKey',
    label: 'Pexels API Key',
    helper: 'Optional. Lets audio thumbnails fetch a prompt-matched stock photo instead of a generic placeholder.',
    tooltip:
      'Free key at pexels.com/api (200 req/hr, 20k/month). When set, audio tiles without embedded cover art search Pexels using the prompt. Unset → falls back to a deterministic Picsum placeholder. Never echoed back to the browser.',
    placeholder: 'Pexels API key',
    configuredFlag: 'pexelsApiKeyConfigured',
  },
];

function SecretsCard() {
  const app = useApp();
  const [values, setValues] = useState<Record<SecretName, string>>(() => ({
    apiKeyComfyOrg: '',
    hfToken: '',
    civitaiToken: '',
    githubToken: '',
    pexelsApiKey: '',
  }));
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<SecretName | null>(null);

  const dirty = SECRETS
    .filter(d => values[d.name].trim().length > 0)
    .map(d => d.name);

  const handleSave = async () => {
    if (dirty.length === 0) return;
    setBusy(true);
    try {
      const payload: Partial<Record<SecretName, string>> = {};
      for (const name of dirty) payload[name] = values[name].trim();
      await api.updateSettings('secret', payload);
      // Comfy Org key is the only one that needs templates to re-evaluate
      // availability after save; refresh both when it's in the batch.
      const needsTemplates = SECRETS.some(d => d.refreshTemplates && dirty.includes(d.name));
      await Promise.all([
        app.refreshSystem(),
        ...(needsTemplates ? [app.refreshTemplates()] : []),
      ]);
      setValues(v => {
        const next = { ...v };
        for (const name of dirty) next[name] = '';
        return next;
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error('Save failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async (name: SecretName) => {
    setBusy(true);
    try {
      await api.deleteSetting('secret', name);
      const def = SECRETS.find(d => d.name === name);
      await Promise.all([
        app.refreshSystem(),
        ...(def?.refreshTemplates ? [app.refreshTemplates()] : []),
      ]);
    } catch (err) {
      toast.error('Clear failed', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmingDef = confirming ? SECRETS.find(d => d.name === confirming) : null;

  return (
    <>
      <Card>
        <SectionHeader
          icon={Key}
          title="API Keys & Tokens"
          description="Optional credentials for downloads, provider workflows, and stock-photo fallbacks. Stored server-side; never returned to the browser after save."
        />
        <CardContent className="space-y-4">
          {(() => {
            const renderField = (def: typeof SECRETS[number]) => {
              const isConfigured = Boolean(app[def.configuredFlag]);
              return (
                <InputField
                  key={def.name}
                  label={def.label}
                  tooltip={def.tooltip}
                  helper={def.helper}
                  type="password"
                  placeholder={def.placeholder}
                  value={values[def.name]}
                  onChange={v => setValues(s => ({ ...s, [def.name]: v }))}
                  configured={
                    isConfigured
                      ? { onClear: () => setConfirming(def.name), clearDisabled: busy }
                      : undefined
                  }
                />
              );
            };
            const [primary, ...rest] = SECRETS;
            return (
              <>
                {/* Comfy Org API key — full width since it's required for all
                    provider workflows; the other 4 are optional add-ons. */}
                {renderField(primary)}
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {rest.map(renderField)}
                </div>
              </>
            );
          })()}
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            {dirty.length === 0
              ? 'Type a value into one or more fields above to enable Save.'
              : `Saving ${dirty.length} field${dirty.length === 1 ? '' : 's'}.`}
          </p>
          <Button onClick={handleSave} disabled={busy || dirty.length === 0}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : 'Save'}
          </Button>
        </CardFooter>
      </Card>
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirmingDef ? `Clear ${confirmingDef.label}?` : 'Clear secret?'}
        description="The stored value will be removed from the server. You can re-enter it later. This cannot be undone."
        confirmLabel="Clear"
        confirmTone="danger"
        busy={busy}
        onConfirm={async () => {
          if (confirming) await handleClear(confirming);
          setConfirming(null);
        }}
      />
    </>
  );
}

/* =================================================================
   1f. Chat / LLM (Ollama) Card
   ================================================================= */

function ChatLlmCard() {
  const app = useApp();
  const live = app.chat;
  const loaded = live !== null;
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [savedOllamaUrl, setSavedOllamaUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [keepAlive, setKeepAlive] = useState('');
  const [defaultStrategy, setDefaultStrategy] = useState<'sliding' | 'auto'>('sliding');
  const [defaultThinkMode, setDefaultThinkMode] = useState<'on' | 'off' | 'auto'>('auto');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  // Holds a failed-probe result so we can offer a "Save anyway" escape hatch
  // without losing the typed URL between clicks.
  const [probeFailedUrl, setProbeFailedUrl] = useState<string | null>(null);

  // Re-seed local edit buffers from the live AppContext snapshot when it
  // changes (initial load and post-save refresh). Same pattern NetworkCard
  // uses for its fields.
  useEffect(() => {
    if (!live) return;
    setOllamaUrl(live.ollamaUrl);
    setSavedOllamaUrl(live.ollamaUrl);
    setDefaultModel(live.defaultModel);
    setKeepAlive(live.keepAlive);
    if (live.defaultContextStrategy) setDefaultStrategy(live.defaultContextStrategy);
    if (live.defaultThinkMode) setDefaultThinkMode(live.defaultThinkMode);
  }, [live]);

  const persist = async () => {
    await api.updateSettings('chat', {
      ollamaUrl: ollamaUrl.trim(),
      defaultModel: defaultModel.trim(),
      keepAlive: keepAlive.trim(),
      defaultContextStrategy: defaultStrategy,
      defaultThinkMode,
    });
    await app.refreshSystem();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSave = async () => {
    setBusy(true);
    setProbeFailedUrl(null);
    try {
      const trimmed = ollamaUrl.trim();
      // Only probe when the URL changed — keep model / keepAlive saves cheap.
      const urlChanged = trimmed !== savedOllamaUrl.trim();
      if (urlChanged && trimmed) {
        const probe = await api.probe('ollama', trimmed);
        if (!probe.ok) {
          toast.error(`Could not reach Ollama at ${trimmed}`, {
            description: probe.error,
          });
          setProbeFailedUrl(trimmed);
          return;
        }
        toast.success(`Connected, found ${probe.count} models`);
      }
      await persist();
    } catch (err) {
      toast.error('Failed to save chat settings', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveAnyway = async () => {
    setBusy(true);
    try {
      await persist();
      setProbeFailedUrl(null);
    } catch (err) {
      toast.error('Failed to save chat settings', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionHeader
        icon={MessageSquare}
        title="Chat / LLM"
        description="Local LLM backend used by the Chat page (Ollama or any OpenAI-compatible server)."
      />
      <CardContent>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <InputField
            label="Ollama URL"
            value={ollamaUrl}
            onChange={setOllamaUrl}
            placeholder="http://localhost:11434"
            disabled={!loaded}
            tooltip="Base URL of your local Ollama server. Studio appends /v1 for chat completions and /api for tag/pull/delete calls."
            leftIcon={<Server />}
          />
          <InputField
            label="Default model"
            value={defaultModel}
            onChange={setDefaultModel}
            placeholder="llama3.3:70b-instruct-q4_K_M"
            disabled={!loaded}
            tooltip="Pre-selected on a fresh chat. Pull this model first via the Chat → Models page."
            leftIcon={<Cpu />}
          />
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="field-label">keep_alive</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="cursor-help text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="keep_alive info"
                  >
                    <HelpCircle className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  How long Ollama keeps the model in VRAM after a request.
                </TooltipContent>
              </Tooltip>
            </div>
            <SelectField
              value={keepAlive || '5m'}
              onValueChange={setKeepAlive}
              disabled={!loaded}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Immediate (unload right after request)</SelectItem>
                <SelectItem value="1m">1 minute</SelectItem>
                <SelectItem value="5m">5 minutes</SelectItem>
                <SelectItem value="15m">15 minutes</SelectItem>
                <SelectItem value="1h">1 hour</SelectItem>
              </SelectContent>
            </SelectField>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="field-label">Default context strategy</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="cursor-help text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Default context strategy info"
                  >
                    <HelpCircle className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Applied to every brand-new conversation. You can override per-conversation from the chat header meter.
                </TooltipContent>
              </Tooltip>
            </div>
            <SelectField
              value={defaultStrategy}
              onValueChange={v => setDefaultStrategy(v as 'sliding' | 'auto')}
              disabled={!loaded}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sliding">Sliding — drop oldest turns from the request only (DB untouched)</SelectItem>
                <SelectItem value="auto">Auto — run Compact server-side (destructive: history is replaced with a summary)</SelectItem>
              </SelectContent>
            </SelectField>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-1.5">
              <label className="field-label">Default thinking mode</label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="cursor-help text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Default thinking mode info"
                  >
                    <HelpCircle className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Initial value for the per-chat Thinking toggle. Off is the fast path on thinking-mode models (qwen3.5, gemma3) — disables the chain-of-thought trace which can be 30× the size of the answer.
                </TooltipContent>
              </Tooltip>
            </div>
            <SelectField
              value={defaultThinkMode}
              onValueChange={v => setDefaultThinkMode(v as 'on' | 'off' | 'auto')}
              disabled={!loaded}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto — model decides</SelectItem>
                <SelectItem value="on">On — always emit chain-of-thought</SelectItem>
                <SelectItem value="off">Off — suppress thinking (fast on qwen3.5 / gemma3)</SelectItem>
              </SelectContent>
            </SelectField>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">
          {probeFailedUrl
            ? 'Probe failed - persist the URL anyway, or fix it and retry.'
            : 'URL is probed before saving. Changes are applied immediately.'}
        </p>
        <div className="inline-flex gap-2">
          {probeFailedUrl && probeFailedUrl === ollamaUrl.trim() && (
            <Button onClick={handleSaveAnyway} disabled={busy} variant="secondary">
              Save anyway
            </Button>
          )}
          <Button onClick={handleSave} disabled={busy || !loaded}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1g. Chat Advanced Card — exposes 8 tunables that previously lived as
       hardcoded constants (high-water threshold, fallback ctx, tool-loop
       cap, etc.) so admins can tune them without redeploying.
   ================================================================= */

interface AdvancedFieldDef {
  key: keyof ChatAdvancedSettings;
  label: string;
  helper: string;
  unit?: string;
  icon: LucideIcon;
}

const CHAT_ADVANCED_FIELDS: AdvancedFieldDef[] = [
  {
    key: 'highWaterPercent',
    label: 'High-water threshold (%)',
    unit: '%',
    icon: Percent,
    helper: 'Strategy fires when estimated next-turn usage hits this percent of the context budget. 80 by default.',
  },
  {
    key: 'maxToolSteps',
    label: 'Max tool-dispatch loops',
    icon: Repeat,
    helper: 'Cap on tool-call iterations per request. Stops runaway chains. 6 by default.',
  },
  {
    key: 'loadingHintMs',
    label: 'Loading-hint delay (ms)',
    unit: 'ms',
    icon: Timer,
    helper: 'Delay after submit with no chunks before the "Loading model into VRAM…" hint shows. 1500 by default.',
  },
  {
    key: 'keepRecent',
    label: 'Sliding: keep last N turns',
    icon: Hash,
    helper: 'When the Sliding strategy fires, keep this many recent user/assistant turns and drop everything older from the outgoing request. System messages are always kept. 4 by default.',
  },
  {
    key: 'titleTimeoutMs',
    label: 'Auto-title timeout (ms)',
    unit: 'ms',
    icon: Timer,
    helper: 'Bound on the auto-title one-shot LLM call. 30000 by default.',
  },
  {
    key: 'summaryTimeoutMs',
    label: 'Compact summary timeout (ms)',
    unit: 'ms',
    icon: Timer,
    helper: 'Bound on the summarizer call shared by the manual Compact-now button and the Auto strategy. 60000 by default.',
  },
];

function ChatAdvancedCard() {
  const app = useApp();
  const liveAdvanced = app.chat?.advanced ?? null;
  const [advanced, setAdvanced] = useState<ChatAdvancedSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (liveAdvanced) setAdvanced(liveAdvanced);
  }, [liveAdvanced]);

  const updateField = (key: keyof ChatAdvancedSettings, raw: string) => {
    if (!advanced) return;
    const n = Number(raw);
    setAdvanced({
      ...advanced,
      [key]: Number.isFinite(n) && n > 0 ? n : advanced[key],
    });
  };

  const handleSave = async () => {
    if (!advanced) return;
    setBusy(true);
    try {
      await api.updateSettings('chat', { advanced });
      await app.refreshSystem();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast.error('Failed to save advanced chat settings', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionHeader
        icon={Database}
        title="Chat advanced"
        description="Power-user knobs for context-window management, tool dispatch, and timeouts. Defaults are sensible — only touch these if you know what you're tuning."
      />
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {CHAT_ADVANCED_FIELDS.map(f => {
            const Icon = f.icon;
            return (
              <InputField
                key={f.key}
                label={f.label}
                tooltip={f.helper}
                type="number"
                min={1}
                value={advanced ? String(advanced[f.key]) : ''}
                onChange={v => updateField(f.key, v)}
                disabled={!advanced}
                leftIcon={<Icon />}
              />
            );
          })}
        </div>
        {/* Boolean toggle — kept outside the numeric grid so the InputField
            uniformity doesn't have to grow a "boolean" branch. */}
        <div className="mt-4 flex items-start justify-between gap-3 rounded-md border bg-muted px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">Smart suggestions</div>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
              After each assistant turn, run one extra LLM call to propose
              follow-up prompts the user might want to send next. Off →
              static heuristic pills only (no extra round-trip).
            </p>
          </div>
          <Switch
            checked={!!advanced?.smartSuggestions}
            disabled={!advanced}
            onCheckedChange={(checked) => {
              if (!advanced) return;
              setAdvanced({ ...advanced, smartSuggestions: !!checked });
            }}
          />
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">Changes are applied immediately to the chat backend.</p>
        <Button onClick={handleSave} disabled={busy || !advanced}>
          {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saved ? 'Saved' : 'Save'}
        </Button>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   2. Launch Options Card
   ================================================================= */

function LaunchOptionRow({
  item,
  onToggle,
  onValueChange,
}: {
  item: LaunchOptionItem;
  onToggle: (key: string, enabled: boolean) => void;
  onValueChange: (key: string, value: string | number) => void;
}) {
  const label = item.key;
  const description = KEY_DESCRIPTIONS[item.key] || item.description || '';
  const isReadOnly = item.readOnly === true;
  const showValueInput = item.type !== 'flag' && item.enabled && !isReadOnly;
  const showReadOnlyValue =
    item.type !== 'flag' && item.enabled && isReadOnly && item.value !== undefined;

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${
        isReadOnly ? 'opacity-60' : 'hover:bg-muted'
      }`}
    >
      <div className="shrink-0">
        <Switch
          checked={item.enabled}
          onCheckedChange={v => onToggle(item.key, v)}
          disabled={isReadOnly}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs font-semibold text-foreground">{label}</code>
          {isReadOnly && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Read-only
            </span>
          )}
          {showReadOnlyValue && (
            <span className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
              {String(item.value)}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {showValueInput && (
        <div className="shrink-0">
          <input
            type={item.type === 'number' ? 'number' : 'text'}
            value={item.value ?? ''}
            onChange={e =>
              onValueChange(
                item.key,
                item.type === 'number'
                  ? e.target.value === ''
                    ? ('' as unknown as number)
                    : Number(e.target.value)
                  : e.target.value
              )
            }
            className="w-36 rounded-md border border-input bg-card px-2.5 py-1 font-mono text-[13px] text-foreground transition focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/40"
            placeholder={item.type === 'number' ? '0' : 'value'}
          />
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  items,
  onToggle,
  onValueChange,
}: {
  category: string;
  items: LaunchOptionItem[];
  onToggle: (key: string, enabled: boolean) => void;
  onValueChange: (key: string, value: string | number) => void;
}) {
  const enabledCount = items.filter(i => i.enabled).length;
  const Icon = CATEGORY_ICONS[category] || Terminal;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-3 bg-muted px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">
            {CATEGORY_LABELS[category] || category}
          </span>
          {enabledCount > 0 && (
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-brand/20 text-[10px] font-bold text-brand">
              {enabledCount}
            </span>
          )}
        </div>
        <span className="text-[11px] font-medium text-muted-foreground">{items.length} options</span>
      </div>
      <div className="divide-y border-t">
        {items.map(item => (
          <LaunchOptionRow
            key={item.key}
            item={item}
            onToggle={onToggle}
            onValueChange={onValueChange}
          />
        ))}
      </div>
    </div>
  );
}

function CommandPreview({ text, loading }: { text: string; loading: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="field-label">
          Command preview
        </span>
        <Button
          onClick={copy}
          variant="secondary"
          size="sm"
        >
          {copied ? (
            <Check className="h-3 w-3 text-success" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-slate-950 px-3 py-3">
        <code className="block whitespace-pre-wrap break-all font-mono text-sm text-emerald-400">
          {loading ? (
            <span className="text-slate-500">Loading...</span>
          ) : (
            <>
              <span className="select-none text-slate-500">$ </span>
              {text}
            </>
          )}
        </code>
      </div>
    </div>
  );
}

function LaunchOptionsCard() {
  const [data, setData] = useState<LaunchOptionsData | null>(null);
  const [items, setItems] = useState<LaunchOptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseResponse = useCallback((raw: Record<string, unknown>) => {
    // Launcher wraps response as {code, message, data: {...}}
    const unwrapped = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
    const d = unwrapped as unknown as LaunchOptionsData;
    setData(d);
    if (Array.isArray(d.items)) {
      setItems(
        d.items.map(item => ({
          key: item.key || '',
          type: item.type || 'flag',
          category: item.category || 'other',
          description: item.description || '',
          enabled: !!item.enabled,
          value: item.value,
          readOnly: !!item.readOnly,
        }))
      );
    } else {
      setItems([]);
    }
  }, []);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await api.getLaunchOptions();
      parseResponse(raw);
      setError(null);
    } catch (err) {
      setError('Could not load launch options');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [parseResponse]);

  useEffect(() => {
    fetchOptions();
  }, [fetchOptions]);

  const handleToggle = useCallback((key: string, enabled: boolean) => {
    setItems(prev =>
      prev.map(item => (item.key === key ? { ...item, enabled } : item))
    );
  }, []);

  const handleValueChange = useCallback((key: string, value: string | number) => {
    setItems(prev =>
      prev.map(item => (item.key === key ? { ...item, value } : item))
    );
  }, []);

  const commandPreview = useMemo(() => {
    if (data?.fullCommandLine) {
      const parts = ['python main.py'];
      for (const item of items) {
        if (item.enabled) {
          if (item.type === 'flag') {
            parts.push(item.key);
          } else if (item.value !== undefined && item.value !== '') {
            parts.push(`${item.key} ${item.value}`);
          }
        }
      }
      return parts.join(' ');
    }
    const parts = ['python main.py'];
    for (const item of items) {
      if (item.enabled) {
        if (item.type === 'flag') {
          parts.push(item.key);
        } else if (item.value !== undefined && item.value !== '') {
          parts.push(`${item.key} ${item.value}`);
        }
      }
    }
    return parts.join(' ');
  }, [items, data?.fullCommandLine]);

  const grouped = useMemo(() => {
    const map: Record<string, LaunchOptionItem[]> = {};
    for (const item of items) {
      const cat = item.category;
      if (!map[cat]) map[cat] = [];
      map[cat].push(item);
    }
    const order = Object.keys(CATEGORY_LABELS);
    const sorted = Object.keys(map).sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      const aIdx = ai === -1 ? 999 : ai;
      const bIdx = bi === -1 ? 999 : bi;
      return aIdx - bIdx;
    });
    return sorted.map(cat => ({ category: cat, items: map[cat] }));
  }, [items]);

  const totalEnabled = items.filter(i => i.enabled).length;

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = items.map(item => ({
        key: item.key,
        type: item.type,
        category: item.category,
        enabled: item.enabled,
        value: item.value,
      }));
      await api.updateLaunchOptions({ items: payload });
      await api.restartComfyUI();
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      setError(null);
    } catch (err) {
      setError('Failed to save launch options');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    try {
      await api.resetLaunchOptions();
      await fetchOptions();
    } catch (err) {
      setError('Failed to reset launch options');
      console.error(err);
    }
  };

  return (
    <Card>
      <SectionHeader
        icon={Terminal}
        title="Launch Options"
        description="Startup arguments and runtime command preview."
        right={
          <div className="flex items-center gap-2">
            {!loading && items.length > 0 && (
              <Badge variant="slate">
                <SlidersHorizontal className="h-3 w-3" />
                {totalEnabled} of {items.length} enabled
              </Badge>
            )}
            <Button
              onClick={fetchOptions}
              variant="ghost"
              size="icon"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        }
      />
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        <CommandPreview text={commandPreview} loading={loading} />

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-10 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        ) : grouped.length === 0 ? (
          <div className="empty-box">
            No launch options available from the API.
          </div>
        ) : (
          // CSS columns (masonry) instead of grid: cards flow top-to-bottom
          // per column, packing tightly regardless of individual card heights.
          // Grid would leave empty space below the shorter card whenever its
          // row-neighbour is expanded; columns don't. `break-inside-avoid`
          // keeps each card whole; `mb-2` replaces space-y-* which doesn't
          // apply inside a columns layout.
          <div className="md:columns-2 md:gap-2 [&>*]:break-inside-avoid [&>*]:mb-2 md:[&>*:last-child]:mb-0">
            {grouped.map(({ category, items: catItems }) => (
              <CategorySection
                key={category}
                category={category}
                items={catItems}
                onToggle={handleToggle}
                onValueChange={handleValueChange}
              />
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-xs text-muted-foreground">
          {grouped.length === 0
            ? 'No configurable flags detected.'
            : 'Changes require a ComfyUI restart to take effect.'}
        </p>
        <div className="inline-flex gap-2">
          <Button onClick={handleReset} variant="secondary">
            <RotateCcw className="w-3 h-3" />
            Reset
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <RefreshCw className="w-3 h-3 animate-spin" />
            ) : saved ? (
              <Check className="w-3 h-3" />
            ) : (
              <Save className="w-3 h-3" />
            )}
            {saved ? 'Saved & Restarting' : saving ? 'Saving' : 'Save & Restart'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   3. Network Configuration Card
   ================================================================= */

function ReachDot({ reach }: { reach?: { accessible: boolean; latencyMs?: number } }) {
  if (!reach) return null;
  const cls = reach.accessible ? 'bg-success' : 'bg-destructive';
  const tip = reach.accessible
    ? `reachable${reach.latencyMs != null ? ` · ${reach.latencyMs}ms` : ''}`
    : 'not reachable';
  return (
    <span
      title={tip}
      className={`inline-block h-1.5 w-1.5 rounded-full ${cls}`}
      aria-label={tip}
    />
  );
}

function NetworkRow({
  label,
  icon: Icon,
  placeholder,
  value,
  onChange,
  onSave,
  saving,
  saved,
  reach,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  reach?: { accessible: boolean; latencyMs?: number };
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <label className="field-label flex items-center gap-1.5">
        <Icon className="h-3 w-3 text-muted-foreground" />
        {label}
        <ReachDot reach={reach} />
      </label>
      <div className="field-wrap py-1 min-w-0">
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          className="field-input font-mono"
          placeholder={placeholder}
          spellCheck={false}
        />
        <button
          onClick={onSave}
          disabled={saving}
          className="shrink-0 rounded-md bg-brand px-2 py-0.5 text-[11px] font-semibold text-brand-foreground transition hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saved ? (
            <Check className="h-3 w-3" />
          ) : saving ? (
            <RefreshCw className="h-3 w-3 animate-spin" />
          ) : (
            'Save'
          )}
        </button>
      </div>
    </div>
  );
}

interface Reachability { url: string; accessible: boolean; latencyMs?: number }

function NetworkCard() {
  const app = useApp();
  const cfg = app.network;
  // Local edit buffers seed from the AppContext snapshot. Re-seed whenever
  // the snapshot changes (e.g. after a save's `refreshSystem`) so unsaved
  // text isn't clobbered mid-edit but a refresh does pick up server state.
  const [hfEndpoint, setHfEndpoint] = useState('');
  const [githubProxy, setGithubProxy] = useState('');
  const [pipSource, setPipSource] = useState('');
  const [trustedHosts, setTrustedHosts] = useState('');
  const [modelTrustedHosts, setModelTrustedHosts] = useState('');
  const [allowPrivateIp, setAllowPrivateIp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingHf, setSavingHf] = useState(false);
  const [savedHf, setSavedHf] = useState(false);
  const [savingGh, setSavingGh] = useState(false);
  const [savedGh, setSavedGh] = useState(false);
  const [savingPip, setSavingPip] = useState(false);
  const [savedPip, setSavedPip] = useState(false);
  const [savingHosts, setSavingHosts] = useState(false);
  const [savedHosts, setSavedHosts] = useState(false);
  const [savingModelHosts, setSavingModelHosts] = useState(false);
  const [savedModelHosts, setSavedModelHosts] = useState(false);
  const [savingAllow, setSavingAllow] = useState(false);

  const loading = cfg === null;
  const reach: { github?: Reachability; pip?: Reachability; huggingface?: Reachability } =
    cfg?.reachability ?? {};

  useEffect(() => {
    if (!cfg) return;
    setHfEndpoint(cfg.huggingfaceEndpoint || '');
    setGithubProxy(cfg.githubProxy || '');
    setPipSource(cfg.pipSource || '');
    setTrustedHosts((cfg.pluginTrustedHosts || []).join(', '));
    setModelTrustedHosts((cfg.modelTrustedHosts || []).join(', '));
    setAllowPrivateIp(Boolean(cfg.allowPrivateIpMirrors));
  }, [cfg]);

  const refreshNetwork = app.refreshSystem;

  const saveHf = async () => {
    setSavingHf(true);
    try {
      await api.setSystemConfig('huggingface-endpoint', hfEndpoint);
      setSavedHf(true);
      setTimeout(() => setSavedHf(false), 2000);
      void refreshNetwork();
    } catch {
      setError('Failed to save HuggingFace endpoint');
    } finally {
      setSavingHf(false);
    }
  };
  const saveGh = async () => {
    setSavingGh(true);
    try {
      await api.setSystemConfig('github-proxy', githubProxy);
      setSavedGh(true);
      setTimeout(() => setSavedGh(false), 2000);
      void refreshNetwork();
    } catch {
      setError('Failed to save GitHub proxy');
    } finally {
      setSavingGh(false);
    }
  };
  const savePip = async () => {
    setSavingPip(true);
    try {
      await api.setSystemConfig('pip-source', pipSource);
      setSavedPip(true);
      setTimeout(() => setSavedPip(false), 2000);
      void refreshNetwork();
    } catch {
      setError('Failed to save pip source');
    } finally {
      setSavingPip(false);
    }
  };
  const saveHosts = async () => {
    setSavingHosts(true);
    try {
      const hosts = trustedHosts.split(',').map(s => s.trim()).filter(Boolean);
      await api.setSystemConfig('plugin-trusted-hosts', hosts);
      setSavedHosts(true);
      setTimeout(() => setSavedHosts(false), 2000);
      void refreshNetwork();
    } catch {
      setError('Failed to save plugin trusted hosts');
    } finally {
      setSavingHosts(false);
    }
  };
  const saveModelHosts = async () => {
    setSavingModelHosts(true);
    try {
      const hosts = modelTrustedHosts.split(',').map(s => s.trim()).filter(Boolean);
      await api.setSystemConfig('model-trusted-hosts', hosts);
      setSavedModelHosts(true);
      setTimeout(() => setSavedModelHosts(false), 2000);
      void refreshNetwork();
    } catch {
      setError('Failed to save model trusted hosts');
    } finally {
      setSavingModelHosts(false);
    }
  };
  const toggleAllow = async (next: boolean) => {
    setSavingAllow(true);
    const prev = allowPrivateIp;
    setAllowPrivateIp(next);
    try {
      await api.setSystemConfig('pip-allow-private-ip', next);
      void refreshNetwork();
    } catch {
      setAllowPrivateIp(prev);
      setError('Failed to update private-IP mirror policy');
    } finally {
      setSavingAllow(false);
    }
  };

  return (
    <Card>
      <SectionHeader
        icon={Globe}
        title="Network"
        description="Download sources and proxies."
        right={
          <Button
            onClick={() => { void refreshNetwork(); }}
            variant="ghost"
            size="icon"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        }
      />
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-32 rounded bg-muted animate-pulse" />
                <div className="h-9 rounded-lg bg-muted animate-pulse" />
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
              <NetworkRow
                label="HuggingFace Endpoint"
                icon={Link2}
                placeholder="https://huggingface.co"
                value={hfEndpoint}
                onChange={setHfEndpoint}
                onSave={saveHf}
                saving={savingHf}
                saved={savedHf}
                reach={reach.huggingface}
              />
              <NetworkRow
                label="GitHub Proxy"
                icon={GitBranch}
                placeholder="https://github.com"
                value={githubProxy}
                onChange={setGithubProxy}
                onSave={saveGh}
                saving={savingGh}
                saved={savedGh}
                reach={reach.github}
              />
              <NetworkRow
                label="Pip Source"
                icon={Package}
                placeholder="https://pypi.org/simple"
                value={pipSource}
                onChange={setPipSource}
                onSave={savePip}
                saving={savingPip}
                saved={savedPip}
                reach={reach.pip}
              />
              <NetworkRow
                label="Plugin Trusted Hosts"
                icon={Shield}
                placeholder="codeberg.org, git.example.com"
                value={trustedHosts}
                onChange={setTrustedHosts}
                onSave={saveHosts}
                saving={savingHosts}
                saved={savedHosts}
              />
              <NetworkRow
                label="Model Trusted Hosts"
                icon={Shield}
                placeholder="cdn.example.com, mirror.example.org"
                value={modelTrustedHosts}
                onChange={setModelTrustedHosts}
                onSave={saveModelHosts}
                saving={savingModelHosts}
                saved={savedModelHosts}
              />
            </div>
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">Allow Private-IP Pip Mirrors</p>
                <p className="text-[11px] text-muted-foreground">
                  Accept <span className="font-mono">http://</span> pip sources on LAN IPs (10.*, 192.168.*, 172.16-31.*).
                </p>
              </div>
              <Switch
                size="sm"
                checked={allowPrivateIp}
                disabled={savingAllow}
                onCheckedChange={(v: boolean) => toggleAllow(v)}
                aria-label="Allow private-IP pip mirrors"
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* =================================================================
   4. Storage Info Card (read-only)
   ================================================================= */

const STORAGE_PATHS = [
  { label: 'Models', path: '/root/ComfyUI/models' },
  { label: 'Output', path: '/root/ComfyUI/output' },
  { label: 'Plugins', path: '/root/ComfyUI/custom_nodes' },
  { label: 'Cache', path: '/root/.cache' },
];

function StorageRowCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button onClick={copy} variant="ghost" size="icon" title="Copy to clipboard">
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function ThumbnailCacheRow() {
  const [stats, setStats] = useState<{ count: number; totalBytes: number } | null>(null);
  const [clearing, setClearing] = useState(false);

  const refresh = useCallback(() => {
    api.getThumbnailStats()
      .then((s) => setStats({ count: s.count, totalBytes: s.totalBytes }))
      .catch(() => setStats({ count: 0, totalBytes: 0 }));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const clear = async () => {
    setClearing(true);
    try {
      const { deleted } = await api.clearThumbnailCache();
      toast.success(`Cleared ${deleted} thumbnail${deleted === 1 ? '' : 's'}`);
      refresh();
    } catch (err) {
      toast.error('Failed to clear thumbnail cache', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted">
      <div className="flex min-w-0 items-center gap-2">
        <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Thumbnail cache</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {stats
              ? `${stats.count} file${stats.count === 1 ? '' : 's'} · ${formatBytes(stats.totalBytes)}`
              : 'Loading…'}
          </div>
        </div>
      </div>
      <Button
        onClick={clear}
        disabled={clearing || !stats || stats.count === 0}
        variant="secondary"
      >
        {clearing ? 'Clearing…' : 'Clear'}
      </Button>
    </div>
  );
}

function StorageCard() {
  return (
    <Card>
      <SectionHeader
        icon={HardDrive}
        title="Storage"
        description="File locations used by the current workspace."
      />
      <div className="divide-y">
        {STORAGE_PATHS.map(({ label, path }) => (
          <div
            key={path}
            className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{label}</div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{path}</div>
            </div>
            <StorageRowCopyButton text={path} />
          </div>
        ))}
        <ThumbnailCacheRow />
      </div>
    </Card>
  );
}

/* =================================================================
   Page
   ================================================================= */

type SettingsTab = 'general' | 'mcp' | 'comfy' | 'souls' | 'skills' | 'commands';

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'mcp', label: 'MCP', icon: Plug },
  { id: 'comfy', label: 'Comfy', icon: CpuTabIcon },
  { id: 'souls', label: 'Souls', icon: Sparkles },
  { id: 'skills', label: 'Skills', icon: BookOpen },
  { id: 'commands', label: 'Commands', icon: SlashSquare },
];

export default function Settings() {
  const [tab, setTab] = usePersistedState<SettingsTab>('settings.tab', 'general');

  const tabStrip = (
    <div role="tablist" aria-label="Settings tabs" className="tab-strip">
      {TABS.map(t => {
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab-strip-item inline-flex items-center gap-1.5 ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <Icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <PageSubbar title="Settings" description="Configure your workspace" right={tabStrip} />
      <div className="page-container space-y-4">
        {/* General — LLM, chat advanced, tools, secrets, storage, network */}
        {tab === 'general' && (
          <div className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <ChatLlmCard />
              <ChatAdvancedCard />
            </div>
            <ToolsCard />
            <SecretsCard />
            <div className="grid gap-3 md:grid-cols-2">
              <StorageCard />
              <NetworkCard />
            </div>
          </div>
        )}

        {/* MCP — Studio MCP server + external servers (side by side), integrated tools */}
        {tab === 'mcp' && (
          <div className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-2">
              <StudioMcpServerSection />
              <McpServersSection />
            </div>
            <IntegratedToolsSection />
          </div>
        )}

        {/* Comfy — launch options */}
        {tab === 'comfy' && (
          <div className="space-y-3">
            <LaunchOptionsCard />
          </div>
        )}

        {/* Souls — soul list + memory */}
        {tab === 'souls' && (
          <div className="space-y-3">
            <SoulsSection />
            <MemorySection />
          </div>
        )}

        {/* Skills — reusable instruction blocks */}
        {tab === 'skills' && (
          <div className="space-y-3">
            <SkillsSection />
          </div>
        )}

        {/* Commands — slash-triggered shortcuts for the composer */}
        {tab === 'commands' && (
          <div className="space-y-3">
            <CommandsSection />
          </div>
        )}
      </div>
    </>
  );
}
