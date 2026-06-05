// Typed client-side mirror of the server's canonical error envelope.
//
// `code` is the stable machine-readable union from `envelope.contract.ts`. UI
// code must match on `code` (e.g. `err.code === 'not_found'`), never on the
// human-readable `message`. `status` is the HTTP status the server attached
// per `errorStatus[code]`; surfaced for callers that key on status as well.

import type { ErrorCode } from '@server/contracts/envelope.contract';

export interface ApiClientErrorInit {
  code: ErrorCode;
  status: number;
  message: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(init: ApiClientErrorInit) {
    super(init.message);
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status;
    if (init.details !== undefined) this.details = init.details;
  }
}

export function isApiClientError(value: unknown): value is ApiClientError {
  return value instanceof ApiClientError;
}
