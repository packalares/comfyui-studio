// Integration tests for /models/recipes routes.

import { describe, it, expect } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import { authedFetch } from '../helpers/authedFetch.js';
import { useFreshDb } from '../lib/db/_helpers.js';

const { default: recipesRouter } = await import('../../src/routes/modelsRecipes.routes.js');

function startApp(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(recipesRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const VALID_BODY = {
  title: 'My Recipe',
  loras: [{ filename: 'model.safetensors', save_path: 'loras', strength: 1 }],
};

useFreshDb();

// ---- GET /models/recipes — list (the route that 404s in prod when un-mounted) ----

describe('GET /models/recipes', () => {
  it('200 with an empty array when no recipes exist (authed)', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes`);
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[] };
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toEqual([]);
    } finally { await app.close(); }
  });

  it('200 returns created recipes after insertion (authed)', async () => {
    const app = await startApp();
    try {
      const createRes = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      expect(createRes.status).toBe(200);
      const listRes = await authedFetch(`${app.url}/models/recipes`);
      expect(listRes.status).toBe(200);
      const body = await listRes.json() as { data: Array<{ title: string }> };
      expect(body.data.length).toBe(1);
      expect(body.data[0].title).toBe('My Recipe');
    } finally { await app.close(); }
  });

  it('401 when called without the same-origin signal or a Bearer key', async () => {
    const app = await startApp();
    try {
      // Plain fetch — no Sec-Fetch-Site, no cookie, no Authorization.
      // The auth middleware throws UnauthorizedError; express's default error
      // handler (no errorHandler mounted in this test app) translates that to
      // a 401 status. The shape of the body isn't checked because the canonical
      // JSON envelope only lands when `errorHandler()` is installed.
      const res = await fetch(`${app.url}/models/recipes`);
      expect(res.status).toBe(401);
    } finally { await app.close(); }
  });
});

// ---- POST /models/recipes — validation ----

describe('POST /models/recipes', () => {
  it('400 when title is missing', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loras: VALID_BODY.loras }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
    } finally { await app.close(); }
  });

  it('400 when loras is empty', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Test', loras: [] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('validation_failed');
    } finally { await app.close(); }
  });

  it('200 and returns created recipe on valid input', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: number; title: string } };
      expect(body.data.title).toBe('My Recipe');
      expect(typeof body.data.id).toBe('number');
    } finally { await app.close(); }
  });
});

// ---- PATCH /models/recipes/:id — 404 on missing ----

describe('PATCH /models/recipes/:id', () => {
  it('404 when id does not exist', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes/99999`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Updated' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    } finally { await app.close(); }
  });
});

// ---- GET /models/recipes/:id — 404 on missing ----

describe('GET /models/recipes/:id', () => {
  it('404 when id does not exist', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes/99999`);
      expect(res.status).toBe(404);
    } finally { await app.close(); }
  });

  it('returns recipe after creation', async () => {
    const app = await startApp();
    try {
      const createRes = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { data: { id: number } };
      const id = created.data.id;

      const getRes = await authedFetch(`${app.url}/models/recipes/${id}`);
      expect(getRes.status).toBe(200);
      const body = await getRes.json() as { data: { title: string } };
      expect(body.data.title).toBe('My Recipe');
    } finally { await app.close(); }
  });
});

// ---- DELETE /models/recipes/:id ----

describe('DELETE /models/recipes/:id', () => {
  it('404 when id does not exist', async () => {
    const app = await startApp();
    try {
      const res = await authedFetch(`${app.url}/models/recipes/99999`, { method: 'DELETE' });
      expect(res.status).toBe(404);
    } finally { await app.close(); }
  });

  it('200 and deletes the recipe', async () => {
    const app = await startApp();
    try {
      const createRes = await authedFetch(`${app.url}/models/recipes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY),
      });
      const created = await createRes.json() as { data: { id: number } };
      const id = created.data.id;

      const delRes = await authedFetch(`${app.url}/models/recipes/${id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);

      // Confirm it's gone
      const getRes = await authedFetch(`${app.url}/models/recipes/${id}`);
      expect(getRes.status).toBe(404);
    } finally { await app.close(); }
  });
});
