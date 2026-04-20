// Tests for logger redaction helpers.

import { describe, expect, it } from 'vitest';
import { redactHeaders, redactBody } from '../../src/middleware/logging.js';

describe('redactHeaders', () => {
  it('redacts Authorization', () => {
    const out = redactHeaders({ authorization: 'Bearer topsecret', accept: '*/*' });
    expect(out.authorization).toBe('[redacted]');
    expect(out.accept).toBe('*/*');
  });

  it('redacts cookie and x-api-key (case-insensitive)', () => {
    const out = redactHeaders({ Cookie: 'id=abc', 'X-API-Key': 'k' });
    expect(out.Cookie).toBe('[redacted]');
    expect(out['X-API-Key']).toBe('[redacted]');
  });
});

describe('redactBody', () => {
  it('redacts apiKey, hfToken, token, password, secret', () => {
    const out = redactBody({
      apiKey: 'x', hfToken: 'y', token: 'z', password: 'p', secret: 's', safe: 'ok',
    }) as Record<string, string>;
    expect(out.apiKey).toBe('[redacted]');
    expect(out.hfToken).toBe('[redacted]');
    expect(out.token).toBe('[redacted]');
    expect(out.password).toBe('[redacted]');
    expect(out.secret).toBe('[redacted]');
    expect(out.safe).toBe('ok');
  });

  it('passes through non-object bodies untouched', () => {
    expect(redactBody('plain string')).toBe('plain string');
    expect(redactBody(null)).toBe(null);
    expect(redactBody(undefined)).toBe(undefined);
  });
});
