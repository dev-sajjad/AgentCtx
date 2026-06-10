import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Shared, dependency-free helpers used across modules. Keep pure and testable —
 * anything here is fair game for `tests/shared/utils.test.ts`.
 */

/** Generate a short, collision-resistant id. Optionally namespaced (`mem_a1b2…`). */
export function generateId(prefix = ''): string {
  const id = randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from',
]);

/**
 * Lowercase, split on non-alphanumeric boundaries, drop stopwords and
 * single-character tokens. The basis for keyword search and relevance scoring.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Fraction of distinct query keywords that appear in `text` (0..1).
 * Used to score files and memory entries against the current task.
 */
export function keywordOverlap(query: string, text: string): number {
  const q = Array.from(new Set(tokenize(query)));
  if (q.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  const hits = q.filter((t) => haystack.has(t)).length;
  return hits / q.length;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Current epoch milliseconds. Wrapped so callers/tests can reason about time. */
export function now(): number {
  return Date.now();
}

/** Hours → milliseconds. */
export function hoursToMs(hours: number): number {
  return Math.round(hours * 60 * 60 * 1000);
}

/** Days → milliseconds. */
export function daysToMs(days: number): number {
  return Math.round(days * 24 * 60 * 60 * 1000);
}
