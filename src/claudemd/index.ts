import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { estimateTokens, type TokenCounter } from '../shared/tokens.js';
import type { MemoryEntry } from '../shared/types.js';

/**
 * CLAUDE.md manager — parse, validate, and keep the project's CLAUDE.md in sync
 * with what AgentCtx has learned (memory). CLAUDE.md is prepended to every
 * agent prompt, so it is high-leverage and worth keeping tight and current.
 *
 * Pure functions do the work (testable, no I/O); {@link ClaudeMdManager} is a
 * thin filesystem wrapper. See `agentctx claudemd read|validate|suggest|edit`.
 */

// Matches a level-2 heading (`## Title`) but not `###...`.
const H2_RE = /^##(?!#)\s+(.+?)\s*$/;
// Matches a level-1 title (`# Title`) but not `##...`.
const H1_RE = /^#(?!#)\s+(.+?)\s*$/;

/** A CLAUDE.md large enough that it noticeably taxes every prompt's budget. */
const LARGE_TOKEN_THRESHOLD = 8000;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ClaudeMdSection {
  /** Heading text after `## `. */
  heading: string;
  /** Body between this heading and the next `## ` (trailing blank lines trimmed). */
  body: string;
  /** Zero-based line index of the heading. */
  startLine: number;
}

export interface ParsedClaudeMd {
  /** Text of the first `# ` heading, or null if none. */
  title: string | null;
  /** Everything before the first `## ` (includes the title). */
  preamble: string;
  sections: ClaudeMdSection[];
}

/** Split CLAUDE.md into its top-level (`##`) sections. Nested `###` stay with their parent. */
export function parseClaudeMd(content: string): ParsedClaudeMd {
  const lines = content.split('\n');
  let title: string | null = null;
  const sections: ClaudeMdSection[] = [];

  // Heading line index of each `## ` section, in order.
  const heads: { heading: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (title === null) {
      const h1 = line.match(H1_RE);
      if (h1) title = h1[1]!.trim();
    }
    const h2 = line.match(H2_RE);
    if (h2) heads.push({ heading: h2[1]!.trim(), line: i });
  }

  const firstH2 = heads[0]?.line ?? lines.length;
  const preamble = lines.slice(0, firstH2).join('\n').trim();

  for (let k = 0; k < heads.length; k++) {
    const start = heads[k]!.line;
    const end = heads[k + 1]?.line ?? lines.length;
    const body = lines.slice(start + 1, end).join('\n').replace(/\s+$/, '').replace(/^\s+/, '');
    sections.push({ heading: heads[k]!.heading, body, startLine: start });
  }

  return { title, preamble, sections };
}

/** True when a section body is blank or only italic/empty-bullet placeholders. */
export function isPlaceholderBody(body: string): boolean {
  const real = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^_.*_$/.test(l)) // `_describe this_`
    .filter((l) => !/^[-*]\s*$/.test(l)) // empty bullet
    .filter((l) => !/^[-*]\s+[^`]*`\s*`\s*:?.*$/.test(l)); // `- Build: ``` (empty backticks)
  return real.length === 0;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface RecommendedSection {
  label: string;
  match: string[];
}

const RECOMMENDED: RecommendedSection[] = [
  { label: 'Architecture', match: ['architecture', 'overview', 'stack'] },
  { label: 'Coding conventions', match: ['convention', 'coding', 'style'] },
  { label: 'Commands', match: ['command', 'scripts', 'build', 'test'] },
  { label: 'Off-limits', match: ['off-limits', 'off limits', 'never', 'do not', 'guardrail'] },
];

export type IssueSeverity = 'warning' | 'info';

export interface ValidationIssue {
  severity: IssueSeverity;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  tokenCount: number;
  sectionCount: number;
}

/** Lint a CLAUDE.md: missing recommended sections, empty placeholders, size, title. */
export function validateClaudeMd(content: string, countTokens: TokenCounter = estimateTokens): ValidationResult {
  const parsed = parseClaudeMd(content);
  const issues: ValidationIssue[] = [];
  const headings = parsed.sections.map((s) => s.heading.toLowerCase());

  if (parsed.title === null) {
    issues.push({ severity: 'warning', message: 'no top-level `# ` title' });
  }

  for (const rec of RECOMMENDED) {
    const present = headings.some((h) => rec.match.some((m) => h.includes(m)));
    if (!present) {
      issues.push({ severity: 'info', message: `no recommended section: ${rec.label}` });
    }
  }

  for (const s of parsed.sections) {
    if (isPlaceholderBody(s.body)) {
      issues.push({ severity: 'warning', message: `section "${s.heading}" is empty or only a placeholder` });
    }
  }

  const tokenCount = countTokens(content);
  if (tokenCount > LARGE_TOKEN_THRESHOLD) {
    issues.push({
      severity: 'info',
      message: `CLAUDE.md is large (~${tokenCount} tokens); it is prepended to every prompt — consider trimming`,
    });
  }

  return { issues, tokenCount, sectionCount: parsed.sections.length };
}

