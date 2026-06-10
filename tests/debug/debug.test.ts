import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DebugStore, DebugInspector, diffLines } from '../../src/debug/index.js';
import type { CompiledContext, ContextSource, RunRecord } from '../../src/shared/types.js';

function src(
  type: ContextSource['type'],
  token_count: number,
  relevance_score: number,
  path?: string,
): ContextSource {
  return { type, content: 'x', token_count, relevance_score, ...(path ? { path } : {}) };
}

function compiled(
  sources: ContextSource[],
  system_prompt: string,
  token_count: number,
): CompiledContext {
  return { system_prompt, token_count, sources };
}

function runInput(c: CompiledContext): Omit<RunRecord, 'id' | 'created_at'> {
  return { command: 'compile', role: 'backend-engineer', task: 'fix auth', project: 'demo', compiled: c };
}

function record(id: string, created_at: number, c: CompiledContext): RunRecord {
  return { id, created_at, command: 'compile', role: 'backend-engineer', task: 'fix auth', project: 'demo', compiled: c };
}

describe('DebugStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentctx-debug-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves runs and lists them newest-first', () => {
    const store = new DebugStore(dir);
    const a = store.save(runInput(compiled([], 'a', 1)), 1000);
    const b = store.save(runInput(compiled([], 'b', 2)), 2000);
    const c = store.save(runInput(compiled([], 'c', 3)), 3000);

    expect(store.list().map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(store.last()?.id).toBe(c.id);
    expect(store.list(2)).toHaveLength(2);

    const pair = store.lastTwo();
    expect(pair?.latest.id).toBe(c.id);
    expect(pair?.previous.id).toBe(b.id);
  });

  it('returns null when fewer than the required runs exist', () => {
    const store = new DebugStore(dir);
    expect(store.last()).toBeNull();
    expect(store.lastTwo()).toBeNull();
    store.save(runInput(compiled([], 'only', 1)), 1000);
    expect(store.lastTwo()).toBeNull();
    expect(store.last()).not.toBeNull();
  });

  it('skips invalid run files', () => {
    const store = new DebugStore(dir);
    store.save(runInput(compiled([], 'ok', 1)), 1000);
    writeFileSync(join(dir, '9999-bad.json'), '{ not valid json', 'utf-8');
    expect(store.list()).toHaveLength(1);
  });
});

describe('diffLines', () => {
  it('produces an LCS line diff', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
      { kind: ' ', text: 'a' },
      { kind: '-', text: 'b' },
      { kind: '+', text: 'x' },
      { kind: ' ', text: 'c' },
    ]);
  });

  it('handles pure additions', () => {
    expect(diffLines([], ['x', 'y'])).toEqual([
      { kind: '+', text: 'x' },
      { kind: '+', text: 'y' },
    ]);
  });
});

describe('DebugInspector', () => {
  it('formatRun renders metadata, sources, and the prompt', () => {
    const rec = record('run_1', 1000, compiled([src('role', 10, 1)], 'You are an engineer.', 10));
    const out = new DebugInspector().formatRun(rec);
    expect(out).toContain('fix auth');
    expect(out).toContain('backend-engineer');
    expect(out).toContain('You are an engineer.');
    expect(out).toContain('[role]');
  });

  it('diff reports added, removed, changed sources and token delta', () => {
    const prev = record(
      'run_a',
      1000,
      compiled(
        [src('role', 10, 1), src('file', 100, 0.5, 'src/a.ts'), src('file', 50, 0.4, 'src/old.ts')],
        'line1\nline2',
        160,
      ),
    );
    const latest = record(
      'run_b',
      2000,
      compiled(
        [src('role', 10, 1), src('file', 130, 0.5, 'src/a.ts'), src('file', 70, 0.3, 'src/new.ts')],
        'line1\nCHANGED',
        210,
      ),
    );

    const inspector = new DebugInspector();
    const result = inspector.diff(prev, latest);

    expect(result.tokenDelta).toBe(50);
    expect(result.added.map((s) => s.path)).toContain('src/new.ts');
    expect(result.removed.map((s) => s.path)).toContain('src/old.ts');
    expect(result.changed.find((c) => c.path === 'src/a.ts')).toMatchObject({
      before: 100,
      after: 130,
    });

    const out = inspector.formatDiff(prev, latest, result);
    expect(out).toContain('src/new.ts');
    expect(out).toContain('src/old.ts');
    expect(out).toContain('Δ +50');
    expect(out).toContain('+ CHANGED');
  });
});
