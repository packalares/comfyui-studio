import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Image as ImageIcon, Film, Music, Box, Wrench,
  Loader2, Download, AlertTriangle, CheckCircle2,
  SlidersHorizontal, Braces, Wand2, Sparkles, RotateCcw,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import CompareSlider from '../components/CompareSlider';
import ThreeDViewer from '../components/ThreeDViewer';
import DynamicForm from '../components/DynamicForm';
import AdvancedSettings from '../components/AdvancedSettings';
import ModelDropdown from '../components/ModelDropdown';
import JsonEditor from '../components/JsonEditor';
import DependencyModal from '../components/DependencyModal';
import ExposeWidgetsModal from '../components/ExposeWidgetsModal';
import PageSubbar from '../components/PageSubbar';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { Switch } from '../components/ui/switch';
import { api, ApiError } from '../services/comfyui';
import { isThreeDFilename } from '../lib/media';
import { toast } from 'sonner';
import type { StudioCategory, Template, DependencyCheck, AdvancedSetting, FormInput } from '../types';
import { Settings2 } from 'lucide-react';

const categories: { id: StudioCategory; label: string; icon: React.ElementType }[] = [
  { id: 'image', label: 'IMAGE', icon: ImageIcon },
  { id: 'video', label: 'VIDEO', icon: Film },
  { id: 'audio', label: 'AUDIO', icon: Music },
  { id: '3d', label: '3D', icon: Box },
  { id: 'tools', label: 'TOOLS', icon: Wrench },
];

const categoryTitles: Record<StudioCategory, string> = {
  image: 'Image Generator',
  video: 'Video Generator',
  audio: 'Audio Generator',
  '3d': '3D Generator',
  tools: 'AI-Tools Generator',
};

function getCategoryForTemplate(t: Template): StudioCategory {
  if (t.studioCategory) return t.studioCategory;
  const cat = t.category?.toLowerCase();
  if (cat === 'image') return 'image';
  if (cat === 'video') return 'video';
  if (cat === 'audio') return 'audio';
  if (cat === '3d') return '3d';
  if (cat === 'utility' || cat === 'tools') return 'tools';
  const mt = t.mediaType?.toLowerCase();
  if (mt === 'image') return 'image';
  if (mt === 'video') return 'video';
  if (mt === 'audio') return 'audio';
  if (mt === '3d') return '3d';
  return 'image';
}

