import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  ArrowLeft, CheckCircle2, Download, ExternalLink, HardDriveDownload, HelpCircle, RotateCcw, Trash2, XCircle,
} from 'lucide-react';
import { api } from '../../services/comfyui';
import { packEvents, usePackTaskEvents } from '../../services/packEvents';
import type { Pack, PackModelSettings, PackSettingDef, PackSettings, PackTaskProgress } from '../../types';
import { formatBytes } from '../../lib/utils';
import { Card, CardContent, CardHeader } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge, type BadgeVariant } from '../../components/ui/badge';
import { Checkbox } from '../../components/ui/checkbox';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Spinner } from '../../components/ui/spinner';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../../components/ui/table';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/forms/SelectField';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import PageSubbar from '../../components/layout/PageSubbar';

/** Sentinel for "no explicit choice" in the Ollama-model pickers below —
 *  Radix `Select.Item` rejects an empty-string `value`, so an unset setting
 *  (deleted via `PATCH .../settings` with `null`) is represented by this
 *  string in the picker only, never persisted. */
const UNSET = '__unset__';

const STATE_BADGE: Record<PackModelSettings['state'], { label: string; variant: BadgeVariant }> = {
  absent: { label: 'Not downloaded', variant: 'neutral' },
  downloading: { label: 'Downloading', variant: 'brand' },
  downloaded: { label: 'Downloaded', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
};

const KIND_LABEL: Record<PackModelSettings['kind'], string> = {
  checkpoint: 'Checkpoint',
  whisper: 'Whisper',
  tts: 'TTS',
  llm: 'LLM',
  lm: '5Hz LM',
};

/**
 * /packs/:id/settings — per-pack model selection + repo overrides. Unlike
 * `Packs.tsx` (whole-pack install/uninstall), this page lets the operator
 * choose WHICH of a pack's models actually download, and correct a wrong HF
 * repo id without a code change — the two production pain points this page
 * exists to fix (see the task's WHY section: three wrong repo ids each cost
 * a code-change -> sync -> retry cycle; a full install always pulled every
 * model unconditionally, ~19 GB apiece for two that are rarely needed).
 */
export default function PackSettings() {
  const { id } = useParams<{ id: string }>();
  const [pack, setPack] = useState<Pack | null>(null);
  const [settings, setSettings] = useState<PackSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** `modelId -> taskId` for downloads THIS page kicked off — mirrors
   *  `Packs.tsx`'s `tasksByPack` map. */
  const [tasksByModel, setTasksByModel] = useState<Record<string, string>>({});
  /** Installed Ollama model names — fetched once for any `'ollama-model'`
   *  settingDef picker on this pack (e.g. ace-step's lyrics/suggestion
   *  models). `null` while loading, `[]` if Ollama is unreachable/empty. */
  const [ollamaModels, setOllamaModels] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [{ items }, s] = await Promise.all([api.getPacks(), api.getPackSettings(id)]);
      setPack(items.find((p) => p.id === id) ?? null);
      setSettings(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pack settings');
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  // Only fetched once `settings` reveals an `'ollama-model'` settingDef —
  // avoids the round-trip for packs (or pages) that never need it.
  useEffect(() => {
    if (!settings?.settingDefs.some((d) => d.kind === 'ollama-model')) return;
    if (ollamaModels !== null) return;
    api.chat.listInstalledModels()
      .then(({ models }) => setOllamaModels((models ?? []).map((m) => m.name)))
      .catch(() => setOllamaModels([]));
  }, [settings, ollamaModels]);

  const handleUpdateSetting = useCallback(async (key: string, value: string | null) => {
    if (!id) return;
    try {
      const s = await api.updatePackSettings(id, { settings: { [key]: value } });
      setSettings(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to update ${key}`);
    }
  }, [id]);

  // Any 'pack:progress' push for THIS pack (a model download this page
  // started, one started elsewhere, or a full pack install downloading a
  // model that's on this page's table) refetches on completion so the
  // table's state/size/selected columns stay correct without ever polling.
  useEffect(() => {
    if (!id) return;
    return packEvents.onProgress((progress: PackTaskProgress) => {
      if (progress.packId === id && progress.completed) void load();
    });
  }, [id, load]);

  const handleToggleSelected = useCallback(async (modelId: string, selected: boolean) => {
    if (!id) return;
    try {
      const s = await api.updatePackSettings(id, { models: { [modelId]: { selected } } });
      setSettings(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update selection');
    }
  }, [id]);

  const handleSaveRepoOverride = useCallback(async (modelId: string, repoOverride: string | null) => {
    if (!id) return;
    try {
      const s = await api.updatePackSettings(id, { models: { [modelId]: { repoOverride } } });
      setSettings(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update repo override');
    }
  }, [id]);

  const handleDownload = useCallback(async (modelId: string) => {
    if (!id) return;
    try {
      const { taskId } = await api.downloadPackModel(id, modelId);
      setTasksByModel((prev) => ({ ...prev, [modelId]: taskId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start download');
    }
  }, [id]);

  const handleRemove = useCallback(async (modelId: string) => {
    if (!id) return;
    try {
      await api.removePackModel(id, modelId);
      void load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove model');
    }
  }, [id, load]);

  const onTaskComplete = useCallback((modelId: string) => {
    setTasksByModel((prev) => {
      const { [modelId]: _removed, ...rest } = prev;
      return rest;
    });
    void load();
  }, [load]);

  // Settings not covered by a declared `settingDef` still round-trip (the
  // server's `settings` map is unfiltered) — shown as a plain fallback row
  // below the documented pickers so nothing silently disappears.
  const knownKeys = new Set((settings?.settingDefs ?? []).map((d) => d.key));
  const rawSettingsEntries = settings
    ? Object.entries(settings.settings).filter(([key]) => !knownKeys.has(key))
    : [];

  return (
    <>
      <PageSubbar
        title={pack?.label ?? id ?? 'Pack settings'}
        description={settings === null ? 'Loading…' : `${settings.models.length} model${settings.models.length === 1 ? '' : 's'}`}
        right={(
          <Button variant="outline" size="sm" asChild>
            <Link to="/packs">
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to packs
            </Link>
          </Button>
        )}
      />
      <div className="p-4 space-y-4">
        {pack?.description && (
          <p className="text-sm text-muted-foreground">{pack.description}</p>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <Card>
          <CardHeader className="gap-1">
            <h2 className="text-sm font-medium">Models</h2>
            <p className="text-xs text-muted-foreground">
              Only selected models download as part of a full pack install. Deselect a model to
              skip it; download or remove any model individually here regardless of selection.
            </p>
          </CardHeader>
          {settings === null ? (
            <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
          ) : settings.models.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">
              This pack has no selectable models.
            </CardContent>
          ) : (
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8"></TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Repo</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settings.models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      activeTaskId={tasksByModel[m.id]}
                      onToggleSelected={handleToggleSelected}
                      onSaveRepoOverride={handleSaveRepoOverride}
                      onDownload={handleDownload}
                      onRemove={handleRemove}
                      onTaskComplete={onTaskComplete}
                    />
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader className="gap-1">
            <h2 className="text-sm font-medium">Pack settings</h2>
            <p className="text-xs text-muted-foreground">
              Other per-install overrides for this pack, beyond model selection.
            </p>
          </CardHeader>
          {settings === null ? (
            <CardContent className="text-sm text-muted-foreground">Loading…</CardContent>
          ) : settings.settingDefs.length === 0 && rawSettingsEntries.length === 0 ? (
            <CardContent className="text-sm text-muted-foreground">
              No additional settings for this pack yet.
            </CardContent>
          ) : (
            <CardContent className="space-y-4">
              {settings.settingDefs.map((def) => (
                <SettingDefRow
                  key={def.key}
                  def={def}
                  value={settings.settings[def.key] ?? null}
                  ollamaModels={ollamaModels}
                  onChange={handleUpdateSetting}
                />
              ))}
              {rawSettingsEntries.length > 0 && (
                <div className="space-y-2 border-t border-border pt-3">
                  {rawSettingsEntries.map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-mono text-muted-foreground">{key}</span>
                      <span className="font-mono">{value}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>
    </>
  );
}

/** One documented `pack_settings` row — currently only `kind: 'ollama-model'`
 *  pickers exist (ace-step's `llm.suggestionModel` / `llm.lyricsModel`), but
 *  `'text'` is supported too so a future free-text setting doesn't need a
 *  new component. */
function SettingDefRow({
  def,
  value,
  ollamaModels,
  onChange,
}: {
  def: PackSettingDef;
  value: string | null;
  ollamaModels: string[] | null;
  onChange: (key: string, value: string | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-medium">{def.label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="cursor-help text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`${def.label} info`}
            >
              <HelpCircle className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">{def.tooltip}</TooltipContent>
        </Tooltip>
      </div>
      <p className="text-xs text-muted-foreground">{def.description}</p>

      {def.kind === 'ollama-model' ? (
        <div className="flex items-center gap-2">
          <SelectField
            value={value ?? UNSET}
            onValueChange={(v) => onChange(def.key, v === UNSET ? null : v)}
          >
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder={def.placeholder ?? 'Follow Ollama default'} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{def.placeholder ?? 'Follow Ollama default'}</SelectItem>
              {(ollamaModels ?? []).map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </SelectField>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/models?source=ollama">
              <ExternalLink className="w-3.5 h-3.5" />
              Manage Ollama models
            </Link>
          </Button>
        </div>
      ) : def.kind === 'textarea' ? (
        <div className="space-y-1.5">
          {/* Unset means "use the shipped default", so the box starts pre-filled
              with that default rather than empty — otherwise a user editing a
              prompt would have to retype the whole thing to make one change.
              Saving text identical to the default clears the override instead
              of storing a duplicate copy, so future default improvements still
              reach anyone who never customised it. */}
          <Textarea
            value={value ?? def.defaultValue ?? ''}
            placeholder={def.placeholder}
            onChange={(e) => {
              const next = e.target.value;
              const isDefault = def.defaultValue !== undefined && next.trim() === def.defaultValue.trim();
              onChange(def.key, next.trim() && !isDefault ? next : null);
            }}
            className="min-h-[220px] font-mono text-[11px] leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              {value ? 'Customised' : 'Using the built-in default'}
            </span>
            {value && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                onClick={() => onChange(def.key, null)}
              >
                <RotateCcw className="w-3 h-3" />
                Reset to default
              </Button>
            )}
          </div>
        </div>
      ) : (
        <Input
          value={value ?? ''}
          placeholder={def.placeholder}
          onChange={(e) => onChange(def.key, e.target.value.trim() ? e.target.value : null)}
          className="max-w-sm text-xs"
        />
      )}

      {ollamaModels !== null && ollamaModels.length === 0 && def.kind === 'ollama-model' && (
        <p className="text-[10px] text-muted-foreground">
          No Ollama models installed yet — pull one from the Ollama models page above.
        </p>
      )}
    </div>
  );
}

function ModelRow({
  model,
  activeTaskId,
  onToggleSelected,
  onSaveRepoOverride,
  onDownload,
  onRemove,
  onTaskComplete,
}: {
  model: PackModelSettings;
  activeTaskId?: string;
  onToggleSelected: (modelId: string, selected: boolean) => void;
  onSaveRepoOverride: (modelId: string, repoOverride: string | null) => void;
  onDownload: (modelId: string) => void;
  onRemove: (modelId: string) => void;
  onTaskComplete: (modelId: string) => void;
}) {
  const [repoDraft, setRepoDraft] = useState(model.effectiveRepo);
  useEffect(() => { setRepoDraft(model.effectiveRepo); }, [model.effectiveRepo]);

  const busy = !!activeTaskId || model.state === 'downloading';
  const stateBadge = STATE_BADGE[model.state];
  const hasOverride = model.repoOverride != null;
  const repoDirty = repoDraft.trim() !== model.effectiveRepo;

  const commitRepo = () => {
    const next = repoDraft.trim();
    if (!next || next === model.effectiveRepo) { setRepoDraft(model.effectiveRepo); return; }
    // Overriding to exactly the registry default is the same as clearing
    // the override — store `null` so `GET .../settings` still reports
    // `repoOverride: null` (no deviation) instead of a redundant one.
    onSaveRepoOverride(model.id, next === model.defaultRepo ? null : next);
  };

  return (
    <TableRow>
      <TableCell>
        <Checkbox
          checked={model.selected}
          disabled={busy}
          onCheckedChange={(v) => onToggleSelected(model.id, v === true)}
        />
      </TableCell>
      <TableCell>
        <div className="font-medium text-sm">{model.label}</div>
        <div className="text-xs text-muted-foreground">{model.description}</div>
        {!model.selected && (
          <div className="text-[10px] text-muted-foreground mt-0.5">
            Not selected{model.defaultSelected ? ' (deselected from default)' : ''}
          </div>
        )}
      </TableCell>
      <TableCell>
        <Badge variant="secondary">{KIND_LABEL[model.kind]}</Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {model.sizeBytes != null ? formatBytes(model.sizeBytes) : `~${model.sizeGb} GB`}
      </TableCell>
      <TableCell>
        <Badge variant={stateBadge.variant}>{stateBadge.label}</Badge>
        {activeTaskId && (
          <div className="mt-1 w-40">
            <ModelDownloadProgress taskId={activeTaskId} onComplete={() => onTaskComplete(model.id)} />
          </div>
        )}
      </TableCell>
      <TableCell className="min-w-[220px]">
        <div className="flex items-center gap-1.5">
          <Input
            value={repoDraft}
            onChange={(e) => setRepoDraft(e.target.value)}
            onBlur={commitRepo}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            disabled={busy}
            className="text-xs font-mono"
          />
          {hasOverride && (
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              title={`Reset to default (${model.defaultRepo})`}
              onClick={() => { onSaveRepoOverride(model.id, null); setRepoDraft(model.defaultRepo); }}
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
          default: {model.defaultRepo}{repoDirty && !hasOverride ? ' (unsaved)' : ''}
        </div>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1.5">
          {model.state === 'downloaded' || model.state === 'failed' ? (
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => onRemove(model.id)}>
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </Button>
          ) : null}
          {model.state !== 'downloaded' && (
            <Button size="sm" disabled={busy} onClick={() => onDownload(model.id)}>
              {busy ? <Spinner size="sm" /> : <Download className="w-3.5 h-3.5" />}
              {model.state === 'failed' ? 'Retry' : 'Download'}
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** Compact per-row progress bar for a model download — same WS-first,
 *  REST-fallback pattern as `Packs.tsx`'s `PackTaskProgressView`, just
 *  smaller (no log line, this is a table cell not a card). */
function ModelDownloadProgress({ taskId, onComplete }: { taskId: string; onComplete: () => void }) {
  const [progress, setProgress] = useState<PackTaskProgress | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const applyUpdate = useRef((data: PackTaskProgress) => {
    setProgress(data);
    if (data.completed && !completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current();
    }
  });

  usePackTaskEvents(taskId, (data) => applyUpdate.current(data));

  useEffect(() => {
    let cancelled = false;
    api.getPackProgress(taskId).then((data) => { if (!cancelled) applyUpdate.current(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [taskId]);

  const pct = Math.max(0, Math.min(100, progress?.progress ?? 0));
  const done = progress?.completed ?? false;
  const success = done && pct >= 100;

  return (
    <div className="flex items-center gap-1.5">
      {done ? (
        success ? <CheckCircle2 className="w-3 h-3 text-success shrink-0" /> : <XCircle className="w-3 h-3 text-destructive shrink-0" />
      ) : (
        <HardDriveDownload className="w-3 h-3 text-brand shrink-0" />
      )}
      <div className="h-1 flex-1 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${done && !success ? 'bg-destructive' : 'bg-brand'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground font-mono w-7 text-right">{Math.round(pct)}%</span>
    </div>
  );
}
