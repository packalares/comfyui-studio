// Category-driven LoRA training config — ported from ace-step-ui's
// `types/training.ts` + `hooks/useTrainingCategory.ts`. All category-specific
// preprocessing/auto-label/training defaults live in
// `../../data/training-categories.json` (copied verbatim from ace-step-ui);
// this module types that file and resolves category + sub-type selections
// into a merged runtime config for `TrainTab`.
//
// One deliberate divergence from ace-step-ui: the JSON's `outputRoot` field
// (`/app/ACE-Step-1.5/lora_output`) is ace-step-ui's absolute path inside its
// own container and has no meaning here — comfy has no checked-out ACE-Step
// source tree. `buildOutputDir` below returns a *relative* subdir
// (`${outputSubdir}/${datasetName}`) instead; the server resolves that
// against its own `paths.aceLoraOutputDir` (see
// `routes/ace/training.routes.ts`'s `startTrainingRoute`), so `outputRoot`
// is kept in the JSON only for the category-summary display text.

import { useCallback, useEffect, useMemo, useState } from 'react';
import categoriesJson from '../../data/training-categories.json';

export type TrainingCategoryId =
  | 'voice'
  | 'instrument'
  | 'drum_component'
  | 'instrumental'
  | 'genre'
  | 'mood'
  | 'producer'
  | 'groove';

export type TagPosition = 'prepend' | 'append';

export interface PreprocessingConfig {
  enabled: boolean;
  model: string;
  keepStems: string[];
  chain?: string[];
  extraArgs?: Record<string, unknown>;
  fallbackModel?: string;
}

export interface AutoLabelConfig {
  skipMetas: boolean;
  transcribeLyrics: boolean;
  formatLyrics: boolean;
  customTag: string;
  tagPosition: TagPosition;
}

export interface TrainingDefaults {
  rank: number;
  alpha: number;
  dropout: number;
  learningRate: number;
  epochs: number;
  batchSize: number;
  gradientAccumulation: number;
  saveEvery: number;
  outputSubdir: string;
}

export interface DatasetGuidance {
  minSamples: number;
  recommendedSamples: number;
  minSampleSeconds: number;
  maxSampleSeconds: number;
  instructions: string;
}

export interface TrainingCategoryBase {
  displayName: string;
  description: string;
  icon: string;
  preprocessing: PreprocessingConfig;
  autoLabel: AutoLabelConfig;
  training: TrainingDefaults;
  dataset: DatasetGuidance;
}

export interface TrainingSubType {
  id: string;
  displayName: string;
  description?: string;
  icon?: string;
  preprocessing?: PreprocessingConfig;
  autoLabel?: AutoLabelConfig;
  training?: Partial<TrainingDefaults>;
  dataset?: Partial<DatasetGuidance>;
}

export interface TrainingCategoryConfig extends TrainingCategoryBase {
  id: TrainingCategoryId;
  subTypes?: TrainingSubType[];
}

export interface TrainingCategoriesFile {
  outputRoot: string;
  categories: TrainingCategoryConfig[];
}

export interface ResolvedCategoryConfig {
  id: TrainingCategoryId;
  subTypeId: string | null;
  displayName: string;
  description: string;
  icon: string;
  preprocessing: PreprocessingConfig;
  autoLabel: AutoLabelConfig;
  training: TrainingDefaults;
  dataset: DatasetGuidance;
}

const STORAGE_KEY_CATEGORY = 'ace:trainingCategory';
const STORAGE_KEY_SUBTYPE = 'ace:trainingSubType';

const data = categoriesJson as TrainingCategoriesFile;
const CATEGORIES: TrainingCategoryConfig[] = data.categories;
const VALID_IDS = new Set<TrainingCategoryId>(CATEGORIES.map((c) => c.id));

function readStoredCategory(): TrainingCategoryId | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY_CATEGORY);
  if (raw && VALID_IDS.has(raw as TrainingCategoryId)) return raw as TrainingCategoryId;
  return null;
}

function readStoredSubType(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(STORAGE_KEY_SUBTYPE);
}

export function getCategoryConfig(id: TrainingCategoryId | null): TrainingCategoryConfig | null {
  if (!id) return null;
  return CATEGORIES.find((c) => c.id === id) ?? null;
}

export function getSubType(category: TrainingCategoryConfig | null, subTypeId: string | null): TrainingSubType | null {
  if (!category || !subTypeId || !category.subTypes) return null;
  return category.subTypes.find((s) => s.id === subTypeId) ?? null;
}