export default function Studio() {
  const { templateName } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { templates, currentJob, submitGeneration, connected, refreshTemplates, uploadMaxBytes } = useApp();

  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);

  const initialCategory = (searchParams.get('category') as StudioCategory) || null;

  // Per-category memory of the last template the user was on. Persisted in localStorage
  // so it survives reloads; only honored when the user arrives at Studio without a specific
  // template URL (arriving from Explore with /studio/:templateName wins instead).
  const LAST_TEMPLATE_STORAGE_KEY = 'studio:lastTemplateByCategory';
  const LAST_CATEGORY_STORAGE_KEY = 'studio:lastCategory';
  const [lastTemplateByCategory, setLastTemplateByCategory] = useState<Partial<Record<StudioCategory, string>>>(() => {
    try {
      const raw = localStorage.getItem(LAST_TEMPLATE_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Partial<Record<StudioCategory, string>>) : {};
    } catch {
      return {};
    }
  });

  // Initial category resolution order: `?category=xxx` URL param > localStorage > 'image'.
  // If the URL also has a templateName, a later effect will realign activeCategory to that
  // template's actual category once templates have loaded.
  const resolveInitialCategory = (): StudioCategory => {
    if (initialCategory) return initialCategory;
    try {
      const saved = localStorage.getItem(LAST_CATEGORY_STORAGE_KEY) as StudioCategory | null;
      if (saved && ['image','video','audio','3d','tools'].includes(saved)) return saved;
    } catch { /* localStorage unavailable */ }
    return 'image';
  };
  const [activeCategory, setActiveCategory] = useState<StudioCategory>(resolveInitialCategory);
  const [selectedTemplate, setSelectedTemplate] = useState<string>(templateName || '');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [outputImage, setOutputImage] = useState<string | null>(null);
  // Compare defaults ON so users see the before/after split immediately when
  // the gate (input image + output + completed) is satisfied. Users can flip
  // it off to see just the output.
  const [showCompare, setShowCompare] = useState(true);

  // Dependency check state
  const [depCheck, setDepCheck] = useState<DependencyCheck | null>(null);
  const [depLoading, setDepLoading] = useState(false);
  const [showDepModal, setShowDepModal] = useState(false);

  // Advanced settings state
  const [advancedSettingsDefs, setAdvancedSettingsDefs] = useState<AdvancedSetting[]>([]);
  const [advancedValues, setAdvancedValues] = useState<Record<string, { proxyIndex: number; value: unknown }>>({});

  // "Expose fields" modal state
  const [showExposeModal, setShowExposeModal] = useState(false);
  const [hasEditableWidgets, setHasEditableWidgets] = useState(false);
  // Primitive-derived form fields (from titled Primitive* nodes inside
  // the workflow's subgraphs). Populated when the user selects a modern
  // subgraph template so fields like Width/Height/Length/Frame Rate and
  // the per-workflow Prompt default surface in the main form.
  const [primitiveFormFields, setPrimitiveFormFields] = useState<FormInput[]>([]);

  // Auto-open the expose modal once, when a ?expose=1 URL param lands — used
  // by the "Import as template" flow to drop the user straight into widget
  // review. Fires once per selectedTemplate, after we've confirmed the
  // workflow has editable widgets to review.
  const [autoExposeHandled, setAutoExposeHandled] = useState(false);
  useEffect(() => {
    if (autoExposeHandled) return;
    if (!selectedTemplate) return;
    if (!hasEditableWidgets) return;
    if (searchParams.get('expose') !== '1') return;
    setShowExposeModal(true);
    setAutoExposeHandled(true);
    // Strip the flag from the URL so reloads don't re-open the modal.
    const next = new URLSearchParams(searchParams);
    next.delete('expose');
    navigate(
      { pathname: `/studio/${encodeURIComponent(selectedTemplate)}`, search: next.toString() ? `?${next.toString()}` : '' },
      { replace: true },
    );
  }, [selectedTemplate, hasEditableWidgets, searchParams, autoExposeHandled, navigate]);

  // ComfyUI logs drawer

  // Filter templates by active category
  const categoryTemplates = useMemo(() => {
    return templates.filter(t => getCategoryForTemplate(t) === activeCategory);
  }, [templates, activeCategory]);

  // Current template object
  const template = useMemo(
    () => templates.find(t => t.name === selectedTemplate),
    [templates, selectedTemplate]
  );

  // Merged form inputs: template's base fields (image/audio/video uploads +
  // generic prompt) plus Primitive-derived fields from the workflow's
  // subgraphs. Same id wins from the primitive side so a workflow-provided
  // "Prompt" default overrides the generic placeholder prompt.
  const mergedFormInputs = useMemo(() => {
    const base = template?.formInputs ?? [];
    if (primitiveFormFields.length === 0) return base;
    const byId = new Map<string, FormInput>();
    for (const f of base) byId.set(f.id, f);
    for (const f of primitiveFormFields) byId.set(f.id, f);
    return Array.from(byId.values());
  }, [template?.formInputs, primitiveFormFields]);

  // Fetch advanced settings when template changes. We also probe `/template-widgets`
  // to decide whether the "Edit advanced fields" button should be shown — only if there
  // actually are editable widgets in the template's workflow.
  const refreshAdvancedSettings = useCallback((name: string) => {
    return api.getWorkflowSettings(name).then(result => {
      setAdvancedSettingsDefs(result.settings);
    }).catch(() => {
      setAdvancedSettingsDefs([]);
    });
  }, []);

  useEffect(() => {
    if (!selectedTemplate) {
      setAdvancedSettingsDefs([]);
      setAdvancedValues({});
      setHasEditableWidgets(false);
      setPrimitiveFormFields([]);
      return;
    }
    let cancelled = false;
    setAdvancedValues({});
    // Clear primitive fields at the START of a fetch so entries from the
    // previous template never leak into the current one. The fetch below
    // writes back the fresh set; the reset-on-template-change effect no
    // longer touches this state (used to race with templates[] loading
    // after selectedTemplate was already set).
    setPrimitiveFormFields([]);
    api.getWorkflowSettings(selectedTemplate)
      .then(result => {
        if (!cancelled) setAdvancedSettingsDefs(result.settings);
      })
      .catch(() => {
        if (!cancelled) setAdvancedSettingsDefs([]);
      });
    api.getTemplateWidgets(selectedTemplate)
      .then(result => {
        if (cancelled) return;
        // "Edit advanced fields" only opens for widgets the user could ACTUALLY expose —
        // form-claimed widgets (main Prompt + uploads) are read for defaults, not to
        // expose, so they don't count towards the button's visibility.
        const exposable = result.widgets.filter(w => !w.formClaimed);
        setHasEditableWidgets(exposable.length > 0);
        const primitiveFields = result.primitiveFormFields ?? [];
        setPrimitiveFormFields(primitiveFields);

        // Prompt pre-fill source priority:
        //   1. A titled PrimitiveStringMultiline (modern subgraph workflows
        //      like LTX2 keep the default prompt here).
        //   2. The first positive CLIPTextEncode (classic flat workflows).
        // Only fills when the form's prompt is still empty, so a user's
        // typed text isn't overwritten.
        const primitivePrompt = primitiveFields.find(f => f.id === 'prompt');
        const primitivePromptValue = typeof primitivePrompt?.default === 'string'
          ? primitivePrompt.default : '';
        const positive = result.widgets.find(w =>
          w.nodeType === 'CLIPTextEncode' &&
          w.widgetName === 'text' &&
          !/negative/i.test(w.nodeTitle || '')
        );
        const fallbackPromptValue =
          positive && typeof positive.value === 'string' ? positive.value : '';
        const promptValue = primitivePromptValue || fallbackPromptValue;
        if (promptValue.length > 0) {
          setFormValues(prev => (prev.prompt ? prev : { ...prev, prompt: promptValue }));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHasEditableWidgets(false);
          setPrimitiveFormFields([]);
        }
      });
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  // Run dependency check when template changes
  useEffect(() => {
    if (!selectedTemplate) {
      setDepCheck(null);
      return;
    }
    let cancelled = false;
    setDepLoading(true);
    setDepCheck(null);
    api.checkDependencies(selectedTemplate)
      .then(result => {
        if (!cancelled) {
          setDepCheck(result);
          if (!result.ready && result.missing.length > 0) {
            setShowDepModal(true);
          }
        }
      })
      .catch(() => {
        // If check fails, assume ready (graceful)
        if (!cancelled) {
          setDepCheck({ ready: true, required: [], missing: [] });
        }
      })
      .finally(() => {
        if (!cancelled) setDepLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  // When navigating with templateName param, set the category and template
  useEffect(() => {
    if (templateName) {
      const t = templates.find(tm => tm.name === templateName);
      if (t) {
        setActiveCategory(getCategoryForTemplate(t));
        setSelectedTemplate(templateName);
      }
    }
  }, [templateName, templates]);

  // Reset form values when the SELECTED TEMPLATE changes. We key on
  // `selectedTemplate` not `template?.name` because `template` is derived
  // from the `templates[]` array — on a fresh page load `selectedTemplate`
  // can be set (from URL) BEFORE templates have streamed in, which would
  // fire this effect a second time once templates load and clobber the
  // primitive-field defaults that the /template-widgets fetch already
  // merged in.
  useEffect(() => {
    if (template?.formInputs) {
      const defaults: Record<string, unknown> = {};
      for (const input of template.formInputs) {
        if (input.default !== undefined) {
          defaults[input.id] = input.default;
        }
      }
      setFormValues(defaults);
    } else {
      setFormValues({});
    }
  }, [selectedTemplate]);

  // Merge primitive defaults into formValues when they arrive. Only fills
  // ids that are currently unset — never clobbers user edits or values
  // already populated from the template's static formInputs.
  useEffect(() => {
    if (primitiveFormFields.length === 0) return;
    setFormValues(prev => {
      const next = { ...prev };
      let changed = false;
      for (const f of primitiveFormFields) {
        if (f.default !== undefined && next[f.id] === undefined) {
          next[f.id] = f.default;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [primitiveFormFields]);

  // When category changes, prefer the user's last template for that category; fall back to
  // the first template in the list. Skipped when the current template already belongs to the
  // active category (e.g. user just landed from Explore with a specific templateName URL).
  useEffect(() => {
    if (template && getCategoryForTemplate(template) === activeCategory) return;
    if (categoryTemplates.length === 0) return;
    const remembered = lastTemplateByCategory[activeCategory];
    const rememberedTemplate = remembered && categoryTemplates.find(t => t.name === remembered);
    const target = rememberedTemplate ? rememberedTemplate.name : categoryTemplates[0].name;
    if (target !== selectedTemplate) {
      setSelectedTemplate(target);
      navigate(`/studio/${target}`, { replace: true });
    }
  }, [activeCategory, categoryTemplates]);

  // Whenever a template is selected, remember it as the last-used one for its category.
  // Also remember the category itself so a bare `/studio` URL can restore the last tab.
  useEffect(() => {
    if (!template) return;
    const cat = getCategoryForTemplate(template);
    if (lastTemplateByCategory[cat] !== template.name) {
      const next = { ...lastTemplateByCategory, [cat]: template.name };
      setLastTemplateByCategory(next);
      try { localStorage.setItem(LAST_TEMPLATE_STORAGE_KEY, JSON.stringify(next)); } catch { /* quota / private mode */ }
    }
    try { localStorage.setItem(LAST_CATEGORY_STORAGE_KEY, cat); } catch { /* ignore */ }
  }, [template?.name]);

  // If the URL landed us on a template that belongs to a different category than the one we
  // restored from localStorage, realign activeCategory so the tabs show the correct one.
  // Runs once templates are loaded and the selected template is resolvable.
  useEffect(() => {
    if (!template) return;
    const cat = getCategoryForTemplate(template);
    if (cat !== activeCategory) setActiveCategory(cat);
  }, [template?.name]);

  // Persist category on user-initiated changes too (tab clicks before any template resolves).
  useEffect(() => {
    try { localStorage.setItem(LAST_CATEGORY_STORAGE_KEY, activeCategory); } catch { /* ignore */ }
  }, [activeCategory]);

  const handleSelectTemplate = useCallback((name: string) => {
    setSelectedTemplate(name);
    navigate(`/studio/${name}`, { replace: true });
  }, [navigate]);

  const handleCategoryChange = useCallback((cat: StudioCategory) => {
    setActiveCategory(cat);
  }, []);

  const handleReset = useCallback(() => {
    if (mergedFormInputs.length > 0) {
      const defaults: Record<string, unknown> = {};
      for (const input of mergedFormInputs) {
        if (input.default !== undefined) {
          defaults[input.id] = input.default;
        }
      }
      setFormValues(defaults);
    } else {
      setFormValues({});
    }
    setAdvancedValues({});
  }, [mergedFormInputs]);

  const handleGenerate = async () => {
    if (!selectedTemplate) return;

    const inputs: Record<string, unknown> = {};
    const maxMb = Math.round(uploadMaxBytes / (1024 * 1024));

    for (const [key, val] of Object.entries(formValues)) {
      if (val && typeof val === 'object' && 'file' in (val as Record<string, unknown>)) {
        const fileVal = val as { file: File };
        // Client-side pre-check — catches oversize files before the round-trip.
        if (fileVal.file.size > uploadMaxBytes) {
          const fileMb = (fileVal.file.size / (1024 * 1024)).toFixed(1);
          toast.error('File too large', {
            description: `"${fileVal.file.name}" is ${fileMb} MB. Max upload size is ${maxMb} MB.`,
          });
          return;
        }
        try {
          const result = await api.uploadImage(fileVal.file);
          inputs[key] = result.name;
        } catch (err) {
          // Structured server errors (413 with maxBytes, or 400 with detail)
          // come back as ApiError. Fall back to generic message otherwise.
          if (err instanceof ApiError && err.status === 413) {
            const data = err.data as { maxBytes?: number } | null;
            const serverMax = data?.maxBytes ?? uploadMaxBytes;
            const serverMaxMb = Math.round(serverMax / (1024 * 1024));
            const fileMb = (fileVal.file.size / (1024 * 1024)).toFixed(1);
            toast.error('File too large', {
              description: `"${fileVal.file.name}" is ${fileMb} MB. Server cap is ${serverMaxMb} MB.`,
            });
          } else {
            const msg = err instanceof Error ? err.message : 'Upload failed';
            toast.error('Upload failed', { description: msg });
          }
          return;
        }
      } else {
        inputs[key] = val;
      }
    }

    const advSettings = Object.keys(advancedValues).length > 0 ? advancedValues : undefined;
    await submitGeneration(selectedTemplate, inputs, advSettings);
  };

  const handleJsonChange = useCallback((values: Record<string, unknown>) => {
    setFormValues(values);
  }, []);

  const isRunning = currentJob?.status === 'running' || currentJob?.status === 'pending';
  const hasMissingDeps = depCheck !== null && !depCheck.ready;
  const generateDisabled = !selectedTemplate || isRunning || !connected || hasMissingDeps;

  useEffect(() => {
    if (currentJob?.status === 'completed' && currentJob.outputUrl) {
      setOutputImage(currentJob.outputUrl);
    }
  }, [currentJob?.status, currentJob?.outputUrl]);

  const inputImagePreview = useMemo(() => {
    for (const fi of mergedFormInputs) {
      if (fi.type === 'image') {
        const val = formValues[fi.id] as { preview?: string } | null;
        if (val?.preview) return val.preview;
      }
    }
    return null;
  }, [mergedFormInputs, formValues]);

  // The template's mediaType describes its THUMBNAIL (almost always "image" even for video/audio templates).
  // The job's outputMediaType is derived from the generated filename's extension and is the real
  // source of truth — fall back to the template only if the job hasn't told us yet.
  const outputMediaType = currentJob?.outputMediaType || template?.mediaType || 'image';
  // 3D outputs (.glb/.gltf/...) are classified server-side as mediaType=image
  // but render via <model-viewer>, not <img>. Compare is meaningless (no
  // before/after frame to diff) so hide the toggle when the output is 3D.
  const isOutput3D = isThreeDFilename(outputImage);
  // Compare only makes sense when BOTH sides are images. i2v / i2a templates
  // produce video/audio outputs — feeding those into CompareSlider renders
  // a <img src="*.mp4"> which shows as a broken image. Guard here so the
  // toggle is hidden AND the render branch falls through to the correct
  // per-mediaType element below.
  const canCompare =
    !!inputImagePreview && !!outputImage && currentJob?.status === 'completed'
    && !isOutput3D && outputMediaType === 'image';

  return (
    <>
      {/* Expose-widgets modal — opens when the user clicks "Edit advanced fields". */}
      {showExposeModal && selectedTemplate && (
        <ExposeWidgetsModal
          templateName={selectedTemplate}
          onClose={() => setShowExposeModal(false)}
          onSaved={() => {
            // Re-pull advanced settings so the panel reflects the new selection right away.
            if (selectedTemplate) refreshAdvancedSettings(selectedTemplate);
          }}
        />
      )}
      {/* Dependency Modal */}
      {showDepModal && depCheck && depCheck.missing.length > 0 && (
        <DependencyModal
          missing={depCheck.missing}
          onClose={() => setShowDepModal(false)}
          onDownloadComplete={() => {
            setShowDepModal(false);
            // Re-check dependencies
            if (selectedTemplate) {
              api.checkDependencies(selectedTemplate).then(setDepCheck).catch(() => {});
            }
          }}
        />
      )}

      <PageSubbar
        title="Studio"
        description={template?.title}
        right={
          <div
            role="tablist"
            aria-label="Category"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm"
          >
            {categories.map(cat => {
              const Icon = cat.icon;
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => handleCategoryChange(cat.id)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {cat.label}
                </button>
              );
            })}
          </div>
        }
      />

      <div className="page-container">
        <div className="panel">
          <div className="flex flex-col lg:flex-row lg:h-[calc(100vh-180px)]">
            {/* Left aside: form */}
            <aside className="w-full lg:w-[420px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white flex flex-col">
            <div className="panel-header flex items-center justify-between">
              <div className="min-w-0">
                <h2 className="panel-header-title">{categoryTitles[activeCategory]}</h2>
                {template?.title && (
                  <p className="panel-header-desc truncate">{template.title}</p>
                )}
              </div>
              <div
                role="tablist"
                aria-label="Input mode"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm shrink-0"
              >
                <button
                  role="tab"
                  aria-selected={mode === 'form'}
                  onClick={() => setMode('form')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    mode === 'form' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Form
                </button>
                <button
                  role="tab"
                  aria-selected={mode === 'json'}
                  onClick={() => setMode('json')}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    mode === 'json' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Braces className="w-3.5 h-3.5" />
                  JSON
                </button>
              </div>
            </div>

            <div className="panel-body flex-1 overflow-y-auto scrollbar-subtle space-y-5">
              {/* Not connected banner */}
              {!connected && (
                <div className="flex items-start gap-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-amber-800">ComfyUI is not connected</p>
                    <button
                      onClick={() => navigate('/settings')}
                      className="text-[11px] text-amber-700 underline mt-0.5"
                    >
                      Configure in Settings
                    </button>
                  </div>
                </div>
              )}

              {/* MODEL section */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Model</p>
                  {depLoading && (
                    <Loader2 className="w-3 h-3 text-slate-400 animate-spin" />
                  )}
                  {!depLoading && depCheck?.ready && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  )}
                  {!depLoading && hasMissingDeps && (
                    <button
                      onClick={() => setShowDepModal(true)}
                      className="flex items-center gap-1 text-[10px] text-amber-600 hover:text-amber-700"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      {depCheck?.missing.length} missing
                    </button>
                  )}
                </div>
                <ModelDropdown
                  templates={categoryTemplates}
                  selected={selectedTemplate}
                  onSelect={handleSelectTemplate}
                />
              </div>

              {/* PARAMETERS section */}
              <div>
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-3">Parameters</p>

                {mode === 'form' ? (
                  mergedFormInputs.length > 0 ? (
                    <>
                      <DynamicForm
                        inputs={mergedFormInputs}
                        values={formValues}
                        onChange={setFormValues}
                      />
                      {advancedSettingsDefs.length > 0 && (
                        <div className="mt-4">
                          <AdvancedSettings
                            settings={advancedSettingsDefs}
                            values={advancedValues}
                            onChange={setAdvancedValues}
                          />
                        </div>
                      )}
                      {hasEditableWidgets && (
                        <button
                          type="button"
                          onClick={() => setShowExposeModal(true)}
                          className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-700 transition-colors"
                        >
                          <Settings2 className="w-3.5 h-3.5" />
                          Edit advanced fields
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-slate-400">Select a model to see parameters.</p>
                  )
                ) : (
                  <JsonEditor
                    values={formValues}
                    onChange={handleJsonChange}
                  />
                )}
              </div>
            </div>

            {/* Footer: progress + Reset/Generate */}
            <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 flex flex-col items-stretch gap-3">
              {isRunning && currentJob && (
                <div>
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>{currentJob.status === 'pending' ? 'Queued…' : 'Generating…'}</span>
                    <span>{Math.round(currentJob.progress)}%</span>
                  </div>
                  <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${Math.min(100, Math.max(0, currentJob.progress))}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReset}
                  className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
                <div className="flex-1 relative group">
                  <button
                    onClick={handleGenerate}
                    disabled={generateDisabled}
                    className="relative w-full overflow-hidden inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-teal-500 to-emerald-500 text-white py-2 text-sm font-semibold shadow-sm hover:shadow-md hover:from-teal-600 hover:to-emerald-600 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:ring-offset-1 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-400 disabled:shadow-none"
                  >
                    {/* Shimmer sweep. Disabled when running or unusable so
                        the button doesn't flash during actual generation. */}
                    {!isRunning && !generateDisabled && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"
                      />
                    )}
                    {isRunning ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin relative" />
                        <span className="relative">Generating…</span>
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-4 h-4 relative" />
                        <span className="relative">Generate</span>
                        <Sparkles className="w-3 h-3 relative opacity-80" />
                      </>
                    )}
                  </button>
                  {hasMissingDeps && !isRunning && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                      Missing required models
                    </div>
                  )}
                </div>
              </div>
            </div>
            </aside>

            {/* Right main: result */}
            <main className="flex-1 flex flex-col min-w-0">
            <div className="border-b border-slate-200 bg-white px-4 py-3 flex items-center justify-between gap-3">
              <h3 className="panel-header-title">Result</h3>
              <div className="flex items-center gap-3">
                {canCompare && (
                  <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Compare
                    <Switch
                      checked={showCompare}
                      onCheckedChange={setShowCompare}
                      aria-label="Toggle before/after comparison"
                    />
                  </label>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <a
                      href={outputImage || undefined}
                      download={outputImage ? undefined : undefined}
                      aria-disabled={!outputImage}
                      onClick={(e) => { if (!outputImage) e.preventDefault(); }}
                      className={`btn-icon ${!outputImage ? 'pointer-events-none opacity-40' : ''}`}
                      aria-label="Download output"
                    >
                      <Download className="w-4 h-4" />
                    </a>
                  </TooltipTrigger>
                  <TooltipContent>
                    {outputImage ? 'Download output' : 'No output to download yet'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="flex-1 p-6 flex items-center justify-center relative overflow-hidden bg-slate-50">
              {currentJob?.status === 'completed' && outputImage ? (
                <div className="relative w-full h-full max-w-3xl max-h-[calc(100vh-14rem)] flex items-center justify-center">
                  {isOutput3D ? (
                    <div className="w-full h-full min-h-[400px] rounded-lg overflow-hidden">
                      <ThreeDViewer src={outputImage} alt="Generated 3D model" />
                    </div>
                  ) : canCompare && showCompare ? (
                    <CompareSlider
                      beforeSrc={inputImagePreview}
                      afterSrc={outputImage}
                      beforeLabel="Input"
                      afterLabel="Output"
                    />
                  ) : outputMediaType === 'video' ? (
                    <video
                      src={outputImage}
                      controls
                      className="max-w-full max-h-full rounded-lg"
                    />
                  ) : outputMediaType === 'audio' ? (
                    <div className="w-full max-w-md">
                      <div className="bg-white rounded-xl p-6 shadow-sm border border-slate-200">
                        <div className="flex items-center justify-center mb-4">
                          <div className="w-16 h-16 rounded-full bg-emerald-50 flex items-center justify-center">
                            <Music className="w-8 h-8 text-emerald-600" />
                          </div>
                        </div>
                        <audio src={outputImage} controls className="w-full" />
                      </div>
                    </div>
                  ) : (
                    <img
                      src={outputImage}
                      alt="Generated output"
                      className="max-w-full max-h-full object-contain rounded-lg"
                    />
                  )}

                  {currentJob.seed !== undefined && (
                    <p className="absolute bottom-3 left-3 text-xs text-slate-500 bg-white/80 px-2 py-1 rounded">
                      Seed: {currentJob.seed}
                    </p>
                  )}
                </div>
              ) : currentJob?.status === 'failed' ? (
                <div className="text-center">
                  <div className="w-14 h-14 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-3">
                    <AlertTriangle className="w-7 h-7 text-red-400" />
                  </div>
                  <p className="text-sm font-medium text-red-600">Generation failed</p>
                  <p className="text-xs text-slate-500 mt-1">Check the console for details</p>
                </div>
              ) : isRunning ? (
                <div className="text-center">
                  <Loader2 className="w-10 h-10 text-teal-500 animate-spin mx-auto mb-3" />
                  <p className="text-sm text-slate-500">Generating…</p>
                </div>
              ) : (
                <div className="text-center max-w-sm">
                  {/* Animated hero icon with soft gradient halo — more
                      inviting than a flat grey square. The gradient picks
                      up the category's media-type color so users feel
                      they've landed in the right context. */}
                  <div className="relative mx-auto mb-5 w-28 h-28">
                    <div
                      className={`absolute inset-0 rounded-3xl blur-2xl opacity-60 animate-pulse bg-gradient-to-br ${
                        activeCategory === 'video' ? 'from-purple-300 to-fuchsia-300' :
                        activeCategory === 'audio' ? 'from-orange-300 to-amber-300' :
                        activeCategory === '3d' ? 'from-emerald-300 to-teal-300' :
                        activeCategory === 'tools' ? 'from-slate-300 to-slate-400' :
                        'from-sky-300 to-indigo-300'
                      }`}
                      aria-hidden="true"
                    />
                    <div className="relative w-28 h-28 rounded-3xl bg-white ring-1 ring-slate-200 shadow-sm flex items-center justify-center">
                      {activeCategory === 'video' ? (
                        <Film className="w-11 h-11 text-purple-400" />
                      ) : activeCategory === 'audio' ? (
                        <Music className="w-11 h-11 text-orange-400" />
                      ) : activeCategory === '3d' ? (
                        <Box className="w-11 h-11 text-emerald-400" />
                      ) : activeCategory === 'tools' ? (
                        <Wrench className="w-11 h-11 text-slate-400" />
                      ) : (
                        <ImageIcon className="w-11 h-11 text-sky-400" />
                      )}
                    </div>
                  </div>
                  <h4 className="text-sm font-semibold text-slate-700 mb-1">
                    Ready when you are
                  </h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Pick a model on the left, fill the prompt, and hit{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-teal-600">
                      <Wand2 className="w-3 h-3" />Generate
                    </span>
                    . Output shows up here.
                  </p>
                </div>
              )}
            </div>
            </main>
          </div>
        </div>
      </div>
    </>
  );
}
