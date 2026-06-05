// Canonical scope registry for API keys.
//
// SCOPES and Scope are now defined in `contracts/auth.contract.ts` (the
// canonical source) so UI-side tsc can resolve them without needing server-
// internal dependencies (express, better-sqlite3, etc.). Re-exported here for
// back-compat — all server-side importers keep working unchanged.
//
// Wave 3 routes reference these via `defineRoute({ auth: { scopes: [...] } })`.
// `admin:all` is a master scope: middleware short-circuits any scope check when
// the presented key carries it. `admin:keys` is required to manage other keys
// (create, list, revoke) — `admin:all` implies it.

export { SCOPES, type Scope } from '../../contracts/auth.contract.js';
import { SCOPES } from '../../contracts/auth.contract.js';

const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES);

export function isScope(value: unknown): value is import('../../contracts/auth.contract.js').Scope {
  return typeof value === 'string' && SCOPE_SET.has(value);
}
