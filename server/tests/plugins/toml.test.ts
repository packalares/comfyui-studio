// Coverage for the lightweight TOML reader used by plugin metadata extraction.

import { describe, expect, it } from 'vitest';
import { parseMinimalToml } from '../../src/services/plugins/toml.minimal.js';

describe('parseMinimalToml', () => {
  it('parses pyproject-style project metadata', () => {
    const input = `
[project]
name = "my-plugin"
version = "1.2.3"
description = "a cool plugin"
dependencies = ["a", "b"]
`;
    const r = parseMinimalToml(input) as { project: Record<string, unknown> };
    expect(r.project.name).toBe('my-plugin');
    expect(r.project.version).toBe('1.2.3');
    expect(r.project.description).toBe('a cool plugin');
    expect(r.project.dependencies).toEqual(['a', 'b']);
  });

  it('handles [tool.comfy] nested sections', () => {
    const input = `
[tool.comfy]
DisplayName = "ComfyCoolThing"
`;
    const r = parseMinimalToml(input) as { tool: { comfy: { DisplayName: string } } };
    expect(r.tool.comfy.DisplayName).toBe('ComfyCoolThing');
  });

  it('handles inline author table', () => {
    const input = `
[project]
authors = [{name = "Alice", email = "a@example.com"}]
`;
    const r = parseMinimalToml(input) as { project: { authors: Array<{ name: string; email: string }> } };
    expect(Array.isArray(r.project.authors)).toBe(true);
    expect(r.project.authors[0].name).toBe('Alice');
  });

  it('ignores comments', () => {
    const input = `[p]\n# hello\nkey = "value" # trailing\n`;
    const r = parseMinimalToml(input) as { p: { key: string } };
    expect(r.p.key).toBe('value');
  });

  it('handles bool + number values', () => {
    const input = `[p]\nflag = true\nnum = 42\n`;
    const r = parseMinimalToml(input) as { p: { flag: boolean; num: number } };
    expect(r.p.flag).toBe(true);
    expect(r.p.num).toBe(42);
  });
});
