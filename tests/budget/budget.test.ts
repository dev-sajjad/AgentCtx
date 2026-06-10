import { describe, it, expect } from 'vitest';
import {
  BudgetTracker,
  contextWindow,
  DEFAULT_WINDOW,
} from '../../src/budget/index.js';
import type { CompiledContext, ContextSource } from '../../src/shared/types.js';

function src(
  type: ContextSource['type'],
  token_count: number,
  relevance_score: number,
  path?: string,
): ContextSource {
  return { type, content: 'x', token_count, relevance_score, ...(path ? { path } : {}) };
}

function compiled(sources: ContextSource[]): CompiledContext {
  return { system_prompt: 'x', token_count: 0, sources };
}

// role 100, CLAUDE.md 200, files (a+b) 400, memory 50
const SAMPLE = compiled([
  src('role', 100, 1),
  src('file', 200, 0.9, 'CLAUDE.md'),
  src('file', 300, 0.5, 'src/a.ts'),
  src('file', 100, 0.4, 'src/b.ts'),
  src('memory', 50, 0.6),
]);

const tracker = new BudgetTracker();
const rowTokens = (report: ReturnType<BudgetTracker['analyze']>, label: string): number | undefined =>
  report.rows.find((r) => r.label === label)?.tokens;

describe('contextWindow', () => {
  it('looks up known models', () => {
    expect(contextWindow('claude-sonnet-4-6')).toBe(200_000);
  });
  it('falls back to the default for unknown models', () => {
    expect(contextWindow('nope-9000')).toBe(DEFAULT_WINDOW);
  });
});

describe('BudgetTracker.analyze', () => {
  it('groups sources into labeled rows and totals them', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 1000, historyTokens: 100 });
    expect(rowTokens(report, 'Role template')).toBe(100);
    expect(rowTokens(report, 'CLAUDE.md')).toBe(200);
    expect(rowTokens(report, 'Files')).toBe(400);
    expect(rowTokens(report, 'Memory (injected)')).toBe(50);
    expect(rowTokens(report, 'Conversation history')).toBe(100);
    expect(report.totalUsed).toBe(850);
    expect(report.remaining).toBe(150);
    // no System prompt row unless systemTokens given
    expect(rowTokens(report, 'System prompt')).toBeUndefined();
  });

  it('flags warning status and emits suggestions at/over threshold', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 1000, historyTokens: 100 });
    expect(report.status).toBe('warning');
    expect(report.overThreshold).toBe(true);
    expect(report.overCeiling).toBe(false);
    expect(report.suggestions).toHaveLength(3);
    // lowest-relevance non-role source is src/b.ts (0.4)
    expect(report.suggestions[0]).toContain('src/b.ts');
  });

  it('reports healthy with no suggestions when well under budget', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 200_000 });
    expect(report.status).toBe('healthy');
    expect(report.overThreshold).toBe(false);
    expect(report.suggestions).toEqual([]);
  });

  it('detects overflow past the hard ceiling', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 500 });
    expect(report.totalUsed).toBe(750);
    expect(report.overCeiling).toBe(true);
    expect(report.status).toBe('over');
    expect(report.remaining).toBe(-250);
    expect(report.suggestions).toHaveLength(3);
  });

  it('includes a System prompt row when systemTokens is provided', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 200_000, systemTokens: 25 });
    expect(report.rows[0]?.label).toBe('System prompt');
    expect(rowTokens(report, 'System prompt')).toBe(25);
    expect(report.totalUsed).toBe(775);
  });
});

describe('BudgetTracker.format', () => {
  it('renders the breakdown table with bars and a status line', () => {
    const report = tracker.analyze(SAMPLE, { contextWindow: 1000, historyTokens: 100 });
    const out = tracker.format(report);
    expect(out).toContain('Context window: claude-sonnet-4-6 (1,000 tokens)');
    expect(out).toContain('Total used');
    expect(out).toContain('Remaining');
    expect(out).toContain('Suggestions:');
    expect(out).toContain('█');
    expect(out).toContain('~');
  });
});
