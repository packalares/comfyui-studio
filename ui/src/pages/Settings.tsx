import { useState, useEffect, useCallback, useMemo } from 'react';
import PageSubbar from '../components/PageSubbar';
import ToolsCard from '../components/settings/ToolsCard';
import {
  Copy,
  Check,
  Save,
  RotateCcw,
  Eye,
  EyeOff,
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
  Trash2,
  Shield,
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
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../services/comfyui';
import { useApp } from '../context/AppContext';
import { Switch } from '../components/ui/switch';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '../components/ui/card';

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

function StatusBadge({ ok, labelOk, labelBad }: { ok: boolean; labelOk: string; labelBad: string }) {
  return (
    <Badge variant={ok ? 'emerald' : 'amber'}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          ok ? 'bg-emerald-500' : 'bg-amber-500'
        }`}
      />
      {ok ? labelOk : labelBad}
    </Badge>
  );
}

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
        <Icon className="w-3.5 h-3.5 text-slate-400 mt-0.5" />
        <div>
          <h2 className="text-sm font-semibold text-slate-900 leading-tight">{title}</h2>
          <p className="mt-0.5 text-[11px] text-slate-400">{description}</p>
        </div>
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </CardHeader>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`toggle ${checked ? 'toggle-on' : 'toggle-off'} ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      }`}
    >
      <span
        className={`toggle-thumb ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

/* =================================================================
   1. API Key Card
   ================================================================= */

function ApiKeyCard() {
  const { apiKeyConfigured: configured, refreshSystem, refreshTemplates } = useApp();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await api.setApiKey(apiKey.trim());
      await Promise.all([refreshSystem(), refreshTemplates()]);
      setApiKey('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearApiKey();
      await Promise.all([refreshSystem(), refreshTemplates()]);
      setApiKey('');
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || apiKey.trim().length === 0;

  return (
    <Card>
      <SectionHeader
        icon={Key}
        title="Comfy Org API Key"
        description="Required for Gemini, Kling, Grok, Runway, and other provider workflows."
        right={<StatusBadge ok={configured} labelOk="Configured" labelBad="Not set" />}
      />
      <CardContent className="space-y-3">
        <label className="field-label">
          API key
        </label>
        <div className="field-wrap">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="field-input font-mono"
            placeholder={configured ? 'Key is set — type a new one to replace' : 'Enter your API key'}
            autoComplete="off"
            spellCheck={false}
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
        <div className="info-box">
          <p>
            Stored server-side in a config file on the GPU (readable only by the process owner) and attached to every prompt as <code>extra_data.api_key_comfy_org</code>. Never returned to the browser after save.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes are applied immediately.</p>
        <div className="inline-flex gap-2">
          {configured && (
            <Button onClick={handleClear} disabled={busy} variant="secondary" className="!text-red-600 hover:!bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1b. HuggingFace Token Card
   ================================================================= */

function HfTokenCard() {
  const { hfTokenConfigured: configured, refreshSystem } = useApp();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      await api.setHfToken(token.trim());
      await refreshSystem();
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearHfToken();
      await refreshSystem();
      setToken('');
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || token.trim().length === 0;

  return (
    <Card>
      <SectionHeader
        icon={Key}
        title="HuggingFace Token"
        description="Required to download gated models (e.g. FLUX.2-klein) and private repos."
        right={<StatusBadge ok={configured} labelOk="Configured" labelBad="Not set" />}
      />
      <CardContent className="space-y-3">
        <label className="field-label">
          Access token
        </label>
        <div className="field-wrap">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            className="field-input font-mono"
            placeholder={configured ? 'Token is set — type a new one to replace' : 'hf_…'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowToken(v => !v)}
            className="text-slate-400 transition hover:text-slate-700"
            aria-label={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="info-box">
          <p>
            Create a <strong>read</strong> token at <code>huggingface.co/settings/tokens</code>.
            Stored server-side in the same config file as the API key; sent as
            <code> Authorization: Bearer</code> on HEAD/GET calls for gated HuggingFace URLs.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes are applied immediately.</p>
        <div className="inline-flex gap-2">
          {configured && (
            <Button onClick={handleClear} disabled={busy} variant="secondary" className="!text-red-600 hover:!bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1c. CivitAI Token Card
   ================================================================= */

function CivitaiTokenCard() {
  const { civitaiTokenConfigured: configured, refreshSystem } = useApp();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      await api.setCivitaiToken(token.trim());
      await refreshSystem();
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearCivitaiToken();
      await refreshSystem();
      setToken('');
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || token.trim().length === 0;

  return (
    <Card>
      <SectionHeader
        icon={Key}
        title="CivitAI Token"
        description="Adds authentication for civitai.com downloads (LoRAs, workflows) and gated items."
        right={<StatusBadge ok={configured} labelOk="Configured" labelBad="Not set" />}
      />
      <CardContent className="space-y-3">
        <label className="field-label">
          Access token
        </label>
        <div className="field-wrap">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            className="field-input font-mono"
            placeholder={configured ? 'Token is set — type a new one to replace' : 'CivitAI API key'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowToken(v => !v)}
            className="text-slate-400 transition hover:text-slate-700"
            aria-label={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="info-box">
          <p>
            Create an API key on <code>civitai.com/user/account</code>. Stored
            server-side; attached as <code>Authorization: Bearer</code> to
            civitai.com HEAD/GET requests. Never echoed back to the browser.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes are applied immediately.</p>
        <div className="inline-flex gap-2">
          {configured && (
            <Button onClick={handleClear} disabled={busy} variant="secondary" className="!text-red-600 hover:!bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1d. GitHub Token Card
   ================================================================= */

function GithubTokenCard() {
  const { githubTokenConfigured: configured, refreshSystem } = useApp();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      await api.setGithubToken(token.trim());
      await refreshSystem();
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearGithubToken();
      await refreshSystem();
      setToken('');
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || token.trim().length === 0;

  return (
    <Card>
      <SectionHeader
        icon={Key}
        title="GitHub Token"
        description="Adds authentication for github.com release downloads and lifts the unauthenticated 60/h API rate limit."
        right={<StatusBadge ok={configured} labelOk="Configured" labelBad="Not set" />}
      />
      <CardContent className="space-y-3">
        <label className="field-label">
          Access token
        </label>
        <div className="field-wrap">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            className="field-input font-mono"
            placeholder={configured ? 'Token is set — type a new one to replace' : 'github_pat_…'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowToken(v => !v)}
            className="text-slate-400 transition hover:text-slate-700"
            aria-label={showToken ? 'Hide token' : 'Show token'}
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="info-box">
          <p>
            Create a fine-grained <strong>read</strong> token at <code>github.com/settings/tokens</code>.
            Stored server-side; attached as <code>Authorization: Bearer</code>
            to github.com release downloads + api.github.com calls. Never echoed back to the browser.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes are applied immediately.</p>
        <div className="inline-flex gap-2">
          {configured && (
            <Button onClick={handleClear} disabled={busy} variant="secondary" className="!text-red-600 hover:!bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1e. Pexels API Key Card
   ================================================================= */

function PexelsApiKeyCard() {
  const { pexelsApiKeyConfigured: configured, refreshSystem } = useApp();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setBusy(true);
    try {
      await api.setPexelsApiKey(token.trim());
      await refreshSystem();
      setToken('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      await api.clearPexelsApiKey();
      await refreshSystem();
      setToken('');
    } finally {
      setBusy(false);
    }
  };

  const saveDisabled = busy || token.trim().length === 0;

  return (
    <Card>
      <SectionHeader
        icon={Key}
        title="Pexels API Key"
        description="Optional. Lets audio thumbnails fetch a prompt-matched stock photo instead of a generic placeholder."
        right={<StatusBadge ok={configured} labelOk="Configured" labelBad="Not set" />}
      />
      <CardContent className="space-y-3">
        <label className="field-label">
          API key
        </label>
        <div className="field-wrap">
          <input
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={e => setToken(e.target.value)}
            className="field-input font-mono"
            placeholder={configured ? 'Key is set — type a new one to replace' : 'Pexels API key'}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => setShowToken(v => !v)}
            className="text-slate-400 transition hover:text-slate-700"
            aria-label={showToken ? 'Hide key' : 'Show key'}
          >
            {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <div className="info-box">
          <p>
            Free key at <code>pexels.com/api</code> (200 req/hr, 20k/month).
            When set, audio tiles without embedded cover art search Pexels
            using the prompt. Unset → falls back to a deterministic Picsum
            placeholder. Never echoed back to the browser.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">Changes are applied immediately.</p>
        <div className="inline-flex gap-2">
          {configured && (
            <Button onClick={handleClear} disabled={busy} variant="secondary" className="!text-red-600 hover:!bg-red-50">
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
          <Button onClick={handleSave} disabled={saveDisabled}>
            {saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
            {saved ? 'Saved' : configured ? 'Replace' : 'Save'}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* =================================================================
   1f. Chat / LLM (Ollama) Card
   ================================================================= */

function ChatLlmCard() {
  const [ollamaUrl, setOllamaUrl] = useState('');
  const [savedOllamaUrl, setSavedOllamaUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [keepAlive, setKeepAlive] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Holds a failed-probe result so we can offer a "Save anyway" escape hatch
  // without losing the typed URL between clicks.
  const [probeFailedUrl, setProbeFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    api.getChatSettings()
      .then(s => {
        setOllamaUrl(s.ollamaUrl);
        setSavedOllamaUrl(s.ollamaUrl);
        setDefaultModel(s.defaultModel);
        setKeepAlive(s.keepAlive);
      })
      .catch(() => { /* fall back to placeholders */ })
      .finally(() => setLoaded(true));
  }, []);

  const persist = async () => {
    const next = await api.setChatSettings({
      ollamaUrl: ollamaUrl.trim(),
      defaultModel: defaultModel.trim(),
      keepAlive: keepAlive.trim(),
    });
    setOllamaUrl(next.ollamaUrl);
    setSavedOllamaUrl(next.ollamaUrl);
    setDefaultModel(next.defaultModel);
    setKeepAlive(next.keepAlive);
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
        const probe = await api.probeChatOllama(trimmed);
        if (!probe.ok) {
          toast.error(`Could not reach Ollama at ${trimmed}`, {
            description: probe.error,
          });
          setProbeFailedUrl(trimmed);
          return;
        }
        toast.success(`Connected, found ${probe.modelCount} models`);
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
      <CardContent className="space-y-3">
        <div>
          <label className="field-label">Ollama URL</label>
          <div className="field-wrap">
            <input
              type="text"
              value={ollamaUrl}
              onChange={e => setOllamaUrl(e.target.value)}
              className="field-input font-mono"
              placeholder="http://localhost:11434"
              spellCheck={false}
              disabled={!loaded}
            />
          </div>
          <p className="field-helper">
            Base URL of your local Ollama server. Studio appends <code>/v1</code> for chat
            completions and <code>/api</code> for tag/pull/delete calls.
          </p>
        </div>
        <div>
          <label className="field-label">Default model</label>
          <div className="field-wrap">
            <input
              type="text"
              value={defaultModel}
              onChange={e => setDefaultModel(e.target.value)}
              className="field-input font-mono"
              placeholder="llama3.3:70b-instruct-q4_K_M"
              spellCheck={false}
              disabled={!loaded}
            />
          </div>
          <p className="field-helper">
            Pre-selected on a fresh chat. Pull this model first via the Chat → Models page.
          </p>
        </div>
        <div>
          <label className="field-label">keep_alive</label>
          <div className="field-wrap">
            <input
              type="text"
              value={keepAlive}
              onChange={e => setKeepAlive(e.target.value)}
              className="field-input font-mono"
              placeholder="5m"
              spellCheck={false}
              disabled={!loaded}
            />
          </div>
          <p className="field-helper">
            How long Ollama keeps the model in VRAM after a request. <code>5m</code>,
            <code>1h</code>, or <code>0</code> to unload immediately.
          </p>
        </div>
      </CardContent>
      <CardFooter>
        <p className="text-xs text-slate-500">
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
        isReadOnly ? 'opacity-60' : 'hover:bg-slate-50'
      }`}
    >
      <div className="shrink-0">
        <Toggle
          checked={item.enabled}
          onChange={v => onToggle(item.key, v)}
          disabled={isReadOnly}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-xs font-semibold text-slate-800">{label}</code>
          {isReadOnly && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-500">
              Read-only
            </span>
          )}
          {showReadOnlyValue && (
            <span className="rounded border border-slate-100 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-500">
              {String(item.value)}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{description}</p>
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
            className="w-36 rounded-md border border-slate-300 bg-white px-2.5 py-1 font-mono text-[13px] text-slate-900 transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
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
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-700">
            {CATEGORY_LABELS[category] || category}
          </span>
          {enabledCount > 0 && (
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-teal-100 text-[10px] font-bold text-teal-700">
              {enabledCount}
            </span>
          )}
        </div>
        <span className="text-[11px] font-medium text-slate-400">{items.length} options</span>
      </div>
      <div className="divide-y divide-slate-100 border-t border-slate-200">
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
            <Check className="h-3 w-3 text-emerald-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-950 px-3 py-3">
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
          <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2">
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}

        <CommandPreview text={commandPreview} loading={loading} />

        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-10 rounded-lg bg-slate-100 animate-pulse" />
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
        <p className="text-xs text-slate-500">
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
  const cls = reach.accessible ? 'bg-emerald-500' : 'bg-rose-500';
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
        <Icon className="h-3 w-3 text-slate-400" />
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
          className="shrink-0 rounded-md bg-teal-600 px-2 py-0.5 text-[11px] font-semibold text-white transition hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
  const [hfEndpoint, setHfEndpoint] = useState('');
  const [githubProxy, setGithubProxy] = useState('');
  const [pipSource, setPipSource] = useState('');
  const [trustedHosts, setTrustedHosts] = useState('');
  const [modelTrustedHosts, setModelTrustedHosts] = useState('');
  const [allowPrivateIp, setAllowPrivateIp] = useState(false);
  const [reach, setReach] = useState<{ github?: Reachability; pip?: Reachability; huggingface?: Reachability }>({});
  const [loading, setLoading] = useState(true);
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

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const cfg = await api.getNetworkConfig();
      const raw = cfg as Record<string, unknown>;
      const unwrapped = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, unknown>;
      setHfEndpoint(String(unwrapped.huggingfaceEndpoint || unwrapped.hf_endpoint || ''));
      setGithubProxy(String(unwrapped.githubProxy || unwrapped.github_proxy || ''));
      setPipSource(String(unwrapped.pipSource || unwrapped.pip_source || ''));
      const hosts = Array.isArray(unwrapped.pluginTrustedHosts) ? unwrapped.pluginTrustedHosts : [];
      setTrustedHosts(hosts.join(', '));
      const mhosts = Array.isArray(unwrapped.modelTrustedHosts) ? unwrapped.modelTrustedHosts : [];
      setModelTrustedHosts(mhosts.join(', '));
      setAllowPrivateIp(Boolean(unwrapped.allowPrivateIpMirrors));
      const r = unwrapped.reachability as { github?: Reachability; pip?: Reachability; huggingface?: Reachability } | undefined;
      setReach(r || {});
      setError(null);
    } catch (err) {
      setError('Could not load network config');
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const saveHf = async () => {
    setSavingHf(true);
    try {
      await api.setHuggingFaceEndpoint(hfEndpoint);
      setSavedHf(true);
      setTimeout(() => setSavedHf(false), 2000);
    } catch {
      setError('Failed to save HuggingFace endpoint');
    } finally {
      setSavingHf(false);
    }
  };
  const saveGh = async () => {
    setSavingGh(true);
    try {
      await api.setGithubProxy(githubProxy);
      setSavedGh(true);
      setTimeout(() => setSavedGh(false), 2000);
    } catch {
      setError('Failed to save GitHub proxy');
    } finally {
      setSavingGh(false);
    }
  };
  const savePip = async () => {
    setSavingPip(true);
    try {
      await api.setPipSource(pipSource);
      setSavedPip(true);
      setTimeout(() => setSavedPip(false), 2000);
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
      await api.setPluginTrustedHosts(hosts);
      setSavedHosts(true);
      setTimeout(() => setSavedHosts(false), 2000);
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
      await api.setModelTrustedHosts(hosts);
      setSavedModelHosts(true);
      setTimeout(() => setSavedModelHosts(false), 2000);
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
      await api.setAllowPrivateIpMirrors(next);
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
            onClick={loadConfig}
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
          <div className="rounded-lg border border-red-100 bg-red-50 px-3 py-2">
            <p className="text-xs text-red-600">{error}</p>
          </div>
        )}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="space-y-1.5">
                <div className="h-3 w-32 rounded bg-slate-100 animate-pulse" />
                <div className="h-9 rounded-lg bg-slate-100 animate-pulse" />
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
                <p className="text-xs font-medium text-slate-700">Allow Private-IP Pip Mirrors</p>
                <p className="text-[11px] text-slate-500">
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
        <Check className="h-3.5 w-3.5 text-emerald-500" />
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
    <div className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
      <div className="flex min-w-0 items-center gap-2">
        <ImageIcon className="h-4 w-4 shrink-0 text-slate-500" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-800">Thumbnail cache</div>
          <div className="mt-0.5 text-xs text-slate-500">
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
      <div className="divide-y divide-slate-100">
        {STORAGE_PATHS.map(({ label, path }) => (
          <div
            key={path}
            className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-800">{label}</div>
              <div className="mt-0.5 truncate font-mono text-xs text-slate-500">{path}</div>
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

export default function Settings() {
  return (
    <>
      <PageSubbar title="Settings" description="Configure your workspace" />
      <div className="page-container space-y-3">
        {/* API keys row — Comfy Org | HuggingFace | CivitAI | GitHub | Pexels */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <ApiKeyCard />
          <HfTokenCard />
          <CivitaiTokenCard />
          <GithubTokenCard />
          <PexelsApiKeyCard />
        </div>
        {/* Chat / LLM full row */}
        <ChatLlmCard />
        {/* Chat tools / integrations — sits BELOW the Chat / LLM card per phase 2 spec */}
        <ToolsCard />
        {/* Storage + Network row */}
        <div className="grid gap-3 md:grid-cols-2">
          <StorageCard />
          <NetworkCard />
        </div>
        {/* Launch options — full width */}
        <LaunchOptionsCard />
      </div>
    </>
  );
}
