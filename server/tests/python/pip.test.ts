// argv assertions for pip install/uninstall + pipSource validation.

import { describe, expect, it } from 'vitest';
import { setPipSource, getPipSource } from '../../src/services/python/pipSource.service.js';
import * as packages from '../../src/services/python/packages.service.js';
import * as deps from '../../src/services/python/dependencies.service.js';

describe('pip source set/get', () => {
  it('rejects non-http(s) URLs', () => {
    expect(() => setPipSource('ftp://example.com/simple')).toThrow(/http/);
    expect(() => setPipSource('')).toThrow(/required/);
  });

  it('accepts https URL and round-trips', () => {
    setPipSource('https://pypi.example.com/simple');
    expect(getPipSource()).toBe('https://pypi.example.com/simple');
  });
});

describe('pip packages argv validation', () => {
  it('rejects empty or flag-like package names', async () => {
    await expect(packages.uninstallPackage('')).rejects.toThrow(/required/);
    await expect(packages.uninstallPackage('-r foo')).rejects.toThrow(/Invalid/);
    await expect(packages.uninstallPackage('pkg --extra')).rejects.toThrow(/Invalid/);
  });

  it('rejects empty install spec', async () => {
    await expect(packages.installPackage('   ')).rejects.toThrow(/required/);
  });
});

describe('pip requirements parser', () => {
  it('parses name + version spec + comments + empty lines', () => {
    const body = `# header\n\nfoo==1.0.0\nbar>=2.1\nbaz\n# trailing comment\n`;
    const r = deps.parseRequirements(body);
    expect(r).toEqual([
      { name: 'foo', version: '==1.0.0' },
      { name: 'bar', version: '>=2.1' },
      { name: 'baz', version: '' },
    ]);
  });

  it('isCompatible matches only strict ==', () => {
    expect(deps.isCompatible('1.2.3', '==1.2.3')).toBe(true);
    expect(deps.isCompatible('1.2.3', '==1.2.4')).toBe(false);
    expect(deps.isCompatible('1.2.3', '>=1.0')).toBe(true); // only == is enforced
  });
});
