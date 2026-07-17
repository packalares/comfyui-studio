// T3: when settings.getHfToken() returns a value, hfAuthHeaders uses it.
//
// Audit D3: hfAuthHeaders() only read env.HUGGINGFACE_TOKEN, ignoring the
// settings-layer token set via the UI. Paste-URL resolution reported gated=true
// for accessible models when the token was only in Settings.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  settingsToken: undefined as string | undefined,
  envToken: 'env-hf-token-xyz789',
}));

vi.mock('../../../src/services/settings/index.js', () => ({
  getHfToken: vi.fn(() => mocks.settingsToken),
  getGithubToken: vi.fn().mockReturnValue(undefined),
}));

vi.mock('../../../src/config/env.js', () => ({
  env: {
    HUGGINGFACE_TOKEN: mocks.envToken,
    NODE_ENV: 'test',
    CIVITAI_API_BASE: 'https://civitai.com/api/v1',
  },
}));

import { resolveHuggingfaceUrl } from '../../../src/services/models/resolvers.js';
import * as settings from '../../../src/services/settings/index.js';

const SETTINGS_TOKEN = 'settings-hf-token-abc123';
const ENV_TOKEN = mocks.envToken;

describe('hfAuthHeaders — settings token fallback (D3)', () => {
  beforeEach(() => {
    mocks.settingsToken = undefined;
    vi.mocked(settings.getHfToken).mockImplementation(() => mocks.settingsToken);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses settings token when available, not env token', async () => {
    mocks.settingsToken = SETTINGS_TOKEN;
    vi.mocked(settings.getHfToken).mockReturnValue(SETTINGS_TOKEN);

    let capturedAuth: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '1000000' },
      });
    });

    await resolveHuggingfaceUrl(
      'https://huggingface.co/org/repo/blob/main/model.safetensors',
    );

    expect(capturedAuth).toBe(`Bearer ${SETTINGS_TOKEN}`);
    expect(capturedAuth).not.toBe(`Bearer ${ENV_TOKEN}`);
  });

  it('falls back to env token when settings token is absent', async () => {
    vi.mocked(settings.getHfToken).mockReturnValue(undefined);

    let capturedAuth: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
      return new Response(null, {
        status: 200,
        headers: { 'content-length': '1000000' },
      });
    });

    await resolveHuggingfaceUrl(
      'https://huggingface.co/org/repo/blob/main/model.safetensors',
    );

    expect(capturedAuth).toBe(`Bearer ${ENV_TOKEN}`);
  });

  it('settings token prevents false gated=true for accessible models', async () => {
    vi.mocked(settings.getHfToken).mockReturnValue(SETTINGS_TOKEN);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth === `Bearer ${SETTINGS_TOKEN}`) {
        return new Response(null, {
          status: 200,
          headers: { 'content-length': '500000' },
        });
      }
      return new Response(null, { status: 401 });
    });

    const out = await resolveHuggingfaceUrl(
      'https://huggingface.co/org/repo/blob/main/model.safetensors',
    );

    expect(out).not.toBeNull();
    expect(out!.gated).toBeUndefined();
    expect(out!.sizeBytes).toBe(500000);
  });
});
