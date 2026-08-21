// Architecture-level invariant tests for the model manager.
// These are "best-effort lint" guards: they catch future code that bypasses
// the model manager or skips the dependency pre-check gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../../src');

// ── helpers ───────────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Files/dirs whitelisted from the readdir check. Each entry is a substring
// of the relative path from SRC. Whitelist conservatively: only files that
// legitimately own their domain's scan concern.
const READDIR_WHITELIST = [
  // Model manager owns all model-directory scanning:
  '/services/models/',
  // Gallery domain does its own media scan:
  '/services/gallery/',
  // Plugin discovery walks plugin dirs — different domain:
  '/services/plugins/',
  // Media library walks upload dirs — different domain:
  '/services/mediaLibrary',
  // DB connection walks migration dirs — not model dirs:
  '/lib/db/',
  // Folder registry proxies ComfyUI's folder list, not the disk:
  '/services/catalog/folderRegistry',
  // Template dep check reads model files index via the manager's API:
  '/services/templates/dependencyCheck',
  // ComfyUI process management (reads log dirs):
  '/services/comfyui/process',
  // Pack model destination resolution owns the "is this pack model already on
  // disk?" check (`looksDownloaded`). It does NOT enumerate model directories
  // to build a listing — that is the model manager's job and this file never
  // does it. It stats ONE already-resolved destination path to decide whether
  // to skip a multi-GB re-download, so there is nothing for the manager to
  // bypass. It only trips this rule because the check moved here from
  // `services/packs/install.ts` (which never referenced COMFYUI_PATH, so it
  // failed condition (b)) to sit next to the path derivation both the
  // installer and the settings view share.
  '/services/packs/modelPaths',
];

function isWhitelisted(absPath: string): boolean {
  const rel = absPath.replace(SRC, '').replace(/\\/g, '/');
  return READDIR_WHITELIST.some((w) => rel.includes(w));
}

// ── A: No rogue readdir calls outside the model manager ──────────────────────

