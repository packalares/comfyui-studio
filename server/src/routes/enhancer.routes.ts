// Prompt-enhancer routes.
//
// Two endpoints serve the bundled enhancer data under `data/enhancer/`:
//
//   GET /enhancer              — one-shot bundle: profile metadata list +
//                                 master header/footer + genres + operations +
//                                 negative defaults + video presets. The UI
//                                 fetches this once on first Enhance and
//                                 caches it for the session.
//
//   GET /enhancer/profiles/:id — full profile JSON (examples, platform_block,
//                                 operation_overrides, sampling, etc).
//                                 Fetched on each Enhance click for the
//                                 currently active mode's profileId; cached
//                                 client-side after first fetch.
//
// Both endpoints read directly from disk. Files are 2-10 KB each; modern OS
// page cache keeps them warm after the first read. No in-memory loader, no
// hot-reload glue, no Map — edits to JSON files appear on the next request
// automatically. Bundle assembly is parallel via Promise.all so the latency
// is bounded by the slowest single file (~1 ms on warm SSD).
//
// No auth required: profile data is non-sensitive (it's the same JSON
// shipped in the repo). The actual LLM call still goes through the
// auth-gated /api/llm/chat endpoint.

import { Router } from 'express';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { paths } from '../config/paths.js';
import { safeResolve } from '../lib/fs.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Bundled data root (server/data/enhancer/). Pinned to BUNDLED_DATA_DIR via
// `paths.enhancerDir` — does NOT honour $DATA_DIR overrides. Enhancer
// content is read-only shipped data, not runtime-mutable state.
const ENHANCER_DIR = paths.enhancerDir;
const PROFILES_DIR = path.join(ENHANCER_DIR, 'profiles');

// Tight allow-list for the :id path segment — profiles use snake_case ids
// (kontext_instruction, flux2_prose, qwen_image_studio etc.). Reject anything
// else BEFORE we touch the filesystem so a path-traversal attempt never
// reaches readFile.
const PROFILE_ID_RE = /^[a-z0-9_]+$/;

// ---- GET /enhancer ----
//
// One round-trip bundle. Returns everything the UI needs to render the
// enhancer dropdowns + assemble system prompts EXCEPT the per-profile
// example blocks (those come via /enhancer/profiles/:id on demand to keep
// this payload small).

router.get('/enhancer', async (_req, res) => {
  try {
    const profileFiles = (await readdir(PROFILES_DIR))
      .filter(f => f.endsWith('.json'));

    // Profile metadata only — id / name / description / applies_to.
    // Skipping examples + platform_block keeps the bundle under ~30 KB.
    const profiles = await Promise.all(profileFiles.map(async f => {
      const raw = await readFile(path.join(PROFILES_DIR, f), 'utf8');
      const p = JSON.parse(raw) as {
        id: string;
        name?: string;
        description?: string;
        applies_to?: string[];
        format?: string;
        default_length_tier?: string;
      };
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        applies_to: p.applies_to ?? [],
        format: p.format,
        default_length_tier: p.default_length_tier,
      };
    }));

    const [header, footer, genres, operations, negativeDefaults, videoPresets] = await Promise.all([
      readFile(path.join(ENHANCER_DIR, 'master/header.txt'), 'utf8'),
      readFile(path.join(ENHANCER_DIR, 'master/footer.txt'), 'utf8'),
      readFile(path.join(ENHANCER_DIR, 'genres.json'),            'utf8').then(JSON.parse),
      readFile(path.join(ENHANCER_DIR, 'operations.json'),        'utf8').then(JSON.parse),
      readFile(path.join(ENHANCER_DIR, 'negative_defaults.json'), 'utf8').then(JSON.parse),
      readFile(path.join(ENHANCER_DIR, 'video_presets.json'),     'utf8').then(JSON.parse),
    ]);

    res.json({
      profiles,
      master: { header, footer },
      genres,
      operations,
      negative_defaults: negativeDefaults,
      video_presets: videoPresets,
    });
  } catch (err) {
    logger.warn('[enhancer] bundle load failed', { error: (err as Error).message });
    res.status(500).json({
      error: { code: 'enhancer_unavailable', message: (err as Error).message },
    });
  }
});

// ---- GET /enhancer/profiles/:id ----
//
// Streams the requested profile file back verbatim. Skip the parse/restringify
// round-trip — the file is already valid JSON. Validation, if any, is the UI's
// job (the schema for a Profile is documented inline in each file).

router.get('/enhancer/profiles/:id', async (req, res) => {
  const { id } = req.params;
  if (!PROFILE_ID_RE.test(id)) {
    res.status(400).json({
      error: { code: 'invalid_profile_id', message: 'profile id must match [a-z0-9_]+' },
    });
    return;
  }
  try {
    const raw = await readFile(safeResolve(PROFILES_DIR, `${id}.json`), 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({
        error: { code: 'profile_not_found', message: `no profile with id "${id}"` },
      });
      return;
    }
    logger.warn(`[enhancer] profile ${id} read failed`, { error: (err as Error).message });
    res.status(500).json({
      error: { code: 'enhancer_read_failed', message: (err as Error).message },
    });
  }
});

export default router;
