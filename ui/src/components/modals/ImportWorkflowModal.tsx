import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UploadCloud, FileJson, Github, Clipboard,
  CheckCircle2, AlertCircle, Image as ImageIcon, Layers, Puzzle,
  Package, Link2, Download, RefreshCw, WifiOff,
} from 'lucide-react';
import type { StagedImportManifest } from '../../types';
import { api, ApiError } from '../../services/comfyui';
import { useApp } from '../../context/AppContext';
import { Checkbox } from '../ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs';
import AppModal from './AppModal';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Spinner } from '../ui/spinner';
import { cn } from '../../lib/utils';

interface Props {
  open: boolean;
  onClose: () => void;
  /**
   * Optional preloaded staging manifest. When supplied the modal jumps
   * straight to the review step — used by `CivitaiTemplateCard` after a
   * multi-workflow zip hits the staging pipeline.
   */
  initialManifest?: StagedImportManifest | null;
  /**
   * Optional callback fired after the commit succeeds. Parents use this to
   * refresh their template list and show a banner. When omitted the modal
   * navigates to `/explore?source=user` as a fallback.
   */
  onImported?: (imported: string[]) => void;
  /** Open directly on a specific tab ('comfy', 'upload', etc.). */
  initialTab?: SourceTab;
  /** Called after a successful comfy-import to refresh the template list. */
  onComfyImported?: () => void;
}

type Step = 'source' | 'upload' | 'review';
// `paste` was a separate tab; merged into `upload` because both produce the
// same workflow JSON — just different input mechanisms (file vs textarea).
type SourceTab = 'comfy' | 'upload' | 'github' | 'civitai';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const GITHUB_URL_EXAMPLES: string[] = [
  'https://github.com/<owner>/<repo>/blob/main/workflow.json',
  'https://raw.githubusercontent.com/<owner>/<repo>/main/workflow.json',
  'https://github.com/<owner>/<repo> (walks the repo for *.json)',
];

