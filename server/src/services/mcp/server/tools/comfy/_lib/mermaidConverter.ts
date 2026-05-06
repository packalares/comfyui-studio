// Mermaid diagram converter for ComfyUI workflows.
// Ported from artokun's services/mermaid-converter.ts.

export type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
};
export type WorkflowJSON = Record<string, WorkflowNode>;

type NodeCategory = 'loading' | 'conditioning' | 'sampling' | 'image' | 'output' | 'utility';

interface MermaidOptions {
  showValues?: boolean;
  direction?: 'LR' | 'TB';
}

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  loading: 'Loading', conditioning: 'Conditioning', sampling: 'Sampling',
  image: 'Image', output: 'Output', utility: 'Utility',
};

const TYPE_COLORS: Record<string, string> = {
  MODEL: 'blue', LATENT: 'red', CONDITIONING: 'orange',
  IMAGE: 'green', CLIP: 'purple', VAE: 'teal',
};

const DISPLAY_VALUES = new Set(['seed','steps','cfg','denoise','sampler_name','scheduler',
  'width','height','ckpt_name','text','upscale_model','image']);

function categorizeNode(ct: string): NodeCategory {
  if (ct === 'SaveImage' || ct === 'PreviewImage') return 'output';
  if (ct.startsWith('CheckpointLoader') || ct.startsWith('CLIPLoader') ||
      ct.startsWith('VAELoader') || ct.startsWith('LoraLoader') || ct.startsWith('ControlNetLoader')) return 'loading';
  if (ct === 'CLIPTextEncode' || ct === 'ConditioningCombine' || ct === 'ConditioningSetArea' || ct === 'ControlNetApply') return 'conditioning';
  if (ct.startsWith('KSampler') || ct === 'SamplerCustom') return 'sampling';
  if (ct === 'VAEDecode' || ct === 'VAEEncode' || ct === 'LoadImage' || ct.startsWith('ImageScale') || ct.startsWith('ImageUpscale')) return 'image';
  return 'utility';
}

function isConn(v: unknown): v is [string, number] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
}

function buildLabel(node: WorkflowNode, showValues: boolean): string {
  const title = node._meta?.title ?? node.class_type;
  if (!showValues) return title;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(node.inputs)) {
    if (isConn(v) || !DISPLAY_VALUES.has(k)) continue;
    const s = typeof v === 'string' ? (v.length > 30 ? v.slice(0,27)+'...' : v) : String(v);
    parts.push(`${k}:${s}`);
  }
  return parts.length === 0 ? title : `${title}<br/>${parts.join(' ')}`;
}

function escape(s: string): string { return s.replace(/"/g, '#quot;'); }

function guessType(ct: string, idx: number): string {
  const m: Record<string, string[]> = {
    CheckpointLoaderSimple: ['MODEL','CLIP','VAE'], LoraLoader: ['MODEL','CLIP'],
    CLIPTextEncode: ['CONDITIONING'], KSampler: ['LATENT'], KSamplerAdvanced: ['LATENT'],
    VAEDecode: ['IMAGE'], VAEEncode: ['LATENT'], EmptyLatentImage: ['LATENT'],
    LoadImage: ['IMAGE','MASK'], ImageScale: ['IMAGE'], ConditioningCombine: ['CONDITIONING'],
    ControlNetLoader: ['CONTROL_NET'], CLIPLoader: ['CLIP'], VAELoader: ['VAE'],
  };
  return m[ct]?.[idx] ?? '';
}

function wrapNode(id: string, label: string, cat: NodeCategory): string {
  switch (cat) {
    case 'sampling': return `${id}{{"${label}"}}`;
    case 'conditioning': return `${id}(["${label}"])`;
    case 'output': return `${id}((("${label}")))`;
    case 'image': return `${id}("${label}")`;
    default: return `${id}["${label}"]`;
  }
}

export function convertToMermaid(workflow: WorkflowJSON, opts: MermaidOptions = {}): string {
  const { showValues = true, direction = 'LR' } = opts;
  const lines = [`flowchart ${direction}`];
  const groups = new Map<NodeCategory, Array<{id: string; node: WorkflowNode}>>();
  for (const [id, node] of Object.entries(workflow)) {
    const cat = categorizeNode(node.class_type);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({ id, node });
  }
  const order: NodeCategory[] = ['loading','conditioning','sampling','image','output','utility'];
  for (const cat of order) {
    const nodes = groups.get(cat);
    if (!nodes?.length) continue;
    lines.push(`  subgraph ${CATEGORY_LABELS[cat]}`);
    for (const { id, node } of nodes) {
      lines.push(`    ${wrapNode(id, escape(buildLabel(node, showValues)), cat)}`);
    }
    lines.push('  end');
  }
  for (const [tid, node] of Object.entries(workflow)) {
    for (const [, v] of Object.entries(node.inputs)) {
      if (!isConn(v)) continue;
      const [sid, oidx] = v;
      const src = workflow[sid];
      const dtype = src ? guessType(src.class_type, oidx) : '';
      const lbl = dtype ? `|${dtype}|` : '';
      lines.push(`  ${sid} -->${lbl} ${tid}`);
    }
  }
  return lines.join('\n');
}