describe('no bypass of the model manager', () => {
  it('only known owners call readdir on model-adjacent paths', () => {
    // This is a "best-effort lint" guard. The pattern is intentionally
    // conservative: we flag files that both (a) call readdir AND (b) reference
    // COMFYUI_PATH or raw model filesystem paths AND (c) are not in the
    // approved whitelist. False positives should be added to READDIR_WHITELIST
    // with a comment explaining the legitimate use.
    const rogue: string[] = [];
    const READDIR_RE = /\bfs(?:\.promises)?\.readdir(?:Sync)?\b/;
    // Only flag direct COMFYUI_PATH access — the tightest signal that a file
    // is doing raw model-dir scanning rather than some other FS operation.
    const MODEL_PATH_HINT_RE = /env\.COMFYUI_PATH\b/;
    for (const file of walk(SRC)) {
      if (isWhitelisted(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (!READDIR_RE.test(src)) continue;
      if (MODEL_PATH_HINT_RE.test(src)) {
        rogue.push(relative(SRC, file));
      }
    }
    expect(rogue).toEqual([]);
  });
});

// ── B: generate route calls dep-check before ComfyUI submission ───────────────

describe('generate route dependency pre-check', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('checkTemplateDependencies is called before comfyui.submitPrompt', async () => {
    // Call order tracker.
    const callOrder: string[] = [];

    // --- mock checkTemplateDependencies ---
    vi.doMock(resolve(SRC, 'services/templates/dependencyCheck.js'), () => ({
      checkTemplateDependencies: vi.fn(async (_name: string) => {
        callOrder.push('depCheck');
        return { ready: true, required: [], missing: [] };
      }),
      resetDependencyCheckCacheForTests: vi.fn(),
    }));

    // --- mock comfyui.submitPrompt ---
    vi.doMock(resolve(SRC, 'services/comfyui/api.js'), () => ({
      submitPrompt: vi.fn(async () => {
        callOrder.push('submitPrompt');
        return { prompt_id: 'test-id', node_errors: {} };
      }),
      ComfyUIHttpError: class ComfyUIHttpError extends Error {},
      cancelAcceptedPrompt: vi.fn(async () => {}),
    }));

    // --- mock minimal express infra so the route module loads ---
    vi.doMock(resolve(SRC, 'lib/defineRoute.js'), () => ({
      defineRoute: vi.fn((_spec: unknown, handler: unknown) => ({
        register: vi.fn(),
        _handler: handler,
      })),
    }));

    vi.doMock(resolve(SRC, 'services/templates/index.js'), () => ({
      getUserWorkflowJson: vi.fn(() => ({ nodes: [], links: [] })),
      getUserTemplate: vi.fn(() => null),
    }));
    vi.doMock(resolve(SRC, 'services/workflow/index.js'), () => ({
      getObjectInfo: vi.fn(async () => ({})),
      workflowToApiPrompt: vi.fn(async () => ({})),
    }));
    vi.doMock(resolve(SRC, 'services/templates/templates.formInputs.js'), () => ({
      generateFormInputs: vi.fn(() => []),
    }));
    vi.doMock(resolve(SRC, 'services/templates/advancedSettings.js'), () => ({
      splitAdvancedSettings: vi.fn(() => ({ proxyEntries: {}, nodeOverrides: {} })),
      applyProxyOverrides: vi.fn(),
      applyNodeOverrides: vi.fn(),
    }));
    vi.doMock(resolve(SRC, 'services/workflow/fgmMute.js'), () => ({
      computeFgmMutedNodes: vi.fn(() => []),
    }));
    vi.doMock(resolve(SRC, 'services/workflow/prompt/enhancerProbe.js'), () => ({
      injectEnhancerProbes: vi.fn(),
    }));
    vi.doMock(resolve(SRC, 'services/gallery/sentry.js'), () => ({
      schedulePromptWatch: vi.fn(),
    }));
    vi.doMock(resolve(SRC, 'lib/db/promptSnapshots.repo.js'), () => ({
      insertSnapshot: vi.fn(),
    }));
    vi.doMock(resolve(SRC, 'services/templates/submitTemplate.js'), () => ({
      computeModelFingerprint: vi.fn(() => ''),
    }));
    vi.doMock(resolve(SRC, 'services/gpu/scheduler.js'), () => ({
      submitGpuJob: vi.fn(async (_name: string, cb: (release: () => void) => Promise<unknown>) => {
        return cb(() => {});
      }),
    }));
    vi.doMock(resolve(SRC, 'services/comfyui/jobBridge.js'), () => ({
      getBridgeClientId: vi.fn(() => 'bridge-client'),
      trackComfyPrompt: vi.fn(async () => {}),
    }));
    vi.doMock(resolve(SRC, 'middleware/rateLimit.js'), () => ({
      rateLimit: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
    }));
    vi.doMock(resolve(SRC, 'services/jobs/urls.js'), () => ({
      buildJobUrls: vi.fn(() => ({ statusUrl: '/status', streamUrl: '/stream' })),
    }));
    vi.doMock(resolve(SRC, 'services/templates/padOverrides.js'), () => ({
      applyPadOverrides: vi.fn(),
    }));
    vi.doMock(resolve(SRC, 'contracts/generate.contract.js'), () => ({
      GenerateBodySchema: { parse: (v: unknown) => v },
      GenerateResponseSchema: {},
    }));
    vi.doMock(resolve(SRC, 'lib/errors.js'), () => ({
      NotFoundError: class NotFoundError extends Error {},
      ValidationError: class ValidationError extends Error {
        constructor(msg: string, public details?: unknown) { super(msg); }
      },
      UpstreamUnavailableError: class UpstreamUnavailableError extends Error {},
    }));

    // Import the route module — this wires the handler but doesn't call it.
    // We reach into the defineRoute mock to grab the handler directly.
    const mod = await import(resolve(SRC, 'routes/generate.routes.js'));
    // The module doesn't expose the handler directly, but we can verify
    // that defineRoute was invoked (which wraps the handler). The critical
    // invariant we test here is module-load-order: if generate.routes.ts
    // imports checkTemplateDependencies, that import must appear before
    // submitPrompt in the module's dependency graph. We verify this by
    // checking the source text directly.
    const src = readFileSync(resolve(SRC, 'routes/generate.routes.ts'), 'utf8');
    const depCheckImportIdx = src.indexOf('checkTemplateDependencies');
    const submitPromptUsageIdx = src.indexOf('comfyui.submitPrompt');
    expect(depCheckImportIdx, 'checkTemplateDependencies must be imported in generate.routes.ts').toBeGreaterThan(-1);
    expect(submitPromptUsageIdx, 'submitPrompt must be called in generate.routes.ts').toBeGreaterThan(-1);
    // The dep-check invocation must appear BEFORE the submitPrompt call in the
    // route handler body (not just imported).
    const depCheckCallIdx = src.indexOf('checkTemplateDependencies(templateName)');
    expect(depCheckCallIdx, 'checkTemplateDependencies must be called with templateName').toBeGreaterThan(-1);
    expect(depCheckCallIdx, 'dep-check must run before submitPrompt').toBeLessThan(submitPromptUsageIdx);

    // Suppress unused import warning.
    void mod;
  });
});
