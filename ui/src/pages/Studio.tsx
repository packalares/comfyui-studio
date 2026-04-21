import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Image as ImageIcon, Film, Music, Box, Wrench,
  Loader2, Download, AlertTriangle, CheckCircle2,
  ScrollText, SlidersHorizontal, Braces,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import CompareSlider from '../components/CompareSlider';
import DynamicForm from '../components/DynamicForm';
import AdvancedSettings from '../components/AdvancedSettings';
import ModelDropdown from '../components/ModelDropdown';
import JsonEditor from '../components/JsonEditor';
import DependencyModal from '../components/DependencyModal';
import ExposeWidgetsModal from '../components/ExposeWidgetsModal';
import LogsDrawer from '../components/LogsDrawer';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { api } from '../services/comfyui';
import type { StudioCategory, Template, DependencyCheck, AdvancedSetting } from '../types';
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
  const { templates, currentJob, submitGeneration, connected, refreshTemplates } = useApp();

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
      if (saved && ['image','video','audio','3d','tools','api'].includes(saved)) return saved;
    } catch { /* localStorage unavailable */ }
    return 'image';
  };
  const [activeCategory, setActiveCategory] = useState<StudioCategory>(resolveInitialCategory);
  const [selectedTemplate, setSelectedTemplate] = useState<string>(templateName || '');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [outputImage, setOutputImage] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);

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
  const [showLogs, setShowLogs] = useState(false);

  // Filter templates by active category
  const categoryTemplates = useMemo(() => {
    return templates.filter(t => getCategoryForTemplate(t) === activeCategory);
  }, [templates, activeCategory]);

  // Current template object
  const template = useMemo(
    () => templates.find(t => t.name === selectedTemplate),
    [templates, selectedTemplate]
  );

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
      return;
    }
    let cancelled = false;
    setAdvancedValues({});
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
        // Pre-fill the main Prompt textarea with the positive CLIPTextEncode's default text.
        // Heuristic: take the first CLIPTextEncode `text` widget whose node title doesn't mention "negative".
        // Reads from the unfiltered list because the positive widget IS form-claimed.
        const positive = result.widgets.find(w =>
          w.nodeType === 'CLIPTextEncode' &&
          w.widgetName === 'text' &&
          !/negative/i.test(w.nodeTitle || '')
        );
        if (positive && typeof positive.value === 'string' && positive.value.length > 0) {
          setFormValues(prev => (prev.prompt ? prev : { ...prev, prompt: positive.value }));
        }
      })
      .catch(() => {
        if (!cancelled) setHasEditableWidgets(false);
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

  // Reset form values when template changes
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
  }, [template?.name]);

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
    setAdvancedValues({});
  }, [template]);

  const handleGenerate = async () => {
    if (!selectedTemplate) return;

    const inputs: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(formValues)) {
      if (val && typeof val === 'object' && 'file' in (val as Record<string, unknown>)) {
        try {
          const fileVal = val as { file: File };
          const result = await api.uploadImage(fileVal.file);
          inputs[key] = result.name;
        } catch {
          console.error(`Upload failed for ${key}`);
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
    if (!template?.formInputs) return null;
    for (const fi of template.formInputs) {
      if (fi.type === 'image') {
        const val = formValues[fi.id] as { preview?: string } | null;
        if (val?.preview) return val.preview;
      }
    }
    return null;
  }, [template, formValues]);

  const canCompare = !!inputImagePreview && !!outputImage && currentJob?.status === 'completed';
  // The template's mediaType describes its THUMBNAIL (almost always "image" even for video/audio templates).
  // The job's outputMediaType is derived from the generated filename's extension and is the real
  // source of truth — fall back to the template only if the job hasn't told us yet.
  const outputMediaType = currentJob?.outputMediaType || template?.mediaType || 'image';

  return (
    <div className="flex h-[calc(100vh-3.5rem)]">
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
      {/* ComfyUI logs drawer */}
      <LogsDrawer open={showLogs} onClose={() => setShowLogs(false)} />

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

      {/* Column 1: Icon Sidebar */}
      <div className="w-14 flex-shrink-0 bg-white border-r border-gray-200 flex flex-col items-center py-4 gap-1">
        {categories.map(cat => {
          const Icon = cat.icon;
          const isActive = activeCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => handleCategoryChange(cat.id)}
              className={`flex flex-col items-center justify-center w-11 py-2 rounded-lg transition-colors ${
                isActive
                  ? 'bg-blue-50 text-blue-600'
                  : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
              }`}
              title={cat.label}
            >
              <Icon className="w-5 h-5" />
              <span className={`text-[9px] font-semibold mt-1 tracking-wide ${
                isActive ? 'text-blue-600' : 'text-gray-400'
              }`}>
                {cat.label}
              </span>
            </button>
          );
        })}
      </div>

      {/* Column 2: Form Panel */}
      <div className="w-[340px] lg:w-[380px] xl:w-[420px] flex-shrink-0 bg-white border-r border-gray-200 flex flex-col overflow-hidden">
        {/* Panel header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3">
          <h2 className="text-base font-semibold text-gray-900">{categoryTitles[activeCategory]}</h2>
          <div
            role="tablist"
            aria-label="Input mode"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm"
          >
            <button
              role="tab"
              aria-selected={mode === 'form'}
              onClick={() => setMode('form')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
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
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-semibold transition ${
                mode === 'json' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              <Braces className="w-3.5 h-3.5" />
              JSON
            </button>
          </div>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          <div className="space-y-5">
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
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Model</p>
                {depLoading && (
                  <Loader2 className="w-3 h-3 text-gray-400 animate-spin" />
                )}
                {!depLoading && depCheck?.ready && (
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
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
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Parameters</p>

              {mode === 'form' ? (
                template?.formInputs ? (
                  <>
                    <DynamicForm
                      inputs={template.formInputs}
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
                        className="mt-3 flex items-center gap-1.5 text-[11px] text-gray-400 hover:text-gray-700 transition-colors"
                      >
                        <Settings2 className="w-3.5 h-3.5" />
                        Edit advanced fields
                      </button>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-400">Select a model to see parameters.</p>
                )
              ) : (
                <JsonEditor
                  values={formValues}
                  onChange={handleJsonChange}
                />
              )}
            </div>
          </div>
        </div>

        {/* Bottom actions (fixed) */}
        <div className="px-4 py-3 border-t border-gray-100 bg-white">
          {/* Progress */}
          {isRunning && currentJob && (
            <div className="mb-3">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>{currentJob.status === 'pending' ? 'Queued...' : 'Generating...'}</span>
                <span>{Math.round(currentJob.progress)}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${Math.min(100, Math.max(0, currentJob.progress))}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="text-sm text-gray-500 hover:text-gray-700 font-medium"
            >
              Reset
            </button>
            <div className="flex-1 relative group">
              <button
                onClick={handleGenerate}
                disabled={generateDisabled}
                className="w-full py-2.5 bg-green-600 text-white font-semibold rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 text-sm"
              >
                {isRunning ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  'Generate'
                )}
              </button>
              {hasMissingDeps && !isRunning && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                  Missing required models
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Column 3: Result Area */}
      <div className="flex-1 bg-gray-50 flex flex-col min-w-0">
        {/* Result header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
          <h3 className="font-semibold text-gray-900">Result</h3>
          <div className="flex items-center gap-2">
            {canCompare && (
              <button
                onClick={() => setShowCompare(!showCompare)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors ${
                  showCompare
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                }`}
              >
                Compare
              </button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setShowLogs(true)}
                  className="btn-icon"
                  aria-label="Open ComfyUI logs"
                >
                  <ScrollText className="w-4 h-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>ComfyUI logs</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Result content */}
        <div className="flex-1 p-6 flex items-center justify-center relative overflow-hidden">
          {currentJob?.status === 'completed' && outputImage ? (
            <div className="relative w-full h-full max-w-3xl max-h-[calc(100vh-14rem)] flex items-center justify-center">
              <a
                href={outputImage}
                download
                className="absolute top-3 right-3 z-10 p-2 bg-white/90 rounded-lg border border-gray-200 text-gray-600 hover:text-gray-900 hover:bg-white transition-colors shadow-sm"
              >
                <Download className="w-4 h-4" />
              </a>

              {showCompare && inputImagePreview ? (
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
                  <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-200">
                    <div className="flex items-center justify-center mb-4">
                      <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center">
                        <Music className="w-8 h-8 text-green-600" />
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
                <p className="absolute bottom-3 left-3 text-xs text-gray-500 bg-white/80 px-2 py-1 rounded">
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
              <p className="text-xs text-gray-500 mt-1">Check the console for details</p>
            </div>
          ) : isRunning ? (
            <div className="text-center">
              <Loader2 className="w-10 h-10 text-teal-500 animate-spin mx-auto mb-3" />
              <p className="text-sm text-gray-500">Generating...</p>
            </div>
          ) : (
            <div className="text-center">
              <div className="w-24 h-24 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
                {activeCategory === 'video' ? (
                  <Film className="w-10 h-10 text-gray-300" />
                ) : activeCategory === 'audio' ? (
                  <Music className="w-10 h-10 text-gray-300" />
                ) : activeCategory === '3d' ? (
                  <Box className="w-10 h-10 text-gray-300" />
                ) : (
                  <ImageIcon className="w-10 h-10 text-gray-300" />
                )}
              </div>
              <p className="text-sm text-gray-400">Generate something to see results here</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
