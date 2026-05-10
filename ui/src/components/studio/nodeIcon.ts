import { Layers, Type, Cpu, Box, Image, Boxes } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function getNodeIcon(classType: string): LucideIcon {
  if (/Loader|CheckpointLoader/i.test(classType)) return Layers;
  if (/CLIPText/i.test(classType)) return Type;
  if (/KSampler|Sampler/i.test(classType)) return Cpu;
  if (/VAE/i.test(classType)) return Box;
  if (/SaveImage|PreviewImage/i.test(classType)) return Image;
  return Boxes;
}

export function humanizeClassType(classType: string): string {
  // Split on uppercase letters preceded by lowercase or digit
  return classType
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim();
}

// ─── Auto-grouping by class_type ─────────────────────────────────────────────
// Mirrors the ComfyUI editor's typical author grouping (Models / Inputs /
// Prompts / Sampling / Output) when the prompt JSON itself doesn't carry
// the editor's `extra.groups` data. Fallback bucket = 'misc'.

export type NodeCategory =
  | 'models'
  | 'inputs'
  | 'prompts'
  | 'sampling'
  | 'output'
  | 'misc';

export function nodeCategory(classType: string): NodeCategory {
  const lc = classType.toLowerCase();
  // Order matters — more specific patterns first
  if (lc.includes('clip') && lc.includes('encode')) return 'prompts';
  if (lc.startsWith('conditioning')) return 'prompts';
  if (lc.includes('sampler') || lc.includes('sampling') || lc.includes('scheduler')) return 'sampling';
  if (lc.includes('saveimage') || lc.includes('savevideo') || lc.includes('preview') || lc.includes('vaedecode')) return 'output';
  if (lc.includes('loader') || lc.includes('lora') || lc.includes('checkpoint')) return 'models';
  if (
    lc.includes('emptylatent') ||
    lc.includes('emptysd3') ||
    lc.includes('emptyimage') ||
    lc.includes('loadimage') ||
    lc.includes('loadvideo') ||
    lc.includes('imageupscale') ||
    lc.includes('imagecrop') ||
    lc.includes('imagescale')
  ) return 'inputs';
  return 'misc';
}

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  models:   'Models',
  inputs:   'Inputs',
  prompts:  'Prompts',
  sampling: 'Sampling',
  output:   'Output',
  misc:     'Other',
};

// Soft-tinted bg + border + label color per category. Uses theme tokens so
// it adapts to whichever palette the user has active. The bg uses /5 alpha
// for a faint wash, border /20 for a clear edge, label gets full color.
export const CATEGORY_STYLE: Record<NodeCategory, { bg: string; border: string; label: string }> = {
  models:   { bg: 'bg-brand/5',       border: 'border-brand/25',       label: 'text-brand' },
  inputs:   { bg: 'bg-success/5',     border: 'border-success/25',     label: 'text-success' },
  prompts:  { bg: 'bg-warning/5',     border: 'border-warning/25',     label: 'text-warning' },
  sampling: { bg: 'bg-destructive/5', border: 'border-destructive/25', label: 'text-destructive' },
  output:   { bg: 'bg-muted/60',      border: 'border-border',         label: 'text-foreground' },
  misc:     { bg: 'bg-muted/40',      border: 'border-border/60',      label: 'text-muted-foreground' },
};
