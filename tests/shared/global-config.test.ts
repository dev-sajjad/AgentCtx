import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGlobalConfig } from '../../src/shared/global-config.js';

const KEY = 'AGENTCTX_GLOBAL_CONFIG';
let dir: string | undefined;

afterEach(() => {
  delete process.env[KEY];
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe('loadGlobalConfig', () => {
  it('returns schema defaults when the file is missing', () => {
    process.env[KEY] = '/nonexistent/agentctx-global-xyz.json';
    const c = loadGlobalConfig();
    expect(c.default_model).toBe('claude-sonnet-4-6');
    expect(c.token_warning_threshold).toBe(0.75);
    expect(c.vector_search).toBe(false);
  });

  it('reads values from the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'agentctx-gc-'));
    const p = join(dir, 'g.json');
    writeFileSync(p, JSON.stringify({ default_model: 'claude-opus-4-8', token_warning_threshold: 0.5 }));
    process.env[KEY] = p;
    const c = loadGlobalConfig();
    expect(c.default_model).toBe('claude-opus-4-8');
    expect(c.token_warning_threshold).toBe(0.5);
  });

  it('falls back to defaults on invalid JSON', () => {
    dir = mkdtempSync(join(tmpdir(), 'agentctx-gc2-'));
    const p = join(dir, 'bad.json');
    writeFileSync(p, '{ not valid json');
    process.env[KEY] = p;
    expect(loadGlobalConfig().default_model).toBe('claude-sonnet-4-6');
  });
});
