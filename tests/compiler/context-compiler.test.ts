import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from '../../src/memory/db.js';
import { MemoryStore } from '../../src/memory/index.js';
import { ContextCompiler } from '../../src/compiler/index.js';
import type { RoleTemplate } from '../../src/shared/types.js';

function makeRole(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
  return {
    name: 'Test Engineer',
    description: 'for tests',
    system_prompt: 'You are a helpful engineer.',
    context_includes: ['**/*.ts'],
    context_excludes: ['**/*.test.ts'],
    token_budget: 5000,
    ...overrides,
  };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentctx-compiler-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'auth.ts'),
    'export function refreshAuthToken() { /* auth token jwt refresh logic */ }',
  );
  writeFileSync(
    join(root, 'src', 'layout.ts'),
    'export function renderLayout() { /* css grid layout styling */ }',
  );
  writeFileSync(join(root, 'src', 'auth.test.ts'), 'test for auth token — should be excluded');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('ContextCompiler', () => {
  it('puts the role prompt first, includes matched files, excludes test files', () => {
    const result = new ContextCompiler().compile({
      role: makeRole(),
      task: 'fix the auth token refresh bug',
      project: 'demo',
      projectRoot: root,
    });

    expect(result.sources[0]?.type).toBe('role');

    const filePaths = result.sources.filter((s) => s.type === 'file').map((s) => s.path);
    expect(filePaths).toContain('src/auth.ts');
    expect(filePaths).toContain('src/layout.ts');
    expect(filePaths).not.toContain('src/auth.test.ts');

    expect(result.system_prompt).toContain('You are a helpful engineer.');
    expect(result.system_prompt).toContain('refreshAuthToken');
    expect(result.token_count).toBeGreaterThan(0);
  });

  it('ranks the keyword-relevant file above the irrelevant one', () => {
    const result = new ContextCompiler().compile({
      role: makeRole(),
      task: 'auth token jwt refresh',
      project: 'demo',
      projectRoot: root,
    });

    const files = result.sources.filter((s) => s.type === 'file');
    const authIdx = files.findIndex((s) => s.path === 'src/auth.ts');
    const layoutIdx = files.findIndex((s) => s.path === 'src/layout.ts');

    expect(authIdx).toBeGreaterThanOrEqual(0);
    expect(layoutIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeLessThan(layoutIdx);
    expect(files[authIdx]!.relevance_score).toBeGreaterThan(files[layoutIdx]!.relevance_score);
  });

  it('pulls relevant memory and appends a "What you should know" section', () => {
    const db = new Database(':memory:');
    migrate(db);
    const memory = new MemoryStore(db);
    memory.save({
      layer: 'mid',
      content: 'auth tokens use JWT on port 3000',
      tags: ['auth'],
      project: 'demo',
      expires_at: null,
    });
    memory.save({
      layer: 'mid',
      content: 'unrelated note about colors',
      tags: [],
      project: 'demo',
      expires_at: null,
    });

    const result = new ContextCompiler().compile({
      role: makeRole(),
      task: 'auth token jwt',
      project: 'demo',
      projectRoot: root,
      memory,
    });

    const mem = result.sources.filter((s) => s.type === 'memory');
    expect(mem.length).toBeGreaterThan(0);
    expect(result.system_prompt).toContain('What you should know');
    expect(result.system_prompt).toContain('auth tokens use JWT on port 3000');
    expect(result.system_prompt).not.toContain('unrelated note about colors');
  });

  it('respects the token budget — a budget below the role prompt drops all chunks', () => {
    const result = new ContextCompiler().compile({
      role: makeRole({ token_budget: 1 }),
      task: 'auth token',
      project: 'demo',
      projectRoot: root,
    });

    expect(result.sources[0]?.type).toBe('role');
    expect(result.sources.filter((s) => s.type === 'file')).toHaveLength(0);
    expect(result.sources.filter((s) => s.type === 'memory')).toHaveLength(0);
  });
});
