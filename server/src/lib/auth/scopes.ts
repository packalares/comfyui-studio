// Canonical scope registry for API keys.
//
// Wave 3 routes reference these via `defineRoute({ auth: { scopes: [...] } })`.
// `admin:all` is a master scope: middleware short-circuits any scope check when
// the presented key carries it. `admin:keys` is required to manage other keys
// (create, list, revoke) — `admin:all` implies it.

export const SCOPES = [
  'catalog:read',
  'catalog:write',
  'models:read',
  'models:write',
  'models:install',
  'chat:read',
  'chat:write',
  'videoboard:read',
  'videoboard:write',
  'videoboard:render',
  'gallery:read',
  'gallery:delete',
  'generate:write',
  'system:read',
  'settings:read',
  'settings:write',
  'admin:keys',
  'admin:all',
] as const;

export type Scope = typeof SCOPES[number];

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}
