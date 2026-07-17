import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Image as ImageIcon, Film, Music, Box, Wrench,
  Download, AlertTriangle, CheckCircle2,
  SlidersHorizontal, Braces, Wand2, Sparkles, RotateCcw,
  Settings2, Workflow, X as XIcon, ArrowRight,
} from 'lucide-react';
import { useApp, useJobs } from '../context/AppContext';
import { Spinner } from '../components/ui/spinner';
import CompareSlider from '../components/viewers/CompareSlider';
import ThreeDViewer from '../components/viewers/ThreeDViewer';
import DynamicForm from '../components/forms/DynamicForm';
import AdvancedSettings from '../components/forms/AdvancedSettings';
import ModelDropdown from '../components/ModelDropdown';
import JsonEditor from '../components/viewers/JsonEditor';
import DependencyModal from '../components/modals/DependencyModal';
import ExposeWidgetsModal from '../components/modals/ExposeWidgetsModal';
import PageSubbar from '../components/layout/PageSubbar';
import PageAside from '../components/layout/PageAside';
import { Tooltip, TooltipTrigger, TooltipContent } from '../components/ui/tooltip';
import { Switch } from '../components/ui/switch';
import { Button } from '../components/ui/button';
import { SelectField, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/forms/SelectField';
import { api, ApiError } from '../services/comfyui';
import { isThreeDFilename } from '../lib/media';
import { toast } from 'sonner';
import { AudioPlayer } from '../components/ui/audio-player';
import type { StudioCategory, TemplateSummary, DependencyCheck, AdvancedSetting, FormInput, WorkflowGroup } from '../types';

const WorkflowGraph = lazy(() => import('../components/studio/WorkflowGraph'));
// VideoBuilder is small and shows on tab click — eagerly imported so the
// first Video-tab click doesn't trigger a Suspense flash. WorkflowGraph
// stays lazy because it pulls a heavier canvas/graph dep tree.
import VideoBuilder, { type EasyBuilderAction } from './VideoBuilder';
import ImageBuilder from './ImageBuilder';
import PresetGrid, { type PresetCard, type PresetApplyPayload } from '../components/PresetGrid';

const categoryTitles: Record<StudioCategory, string> = {
  image: 'Image Generator',
  video: 'Video Generator',
  audio: 'Audio Generator',
  '3d': '3D Generator',
  tools: 'AI-Tools Generator',
};

// Top-level builder tab for the Studio page. The legacy Category dropdown
// was replaced by this strip: Image / Video / Audio host curated "easy"
// UIs (model-driven, mode auto-inferred from inputs); Advanced renders the
// full template picker without any category filter and remembers the last
// template the user opened (single global, not per-category).
type StudioTab = 'image' | 'video' | 'audio' | 'advanced';
const STUDIO_TABS: { id: StudioTab; label: string; Icon: React.ElementType }[] = [
  { id: 'image',    label: 'Image',    Icon: ImageIcon },
  { id: 'video',    label: 'Video',    Icon: Film },
  { id: 'audio',    label: 'Audio',    Icon: Music },
  { id: 'advanced', label: 'Advanced', Icon: Settings2 },
];
const STUDIO_TAB_STORAGE_KEY = 'studio:tab';
const STUDIO_LAST_TEMPLATE_GLOBAL_KEY = 'studio:lastTemplateGlobal';

function getCategoryForTemplate(t: TemplateSummary): StudioCategory {
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

function readSavedStudioTab(): StudioTab {
  try {
    const saved = localStorage.getItem(STUDIO_TAB_STORAGE_KEY) as StudioTab | null;
    if (saved === 'image' || saved === 'video' || saved === 'audio' || saved === 'advanced') return saved;
  } catch { /* localStorage unavailable */ }
  return 'image'; // first-ever visit: land on the first tab, not Advanced
}

export default function Studio() {
  // App.tsx mounts Studio under a single wildcard route `/studio/*` so the
  // component instance is reused across `/studio`, `/studio/easy/<tab>`, and
  // `/studio/<templateName>` — no Suspense flash on tab clicks. Parse the
  // splat here to recover the original `templateName` / `easyTab` semantics.
  const params = useParams();
  const splatPath = params['*'] ?? '';
  const { templateName, easyTab } = useMemo(() => {
    const segs = splatPath.split('/').map(s => {
      try { return decodeURIComponent(s); } catch { return s; }
    }).filter(Boolean);
    if (segs[0] === 'easy') {
      return { templateName: undefined as string | undefined, easyTab: (segs[1] || undefined) as string | undefined };
    }
    if (segs[0]) {
      return { templateName: segs[0] as string | undefined, easyTab: undefined as string | undefined };
    }
    return { templateName: undefined as string | undefined, easyTab: undefined as string | undefined };
  }, [splatPath]);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { templates, currentJob, submitGeneration, connected, refreshTemplates, uploadMaxBytes, queueStatus, livePreviewUrl } = useApp();
  const { errorNodeIds, errorEdges } = useJobs();

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
  // Top-level builder tab: Image / Video / Audio / Advanced. The URL is
  // the single source of truth:
  //   /studio                       → Advanced (no template)
  //   /studio/:templateName         → Advanced (with template)
  //   /studio/easy/video            → Video Easy mode
  //   /studio/easy/image            → Image Easy mode
  //   /studio/easy/audio            → Audio Easy mode
  // Clicking a tab calls navigate(...) to swap routes, so the URL,
  // template name, page title, and dep state all stay in sync.
  const urlEasyTab = (easyTab as StudioTab | undefined);
  const studioTab: StudioTab = (urlEasyTab && (urlEasyTab === 'image' || urlEasyTab === 'video' || urlEasyTab === 'audio'))
    ? urlEasyTab
    : 'advanced';
  const setStudioTab = useCallback((next: StudioTab) => {
    if (next === 'advanced') navigate('/studio');
    else navigate(`/studio/easy/${next}`);
  }, [navigate]);

  // Snapshot the saved tab at mount time — the persist effect below
  // overwrites localStorage on first commit with the current `studioTab`
  // (which is 'advanced' on a bare `/studio`), so the redirect effect
  // can't read the stored value from localStorage anymore. Capturing into
  // useState's lazy initializer freezes it before any effect runs.
  const [initialSavedTab] = useState<StudioTab>(readSavedStudioTab);
  // Bare `/studio` (no template, no easyTab) — pick up where the user
  // left off. Runs ONCE on mount. The Advanced-tab auto-pick effect below
  // is also gated on the same condition so the two don't race and
  // overwrite each other's navigate() in the same commit.
  useEffect(() => {
    if (templateName || easyTab) return;
    if (initialSavedTab !== 'advanced') {
      navigate(`/studio/easy/${initialSavedTab}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Persist the active tab so a bare `/studio` click in the sidebar can
  // restore it on next visit. Saving `advanced` is intentional — if the
  // user was last on Advanced, next bare /studio stays on /studio.
  useEffect(() => {
    try { localStorage.setItem(STUDIO_TAB_STORAGE_KEY, studioTab); } catch { /* ignore */ }
  }, [studioTab]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>(templateName || '');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [outputImage, setOutputImage] = useState<string | null>(null);
  // Compare defaults ON so users see the before/after split immediately when
  // the gate (input image + output + completed) is satisfied. Users can flip
  // it off to see just the output.
  const [showCompare, setShowCompare] = useState(true);
  // When a result is showing, the user can dismiss it back to the graph via
  // the workflow-view button. A new outputUrl resets this to true automatically.
  const [showResult, setShowResult] = useState(true);

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
  // Workflow-aware form fields from `/api/template-widgets`. Once
  // `formFieldsLoaded` flips true these are the authoritative shape — every
  // field carries its `(bindNodeId, bindWidgetName)` binding. Until the
  // fetch completes we render `template.formInputs` from the catalog so the
  // form isn't blank during the round-trip.
  const [primitiveFormFields, setPrimitiveFormFields] = useState<FormInput[]>([]);
  const [formFieldsLoaded, setFormFieldsLoaded] = useState(false);
  const [bundleApiPrompt, setBundleApiPrompt] = useState<Record<string, unknown> | null>(null);
  const [bundleMainNodeIds, setBundleMainNodeIds] = useState<Set<string> | null>(null);
  const [bundleGroups, setBundleGroups] = useState<WorkflowGroup[]>([]);
  // Preset display cards from the template bundle. When non-empty the
  // right-side "Ready when you are" empty state collapses to a condensed
  // header and we render this grid below it.
  const [bundlePresets, setBundlePresets] = useState<PresetCard[]>([]);
  // Held until a Builder consumes the payload. Bumping `id` (or assigning
  // a fresh object) re-fires the Builder's apply useEffect even if the
  // user clicks the same preset twice in a row.
  const [presetApply, setPresetApply] = useState<PresetApplyPayload | null>(null);

  // Error highlight set: the directly-failing nodes plus, for each
  // "required input is missing" error, the upstream node that should have
  // fed that input (resolved via the bundle's api-prompt) — so e.g. a
  // resize node missing its image traces back to the LoadImage that's
  // wired to a form field, and that field/node gets the red treatment.
  const expandedErrorNodeIds = useMemo(() => {
    const set = new Set(errorNodeIds);
    const ap = bundleApiPrompt as Record<string, { inputs?: Record<string, unknown> }> | null;
    for (const e of errorEdges) {
      const link = ap?.[e.nodeId]?.inputs?.[e.missingInput];
      if (Array.isArray(link) && typeof link[0] === 'string') set.add(link[0]);
    }
    return Array.from(set);
  }, [errorNodeIds, errorEdges, bundleApiPrompt]);

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

  // Template pool for the ModelDropdown.
  // - Advanced tab: no category filter — pick from the entire catalog.
  // - Image/Video/Audio tabs: scoped to that category (for now this is a
  //   safety net; those tabs render a placeholder until Phase 2 ships the
  //   curated builder UI).
  const categoryTemplates = useMemo(() => {
    if (studioTab === 'advanced') {
      // Easy-mode templates (those with `studioBuilder` set) belong to the
      // Image/Video/Audio tabs and have no advanced-fields surface — hide
      // them from the Advanced picker so the dropdown only lists templates
      // the workflow editor / form-fields plan can actually drive.
      return templates.filter((t) => !t.studioBuilder);
    }
    return templates.filter(t => getCategoryForTemplate(t) === studioTab);
  }, [templates, studioTab, activeCategory]); // activeCategory kept in deps to satisfy legacy effects below

  // Current template object
  const template = useMemo(
    () => templates.find(t => t.name === selectedTemplate),
    [templates, selectedTemplate]
  );

  // Form fields come from `/api/template-bundle/:name` (the canonical
  // workflow-aware list with bindings, defaults, dedup applied). Until the
  // bundle returns we render no fields — the slim `TemplateSummary` cached
  // in AppContext doesn't carry the placeholder formInputs anymore. The
  // bundle is fast (single round-trip) so the brief empty render is fine.
  const mergedFormInputs = useMemo(() => {
    return formFieldsLoaded ? primitiveFormFields : [];
  }, [primitiveFormFields, formFieldsLoaded]);

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
      setFormFieldsLoaded(false);
      setBundleApiPrompt(null);
      setBundleMainNodeIds(null);
      setBundleGroups([]);
      setBundlePresets([]);
      return;
    }
    let cancelled = false;
    setAdvancedValues({});
    // Clear primitive fields at the START of a fetch so entries from the
    // previous template never leak into the current one. `formFieldsLoaded`
    // gates `mergedFormInputs` on the catalog placeholder until the fetch
    // resolves, preventing stale primitives from bleeding across templates.
    setPrimitiveFormFields([]);
    setFormFieldsLoaded(false);
    // Single round-trip replaces the prior two parallel fetches
    // (`/workflow-settings` + `/template-widgets`); the backend computes the
    // workflow plan once and returns all three payloads.
    api.getTemplateBundle(selectedTemplate)
      .then(result => {
        if (cancelled) return;
        setAdvancedSettingsDefs(result.settings);
        // "Edit advanced fields" only opens for widgets the user could ACTUALLY expose —
        // form-claimed widgets (main Prompt + uploads) are read for defaults, not to
        // expose, so they don't count towards the button's visibility.
        const exposable = result.widgets.filter(w => !w.formClaimed);
        setHasEditableWidgets(exposable.length > 0);
        const primitiveFields = result.primitiveFormFields ?? [];
        setPrimitiveFormFields(primitiveFields);
        setFormFieldsLoaded(true);

        // Derive mainNodeIds from the widgets list for WorkflowGraph.
        const mainIds = new Set(result.widgets.map(w => w.nodeId).filter((x): x is string => !!x));
        setBundleApiPrompt(result.apiPrompt);
        setBundleMainNodeIds(mainIds);
        setBundleGroups(result.groups);
        setBundlePresets(result.presets ?? []);

        // Prompt pre-fill — iterate every bound canonical field and seed
        // `formValues[id]` from the matching widget's default when the user
        // hasn't typed anything there yet. Falls back to the classic
        // CLIPTextEncode/text lookup for legacy flat workflows whose
        // canonical fields carry no bindings.
        const seeds: Record<string, string> = {};
        for (const input of primitiveFields) {
          if (!input.bindNodeId || !input.bindWidgetName) continue;
          // Prefer the field's own `default` (from the primitive/widget
          // walk). When blank, fall back to the widget enumerated for
          // Advanced Settings so we still pick up the workflow's baked-in
          // value — matches the pre-refactor CLIPTextEncode prefill.
          const fieldDefault = typeof input.default === 'string' ? input.default : '';
          let seed = fieldDefault;
          if (seed.length === 0) {
            const w = result.widgets.find(
              x => x.nodeId === input.bindNodeId && x.widgetName === input.bindWidgetName,
            );
            if (w && typeof w.value === 'string') seed = w.value;
          }
          if (seed.length > 0) seeds[input.id] = seed;
        }
        // Classic-workflow fallback: no bound fields matched — reuse the
        // old CLIPTextEncode/text lookup so legacy flat templates still
        // prefill the `prompt` field.
        if (Object.keys(seeds).length === 0) {
          const positive = result.widgets.find(w =>
            w.nodeType === 'CLIPTextEncode' &&
            w.widgetName === 'text' &&
            !/negative/i.test(w.nodeTitle || '')
          );
          if (positive && typeof positive.value === 'string' && positive.value.length > 0) {
            seeds.prompt = positive.value;
          }
        }
        if (Object.keys(seeds).length > 0) {
          setFormValues(prev => {
            const next = { ...prev };
            let changed = false;
            for (const [id, val] of Object.entries(seeds)) {
              if (next[id] === undefined || next[id] === '') {
                next[id] = val;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAdvancedSettingsDefs([]);
          setHasEditableWidgets(false);
          setPrimitiveFormFields([]);
          setFormFieldsLoaded(false);
          setBundleApiPrompt(null);
          setBundleMainNodeIds(null);
          setBundleGroups([]);
        }
      });
    return () => { cancelled = true; };
  }, [selectedTemplate]);

  // Drop stale dep state whenever we leave Advanced, so the auto-modal
  // can't surface for whatever template was last loaded on a different tab.
  useEffect(() => {
    if (studioTab !== 'advanced') {
      setDepCheck(null);
      setShowDepModal(false);
    }
  }, [studioTab]);

  // Run dependency check when template changes — Advanced tab only.
  // Image / Video / Audio builders run their own per-model dep checks
  // inside their components (VideoBuilder.tsx etc.), so this effect
  // never fires for the wrong template when the user is on those tabs.
  useEffect(() => {
    if (!selectedTemplate || studioTab !== 'advanced') {
      setDepCheck(null);
      setShowDepModal(false);
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
    // Reset on template change. Defaults are merged in by the
    // primitiveFormFields effect below, after the bundle arrives.
    setFormValues({});
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
  // the first template in the list. Skipped when the currently selected template already
  // belongs to the active category (e.g. user just landed from Explore / a gallery link
  // with a specific templateName URL).
  //
  // Membership check is against `categoryTemplates` directly (not derived `template`)
  // because during the multi-effect commit triggered by a URL change, the closure here
  // can read a stale `activeCategory` while `selectedTemplate` is already the new value.
  // The previous `template && getCategoryForTemplate(template) === activeCategory` form
  // would then mis-skip the early return and spuriously navigate to the remembered
  // template — an infinite ping-pong when the deps array also omits `selectedTemplate`
  // and `lastTemplateByCategory`.
  useEffect(() => {
    // Skip auto-pick on Image / Video / Audio routes — those tabs are
    // model-driven via their own builder UIs and should NEVER pull the
    // user back into Advanced by guessing a template from history.
    if (studioTab !== 'advanced') return;
    // Bare `/studio` with a non-advanced saved tab: the redirect effect
    // above is about to navigate us to /studio/easy/<saved>. Skip the
    // auto-pick so it doesn't race and yank us to /studio/:lastTemplate
    // in the same commit. Use the captured `initialSavedTab` (NOT
    // localStorage) — the persist effect already overwrote localStorage
    // with the current `studioTab` ('advanced' on bare /studio) during
    // this same commit, so a fresh read would always show 'advanced'.
    if (!templateName && !easyTab && initialSavedTab !== 'advanced') return;
    if (categoryTemplates.length === 0) return;
    if (selectedTemplate && categoryTemplates.some(t => t.name === selectedTemplate)) return;
    const remembered = lastTemplateByCategory[activeCategory];
    const rememberedTemplate = remembered && categoryTemplates.find(t => t.name === remembered);
    const target = rememberedTemplate ? rememberedTemplate.name : categoryTemplates[0].name;
    if (target !== selectedTemplate) {
      setSelectedTemplate(target);
      navigate(`/studio/${target}`, { replace: true });
    }
  }, [studioTab, activeCategory, categoryTemplates, selectedTemplate, lastTemplateByCategory, navigate, templateName, easyTab]);

  // When switching to a non-Advanced tab, drop the stale selectedTemplate
  // so derived state (template title, dep check, formValues) doesn't bleed
  // into the Easy-mode UIs.
  useEffect(() => {
    if (studioTab !== 'advanced') {
      setSelectedTemplate('');
    }
  }, [studioTab]);

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
      // Library-pick shape: `{ name, preview }` with no `file`. The name is
      // already a server-side comfy ref (`<subfolder>/<filename>` or just
      // `<filename>`) — no upload needed. Pass it through verbatim. Check
      // BEFORE the file branch because the upload-fresh shape also keeps a
      // `name` once handleFile lands; we only want to short-circuit when
      // there's NO file to upload.
      if (
        val && typeof val === 'object'
        && 'name' in (val as Record<string, unknown>)
        && !('file' in (val as Record<string, unknown>))
      ) {
        inputs[key] = (val as { name: string }).name;
        continue;
      }
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
  // isRunning is intentionally excluded from the disable condition: clicking while a job
  // runs queues the new prompt behind it (ComfyUI supports a queue). The button label
  // flips to "Add to queue" when the ComfyUI queue is non-empty.
  const generateDisabled = !selectedTemplate || !connected || hasMissingDeps;

  // Easy-mode builders (Video, future Image/Audio) publish their submit +
  // reset + disabled state through this slot. The shared bottom Reset /
  // Generate buttons dispatch to it when the active tab is Easy mode — so
  // there's always exactly one CTA, regardless of which tab is open.
  const [easyAction, setEasyAction] = useState<EasyBuilderAction | null>(null);
  const isEasyTab = studioTab === 'image' || studioTab === 'video' || studioTab === 'audio';
  const footerGenerateDisabled = isEasyTab
    ? (!easyAction || easyAction.disabled)
    : generateDisabled;
  const footerGenerateLabel = isEasyTab
    ? (easyAction?.label ?? 'Generate')
    : 'Generate';
  const handleFooterGenerate = useCallback(() => {
    if (isEasyTab) {
      easyAction?.onSubmit();
    } else {
      handleGenerate();
    }
  }, [isEasyTab, easyAction, handleGenerate]);
  const handleFooterReset = useCallback(() => {
    if (isEasyTab) easyAction?.onReset();
    else handleReset();
  }, [isEasyTab, easyAction, handleReset]);
  const showAddToQueue = isRunning
    || (queueStatus.queue_running ?? 0) > 0
    || (queueStatus.queue_pending ?? 0) > 0;

  useEffect(() => {
    if (currentJob?.status === 'completed' && currentJob.outputUrl) {
      // New result arrived — show it automatically even if the user had
      // previously dismissed to the graph view.
      setOutputImage(currentJob.outputUrl);
      setShowResult(true);
    } else if (currentJob && currentJob.status !== 'completed') {
      // A new job is in flight — wipe the previously-completed output so
      // the result panel doesn't flash the OLD image during the brief
      // gap before the first live-preview frame arrives. Drives the
      // `starting` display mode below.
      setOutputImage(null);
    }
  }, [currentJob?.outputUrl, currentJob?.status]);

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
  // Extract the real filename from /api/view?filename=...&... so the download
  // <a> forces a browser save-as dialog with a sensible name. Without a
  // `download` attribute the browser navigates to the URL and plays the
  // audio/video inline instead of downloading it.
  const outputFilename = useMemo(() => {
    if (!outputImage) return undefined;
    const m = outputImage.match(/[?&]filename=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : 'output';
  }, [outputImage]);
  // Compare only makes sense when BOTH sides are images. i2v / i2a templates
  // produce video/audio outputs — feeding those into CompareSlider renders
  // a <img src="*.mp4"> which shows as a broken image. Guard here so the
  // toggle is hidden AND the render branch falls through to the correct
  // per-mediaType element below.
  const canCompare =
    !!inputImagePreview && !!outputImage && currentJob?.status === 'completed'
    && !isOutput3D && outputMediaType === 'image';

  // ---- Result panel display state -----------------------------------
  //
  // Drives the right-side panel through six explicit modes. Derived (no
  // separate useState) so it always stays in sync with the underlying
  // primitives — no stale renders, no manual setX plumbing.
  //
  // Precedence matters — modes higher in the list shadow ones below:
  //
  //   output      → completed job + outputUrl + user hasn't toggled to graph
  //   livePreview → TAESD preview frames are streaming from comfy
  //   starting    → job submitted but no preview frame yet (the gap
  //                 between "Generate" click and first WS binary)
  //   presets     → Easy-mode tab w/ a template that ships preset cards
  //   graph       → Advanced tab w/ a template selected → workflow graph
  //   hero        → fallback "Ready when you are" empty state
  type ResultPanelMode = 'output' | 'livePreview' | 'starting' | 'presets' | 'graph' | 'hero';
  const resultMode: ResultPanelMode = (() => {
    if (currentJob?.status === 'completed' && outputImage && showResult) return 'output';
    if (livePreviewUrl) return 'livePreview';
    if (currentJob && currentJob.status !== 'completed') return 'starting';
    if (isEasyTab && selectedTemplate && bundlePresets.length > 0) return 'presets';
    if (!isEasyTab && selectedTemplate) return 'graph';
    return 'hero';
  })();

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
      {studioTab === 'advanced' && showDepModal && depCheck && depCheck.missing.length > 0 && (
        <DependencyModal
          missing={depCheck.missing}
          templateName={selectedTemplate ?? undefined}
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
      />

      <div className="flex flex-col lg:flex-row gap-4 p-4">
        {/* Left aside: form. Override the default 320px width with the
            wider 420px Studio needs for two-column form fields. `open`
            stays true so mobile stacks the form above the result. */}
        <PageAside open className="lg:w-[420px]">
            <div>
              <div role="tablist" aria-label="Studio mode" className="flex flex-wrap gap-1 bg-card p-2 border-b ">
                {STUDIO_TABS.map(({ id, label, Icon }) => {
                  const active = studioTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setStudioTab(id)}
                      className={
                        'flex-1 inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ' +
                        (active
                          ? 'bg-brand text-brand-foreground shadow-sm'
                          : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/50')
                      }
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="px-4 py-4 flex-1 overflow-y-auto scrollbar-subtle space-y-5">
              {/* Not connected banner */}
              {!connected && (
                <div className="flex items-start gap-2 p-2.5 bg-warning/10 border border-warning/30 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-xs font-medium text-warning">ComfyUI is not connected</p>
                    <button
                      onClick={() => navigate('/settings')}
                      className="text-[11px] text-warning underline mt-0.5"
                    >
                      Configure in Settings
                    </button>
                  </div>
                </div>
              )}

              {studioTab === 'advanced' && selectedTemplate && (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-foreground">{categoryTitles[activeCategory]}</h2>
                    {template?.title && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground truncate">{template.title}</p>
                    )}
                  </div>
                  <div role="tablist" aria-label="Input mode" className="tab-strip shrink-0">
                    <button
                      role="tab"
                      aria-selected={mode === 'form'}
                      onClick={() => setMode('form')}
                      className={`tab-strip-item ${mode === 'form' ? 'is-active' : ''}`}
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5" />
                      Form
                    </button>
                    <button
                      role="tab"
                      aria-selected={mode === 'json'}
                      onClick={() => setMode('json')}
                      className={`tab-strip-item ${mode === 'json' ? 'is-active' : ''}`}
                    >
                      <Braces className="w-3.5 h-3.5" />
                      JSON
                    </button>
                  </div>
                </div>
              )}

              {/* Video tab — curated Easy-mode UI. The component owns its
                  own prompt/resolution/duration form and submits via the
                  existing /api/generate endpoint (server reads the active
                  template's modes metadata and mutes inactive nodes). */}
              {studioTab === 'video' && (
                <VideoBuilder
                  registerAction={setEasyAction}
                  onSwitchToAdvanced={() => setStudioTab('advanced')}
                  onTemplateChange={setSelectedTemplate}
                  presetApply={presetApply}
                />
              )}

              {/* Image tab — same chrome as VideoBuilder (model select +
                  prompt card + chip row) plus image-specific bits (camera
                  chip, multi-reference grid). Drives the shared bottom
                  Generate / Reset via the same registerAction contract. */}
              {studioTab === 'image' && (
                <ImageBuilder
                  registerAction={setEasyAction}
                  onSwitchToAdvanced={() => setStudioTab('advanced')}
                  onTemplateChange={setSelectedTemplate}
                  presetApply={presetApply}
                />
              )}

              {/* Audio — still a placeholder until its builder ships. Same
                  visual shape as VideoBuilder's empty state so the two read
                  consistently when nothing is wired up. */}
              {studioTab === 'audio' && (
                <div className="min-h-[55vh] flex items-center justify-center">
                  <div className="flex flex-col items-center text-center rounded-xl border border-dashed border-border/70 bg-card/40 px-6 py-10 max-w-sm">
                    <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Music className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm font-semibold text-foreground mb-1">
                      Audio easy mode isn't ready
                    </p>
                    <p className="text-xs text-muted-foreground max-w-xs mb-4">
                      No curated audio workflow is set up yet. You can still drive any compatible template from the Advanced tab.
                    </p>
                    <Button variant="outline" onClick={() => setStudioTab('advanced')}>
                      Switch to Advanced
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {/* MODEL / DEPENDENCIES section — Advanced tab only.
                  Image/Video/Audio render the placeholder above; their
                  curated UIs (Phase 2) will provide their own model picker
                  + dependency surface. */}
              {studioTab === 'advanced' && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Template</p>
                  {depLoading && (
                    <Spinner size="xs" className="text-muted-foreground" />
                  )}
                  {!depLoading && depCheck?.ready && (
                    <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                  )}
                  {!depLoading && hasMissingDeps && (
                    <button
                      onClick={() => setShowDepModal(true)}
                      className="flex items-center gap-1 text-[10px] text-warning hover:text-warning/80"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {hasEditableWidgets && (
                    <button
                      type="button"
                      onClick={() => setShowExposeModal(true)}
                      className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Settings2 className="w-3.5 h-3.5" />
                      Edit advanced fields
                    </button>
                  )}
                </div>
                <ModelDropdown
                  templates={categoryTemplates}
                  selected={selectedTemplate}
                  onSelect={handleSelectTemplate}
                />
              </div>
              )}

              {/* PARAMETERS section — Advanced tab only. */}
              {studioTab === 'advanced' && (
              <div>
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Parameters</p>

                {mode === 'form' ? (
                  mergedFormInputs.length > 0 ? (
                    <>
                      <DynamicForm
                        inputs={mergedFormInputs}
                        values={formValues}
                        onChange={setFormValues}
                        errorNodeIds={expandedErrorNodeIds}
                      />
                      {advancedSettingsDefs.length > 0 && (
                        <div className="mt-4">
                          <AdvancedSettings
                            settings={advancedSettingsDefs}
                            values={advancedValues}
                            onChange={setAdvancedValues}
                            errorNodeIds={expandedErrorNodeIds}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">Select a model to see parameters.</p>
                  )
                ) : (
                  <JsonEditor
                    values={formValues}
                    onChange={handleJsonChange}
                  />
                )}
              </div>
              )}
            </div>

            {/* Footer: Reset/Generate */}
            <div className="border-t bg-muted px-4 py-3 flex flex-col items-stretch gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleFooterReset}
                  className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-card px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10 hover:border-destructive transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reset
                </button>
                <div className="flex-1 relative group">
                  <button
                    onClick={handleFooterGenerate}
                    disabled={footerGenerateDisabled}
                    className="relative w-full overflow-hidden inline-flex items-center justify-center gap-2 rounded-md bg-gradient-to-r from-teal-500 to-success text-brand-foreground py-2 text-sm font-semibold shadow-sm hover:shadow-md hover:from-teal-600 hover:to-success/90 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-1 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:from-muted-foreground disabled:to-muted-foreground disabled:shadow-none"
                  >
                    {/* Shimmer sweep. Hidden when the queue is busy — avoids
                        the button flashing during active generation. */}
                    {!showAddToQueue && !footerGenerateDisabled && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"
                      />
                    )}
                    {showAddToQueue ? (
                      <>
                        <Wand2 className="w-4 h-4 relative" />
                        <span className="relative">Add to queue</span>
                      </>
                    ) : (
                      <>
                        <Wand2 className="w-4 h-4 relative" />
                        <span className="relative">{footerGenerateLabel}</span>
                        <Sparkles className="w-3 h-3 relative opacity-80" />
                      </>
                    )}
                  </button>
                  {!isEasyTab && hasMissingDeps && (
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-1.5 bg-popover text-popover-foreground border text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap">
                      Missing dependencies
                    </div>
                  )}
                </div>
              </div>
            </div>
        </PageAside>

        {/* Right main: result. Detached card so it visually pairs with
            the form aside on the left. */}
        <section className="flex flex-1 min-w-0 flex-col rounded-xl border bg-card shadow-sm overflow-hidden">
            <div className="border-b bg-card px-4 py-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">Result</h3>
              <div className="flex items-center gap-3">
                {canCompare && showResult && (
                  <label className="flex items-center gap-2 cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Compare
                    <Switch
                      checked={showCompare}
                      onCheckedChange={setShowCompare}
                      aria-label="Toggle before/after comparison"
                    />
                  </label>
                )}
                {outputImage && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowResult(r => !r)}
                        aria-label={showResult ? 'View workflow' : 'View result'}
                      >
                        {showResult ? <Workflow className="w-4 h-4" /> : <XIcon className="w-4 h-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {showResult ? 'View workflow' : 'View result'}
                    </TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className={!outputImage ? 'pointer-events-none opacity-40' : ''}
                    >
                      <a
                        href={outputImage || undefined}
                        download={outputFilename}
                        aria-disabled={!outputImage}
                        onClick={(e) => { if (!outputImage) e.preventDefault(); }}
                        aria-label="Download output"
                      >
                        <Download className="w-4 h-4" />
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {outputImage ? 'Download output' : 'No output to download yet'}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div
              // Only the `presets` mode swaps to a scrollable, top-aligned
              // layout (because the preset grid is taller than the panel);
              // every other mode keeps the centered viewer chrome.
              className={
                resultMode === 'presets'
                  ? 'flex-1 relative overflow-y-auto bg-muted'
                  : 'flex-1 p-6 flex items-center justify-center relative overflow-hidden bg-muted'
              }
            >
              {/* `resultMode` precedence is enforced in its derivation;
                  each branch below is independent so adding/removing a
                  state never re-balances a brittle ternary chain. */}

              {resultMode === 'output' && (
                // Output viewer sizes by HEIGHT (max-h matches the
                // viewport height minus surrounding chrome). Width
                // follows aspect ratio via `object-contain`; the
                // earlier max-w-3xl cap was dropped so portrait
                // results use the full available height.
                <div className="relative h-full max-h-[calc(100vh-14rem)] flex items-center justify-center">
                  {isOutput3D ? (
                    <div className="w-full h-full min-h-[400px] rounded-lg overflow-hidden">
                      <ThreeDViewer src={outputImage!} alt="Generated 3D model" />
                    </div>
                  ) : canCompare && showCompare ? (
                    <CompareSlider
                      beforeSrc={inputImagePreview}
                      afterSrc={outputImage!}
                      beforeLabel="Input"
                      afterLabel="Output"
                    />
                  ) : outputMediaType === 'video' ? (
                    <video
                      src={outputImage!}
                      controls
                      className="max-w-full max-h-full rounded-lg"
                    />
                  ) : outputMediaType === 'audio' ? (
                    <div className="w-full max-w-lg">
                      <AudioPlayer src={outputImage!} />
                    </div>
                  ) : (
                    <img
                      src={outputImage!}
                      alt="Generated output"
                      className="max-w-full max-h-full object-contain rounded-lg"
                    />
                  )}

                  {currentJob?.seed !== undefined && (
                    <p className="absolute bottom-3 left-3 text-xs text-muted-foreground bg-card/80 px-2 py-1 rounded">
                      Seed: {currentJob.seed}
                    </p>
                  )}
                </div>
              )}

              {resultMode === 'livePreview' && (
                /* TAESD preview frames arriving from comfy. The img
                   src swaps on every binary WS frame; the prior blob
                   URL was already revoked by the AppContext binary
                   handler. Replaced by the `output` branch when the
                   final result lands. */
                <div className="relative h-full max-h-[calc(100vh-14rem)] flex items-center justify-center">
                  <div className="relative overflow-hidden rounded-lg shadow-md h-full">
                    <img
                      src={livePreviewUrl!}
                      alt="Live preview"
                      className="block h-full w-auto max-h-[calc(100vh-14rem)] object-contain"
                    />
                    {/* Fractal-noise grain overlay — jitters every frame
                        via the `live-grain` keyframe so the static
                        TAESD frame reads as actively-resolving pixels.
                        mix-blend-overlay keeps the underlying preview
                        legible. */}
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0 mix-blend-overlay opacity-30 live-grain"
                    />
                  </div>
                  <div className="absolute top-3 right-3 flex items-center gap-2 rounded-full bg-card/85 backdrop-blur px-3 py-1.5 text-xs font-medium text-foreground shadow-sm">
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full rounded-full bg-brand opacity-75 animate-ping" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
                    </span>
                    Generating
                  </div>
                  {currentJob?.seed !== undefined && (
                    <p className="absolute bottom-3 left-3 text-xs text-muted-foreground bg-card/80 px-2 py-1 rounded">
                      Seed: {currentJob.seed}
                    </p>
                  )}
                </div>
              )}

              {resultMode === 'starting' && (
                /* The gap between Generate-click and the first TAESD
                   preview frame. We have a job (status: pending /
                   running) but no image to show yet. Render a square
                   placeholder driven by the same `live-grain` keyframe
                   so the panel reads as "pixels assembling" rather
                   than blank. Without this we'd flash the empty hero
                   for ~1s which feels broken. */
                <div className="relative h-full max-h-[calc(100vh-14rem)] aspect-square flex items-center justify-center">
                  <div className="relative h-full aspect-square overflow-hidden rounded-lg shadow-md bg-muted/30 ring-1 ring-border/40">
                    {/* Full-tile grain — opacity higher than the live-
                        preview overlay (~60%) since there's no
                        underlying image to keep legible. */}
                    <div
                      aria-hidden
                      className="absolute inset-0 live-grain opacity-60"
                    />
                    {/* Soft brand-tinted bloom in the center to anchor
                        the spinner against the noisy backdrop. */}
                    <div
                      aria-hidden
                      className="absolute inset-1/3 rounded-full bg-brand/15 blur-2xl animate-pulse"
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                      <span className="w-8 h-8 rounded-full border-2 border-foreground/25 border-t-foreground animate-spin" />
                      <p className="text-xs font-medium text-foreground bg-card/85 backdrop-blur px-3 py-1.5 rounded-full shadow-sm">
                        Starting generation…
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {resultMode === 'presets' && (
                /* Template ships preset cards — anchor the hero to the
                   top of the panel so the preset grid claims the rest
                   of the scrollable area. */
                <div className="p-6 pt-10 space-y-10">
                  <div className="flex flex-col items-center text-center">
                    <div className="mb-3 relative">
                      <div className="absolute -inset-1 rounded-full bg-brand/20 blur-xl" />
                      <div className="relative w-20 h-20 rounded-3xl bg-card ring-1 ring-border/60 shadow-sm flex items-center justify-center">
                        {activeCategory === 'video' ? (
                          <Film className="w-8 h-8 text-muted-foreground" />
                        ) : activeCategory === 'audio' ? (
                          <Music className="w-8 h-8 text-muted-foreground" />
                        ) : activeCategory === '3d' ? (
                          <Box className="w-8 h-8 text-muted-foreground" />
                        ) : activeCategory === 'tools' ? (
                          <Wrench className="w-8 h-8 text-muted-foreground" />
                        ) : (
                          <ImageIcon className="w-8 h-8 text-brand" />
                        )}
                      </div>
                    </div>
                    <h4 className="text-sm font-semibold text-foreground mb-1">
                      Ready when you are
                    </h4>
                    <p className="text-xs text-muted-foreground leading-relaxed max-w-sm">
                      Pick a preset below, or fill the prompt and hit{' '}
                      <span className="inline-flex items-center gap-1 font-semibold text-brand">
                        <Wand2 className="w-3 h-3" />Generate
                      </span>
                      . Output shows up here.
                    </p>
                  </div>
                  <PresetGrid
                    presets={bundlePresets}
                    parentTemplateName={selectedTemplate!}
                    onPresetApply={setPresetApply}
                  />
                </div>
              )}

              {resultMode === 'graph' && (
                /* Advanced tab + template selected → live workflow
                   graph. Failed jobs keep the graph visible and just
                   mark the failing node red. Easy-mode tabs skip this
                   branch because their templates are heavily
                   subgraphed (one wrapper node) — the graph renders
                   mostly empty and adds no value. */
                <div className="absolute inset-0">
                  <Suspense fallback={
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground gap-2">
                      <span className="w-4 h-4 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                      Loading graph…
                    </div>
                  }>
                    <WorkflowGraph
                      templateName={selectedTemplate!}
                      isRunning={isRunning}
                      apiPrompt={bundleApiPrompt}
                      mainNodeIds={bundleMainNodeIds}
                      groups={bundleGroups}
                      errorNodeIds={expandedErrorNodeIds}
                    />
                  </Suspense>
                </div>
              )}

              {resultMode === 'hero' && (
                <div className="text-center max-w-sm">
                  {/* Animated hero icon — gradient halo picks up the
                      category color so the empty state reads as "in
                      the right context, just empty". */}
                  <div className="relative mx-auto mb-5 w-28 h-28">
                    <div
                      className="absolute inset-0 rounded-3xl blur-2xl opacity-60 animate-pulse bg-gradient-to-br from-muted to-muted-foreground/30"
                      aria-hidden="true"
                    />
                    <div className="relative w-28 h-28 rounded-3xl bg-card ring-1 ring-border/60 shadow-sm flex items-center justify-center">
                      {activeCategory === 'video' ? (
                        <Film className="w-11 h-11 text-muted-foreground" />
                      ) : activeCategory === 'audio' ? (
                        <Music className="w-11 h-11 text-muted-foreground" />
                      ) : activeCategory === '3d' ? (
                        <Box className="w-11 h-11 text-muted-foreground" />
                      ) : activeCategory === 'tools' ? (
                        <Wrench className="w-11 h-11 text-muted-foreground" />
                      ) : (
                        <ImageIcon className="w-11 h-11 text-brand" />
                      )}
                    </div>
                  </div>
                  <h4 className="text-sm font-semibold text-foreground mb-1">
                    Ready when you are
                  </h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Pick a model on the left, fill the prompt, and hit{' '}
                    <span className="inline-flex items-center gap-1 font-semibold text-brand">
                      <Wand2 className="w-3 h-3" />Generate
                    </span>
                    . Output shows up here.
                  </p>
                </div>
              )}
            </div>
        </section>
      </div>
    </>
  );
}
