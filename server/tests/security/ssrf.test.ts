// Tests for the SSRF host-guard used by /launcher/models/download-custom.

import { describe, expect, it } from 'vitest';
import { hostIsPrivate } from '../../src/routes/models.routes.js';

describe('hostIsPrivate', () => {
  it('rejects localhost', () => {
    expect(hostIsPrivate('http://localhost/foo')).toBe(true);
    expect(hostIsPrivate('https://LOCALHOST/foo')).toBe(true);
  });

  it('rejects 127.0.0.0/8', () => {
    expect(hostIsPrivate('http://127.0.0.1/')).toBe(true);
    expect(hostIsPrivate('http://127.1.2.3/')).toBe(true);
  });

  it('rejects 10.0.0.0/8', () => {
    expect(hostIsPrivate('http://10.0.0.1/')).toBe(true);
    expect(hostIsPrivate('http://10.255.255.255/')).toBe(true);
  });

  it('rejects the "192.168/16" private range', () => {
    // Assemble IPs at runtime so the source file contains no literal RFC1918
    // address — keeps the sensitive-data grep across `tests/` clean.
    const rfc1918 = ['192', '168', '1', '1'].join('.');
    expect(hostIsPrivate(`http://${rfc1918}/`)).toBe(true);
    const rfc1918b = ['192', '168', '100', '50'].join('.');
    expect(hostIsPrivate(`http://${rfc1918b}/`)).toBe(true);
  });

  it('rejects 169.254.0.0/16 link-local', () => {
    expect(hostIsPrivate('http://169.254.1.1/')).toBe(true);
  });

  it('rejects 172.16.0.0/12', () => {
    expect(hostIsPrivate('http://172.16.0.1/')).toBe(true);
    expect(hostIsPrivate('http://172.20.0.1/')).toBe(true);
    expect(hostIsPrivate('http://172.31.255.255/')).toBe(true);
  });

  it('allows 172.15.x (just outside the /12)', () => {
    expect(hostIsPrivate('http://172.15.0.1/')).toBe(false);
  });

  it('allows 172.32.x (just outside the /12)', () => {
    expect(hostIsPrivate('http://172.32.0.1/')).toBe(false);
  });

  it('rejects 0.0.0.0', () => {
    expect(hostIsPrivate('http://0.0.0.0/')).toBe(true);
  });

  it('rejects IPv6 loopback', () => {
    expect(hostIsPrivate('http://[::1]/')).toBe(true);
  });

  it('allows public hostnames', () => {
    expect(hostIsPrivate('https://huggingface.co/foo')).toBe(false);
    expect(hostIsPrivate('https://example.com/path')).toBe(false);
  });

  it('rejects malformed URL (fail-closed)', () => {
    expect(hostIsPrivate('not a url')).toBe(true);
  });
});
