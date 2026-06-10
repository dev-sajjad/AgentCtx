import { basename } from 'node:path';

import type { CompiledContext } from '../shared/types.js';
import { logger } from '../shared/logger.js';

/**
 * Token budget tracking. Turns a {@link CompiledContext} into a per-source
 * breakdown of context-window usage, with warning status and trim suggestions.
 * Drives `agentctx budget`. See docs/specs/token-budget.md.
 */

/** Context window sizes (tokens) keyed by model id, with a safe default. */
export const MODEL_WINDOWS: Record<string, number> = {
  'claude-opus-4-8': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-haiku-4-5': 200_000,
};

export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_WINDOW = 200_000;
export const DEFAULT_WARNING_THRESHOLD = 0.75;

/** Resolve a model id to its context window, falling back to {@link DEFAULT_WINDOW}. */
export function contextWindow(model: string): number {
  return MODEL_WINDOWS[model] ?? DEFAULT_WINDOW;
}

/** Max bar width (chars) representing 100% of the window. */
const BAR_MAX = 40;

export type BudgetStatus = 'healthy' | 'warning' | 'over';

export interface BudgetRow {
  label: string;
  tokens: number;
  /** Fraction of the context window (0..1). */
  percent: number;
}

export interface BudgetReport {
  model: string;
  contextWindow: number;
  rows: BudgetRow[];
  totalUsed: number;
  totalPercent: number;
  remaining: number;
  remainingPercent: number;
  /** Warning threshold as a fraction (0..1). */
  warningThreshold: number;
  overThreshold: boolean;
  overCeiling: boolean;
  status: BudgetStatus;
  suggestions: string[];
}

export interface AnalyzeOptions {
  /** Model id; selects the context window. Default {@link DEFAULT_MODEL}. */
  model?: string;
  /** Explicit context window override (tokens). */
  contextWindow?: number;
  /** Conversation-history tokens supplied by the caller. Default 0. */
  historyTokens?: number;
  /** Base system-prompt tokens (harness overhead). Default 0 → row omitted. */
  systemTokens?: number;
  /** Warning threshold fraction. Default {@link DEFAULT_WARNING_THRESHOLD}. */
  warningThreshold?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function bar(percent: number): string {
  return '█'.repeat(Math.round(clamp(percent, 0, 1) * BAR_MAX));
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

export class BudgetTracker {
  /**
   * Group a compiled context's sources into labeled rows and compute usage
   * against the model's window. Uses the `token_count` already recorded on each
   * `ContextSource`, so the report is consistent with whatever counter the
   * compiler used.
   */
  analyze(compiled: CompiledContext, options: AnalyzeOptions = {}): BudgetReport {
    const model = options.model ?? DEFAULT_MODEL;
    const window = options.contextWindow ?? contextWindow(model);
    const threshold = options.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    const history = options.historyTokens ?? 0;
    const system = options.systemTokens ?? 0;

    let role = 0;
    let claudemd = 0;
    let files = 0;
    let memory = 0;
    for (const source of compiled.sources) {
      if (source.type === 'role') {
        role += source.token_count;
      } else if (source.type === 'memory') {
        memory += source.token_count;
      } else if (source.path !== undefined && basename(source.path) === 'CLAUDE.md') {
        claudemd += source.token_count;
      } else {
        files += source.token_count;
      }
    }

    const rows: BudgetRow[] = [];
    const addRow = (label: string, tokens: number): void => {
      rows.push({ label, tokens, percent: tokens / window });
    };
    if (system > 0) addRow('System prompt', system);
    addRow('Role template', role);
    if (claudemd > 0) addRow('CLAUDE.md', claudemd);
    addRow('Memory (injected)', memory);
    addRow('Files', files);
    addRow('Conversation history', history);

    const totalUsed = system + role + claudemd + memory + files + history;
    const remaining = window - totalUsed;
    const overCeiling = totalUsed > window;
    const overThreshold = totalUsed >= threshold * window;
    const status: BudgetStatus = overCeiling ? 'over' : overThreshold ? 'warning' : 'healthy';
    const suggestions = overThreshold || overCeiling ? this.suggest(compiled) : [];

    return {
      model,
      contextWindow: window,
      rows,
      totalUsed,
      totalPercent: totalUsed / window,
      remaining,
      remainingPercent: remaining / window,
      warningThreshold: threshold,
      overThreshold,
      overCeiling,
      status,
      suggestions,
    };
  }

  /** Trim suggestions, ordered cheapest-impact first. */
  private suggest(compiled: CompiledContext): string[] {
    const droppable = compiled.sources.filter((s) => s.type !== 'role');
    const lowest = [...droppable].sort((a, b) => a.relevance_score - b.relevance_score)[0];
    const suggestions: string[] = [];
    if (lowest) {
      const where = lowest.path !== undefined ? `${lowest.path}` : lowest.type;
      suggestions.push(
        `Drop lowest-relevance source (${where}, score ${lowest.relevance_score.toFixed(2)})`,
      );
    } else {
      suggestions.push('Drop the lowest-relevance context sources');
    }
    suggestions.push('Summarize or truncate conversation history');
    suggestions.push("Lower the role's token_budget");
    return suggestions;
  }

  /** Render a report as the ASCII breakdown table. */
  format(report: BudgetReport): string {
    const sep = '─'.repeat(60);
    const labelWidth = Math.max(
      ...report.rows.map((r) => r.label.length),
      'Conversation history'.length,
    );

    const formatRow = (label: string, tokens: number, percent: number): string => {
      const l = label.padEnd(labelWidth);
      const t = `~${num(tokens)}`.padStart(11);
      const p = `${(percent * 100).toFixed(1)}%`.padStart(6);
      return `${l} ${t} tokens ${p}  ${bar(percent)}`;
    };

    const lines: string[] = [];
    lines.push(`Context window: ${report.model} (${num(report.contextWindow)} tokens)`);
    lines.push(sep);
    for (const row of report.rows) {
      lines.push(formatRow(row.label, row.tokens, row.percent));
    }
    lines.push(sep);
    lines.push(formatRow('Total used', report.totalUsed, report.totalPercent));

    const icon =
      report.status === 'healthy'
        ? '✓ healthy'
        : report.status === 'warning'
          ? '⚠ warning'
          : '✗ over budget';
    lines.push(`${formatRow('Remaining', report.remaining, report.remainingPercent)}  ${icon}`);
    lines.push('');

    if (report.suggestions.length === 0) {
      lines.push('Suggestions: none');
    } else {
      lines.push('Suggestions:');
      for (const suggestion of report.suggestions) lines.push(`  - ${suggestion}`);
    }
    lines.push('');
    lines.push('~ token counts are approximate (tiktoken/heuristic, not exact for Claude)');

    logger.debug('formatted budget report', report.status, report.totalUsed, 'tokens');
    return lines.join('\n');
  }
}
