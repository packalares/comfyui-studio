// API keys repo — CRUD for the `api_keys` table.
//
// Storage shape (see schema.ts):
//   id, prefix, hash, name, scopes (JSON-array TEXT), created_at,
//   last_used_at?, expires_at?, revoked_at?
//
// Lookup is prefix-first: middleware extracts the prefix from the presented
// plain key (cheap), fetches the row by prefix (indexed), and only then runs
// the constant-time hash compare against the stored hash. The hash NEVER
// leaves this module — `get` / `list` strip it from every returned row.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getDb } from './connection.js';
import { isScope, type Scope } from '../auth/scopes.js';

/** Public projection of an API-key row — never carries the hash or plain. */
export interface ApiKeyRecord {
  id: string;
  prefix: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

/** Internal projection that additionally carries the stored hash. Used only by
 *  the auth middleware for constant-time verify. Never serialized to the wire. */
export interface ApiKeyWithHash extends ApiKeyRecord {
  hash: string;
}

export interface CreateApiKeyParams {
  prefix: string;
  hash: string;
  name: string;
  scopes: Scope[];
  expiresAt?: number | null;
}

interface RawRow {
  id: string;
  prefix: string;
  hash: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

function parseScopes(raw: string): Scope[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Scope[] = [];
  for (const v of parsed) if (isScope(v)) out.push(v);
  return out;
}

function rowToWithHash(row: RawRow): ApiKeyWithHash {
  return {
    id: row.id,
    prefix: row.prefix,
    hash: row.hash,
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function rowToRecord(row: RawRow): ApiKeyRecord {
  const { hash: _hash, ...rest } = rowToWithHash(row);
  void _hash;
  return rest;
}

const SELECT_COLS =
  'id, prefix, hash, name, scopes, created_at, last_used_at, expires_at, revoked_at';

/**
 * Insert a new key. The caller is responsible for generating `prefix` + `hash`
 * via `lib/auth/keyGen.ts`. Returns the newly-created public record (no hash).
 */
export function createApiKey(
  params: CreateApiKeyParams,
  db: Database.Database = getDb(),
): ApiKeyRecord {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO api_keys
      (id, prefix, hash, name, scopes, created_at, last_used_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
  `).run(
    id,
    params.prefix,
    params.hash,
    params.name,
    JSON.stringify(params.scopes),
    now,
    params.expiresAt ?? null,
  );
  return {
    id,
    prefix: params.prefix,
    name: params.name,
    scopes: [...params.scopes],
    createdAt: now,
    lastUsedAt: null,
    expiresAt: params.expiresAt ?? null,
    revokedAt: null,
  };
}

/** List every key, newest first. Hashes are stripped. */
export function listApiKeys(db: Database.Database = getDb()): ApiKeyRecord[] {
  const rows = db.prepare(
    `SELECT ${SELECT_COLS} FROM api_keys ORDER BY created_at DESC`,
  ).all() as RawRow[];
  return rows.map(rowToRecord);
}

/** Fetch one key by id. Returns null when not found. Hash stripped. */
export function getApiKey(
  id: string,
  db: Database.Database = getDb(),
): ApiKeyRecord | null {
  const row = db.prepare(
    `SELECT ${SELECT_COLS} FROM api_keys WHERE id = ?`,
  ).get(id) as RawRow | undefined;
  return row ? rowToRecord(row) : null;
}

/**
 * Look up a key by its non-secret prefix — the middleware hot path. Returns
 * the row WITH its hash so the caller can run a constant-time compare. The
 * returned object MUST NOT be forwarded to the wire.
 */
export function getApiKeyByPrefix(
  prefix: string,
  db: Database.Database = getDb(),
): ApiKeyWithHash | null {
  const row = db.prepare(
    `SELECT ${SELECT_COLS} FROM api_keys WHERE prefix = ?`,
  ).get(prefix) as RawRow | undefined;
  return row ? rowToWithHash(row) : null;
}

/**
 * Revoke a key. Sets `revoked_at` to now if not already set. Returns the
 * updated record, or null when the id is unknown. Idempotent — re-revoking
 * preserves the original revoked_at.
 */
export function revokeApiKey(
  id: string,
  db: Database.Database = getDb(),
): ApiKeyRecord | null {
  db.prepare(
    'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).run(Date.now(), id);
  return getApiKey(id, db);
}

/**
 * Update `last_used_at` to now. Used by auth middleware on every successful
 * request so the UI can surface "last seen" timestamps. Returns nothing — the
 * caller already has the in-memory record from `getApiKeyByPrefix`.
 */
export function touchApiKey(
  id: string,
  db: Database.Database = getDb(),
): void {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
}
