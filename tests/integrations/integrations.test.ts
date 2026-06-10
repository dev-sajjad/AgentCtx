import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportIntegration, getIntegration, isIntegration } from '../../src/integrations/index.js';
import type { RoleTemplate } from '../../src/shared/types.js';

const role: RoleTemplate = {
  name: 'Backend',
  description: '',
  system_prompt: 'You are a backend engineer.',
  context_includes: [],
  context_excludes: [],
  token_budget: 1000,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentctx-int-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('integrations', () => {
  it('isIntegration validates names', () => {
    expect(isIntegration('cursor')).toBe(true);
    expect(isIntegration('codex')).toBe(true);
    expect(isIntegration('nope')).toBe(false);
  });

  it('cursor adapter writes .cursorrules with prompt + notes', () => {
    const p = exportIntegration('cursor', { role, notes: ['use JWT', 'port 3000'] }, dir);
    expect(p).toBe(join(dir, '.cursorrules'));
    const text = readFileSync(p, 'utf-8');
    expect(text).toContain('You are a backend engineer.');
    expect(text).toContain('- use JWT');
    expect(text).toContain('Cursor rules');
  });

  it('codex adapter targets AGENTS.md', () => {
    expect(getIntegration('codex').rulesFile).toBe('AGENTS.md');
    const p = exportIntegration('codex', { role }, dir);
    expect(p).toBe(join(dir, 'AGENTS.md'));
  });
});
