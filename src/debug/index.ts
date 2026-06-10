import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RunRecordSchema,
  type ContextSource,
  type RunRecord,
} from '../shared/types.js';
import { generateId, now } from '../shared/utils.js';
import { logger } from '../shared/logger.js';

/**
 * Debug inspector. Persists every compiled context to disk and lets you replay
 * the last prompt or diff the last two runs — so "no magic": exactly what the
 * agent was told is always recoverable. See `agentctx debug last|diff|list`.
 *
 * Storage: one JSON file per run under `.agentctx/runs/`, named
 * `<created_at>-<id>.json`. Human-readable on purpose; gitignored.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export class DebugStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(process.cwd(), '.agentctx', 'runs');
  }

  /** Persist a run, assigning its `id` and `created_at`. Returns the record. */
  save(record: Omit<RunRecord, 'id' | 'created_at'>, createdAt: number = now()): RunRecord {
    mkdirSync(this.dir, { recursive: true });
    const full: RunRecord = { id: generateId('run'), created_at: createdAt, ...record };
    const file = join(this.dir, `${createdAt}-${full.id}.json`);
    writeFileSync(file, JSON.stringify(full, null, 2), 'utf-8');
    logger.debug('recorded run', full.id, 'command', full.command);
    return full;
  }

  /** All recorded runs, newest first. Invalid files are skipped. */
  list(limit?: number): RunRecord[] {
    if (!existsSync(this.dir)) return [];
    const records: RunRecord[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw: unknown = JSON.parse(readFileSync(join(this.dir, name), 'utf-8'));
        records.push(RunRecordSchema.parse(raw));
      } catch (err) {
        logger.debug('skip invalid run file', name, (err as Error).message);
      }
    }
    records.sort((a, b) => b.created_at - a.created_at);
    return limit !== undefined ? records.slice(0, limit) : records;
  }

  /** The most recent run, or null if none recorded. */
  last(): RunRecord | null {
    return this.list(1)[0] ?? null;
  }

  /** The two most recent runs as `{ latest, previous }`, or null if fewer than two. */
  lastTwo(): { latest: RunRecord; previous: RunRecord } | null {
    const two = this.list(2);
    if (two.length < 2) return null;
    return { latest: two[0]!, previous: two[1]! };
  }
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: ' ' | '+' | '-';
  text: string;
}

export interface SourceChange {
  type: string;
  path: string;
  before: number;
  after: number;
}

export interface DiffResult {
  tokenDelta: number;
  added: ContextSource[];
  removed: ContextSource[];
  changed: SourceChange[];
  promptDiff: DiffLine[];
}

/** LCS-based line diff. Returns context, additions, and removals in order. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: '-', text: a[i]! });
      i++;
    } else {
      out.push({ kind: '+', text: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', text: a[i++]! });
  while (j < m) out.push({ kind: '+', text: b[j++]! });
  return out;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES = 200;

function sourceKey(source: ContextSource): string {
  if (source.type === 'file') return `file:${source.path ?? ''}`;
  if (source.type === 'memory') return `memory:${source.content}`;
  return 'role';
}

export class DebugInspector {
  /** Render a single run: metadata, source manifest, and the full system prompt. */
  formatRun(record: RunRecord): string {
    const lines: string[] = [];
    lines.push(`Run ${record.id}  [${record.command}]`);
    lines.push(`When:    ${new Date(record.created_at).toISOString()}`);
    lines.push(`Role:    ${record.role}`);
    lines.push(`Task:    ${record.task || '(none)'}`);
    lines.push(`Project: ${record.project}`);
    if (record.model !== undefined) lines.push(`Model:   ${record.model}`);
    lines.push(`Tokens:  ${record.compiled.token_count}`);
    lines.push('');
    lines.push('Sources:');
    for (const source of record.compiled.sources) {
      lines.push(
        `  [${source.type}] ${source.path ?? source.type} — ${source.token_count}t score=${source.relevance_score.toFixed(3)}`,
      );
    }
    lines.push('');
    lines.push('───── system prompt ─────');
    lines.push(record.compiled.system_prompt);
    return lines.join('\n');
  }

  /** Compute a structured diff between two runs (older → newer). */
  diff(previous: RunRecord, latest: RunRecord): DiffResult {
    const prevMap = new Map<string, ContextSource>(
      previous.compiled.sources.map((s) => [sourceKey(s), s]),
    );
    const latestMap = new Map<string, ContextSource>(
      latest.compiled.sources.map((s) => [sourceKey(s), s]),
    );

    const added: ContextSource[] = [];
    const removed: ContextSource[] = [];
    const changed: SourceChange[] = [];

    for (const [key, source] of latestMap) {
      if (!prevMap.has(key)) added.push(source);
    }
    for (const [key, source] of prevMap) {
      if (!latestMap.has(key)) removed.push(source);
    }
    for (const [key, source] of latestMap) {
      const before = prevMap.get(key);
      if (before && before.token_count !== source.token_count) {
        changed.push({
          type: source.type,
          path: source.path ?? source.type,
          before: before.token_count,
          after: source.token_count,
        });
      }
    }

    const promptDiff = diffLines(
      previous.compiled.system_prompt.split('\n'),
      latest.compiled.system_prompt.split('\n'),
    );

    return {
      tokenDelta: latest.compiled.token_count - previous.compiled.token_count,
      added,
      removed,
      changed,
      promptDiff,
    };
  }

  /** Render a diff result. Prompt diff shows only changed lines (`+`/`-`). */
  formatDiff(previous: RunRecord, latest: RunRecord, result: DiffResult): string {
    const delta = `${result.tokenDelta >= 0 ? '+' : ''}${result.tokenDelta}`;
    const lines: string[] = [];
    lines.push(`Diff: ${previous.id} (older) → ${latest.id} (newer)`);
    lines.push(
      `Tokens: ${previous.compiled.token_count} → ${latest.compiled.token_count} (Δ ${delta})`,
    );
    lines.push(
      `Sources: +${result.added.length} added, -${result.removed.length} removed, ~${result.changed.length} changed`,
    );
    lines.push('');

    if (result.added.length > 0) {
      lines.push('Added:');
      for (const s of result.added) lines.push(`  + [${s.type}] ${s.path ?? s.type} (${s.token_count}t)`);
    }
    if (result.removed.length > 0) {
      lines.push('Removed:');
      for (const s of result.removed) lines.push(`  - [${s.type}] ${s.path ?? s.type} (${s.token_count}t)`);
    }
    if (result.changed.length > 0) {
      lines.push('Changed:');
      for (const c of result.changed) lines.push(`  ~ [${c.type}] ${c.path} ${c.before}t → ${c.after}t`);
    }

    lines.push('');
    lines.push('───── prompt diff ─────');
    const changes = result.promptDiff.filter((d) => d.kind !== ' ');
    if (changes.length === 0) {
      lines.push('  (system prompt identical)');
    } else {
      for (const d of changes.slice(0, MAX_DIFF_LINES)) lines.push(`${d.kind} ${d.text}`);
      if (changes.length > MAX_DIFF_LINES) {
        lines.push(`  … (${changes.length - MAX_DIFF_LINES} more changed lines)`);
      }
    }
    return lines.join('\n');
  }
}
