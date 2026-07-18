// Display metadata for ACE-Step DiT checkpoints. Ported from ace-step-ui's
// `data/models.ts` — the backend (`GET /ace/generate/models`) only returns
// `{ name, is_active, is_preloaded }`, so the human-readable blurb/size and
// short label live client-side, keyed by checkpoint dirname.

export const DIT_MODEL_INFO: Record<string, { label: string; description: string; size: string }> = {
  'acestep-v15-xl-turbo': {
    label: 'Turbo',
    description: 'Distilled for speed — 8 steps, no CFG. Highest clarity, fastest generations.',
    size: '9 GB',
  },
  'acestep-v15-xl-sft': {
    label: 'SFT',
    description: 'Supervised fine-tuned. 50 steps + CFG — best prompt adherence.',
    size: '9 GB',
  },
  'acestep-v15-xl-base': {
    label: 'Base',
    description: 'Foundation model — all tasks + fine-tuning. 50 steps + CFG.',
    size: '9 GB',
  },
};

export function modelLabel(name: string): string {
  return DIT_MODEL_INFO[name]?.label ?? name.replace('acestep-v15-', '');
}

export function modelDescription(name: string): string | undefined {
  return DIT_MODEL_INFO[name]?.description;
}

export function isTurboModel(name: string): boolean {
  return name.includes('turbo');
}