export function resolveCategory(
  category: TrainingCategoryConfig | null,
  subTypeId: string | null,
): ResolvedCategoryConfig | null {
  if (!category) return null;
  const sub = getSubType(category, subTypeId);
  if (!sub) {
    return {
      id: category.id,
      subTypeId: null,
      displayName: category.displayName,
      description: category.description,
      icon: category.icon,
      preprocessing: category.preprocessing,
      autoLabel: category.autoLabel,
      training: category.training,
      dataset: category.dataset,
    };
  }
  return {
    id: category.id,
    subTypeId: sub.id,
    displayName: `${category.displayName} – ${sub.displayName}`,
    description: sub.description ?? category.description,
    icon: sub.icon ?? category.icon,
    preprocessing: sub.preprocessing ?? category.preprocessing,
    autoLabel: sub.autoLabel ?? category.autoLabel,
    training: { ...category.training, ...(sub.training ?? {}) },
    dataset: { ...category.dataset, ...(sub.dataset ?? {}) },
  };
}

/** Whether the dataset for this category should be flagged as
 *  all-instrumental (drives `lyrics: "[Instrumental]"` in build-dataset). */
export function deriveAllInstrumental(resolved: ResolvedCategoryConfig | null): boolean {
  if (!resolved) return false;
  const pre = resolved.preprocessing;
  if (!pre || pre.enabled === false) return false;
  const keep = pre.keepStems ?? [];
  if (keep.length === 0) return false;
  return !keep.some((k) => k.toLowerCase() === 'vocals');
}

/** Relative training-output subdir for a resolved category — resolved
 *  server-side against `paths.aceLoraOutputDir` (see module doc comment). */
export function buildOutputDir(resolved: ResolvedCategoryConfig | null, datasetName?: string | null): string {
  if (!resolved) return '';
  const subdir = resolved.training.outputSubdir.replace(/^\/+|\/+$/g, '');
  const trimmedName = (datasetName ?? '').trim();
  return trimmedName ? `${subdir}/${trimmedName}` : subdir;
}

export interface UseTrainingCategoryReturn {
  categories: TrainingCategoryConfig[];
  outputRoot: string;
  category: TrainingCategoryId | null;
  subType: string | null;
  config: ResolvedCategoryConfig | null;
  defaults: TrainingDefaults | null;
  allInstrumental: boolean;
  setCategory: (id: TrainingCategoryId | null) => void;
  setSubType: (id: string | null) => void;
  buildOutputDir: (datasetName?: string | null) => string;
}

export function useTrainingCategory(): UseTrainingCategoryReturn {
  const [category, setCategoryState] = useState<TrainingCategoryId | null>(() => readStoredCategory());
  const [subType, setSubTypeState] = useState<string | null>(() => readStoredSubType());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (category) window.localStorage.setItem(STORAGE_KEY_CATEGORY, category);
    else window.localStorage.removeItem(STORAGE_KEY_CATEGORY);
  }, [category]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (subType) window.localStorage.setItem(STORAGE_KEY_SUBTYPE, subType);
    else window.localStorage.removeItem(STORAGE_KEY_SUBTYPE);
  }, [subType]);

  const setCategory = useCallback((id: TrainingCategoryId | null) => {
    setCategoryState(id);
    setSubTypeState(null);
  }, []);

  const setSubType = useCallback((id: string | null) => {
    setSubTypeState(id);
  }, []);

  const categoryConfig = useMemo(() => getCategoryConfig(category), [category]);

  useEffect(() => {
    if (!categoryConfig) return;
    if (categoryConfig.subTypes && categoryConfig.subTypes.length > 0 && !subType) {
      setSubTypeState(categoryConfig.subTypes[0].id);
    }
  }, [categoryConfig, subType]);

  const config = useMemo(() => resolveCategory(categoryConfig, subType), [categoryConfig, subType]);

  const buildOutputDirCb = useCallback(
    (datasetName?: string | null) => buildOutputDir(config, datasetName),
    [config],
  );

  return {
    categories: CATEGORIES,
    outputRoot: data.outputRoot,
    category,
    subType,
    config,
    defaults: config?.training ?? null,
    allInstrumental: deriveAllInstrumental(config),
    setCategory,
    setSubType,
    buildOutputDir: buildOutputDirCb,
  };
}