const CIVITAI_URL_EXAMPLE =
  'https://civitai.com/models/12345 or .../models/12345?modelVersionId=67890';

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ImportWorkflowModal(props: Props): JSX.Element | null {
  const { open, onClose, initialManifest, onImported, initialTab, onComfyImported } = props;
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('upload');
  const [tab, setTab] = useState<SourceTab>(initialTab ?? 'comfy');
  const [manifest, setManifest] = useState<StagedImportManifest | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [copyImages, setCopyImages] = useState<boolean>(true);
  const [uploading, setUploading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  // Per-repo install-checkbox state keyed by the plugin repo URL. Default is
  // on for every resolved match across every selected workflow (the Install
  // step is opt-out, matching the "all missing plugins" default on commit).
  const [pluginInstallChoices, setPluginInstallChoices] = useState<Record<string, boolean>>({});
  const [installProgress, setInstallProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Belt-and-suspenders scroll target for the CollisionPrompt — see the
  // useEffect below. The prompt is rendered above the ReviewStep but on a
  // very tall workflow list the modal can still scroll; this brings the
  // prompt back into view the moment a 409 NAME_COLLISION lands.
  const collisionRef = useRef<HTMLDivElement | null>(null);
  const [githubUrl, setGithubUrl] = useState<string>('');
  const [pasteText, setPasteText] = useState<string>('');
  const [pasteTitle, setPasteTitle] = useState<string>('');
  const [civitaiUrl, setCivitaiUrl] = useState<string>('');
  // Surface a NAME_COLLISION 409 from the commit endpoint so the user can
  // pick the suggested slug or cancel. `workflowIndex` is the staged-row
  // index whose computed slug collided — used as the key for the retry's
  // `titleOverrides`. Cleared on successful commit / close.
  const [collision, setCollision] = useState<{
    existingSlug: string; suggestedSlug: string; workflowIndex?: number;
  } | null>(null);

  // Jump to review when we're handed a prestaged manifest (civitai path).
  useEffect(() => {
    if (!open) return;
    if (initialManifest) {
      setManifest(initialManifest);
      setSelectedIndices(new Set(initialManifest.workflows.map((_, i) => i)));
      setStep('review');
    } else {
      setManifest(null);
      setSelectedIndices(new Set());
      setStep('upload');
    }
    setError(null);
    setCopyImages(true);
    setTab(initialTab ?? 'comfy');
    setPluginInstallChoices({});
    setInstallProgress(null);
    setGithubUrl('');
    setPasteText('');
    setPasteTitle('');
    setCivitaiUrl('');
    setCollision(null);
  }, [open, initialManifest]);

  // Default every unique plugin repo across the selected workflows to
  // "install on commit". Runs once on review entry (and on manifest change).
  useEffect(() => {
    if (!manifest) return;
    const next: Record<string, boolean> = {};
    for (const wf of manifest.workflows) {
      for (const r of wf.plugins || []) {
        for (const m of r.matches) {
          if (!(m.repo in next)) next[m.repo] = true;
        }
      }
    }
    setPluginInstallChoices(next);
  }, [manifest]);

  // Scroll the CollisionPrompt into view the moment a 409 NAME_COLLISION
  // lands. Without this, tall workflow lists pushed the prompt below the
  // modal fold and users perceived the Commit click as a no-op.
  useEffect(() => {
    if (!collision) return;
    const el = collisionRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [collision]);

  /**
   * Wave L: derive the "can commit" state for the current selection. The
   * button is disabled when any selected workflow still has unresolved
   * models or plugins — the inline summary below lists the specifics.
   */
  const commitBlockers = useMemo(() => {
    if (!manifest) return { canCommit: false, unresolvedModels: [] as string[], unresolvedPlugins: [] as string[] };
    return computeCommitBlockers(manifest, selectedIndices);
  }, [manifest, selectedIndices]);

  const handleClose = useCallback((): void => {
    // Abort staging on explicit close when it was created in this session —
    // don't abort a caller-supplied manifest since the caller owns it.
    if (manifest && !initialManifest && step === 'review') {
      void api.abortImportStaging(manifest.id).catch(() => undefined);
    }
    onClose();
  }, [manifest, initialManifest, step, onClose]);

  const receiveFile = useCallback(async (file: File): Promise<void> => {
    setError(null);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`File exceeds ${humanBytes(MAX_UPLOAD_BYTES)} limit.`);
      return;
    }
    setUploading(true);
    try {
      const m = await api.importWorkflowUpload(file);
      setManifest(m);
      setSelectedIndices(new Set(m.workflows.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, []);

  const handleFetchGithub = useCallback(async (): Promise<void> => {
    setError(null);
    const trimmed = githubUrl.trim();
    if (!trimmed) {
      setError('Paste a GitHub URL to continue.');
      return;
    }
    setUploading(true);
    try {
      const m = await api.importWorkflowFromGithub(trimmed);
      setManifest(m);
      setSelectedIndices(new Set(m.workflows.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub import failed');
    } finally {
      setUploading(false);
    }
  }, [githubUrl]);

  const handleFetchCivitai = useCallback(async (): Promise<void> => {
    setError(null);
    const trimmed = civitaiUrl.trim();
    if (!trimmed) {
      setError('Paste a CivitAI URL to continue.');
      return;
    }
    setUploading(true);
    try {
      const m = await api.importWorkflowFromCivitai(trimmed);
      setManifest(m);
      setSelectedIndices(new Set(m.workflows.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CivitAI import failed');
    } finally {
      setUploading(false);
    }
  }, [civitaiUrl]);

  const handleParsePaste = useCallback(async (): Promise<void> => {
    setError(null);
    if (!pasteText.trim()) {
      setError('Paste a workflow JSON to continue.');
      return;
    }
    const byteLen = new TextEncoder().encode(pasteText).byteLength;
    if (byteLen > MAX_UPLOAD_BYTES) {
      setError(`Pasted JSON exceeds ${humanBytes(MAX_UPLOAD_BYTES)} limit.`);
      return;
    }
    setUploading(true);
    try {
      const m = await api.importWorkflowFromPaste(
        pasteText,
        pasteTitle.trim() || undefined,
      );
      setManifest(m);
      setSelectedIndices(new Set(m.workflows.map((_, i) => i)));
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Paste import failed');
    } finally {
      setUploading(false);
    }
  }, [pasteText, pasteTitle]);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void receiveFile(file);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) void receiveFile(file);
    // Reset so the same file can be re-selected immediately.
    e.target.value = '';
  };

  const toggleIndex = (idx: number): void => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handleCommit = useCallback(async (
    titleOverrides?: Record<number, string>,
  ): Promise<void> => {
    if (!manifest) return;
    const indices = Array.from(selectedIndices).sort((a, b) => a - b);
    if (indices.length === 0) {
      setError('Select at least one workflow to import.');
      return;
    }
    setError(null);
    setCollision(null);
    setCommitting(true);
    setInstallProgress(null);
    try {
      const result = await api.commitImportStaging(manifest.id, {
        workflowIndices: indices,
        imagesCopy: manifest.images.length > 0 ? copyImages : false,
        titleOverrides,
      });
      // Opt-in plugin installs: for each committed template, the backend
      // already persisted the template_plugins edges. We filter by the
      // per-repo checkbox state and only trigger the install endpoint when
      // at least one repo is toggled on — otherwise we skip the extra
      // round-trip entirely.
      const reposToInstall = Object.keys(pluginInstallChoices)
        .filter((r) => pluginInstallChoices[r]);
      if (reposToInstall.length > 0) {
        setInstallProgress(`Queuing ${reposToInstall.length} plugin install${reposToInstall.length === 1 ? '' : 's'}...`);
        for (const templateName of result.imported) {
          try {
            await api.installMissingPlugins(templateName);
          } catch (err) {
            // Soft-fail: template is committed, the user can retry from
            // the Template card chip. Surface as a banner but keep going.
            console.warn('installMissingPlugins failed for', templateName, err);
          }
        }
      }
      if (onImported) onImported(result.imported);
      else navigate(`/explore?source=user&imported=${result.imported.length}`);
      onClose();
    } catch (err) {
      // Detect the typed 409 NAME_COLLISION payload and pop the rename
      // modal instead of dropping the user back at the generic error
      // banner. The staging row is still alive on the server side, so the
      // retry can re-submit with `titleOverrides` populated.
      if (
        err instanceof ApiError && err.status === 409
        && err.data && typeof err.data === 'object'
        && (err.data as { code?: string }).code === 'NAME_COLLISION'
      ) {
        const data = err.data as {
          existingSlug?: string; suggestedSlug?: string; workflowIndex?: number;
        };
        if (typeof data.existingSlug === 'string' && typeof data.suggestedSlug === 'string') {
          setCollision({
            existingSlug: data.existingSlug,
            suggestedSlug: data.suggestedSlug,
            workflowIndex: typeof data.workflowIndex === 'number' ? data.workflowIndex : undefined,
          });
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setCommitting(false);
      setInstallProgress(null);
    }
  }, [manifest, selectedIndices, copyImages, pluginInstallChoices, onImported, navigate, onClose]);

  const togglePlugin = useCallback((repo: string): void => {
    setPluginInstallChoices((prev) => ({ ...prev, [repo]: !prev[repo] }));
  }, []);

  /**
   * Resolve a missing model by URL. Calls the backend route; on success
   * replaces the manifest with the server's refreshed copy so the row
   * re-renders in the "resolved" state without a separate fetch.
   */
  const handleResolveModelUrl = useCallback(async (
    workflowIndex: number, missingFileName: string, url: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!manifest) return { ok: false, error: 'No staging manifest loaded.' };
    try {
      const result = await api.resolveImportStagingModel(manifest.id, {
        workflowIndex, missingFileName, url,
      });
      if (result.manifest) setManifest(result.manifest);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [manifest]);

  return (
    <AppModal
      open={open}
      onClose={handleClose}
      title="Import workflow"
      subtitle={
        step === 'review'
          ? 'Pick which workflows to add to your library.'
          : 'Upload a .json or .zip exported from ComfyUI.'
      }
      size="lg"
      disableClose={uploading || committing}
      closeOnBackdropClick={false}
      footer={
        <>
          <div className="text-[11px] text-muted-foreground">
            {step === 'review' && manifest
              ? `${selectedIndices.size} of ${manifest.workflows.length} selected`
              : 'Max 20 MB. Multiple workflows will be shown next.'}
          </div>
          <div className="flex items-center gap-2">
            {step === 'review' && !initialManifest && (
              <Button type="button" variant="secondary" onClick={() => { setStep('upload'); setManifest(null); }}>
                Back
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
            {step === 'review' && (
              <Button
                type="button"
                disabled={committing || selectedIndices.size === 0 || !commitBlockers.canCommit}
                onClick={() => { void handleCommit(); }}
                title={
                  !commitBlockers.canCommit
                    ? 'Resolve the highlighted model + plugin rows before importing.'
                    : undefined
                }
              >
                {committing ? <Spinner size="sm" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {committing ? 'Importing…' : `Import ${selectedIndices.size} workflow${selectedIndices.size === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        </>
      }
    >
      {step === 'upload' && (
        <UploadStep
          tab={tab}
          onTabChange={setTab}
          uploading={uploading}
          dragActive={dragActive}
          onDragStateChange={setDragActive}
          onFileSelect={handleFileSelect}
          onDrop={handleDrop}
          fileInputRef={fileInputRef}
          githubUrl={githubUrl}
          onGithubUrlChange={setGithubUrl}
          onFetchGithub={handleFetchGithub}
          pasteText={pasteText}
          onPasteTextChange={setPasteText}
          pasteTitle={pasteTitle}
          onPasteTitleChange={setPasteTitle}
          onParsePaste={handleParsePaste}
          civitaiUrl={civitaiUrl}
          onCivitaiUrlChange={setCivitaiUrl}
          onFetchCivitai={handleFetchCivitai}
          onComfyImported={onComfyImported}
        />
      )}
      {/* CollisionPrompt sits BEFORE the review step so it's visible at the
          top of the modal body — tall workflow lists previously hid the
          prompt below the fold and the user thought the Commit button did
          nothing on a 409 NAME_COLLISION. The companion useEffect above
          scrolls it into view as a belt-and-suspenders measure. */}
      {collision && (
        <div ref={collisionRef}>
          <CollisionPrompt
            existingSlug={collision.existingSlug}
            suggestedSlug={collision.suggestedSlug}
            busy={committing}
            onCancel={() => setCollision(null)}
            onUseSuggested={() => {
              const overrides: Record<number, string> = {};
              // Server reports the colliding index when available; fall back
              // to the first selected index so single-workflow imports still
              // work even if the response is missing the field.
              const targetIndex = collision.workflowIndex
                ?? Array.from(selectedIndices).sort((a, b) => a - b)[0];
              if (typeof targetIndex === 'number') {
                overrides[targetIndex] = collision.suggestedSlug;
              }
              void handleCommit(overrides);
            }}
          />
        </div>
      )}
      {step === 'review' && manifest && (
        <ReviewStep
          manifest={manifest}
          selectedIndices={selectedIndices}
          onToggle={toggleIndex}
          copyImages={copyImages}
          onCopyImagesChange={setCopyImages}
          pluginInstallChoices={pluginInstallChoices}
          onTogglePlugin={togglePlugin}
          installProgress={installProgress}
          onResolveModelUrl={handleResolveModelUrl}
          commitBlockers={commitBlockers}
        />
      )}
      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </AppModal>
  );
}

interface CollisionPromptProps {
  existingSlug: string;
  suggestedSlug: string;
  busy: boolean;
  onCancel: () => void;
  onUseSuggested: () => void;
}

function CollisionPrompt(props: CollisionPromptProps): JSX.Element {
  const { existingSlug, suggestedSlug, busy, onCancel, onUseSuggested } = props;
  return (
    <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-3 text-xs text-warning">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">A workflow named &quot;{existingSlug}&quot; already exists.</div>
          <div className="mt-1">
            Use suggested name <span className="font-mono">{suggestedSlug}</span> or cancel?
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              disabled={busy} onClick={onUseSuggested}
            >
              Use suggested
            </Button>
            <Button
              type="button" variant="secondary"
              disabled={busy} onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Upload

interface UploadStepProps {
  tab: SourceTab;
  onTabChange: (t: SourceTab) => void;
  uploading: boolean;
  dragActive: boolean;
  onDragStateChange: (active: boolean) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  fileInputRef: React.MutableRefObject<HTMLInputElement | null>;
  githubUrl: string;
  onGithubUrlChange: (v: string) => void;
  onFetchGithub: () => void | Promise<void>;
  pasteText: string;
  onPasteTextChange: (v: string) => void;
  pasteTitle: string;
  onPasteTitleChange: (v: string) => void;
  onParsePaste: () => void | Promise<void>;
  civitaiUrl: string;
  onCivitaiUrlChange: (v: string) => void;
  onFetchCivitai: () => void | Promise<void>;
  onComfyImported?: () => void;
}

/** Pill-style file/paste toggle for the Upload tab. Mirrors the
 *  `wf-viewtoggle` pattern used by the Studio graph view. Used twice in the
 *  same render: once anchored to the dropzone's corner, once inline next to
 *  the paste title input. Pulling it out keeps both call sites in sync.
 */
function UploadModeToggle({
  mode, onChange,
}: { mode: 'file' | 'paste'; onChange: (m: 'file' | 'paste') => void }): JSX.Element {
  return (
    <div className="wf-viewtoggle">
      <button
        type="button"
        onClick={() => onChange('file')}
        className={cn('wf-viewtoggle-btn', mode === 'file' && 'is-active')}
      >
        <UploadCloud className="w-3 h-3 inline-block mr-1 -mt-px" />
        File
      </button>
      <button
        type="button"
        onClick={() => onChange('paste')}
        className={cn('wf-viewtoggle-btn', mode === 'paste' && 'is-active')}
      >
        <Clipboard className="w-3 h-3 inline-block mr-1 -mt-px" />
        Paste
      </button>
    </div>
  );
}

function UploadStep(p: UploadStepProps): JSX.Element {
  const {
    tab, onTabChange, uploading, dragActive, onDragStateChange,
    onFileSelect, onDrop, fileInputRef,
    githubUrl, onGithubUrlChange, onFetchGithub,
    pasteText, onPasteTextChange, pasteTitle, onPasteTitleChange, onParsePaste,
    civitaiUrl, onCivitaiUrlChange, onFetchCivitai,
    onComfyImported,
  } = p;
  const pasteBytes = useMemo(
    () => new TextEncoder().encode(pasteText).length,
    [pasteText],
  );
  const pasteOver = pasteBytes > MAX_UPLOAD_BYTES;
  // File vs paste-text picker inside the Upload tab. They produce the same
  // workflow JSON downstream, so the tab is a single space with a toggle
  // rather than two separate tabs in the outer Tabs list.
  const [uploadMode, setUploadMode] = useState<'file' | 'paste'>('file');
  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SourceTab)}>
        <TabsList className="w-full">
          <TabsTrigger value="comfy" className="flex-1">
            <Download className="w-3.5 h-3.5" />
            From ComfyUI
          </TabsTrigger>
          <TabsTrigger value="upload" className="flex-1">
            <UploadCloud className="w-3.5 h-3.5" />
            Upload
          </TabsTrigger>
          <TabsTrigger value="github" className="flex-1">
            <Github className="w-3.5 h-3.5" />
            GitHub
          </TabsTrigger>
          <TabsTrigger value="civitai" className="flex-1">
            <FileJson className="w-3.5 h-3.5" />
            CivitAI
          </TabsTrigger>
        </TabsList>

        <TabsContent value="comfy" className="pt-4">
          <ComfyImportTab onImported={onComfyImported} />
        </TabsContent>
        <TabsContent value="upload" className="pt-4 space-y-3">
          {/* The pill toggle is rendered INSIDE each mode's content, anchored
              so it shares vertical space with the existing UI:
                - File mode: top-right of the dropzone (absolute)
                - Paste mode: inline next to the title input
              This avoids a wasted "switcher row" above the content. */}
          {uploadMode === 'file' && (
            <div
              onDragOver={(e) => { e.preventDefault(); onDragStateChange(true); }}
              onDragLeave={() => onDragStateChange(false)}
              onDrop={onDrop}
              className={`relative rounded-xl border-2 border-dashed transition p-8 text-center ${
                dragActive
                  ? 'border-brand bg-brand/10'
                  : 'border-input bg-muted'
              }`}
            >
              <div className="absolute right-3 top-3">
                <UploadModeToggle mode={uploadMode} onChange={setUploadMode} />
              </div>
              <UploadCloud className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium text-foreground">Drag a file here</p>
              <p className="text-xs text-muted-foreground mt-1">or click to pick one from your computer</p>
              <p className="text-[11px] text-muted-foreground mt-2">Accepts .json or .zip up to 20 MB</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.zip,application/json,application/zip"
                className="hidden"
                onChange={onFileSelect}
              />
              <Button
                type="button"
                className="mt-4"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? <Spinner size="sm" /> : <FileJson className="w-3.5 h-3.5" />}
                {uploading ? 'Uploading…' : 'Choose file'}
              </Button>
            </div>
          )}

          {uploadMode === 'paste' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={pasteTitle}
                  onChange={(e) => onPasteTitleChange(e.target.value)}
                  placeholder="Optional title"
                  className="flex-1 rounded-md border border-input px-3 py-2 text-sm focus:outline-none focus:border-ring"
                  disabled={uploading}
                />
                <UploadModeToggle mode={uploadMode} onChange={setUploadMode} />
              </div>
              <textarea
                value={pasteText}
                onChange={(e) => onPasteTextChange(e.target.value)}
                placeholder='{"nodes":[...], "links":[...]}'
                rows={10}
                className="w-full rounded-md border border-input px-3 py-2 text-xs font-mono focus:outline-none focus:border-ring"
                disabled={uploading}
              />
              <div className="flex items-center justify-between text-[11px]">
                <span className={pasteOver ? 'text-destructive font-medium' : 'text-muted-foreground'}>
                  {humanBytes(pasteBytes)} / Max {humanBytes(MAX_UPLOAD_BYTES)}
                </span>
                <Button
                  type="button"
                  disabled={uploading || !pasteText.trim() || pasteOver}
                  onClick={() => void onParsePaste()}
                >
                  {uploading ? <Spinner size="sm" /> : <Clipboard className="w-3.5 h-3.5" />}
                  {uploading ? 'Parsing…' : 'Parse'}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="github" className="pt-4">
          <div className="space-y-3">
            <label className="block text-xs font-medium text-foreground">
              GitHub URL
            </label>
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => onGithubUrlChange(e.target.value)}
              placeholder="https://github.com/owner/repo/blob/main/workflow.json"
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus:outline-none focus:border-ring"
              disabled={uploading}
              onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) void onFetchGithub(); }}
            />
            <div className="rounded-md bg-muted border px-3 py-2 text-[11px] text-muted-foreground">
              <div className="font-medium text-foreground mb-1">Examples</div>
              <ul className="space-y-0.5 font-mono break-all">
                {GITHUB_URL_EXAMPLES.map((ex) => <li key={ex}>{ex}</li>)}
              </ul>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={uploading || !githubUrl.trim()}
                onClick={() => void onFetchGithub()}
              >
                {uploading ? <Spinner size="sm" /> : <Github className="w-3.5 h-3.5" />}
                {uploading ? 'Fetching…' : 'Fetch'}
              </Button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="civitai" className="pt-4">
          <div className="space-y-3">
            <label className="block text-xs font-medium text-foreground">
              CivitAI URL
            </label>
            <input
              type="url"
              value={civitaiUrl}
              onChange={(e) => onCivitaiUrlChange(e.target.value)}
              placeholder="https://civitai.com/models/12345"
              className="w-full rounded-md border border-input px-3 py-2 text-sm focus:outline-none focus:border-ring"
              disabled={uploading}
              onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) void onFetchCivitai(); }}
            />
            <div className="rounded-md bg-muted border px-3 py-2 text-[11px] text-muted-foreground">
              <div className="font-medium text-foreground mb-1">Example</div>
              <p className="font-mono break-all">{CIVITAI_URL_EXAMPLE}</p>
              <p className="mt-1 text-muted-foreground">
                We look for a workflow JSON in the model's files, then fall back to
                workflows embedded in image generation metadata.
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={uploading || !civitaiUrl.trim()}
                onClick={() => void onFetchCivitai()}
              >
                {uploading ? <Spinner size="sm" /> : <FileJson className="w-3.5 h-3.5" />}
                {uploading ? 'Fetching…' : 'Fetch'}
              </Button>
            </div>
          </div>
        </TabsContent>

      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Review manifest

interface ReviewStepProps {
  manifest: StagedImportManifest;
  selectedIndices: Set<number>;
  onToggle: (idx: number) => void;
  copyImages: boolean;
  onCopyImagesChange: (v: boolean) => void;
  pluginInstallChoices: Record<string, boolean>;
  onTogglePlugin: (repo: string) => void;
  installProgress: string | null;
  /**
   * Resolve a missing model by URL. The parent talks to the backend and
   * returns `{ ok: true }` on success (the parent also refreshes the
   * manifest) or `{ ok: false, error }` so the row can surface the error
   * inline without a global banner.
   */
  onResolveModelUrl: (
    workflowIndex: number,
    missingFileName: string,
    url: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  commitBlockers: {
    canCommit: boolean;
    unresolvedModels: string[];
    unresolvedPlugins: string[];
  };
}

interface PluginSummaryRow {
  repo: string;
  title: string;
  cnr_id?: string;
  /** Count of selected workflows that reference this repo. */
  workflows: number;
}

/**
 * Collapse every selected workflow's plugin resolutions into a single
 * list keyed by repo. Zero-match class types (unresolved) are collected
 * separately so the UI can surface "N custom nodes couldn't be resolved".
 */
function summarizePlugins(
  manifest: StagedImportManifest,
  selectedIndices: Set<number>,
): { resolved: PluginSummaryRow[]; unresolvedClassTypes: string[] } {
  const byRepo = new Map<string, PluginSummaryRow>();
  const unresolved = new Set<string>();
  for (let i = 0; i < manifest.workflows.length; i++) {
    if (!selectedIndices.has(i)) continue;
    const wf = manifest.workflows[i];
    for (const r of wf.plugins || []) {
      if (r.matches.length === 0) {
        unresolved.add(r.classType);
        continue;
      }
      for (const m of r.matches) {
        const existing = byRepo.get(m.repo);
        if (existing) {
          existing.workflows += 1;
        } else {
          byRepo.set(m.repo, {
            repo: m.repo,
            title: m.title,
            cnr_id: m.cnr_id,
            workflows: 1,
          });
        }
      }
    }
  }
  return {
    resolved: Array.from(byRepo.values())
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    unresolvedClassTypes: Array.from(unresolved).sort(),
  };
}

function ReviewStep(p: ReviewStepProps): JSX.Element {
  const {
    manifest, selectedIndices, onToggle, copyImages, onCopyImagesChange,
    pluginInstallChoices, onTogglePlugin, installProgress, onResolveModelUrl,
    commitBlockers,
  } = p;
  const pluginSummary = useMemo(
    () => summarizePlugins(manifest, selectedIndices),
    [manifest, selectedIndices],
  );
  return (
    <div className="space-y-3">
      {manifest.defaultTitle && (
        <div className="text-xs text-muted-foreground">
          Source: <span className="font-medium text-foreground">{manifest.defaultTitle}</span>
          {manifest.sourceUrl && (
            <>
              {' · '}
              <a
                href={manifest.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand hover:text-brand/90"
              >
                View original
              </a>
            </>
          )}
        </div>
      )}
      <ul className="space-y-2">
        {manifest.workflows.map((wf, idx) => (
          <li
            key={`${wf.entryName}-${idx}`}
            className="card-row"
          >
            <Checkbox
              checked={selectedIndices.has(idx)}
              onCheckedChange={() => onToggle(idx)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-foreground truncate" title={wf.title}>
                  {wf.title}
                </span>
                <Badge variant={
                  wf.mediaType === 'video' ? 'danger' :
                  wf.mediaType === 'audio' ? 'warning' :
                  'brand'
                }>
                  {wf.mediaType}
                </Badge>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
                <span className="inline-flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  {wf.nodeCount} nodes
                </span>
                <span>{humanBytes(wf.jsonBytes)}</span>
                {wf.models.length > 0 && (
                  <span>{wf.models.length} model{wf.models.length === 1 ? '' : 's'} required</span>
                )}
                {wf.plugins.length > 0 && (
                  <span>
                    {wf.plugins.length} custom node{wf.plugins.length === 1 ? '' : 's'} detected
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate" title={wf.entryName}>
                {wf.entryName}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {manifest.images.length > 0 && (
        <div className="rounded-lg border bg-muted p-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={copyImages}
              onCheckedChange={(v) => onCopyImagesChange(v === true)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ImageIcon className="w-3.5 h-3.5 text-muted-foreground" />
                Copy {manifest.images.length} reference image{manifest.images.length === 1 ? '' : 's'}
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Files will land in ComfyUI/input/ with the template slug as a prefix to avoid collisions.
              </p>
            </div>
          </label>
        </div>
      )}

      {commitBlockers.unresolvedModels.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-destructive mb-1">
            <AlertCircle className="w-3.5 h-3.5" />
            Cannot import — {commitBlockers.unresolvedModels.length} model
            {commitBlockers.unresolvedModels.length === 1 ? '' : 's'} unresolved.
          </div>
          <p className="text-[11px] text-destructive mb-1">
            Resolve these rows first:
          </p>
          <ul className="list-disc ml-4 text-[11px] text-destructive font-mono space-y-0.5">
            {commitBlockers.unresolvedModels.map((m) => <li key={`m-${m}`}>{m}</li>)}
          </ul>
        </div>
      )}

      {commitBlockers.unresolvedPlugins.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning mb-1">
            <AlertCircle className="w-3.5 h-3.5" />
            {commitBlockers.unresolvedPlugins.length} custom node
            {commitBlockers.unresolvedPlugins.length === 1 ? '' : 's'} couldn't be resolved (warning only — commit proceeds).
          </div>
          <p className="text-[11px] text-warning mb-1">
            ComfyUI-Manager may be unreachable, or the workflow was saved without plugin metadata. You'll still be able to import — missing plugins surface at first run.
          </p>
          <ul className="list-disc ml-4 text-[11px] text-warning font-mono space-y-0.5">
            {commitBlockers.unresolvedPlugins.map((p) => (
              <li key={`p-${p}`}>plugin: {p}</li>
            ))}
          </ul>
        </div>
      )}

      <MissingModelsSection
        manifest={manifest}
        selectedIndices={selectedIndices}
        onResolveModelUrl={onResolveModelUrl}
      />

      {(pluginSummary.resolved.length > 0 || pluginSummary.unresolvedClassTypes.length > 0) && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-warning mb-2">
            <Puzzle className="w-3.5 h-3.5" />
            Required custom nodes ({pluginSummary.resolved.length})
          </div>
          {pluginSummary.resolved.length > 0 && (
            <ul className="space-y-1.5">
              {pluginSummary.resolved.map((p) => (
                <li key={p.repo} className="flex items-start gap-2">
                  <Checkbox
                    checked={!!pluginInstallChoices[p.repo]}
                    onCheckedChange={() => onTogglePlugin(p.repo)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-foreground truncate" title={p.title}>
                      {p.title}
                    </div>
                    <div className="text-[11px] text-muted-foreground font-mono truncate" title={p.repo}>
                      {p.repo}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pluginSummary.unresolvedClassTypes.length > 0 && (
            <div className="mt-2 text-[11px] text-warning">
              <span className="font-medium">Unresolved:</span>{' '}
              {pluginSummary.unresolvedClassTypes.length} class type{pluginSummary.unresolvedClassTypes.length === 1 ? '' : 's'} not
              in Manager's catalog. You can install them manually later via Plugins → Custom URL.
              <details className="mt-1">
                <summary className="cursor-pointer text-warning">Show class types</summary>
                <ul className="mt-1 font-mono text-[10px] text-warning">
                  {pluginSummary.unresolvedClassTypes.map((c) => <li key={c}>{c}</li>)}
                </ul>
              </details>
            </div>
          )}
          <p className="mt-2 text-[11px] text-warning">
            Checked plugins are queued for install after the template is saved.
          </p>
          {installProgress && (
            <p className="mt-1 text-[11px] text-warning inline-flex items-center gap-1">
              <Spinner size="xs" />
              {installProgress}
            </p>
          )}
        </div>
      )}

      {manifest.notes.length > 0 && (
        <details className="rounded-lg border bg-card p-3 text-xs text-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            {manifest.notes.length} note{manifest.notes.length === 1 ? '' : 's'} included
          </summary>
          <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
            {manifest.notes.map((note, i) => (
              <pre key={i} className="whitespace-pre-wrap text-[11px] text-muted-foreground">{note}</pre>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ComfyUI catalog import tab

interface ComfySSEEvent {
  type: 'progress' | 'skip' | 'done' | 'error';
  current?: number;
  total?: number;
  name?: string;
  reason?: string;
  added?: number;
  updated?: number;
  skipped?: number;
  errors?: number;
  message?: string;
}

interface ComfyImportTabProps {
  onImported?: () => void;
}

function ComfyImportTab({ onImported }: ComfyImportTabProps): JSX.Element {
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [currentName, setCurrentName] = useState('');
  const [done, setDone] = useState<{ added: number; updated: number; skipped: number; errors: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const startImport = useCallback(() => {
    if (running) return;
    setRunning(true);
    setCurrent(0);
    setTotal(0);
    setCurrentName('');
    setDone(null);
    setError(null);

    const es = new EventSource('/api/templates/import-from-comfy');
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data as string) as ComfySSEEvent;
        if (ev.type === 'progress') {
          setCurrent(ev.current ?? 0);
          setTotal(ev.total ?? 0);
          setCurrentName(ev.name ?? '');
        } else if (ev.type === 'done') {
          setDone({ added: ev.added ?? 0, updated: ev.updated ?? 0, skipped: ev.skipped ?? 0, errors: ev.errors ?? 0 });
          setRunning(false);
          es.close();
          if (onImported) onImported();
        } else if (ev.type === 'error') {
          setError(ev.message ?? 'Unknown error');
          setRunning(false);
          es.close();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      if (running) {
        setError('Connection lost during import');
        setRunning(false);
      }
      es.close();
    };
  }, [running, onImported]);

  // Cleanup on unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  const progressPct = total > 0 ? Math.round((current / total) * 100) : 0;
  // The Explore page's connectivity flag mirrors the ComfyUI proxy heartbeat.
  // When the upstream is down there's nothing to import from, so we replace
  // the action button with an inline offline banner instead of letting the
  // user click and wait for a stream that'll immediately emit `error`.
  const { connected } = useApp();

  return (
    <div className="rounded-xl border border-input bg-card p-5 space-y-4">
      {/* Header card: icon + title + description */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-brand/10 p-2.5 shrink-0">
          <Download className="w-5 h-5 text-brand" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Import from ComfyUI</h3>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            Pulls every workflow from your local ComfyUI catalog and saves them
            to disk so Studio works offline. Re-running this overwrites updated
            ones and preserves your favorites. Soft-deleted flows stay hidden
            and won&apos;t come back on re-import.
          </p>
        </div>
      </div>

      {/* Offline state: hide the action, show a clear reason */}
      {!connected && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 flex items-start gap-2">
          <WifiOff className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="font-medium text-destructive">ComfyUI is offline</p>
            <p className="text-destructive/80 mt-0.5">
              Start ComfyUI and reopen this dialog to import.
            </p>
          </div>
        </div>
      )}

      {/* Idle state with connection: a contained right-aligned action.
          Full-width felt heavy for a single CTA; this keeps the card balanced. */}
      {connected && !running && !done && !error && (
        <div className="flex justify-end pt-1">
          <Button type="button" onClick={startImport}>
            <Download className="w-3.5 h-3.5" />
            Import all
          </Button>
        </div>
      )}

      {running && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" />
            <span className="truncate">{currentName || 'Starting…'}</span>
            <span className="ml-auto shrink-0">{current} / {total}</span>
          </div>
          <div className="h-2 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-brand transition-all"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {done && (
        <div className="rounded-md border border-success/30 bg-success/10 px-3 py-3 text-xs space-y-1">
          <div className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Import complete
          </div>
          <div className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 mt-1">
            <span>Added</span><span className="font-mono">{done.added}</span>
            <span>Updated</span><span className="font-mono">{done.updated}</span>
            <span>Skipped</span><span className="font-mono">{done.skipped}</span>
            <span>Errors</span><span className="font-mono">{done.errors}</span>
          </div>
          <Button type="button" variant="secondary" className="mt-2" onClick={startImport}>
            <RefreshCw className="w-3.5 h-3.5" />
            Re-import
          </Button>
        </div>
      )}

      {error && (
        <div className="space-y-2">
          <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-xs text-destructive flex items-start gap-2">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
          <Button type="button" variant="secondary" onClick={startImport}>
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing models section — Wave E "Resolve via URL" affordance.
//
// Lists every model filename referenced by a selected workflow. Filenames
// already resolved in the current staging session render with a compact
// "resolved" badge; everything else gets an inline Input + Resolve button.
// Suggestions from the workflow's MarkdownNote bodies prefill the input
// one-click when they match. No global state: each row owns its input,
// spinner, and per-row error message.

interface MissingModelsSectionProps {
  manifest: StagedImportManifest;
  selectedIndices: Set<number>;
  onResolveModelUrl: (
    workflowIndex: number,
    missingFileName: string,
    url: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** Wave L: row state is one of — paste-resolved, auto-resolved, or unresolved. */
type MissingModelRowKind =
  | { state: 'resolved'; source: 'huggingface' | 'civitai'; downloadUrl: string; suggestedFolder?: string }
  | { state: 'auto'; source: 'catalog' | 'markdown' | 'huggingface' | 'civitai' | 'hfRepo'; downloadUrl: string; hfRepo?: string; suggestedFolder?: string }
  | { state: 'unresolved' };

interface MissingModelRow {
  workflowIndex: number;
  workflowTitle: string;
  fileName: string;
  kind: MissingModelRowKind;
  suggestedUrl?: string;
}

/**
 * Collapse every selected workflow's model list into a row-per-filename.
 * When the same filename appears across multiple workflows we keep one
 * row (the first workflow it appeared in) — the backend resolves once
 * and upserts the catalog, so a single resolution covers every workflow.
 */
function collectMissingModelRows(
  manifest: StagedImportManifest,
  selectedIndices: Set<number>,
): MissingModelRow[] {
  const seen = new Map<string, MissingModelRow>();
  for (let i = 0; i < manifest.workflows.length; i++) {
    if (!selectedIndices.has(i)) continue;
    const wf = manifest.workflows[i];
    for (const fileName of wf.models || []) {
      if (seen.has(fileName)) continue;
      const pasted = wf.resolvedModels?.[fileName];
      const auto = wf.autoResolvedModels?.[fileName];
      // Paste-resolved wins over auto — the user explicitly picked a URL.
      let kind: MissingModelRowKind;
      if (pasted) {
        kind = {
          state: 'resolved',
          source: pasted.source,
          downloadUrl: pasted.downloadUrl,
          suggestedFolder: pasted.suggestedFolder,
        };
      } else if (auto) {
        kind = {
          state: 'auto',
          source: auto.source,
          downloadUrl: auto.downloadUrl,
          hfRepo: auto.hfRepo,
          suggestedFolder: auto.suggestedFolder,
        };
      } else {
        kind = { state: 'unresolved' };
      }
      // Best-effort URL suggestion: pick the first note URL whose
      // filename (basename of pathname) matches the row filename.
      const suggestedUrl = (wf.modelUrls || []).find((u) => {
        try { return new URL(u).pathname.split('/').pop() === fileName; }
        catch { return false; }
      });
      seen.set(fileName, {
        workflowIndex: i,
        workflowTitle: wf.title,
        fileName,
        kind,
        suggestedUrl,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Wave L: compute whether the current selection can commit. Returns the
 * blocking rows (unresolved models, unresolved plugins) so the UI can
 * render an inline summary alongside the disabled button.
 */
function computeCommitBlockers(
  manifest: StagedImportManifest,
  selectedIndices: Set<number>,
): { canCommit: boolean; unresolvedModels: string[]; unresolvedPlugins: string[] } {
  // Models block commit — a missing model causes an unrecoverable runtime
  // error in Studio. Plugins DO NOT block — Manager offline or legacy
  // workflows without aux_id routinely surface as empty-match resolutions
  // even when the plugin is locally installed. We still surface the list
  // as a warning so the review step can show it.
  const unresolvedModels = new Set<string>();
  const unresolvedPlugins = new Set<string>();
  for (let i = 0; i < manifest.workflows.length; i++) {
    if (!selectedIndices.has(i)) continue;
    const wf = manifest.workflows[i];
    const covered = new Set<string>([
      ...Object.keys(wf.resolvedModels ?? {}),
      ...Object.keys(wf.autoResolvedModels ?? {}),
    ]);
    for (const fn of wf.models ?? []) {
      if (!covered.has(fn)) unresolvedModels.add(fn);
    }
    for (const p of wf.plugins ?? []) {
      if (!p.matches || p.matches.length === 0) unresolvedPlugins.add(p.classType);
    }
  }
  return {
    canCommit: unresolvedModels.size === 0,
    unresolvedModels: Array.from(unresolvedModels).sort(),
    unresolvedPlugins: Array.from(unresolvedPlugins).sort(),
  };
}

function MissingModelsSection(p: MissingModelsSectionProps): JSX.Element | null {
  const { manifest, selectedIndices, onResolveModelUrl } = p;
  const rows = useMemo(
    () => collectMissingModelRows(manifest, selectedIndices),
    [manifest, selectedIndices],
  );
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border bg-muted p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground mb-2">
        <Package className="w-3.5 h-3.5" />
        Model dependencies ({rows.length})
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        Paste a HuggingFace or CivitAI URL to register the file in the catalog so the
        launcher can download it after import.
      </p>
      <ul className="space-y-2">
        {rows.map((row) => (
          <MissingModelRowView
            key={`${row.workflowIndex}:${row.fileName}`}
            row={row}
            onResolveModelUrl={onResolveModelUrl}
          />
        ))}
      </ul>
    </div>
  );
}

interface MissingModelRowViewProps {
  row: MissingModelRow;
  onResolveModelUrl: MissingModelsSectionProps['onResolveModelUrl'];
}

function viaLabel(source: 'catalog' | 'markdown' | 'huggingface' | 'civitai' | 'hfRepo'): string {
  switch (source) {
    case 'catalog': return 'via catalog';
    case 'markdown': return 'via markdown note';
    case 'huggingface': return 'via HuggingFace';
    case 'civitai': return 'via CivitAI';
    case 'hfRepo': return 'via HF repo';
  }
}

function MissingModelRowView(p: MissingModelRowViewProps): JSX.Element {
  const { row, onResolveModelUrl } = p;
  const [value, setValue] = useState<string>(row.suggestedUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setRowError(null);
    const result = await onResolveModelUrl(row.workflowIndex, row.fileName, value.trim());
    setBusy(false);
    if (!result.ok) setRowError(result.error);
  }, [value, busy, onResolveModelUrl, row.workflowIndex, row.fileName]);

  return (
    <li className="rounded-md border bg-card px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-foreground truncate" title={row.fileName}>
          {row.fileName}
        </span>
        {row.kind.state === 'resolved' && (
          <Badge variant="success" title={row.kind.downloadUrl}>
            <CheckCircle2 className="w-3 h-3" />
            resolved via {row.kind.source}
            {row.kind.suggestedFolder ? ` (${row.kind.suggestedFolder})` : ''}
          </Badge>
        )}
        {row.kind.state === 'auto' && (
          <Badge variant="success" title={row.kind.hfRepo || row.kind.downloadUrl}>
            <CheckCircle2 className="w-3 h-3" />
            auto-resolved {viaLabel(row.kind.source)}
            {row.kind.source === 'hfRepo' && row.kind.hfRepo ? ` — ${row.kind.hfRepo}` : ''}
            {row.kind.suggestedFolder ? ` (${row.kind.suggestedFolder})` : ''}
          </Badge>
        )}
        {row.kind.state === 'unresolved' && (
          <Badge variant="danger">
            <AlertCircle className="w-3 h-3" />
            Unresolved — paste URL below
          </Badge>
        )}
      </div>
      {row.kind.state === 'unresolved' && (
        <div className="mt-1.5 flex items-center gap-2">
          <Link2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <input
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://huggingface.co/... or https://civitai.com/..."
            disabled={busy}
            className="flex-1 rounded border border-input px-2 py-1 text-xs focus:outline-none focus:border-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !value.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Spinner size="xs" /> : 'Resolve'}
          </Button>
        </div>
      )}
      {rowError && (
        <div className="mt-1 text-[11px] text-destructive">{rowError}</div>
      )}
    </li>
  );
}
