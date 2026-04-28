import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UploadCloud, FileJson, Github, Clipboard, Loader2,
  CheckCircle2, AlertCircle, Image as ImageIcon, Layers, Puzzle,
  Package, Link2,
} from 'lucide-react';
import type { StagedImportManifest } from '../types';
import { api, ApiError } from '../services/comfyui';
import { Checkbox } from './ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import AppModal from './AppModal';

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
}

type Step = 'source' | 'upload' | 'review';
type SourceTab = 'upload' | 'github' | 'civitai' | 'paste';

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
  const { open, onClose, initialManifest, onImported } = props;
  const navigate = useNavigate();

  const [step, setStep] = useState<Step>('upload');
  const [tab, setTab] = useState<SourceTab>('upload');
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
    setTab('upload');
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
      size="md"
      disableClose={uploading || committing}
      footer={
        <>
          <div className="text-[11px] text-slate-500">
            {step === 'review' && manifest
              ? `${selectedIndices.size} of ${manifest.workflows.length} selected`
              : 'Max 20 MB. Multiple workflows will be shown next.'}
          </div>
          <div className="flex items-center gap-2">
            {step === 'review' && !initialManifest && (
              <button type="button" className="btn-secondary" onClick={() => { setStep('upload'); setManifest(null); }}>
                Back
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={handleClose}>
              Cancel
            </button>
            {step === 'review' && (
              <button
                type="button"
                className="btn-primary"
                disabled={committing || selectedIndices.size === 0 || !commitBlockers.canCommit}
                onClick={() => { void handleCommit(); }}
                title={
                  !commitBlockers.canCommit
                    ? 'Resolve the highlighted model + plugin rows before importing.'
                    : undefined
                }
              >
                {committing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                {committing ? 'Importing…' : `Import ${selectedIndices.size} workflow${selectedIndices.size === 1 ? '' : 's'}`}
              </button>
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
        />
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
        <div className="mt-3 flex items-start gap-2 rounded-md bg-rose-50 border border-rose-100 px-3 py-2 text-xs text-rose-700">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {collision && (
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
    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-900">
      <div className="flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-medium">A workflow named &quot;{existingSlug}&quot; already exists.</div>
          <div className="mt-1">
            Use suggested name <span className="font-mono">{suggestedSlug}</span> or cancel?
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button" className="btn-primary"
              disabled={busy} onClick={onUseSuggested}
            >
              Use suggested
            </button>
            <button
              type="button" className="btn-secondary"
              disabled={busy} onClick={onCancel}
            >
              Cancel
            </button>
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
}

function UploadStep(p: UploadStepProps): JSX.Element {
  const {
    tab, onTabChange, uploading, dragActive, onDragStateChange,
    onFileSelect, onDrop, fileInputRef,
    githubUrl, onGithubUrlChange, onFetchGithub,
    pasteText, onPasteTextChange, pasteTitle, onPasteTitleChange, onParsePaste,
    civitaiUrl, onCivitaiUrlChange, onFetchCivitai,
  } = p;
  const pasteBytes = useMemo(
    () => new TextEncoder().encode(pasteText).length,
    [pasteText],
  );
  const pasteOver = pasteBytes > MAX_UPLOAD_BYTES;
  return (
    <div className="space-y-3">
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SourceTab)}>
        <TabsList className="w-full">
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
          <TabsTrigger value="paste" className="flex-1">
            <Clipboard className="w-3.5 h-3.5" />
            Paste JSON
          </TabsTrigger>
        </TabsList>
        <TabsContent value="upload" className="pt-4">
          <div
            onDragOver={(e) => { e.preventDefault(); onDragStateChange(true); }}
            onDragLeave={() => onDragStateChange(false)}
            onDrop={onDrop}
            className={`rounded-xl border-2 border-dashed transition p-8 text-center ${
              dragActive
                ? 'border-teal-500 bg-teal-50'
                : 'border-slate-300 bg-slate-50'
            }`}
          >
            <UploadCloud className="w-10 h-10 text-slate-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-700">Drag a file here</p>
            <p className="text-xs text-slate-500 mt-1">or click to pick one from your computer</p>
            <p className="text-[11px] text-slate-400 mt-2">Accepts .json or .zip up to 20 MB</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.zip,application/json,application/zip"
              className="hidden"
              onChange={onFileSelect}
            />
            <button
              type="button"
              className="btn-primary mt-4"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5" />}
              {uploading ? 'Uploading…' : 'Choose file'}
            </button>
          </div>
        </TabsContent>

        <TabsContent value="github" className="pt-4">
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-700">
              GitHub URL
            </label>
            <input
              type="url"
              value={githubUrl}
              onChange={(e) => onGithubUrlChange(e.target.value)}
              placeholder="https://github.com/owner/repo/blob/main/workflow.json"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
              disabled={uploading}
              onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) void onFetchGithub(); }}
            />
            <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-500">
              <div className="font-medium text-slate-600 mb-1">Examples</div>
              <ul className="space-y-0.5 font-mono break-all">
                {GITHUB_URL_EXAMPLES.map((ex) => <li key={ex}>{ex}</li>)}
              </ul>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-primary"
                disabled={uploading || !githubUrl.trim()}
                onClick={() => void onFetchGithub()}
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Github className="w-3.5 h-3.5" />}
                {uploading ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="civitai" className="pt-4">
          <div className="space-y-3">
            <label className="block text-xs font-medium text-slate-700">
              CivitAI URL
            </label>
            <input
              type="url"
              value={civitaiUrl}
              onChange={(e) => onCivitaiUrlChange(e.target.value)}
              placeholder="https://civitai.com/models/12345"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
              disabled={uploading}
              onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) void onFetchCivitai(); }}
            />
            <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-[11px] text-slate-500">
              <div className="font-medium text-slate-600 mb-1">Example</div>
              <p className="font-mono break-all">{CIVITAI_URL_EXAMPLE}</p>
              <p className="mt-1 text-slate-500">
                We look for a workflow JSON in the model's files, then fall back to
                workflows embedded in image generation metadata.
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-primary"
                disabled={uploading || !civitaiUrl.trim()}
                onClick={() => void onFetchCivitai()}
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileJson className="w-3.5 h-3.5" />}
                {uploading ? 'Fetching…' : 'Fetch'}
              </button>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="paste" className="pt-4">
          <div className="space-y-3">
            <p className="text-[11px] text-slate-500">
              Paste a ComfyUI workflow JSON exported from the editor
              (Workflow → Export).
            </p>
            <input
              type="text"
              value={pasteTitle}
              onChange={(e) => onPasteTitleChange(e.target.value)}
              placeholder="Optional title"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-teal-500"
              disabled={uploading}
            />
            <textarea
              value={pasteText}
              onChange={(e) => onPasteTextChange(e.target.value)}
              placeholder='{"nodes":[...], "links":[...]}'
              rows={10}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-xs font-mono focus:outline-none focus:border-teal-500"
              disabled={uploading}
            />
            <div className="flex items-center justify-between text-[11px]">
              <span className={pasteOver ? 'text-rose-600 font-medium' : 'text-slate-500'}>
                {humanBytes(pasteBytes)} / Max {humanBytes(MAX_UPLOAD_BYTES)}
              </span>
              <button
                type="button"
                className="btn-primary"
                disabled={uploading || !pasteText.trim() || pasteOver}
                onClick={() => void onParsePaste()}
              >
                {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clipboard className="w-3.5 h-3.5" />}
                {uploading ? 'Parsing…' : 'Parse'}
              </button>
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
        <div className="text-xs text-slate-500">
          Source: <span className="font-medium text-slate-800">{manifest.defaultTitle}</span>
          {manifest.sourceUrl && (
            <>
              {' · '}
              <a
                href={manifest.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-600 hover:text-teal-700"
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
            className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3"
          >
            <Checkbox
              checked={selectedIndices.has(idx)}
              onCheckedChange={() => onToggle(idx)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-slate-900 truncate" title={wf.title}>
                  {wf.title}
                </span>
                <span className={`badge ${
                  wf.mediaType === 'video' ? 'badge-purple' :
                  wf.mediaType === 'audio' ? 'badge-orange' :
                  'badge-blue'
                }`}>
                  {wf.mediaType}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-3 flex-wrap">
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
              <p className="mt-1 text-[11px] text-slate-400 font-mono truncate" title={wf.entryName}>
                {wf.entryName}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {manifest.images.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={copyImages}
              onCheckedChange={(v) => onCopyImagesChange(v === true)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
                <ImageIcon className="w-3.5 h-3.5 text-slate-500" />
                Copy {manifest.images.length} reference image{manifest.images.length === 1 ? '' : 's'}
              </div>
              <p className="mt-0.5 text-[11px] text-slate-500">
                Files will land in ComfyUI/input/ with the template slug as a prefix to avoid collisions.
              </p>
            </div>
          </label>
        </div>
      )}

      {commitBlockers.unresolvedModels.length > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-rose-900 mb-1">
            <AlertCircle className="w-3.5 h-3.5" />
            Cannot import — {commitBlockers.unresolvedModels.length} model
            {commitBlockers.unresolvedModels.length === 1 ? '' : 's'} unresolved.
          </div>
          <p className="text-[11px] text-rose-800 mb-1">
            Resolve these rows first:
          </p>
          <ul className="list-disc ml-4 text-[11px] text-rose-900 font-mono space-y-0.5">
            {commitBlockers.unresolvedModels.map((m) => <li key={`m-${m}`}>{m}</li>)}
          </ul>
        </div>
      )}

      {commitBlockers.unresolvedPlugins.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-900 mb-1">
            <AlertCircle className="w-3.5 h-3.5" />
            {commitBlockers.unresolvedPlugins.length} custom node
            {commitBlockers.unresolvedPlugins.length === 1 ? '' : 's'} couldn't be resolved (warning only — commit proceeds).
          </div>
          <p className="text-[11px] text-amber-800 mb-1">
            ComfyUI-Manager may be unreachable, or the workflow was saved without plugin metadata. You'll still be able to import — missing plugins surface at first run.
          </p>
          <ul className="list-disc ml-4 text-[11px] text-amber-900 font-mono space-y-0.5">
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
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-900 mb-2">
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
                    <div className="text-xs font-medium text-slate-800 truncate" title={p.title}>
                      {p.title}
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono truncate" title={p.repo}>
                      {p.repo}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {pluginSummary.unresolvedClassTypes.length > 0 && (
            <div className="mt-2 text-[11px] text-amber-800">
              <span className="font-medium">Unresolved:</span>{' '}
              {pluginSummary.unresolvedClassTypes.length} class type{pluginSummary.unresolvedClassTypes.length === 1 ? '' : 's'} not
              in Manager's catalog. You can install them manually later via Plugins → Custom URL.
              <details className="mt-1">
                <summary className="cursor-pointer text-amber-700">Show class types</summary>
                <ul className="mt-1 font-mono text-[10px] text-amber-900">
                  {pluginSummary.unresolvedClassTypes.map((c) => <li key={c}>{c}</li>)}
                </ul>
              </details>
            </div>
          )}
          <p className="mt-2 text-[11px] text-amber-800">
            Checked plugins are queued for install after the template is saved.
          </p>
          {installProgress && (
            <p className="mt-1 text-[11px] text-amber-900 inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              {installProgress}
            </p>
          )}
        </div>
      )}

      {manifest.notes.length > 0 && (
        <details className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">
            {manifest.notes.length} note{manifest.notes.length === 1 ? '' : 's'} included
          </summary>
          <div className="mt-2 space-y-2 max-h-40 overflow-y-auto">
            {manifest.notes.map((note, i) => (
              <pre key={i} className="whitespace-pre-wrap text-[11px] text-slate-600">{note}</pre>
            ))}
          </div>
        </details>
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
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-800 mb-2">
        <Package className="w-3.5 h-3.5" />
        Model dependencies ({rows.length})
      </div>
      <p className="mb-2 text-[11px] text-slate-500">
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
    <li className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-slate-800 truncate" title={row.fileName}>
          {row.fileName}
        </span>
        {row.kind.state === 'resolved' && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800"
            title={row.kind.downloadUrl}>
            <CheckCircle2 className="w-3 h-3" />
            resolved via {row.kind.source}
            {row.kind.suggestedFolder ? ` (${row.kind.suggestedFolder})` : ''}
          </span>
        )}
        {row.kind.state === 'auto' && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800"
            title={row.kind.hfRepo || row.kind.downloadUrl}>
            <CheckCircle2 className="w-3 h-3" />
            auto-resolved {viaLabel(row.kind.source)}
            {row.kind.source === 'hfRepo' && row.kind.hfRepo ? ` — ${row.kind.hfRepo}` : ''}
            {row.kind.suggestedFolder ? ` (${row.kind.suggestedFolder})` : ''}
          </span>
        )}
        {row.kind.state === 'unresolved' && (
          <span className="inline-flex items-center gap-1 rounded bg-rose-50 border border-rose-200 px-1.5 py-0.5 text-[10px] font-medium text-rose-800">
            <AlertCircle className="w-3 h-3" />
            Unresolved — paste URL below
          </span>
        )}
      </div>
      {row.kind.state === 'unresolved' && (
        <div className="mt-1.5 flex items-center gap-2">
          <Link2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <input
            type="url"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://huggingface.co/... or https://civitai.com/..."
            disabled={busy}
            className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs focus:outline-none focus:border-teal-500"
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
          />
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !value.trim()}
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Resolve'}
          </button>
        </div>
      )}
      {rowError && (
        <div className="mt-1 text-[11px] text-rose-700">{rowError}</div>
      )}
    </li>
  );
}