// ---------------------------------------------------------------------------
// Suggestions (from memory)
// ---------------------------------------------------------------------------

export interface SuggestionSet {
  /** Section the additions belong under. */
  section: string;
  /** Bullet contents (without the leading `- `). */
  additions: string[];
}

/** Default section that AgentCtx writes learned facts into. */
export const FACTS_SECTION = 'Project facts (AgentCtx)';

/**
 * Propose CLAUDE.md additions from durable memory. Prefers long- then mid-term
 * entries, newest first, and skips anything already present in the document.
 */
export function suggestForClaudeMd(
  content: string,
  memories: MemoryEntry[],
  options: { section?: string; limit?: number } = {},
): SuggestionSet {
  const section = options.section ?? FACTS_SECTION;
  const limit = options.limit ?? 8;
  const haystack = content.toLowerCase();

  const rank = (layer: MemoryEntry['layer']): number => (layer === 'long' ? 0 : layer === 'mid' ? 1 : 2);
  const candidates = [...memories]
    .filter((m) => m.layer !== 'short')
    .sort((a, b) => rank(a.layer) - rank(b.layer) || b.created_at - a.created_at);

  const additions: string[] = [];
  const seen = new Set<string>();
  for (const m of candidates) {
    const fact = m.content.trim();
    const key = fact.toLowerCase();
    if (seen.has(key) || haystack.includes(key)) continue;
    seen.add(key);
    additions.push(fact);
    if (additions.length >= limit) break;
  }

  return { section, additions };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/** Add a `## heading` section with `body`, or replace the body of an existing one. */
export function upsertSection(content: string, heading: string, body: string): string {
  const lines = content.split('\n');
  const norm = heading.trim().toLowerCase();

  let start = -1;
  let existingHeading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(H2_RE);
    if (m && m[1]!.trim().toLowerCase() === norm) {
      start = i;
      existingHeading = m[1]!.trim();
      break;
    }
  }

  // Preserve the existing heading's casing on replace; use the caller's on insert.
  const block = `## ${existingHeading ?? heading.trim()}\n\n${body.trim()}`;

  if (start === -1) {
    const base = content.replace(/\n+$/, '');
    return `${base}\n\n${block}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (H2_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const rebuilt = [...lines.slice(0, start), ...block.split('\n'), '', ...lines.slice(end)];
  return rebuilt.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '') + '\n';
}

function bulletLines(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .map((l) => l.replace(/^[-*]\s+/, ''));
}

/** Merge a {@link SuggestionSet} into the document as bullets, de-duplicating. */
export function applySuggestions(content: string, set: SuggestionSet): string {
  if (set.additions.length === 0) return content;
  const parsed = parseClaudeMd(content);
  const existing = parsed.sections.find((s) => s.heading.toLowerCase() === set.section.toLowerCase());
  const merged = existing ? bulletLines(existing.body) : [];
  const have = new Set(merged.map((b) => b.toLowerCase()));
  for (const add of set.additions) {
    if (!have.has(add.toLowerCase())) merged.push(add);
  }
  const body = merged.map((b) => `- ${b}`).join('\n');
  return upsertSection(content, existing?.heading ?? set.section, body);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** Render a validation result for the CLI/MCP. */
export function formatValidation(result: ValidationResult): string {
  const lines: string[] = [];
  lines.push(`CLAUDE.md — ${result.sectionCount} sections, ~${result.tokenCount} tokens`);
  if (result.issues.length === 0) {
    lines.push('  ✓ no issues');
    return lines.join('\n');
  }
  for (const issue of result.issues) {
    lines.push(`  ${issue.severity === 'warning' ? '⚠' : 'ℹ'} ${issue.message}`);
  }
  return lines.join('\n');
}

/** Render a suggestion set for the CLI/MCP. */
export function formatSuggestions(set: SuggestionSet): string {
  if (set.additions.length === 0) return 'No new facts to add — CLAUDE.md already covers stored memory.';
  const lines = [`Suggested additions under "## ${set.section}":`, ''];
  for (const add of set.additions) lines.push(`  - ${add}`);
  lines.push('', 'Apply with: agentctx claudemd suggest --apply');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Filesystem wrapper
// ---------------------------------------------------------------------------

export class ClaudeMdManager {
  private readonly path: string;

  constructor(root: string = process.cwd()) {
    this.path = join(root, 'CLAUDE.md');
  }

  get filePath(): string {
    return this.path;
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): string | null {
    return this.exists() ? readFileSync(this.path, 'utf-8') : null;
  }

  write(content: string): void {
    writeFileSync(this.path, content, 'utf-8');
  }
}
