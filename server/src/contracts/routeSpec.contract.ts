// Minimal route-spec type used by the UI API client.
// Lives in contracts/ (a leaf directory with no imports) so UI-side tsc can
// resolve it without following the import chain into server-only modules
// (express, better-sqlite3, auth middleware, etc.) and without needing zod
// to be resolvable from the server source tree in the frontend Docker stage.
//
// The server-side route framework (lib/defineRoute.ts) defines the full
// zod-constrained RouteSpec on top of this; the UI client only needs the
// structural shape to extract input/output types via its own z.infer calls.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface AuthSpec {
  required: boolean;
  scopes?: readonly string[] | string[];
}

/**
 * Structural shape of a route spec — zod-version-agnostic so the UI can use
 * it without a hard dependency on the server's zod installation. The generic
 * params default to `unknown`; the UI client's ApiCallInput/ApiCallOutput
 * utilities key off the structural presence of `params`/`query`/`body` using
 * their own `z.ZodTypeAny` checks against the UI's locally-installed zod.
 */
export interface RouteSpec<
  P = unknown,
  Q = unknown,
  B = unknown,
  R = unknown,
> {
  method: HttpMethod;
  path: string;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  auth?: AuthSpec;
  tags?: readonly string[];
  summary?: string;
  responseContentType?: string;
}
