import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { globSync } from 'glob';

import type {
  CompiledContext,
  ContextSource,
  RoleTemplate,
} from '../shared/types.js';
import type { MemoryEntry } from '../shared/types.js';
import { keywordOverlap, now, daysToMs } from '../shared/utils.js';
import { estimateTokens, type TokenCounter } from '../shared/tokens.js';
import { logger } from '../shared/logger.js';
import type { MemoryStore } from '../memory/index.js';

/**
 * Relevance weights. Must sum to 1.0. See docs/specs/context-compiler.md.
 */
export interface CompilerWeights {
  keyword: number;
  recency: number;
  size: number;
}

export const DEFAULT_WEIGHTS: CompilerWeights = {
  keyword: 0.6,
  recency: 0.25,
  size: 0.15,
};

/** Default model context window (tokens) when the caller does not specify one. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Fraction of the context window reserved for history + the model's response. */
export const DEFAULT_HEADROOM = 0.25;

/** Recency horizon: anything older than this scores ~0 on recency. */
export const DEFAULT_MAX_AGE_MS = daysToMs(90);

/** Token size at/above which a chunk gets the full size penalty. */
export const DEFAULT_LARGE_CHUNK_TOKENS = 8000;

export interface CompileOptions {
  /** The active role template (caller resolves it via RoleManager + config). */
  role: RoleTemplate;
  /** The task the agent is about to work on — drives keyword relevance. */
  task: string;
  /** Project name, used to scope the memory search. */
  project: string;
  /** Root the role's globs resolve against. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Optional memory store. If omitted, no memory chunks are pulled. */
  memory?: MemoryStore;
  /** Model context window in tokens. Default {@link DEFAULT_CONTEXT_WINDOW}. */
  contextWindow?: number;
  /** Max memory entries to consider. Default 10. */
  memoryLimit?: number;
  /** Relevance weights. Default {@link DEFAULT_WEIGHTS}. */
  weights?: CompilerWeights;
  /** Token counter. Default {@link estimateTokens} (swap in tiktoken later). */
  countTokens?: TokenCounter;
  /** Recency horizon in ms. Default {@link DEFAULT_MAX_AGE_MS}. */
  maxAgeMs?: number;
  /** Size-penalty scale in tokens. Default {@link DEFAULT_LARGE_CHUNK_TOKENS}. */
  largeChunkTokens?: number;
  /** Headroom fraction reserved. Default {@link DEFAULT_HEADROOM}. */
  headroom?: number;
}

/** An internal scoring candidate before packing. */
interface Candidate {
  type: 'file' | 'memory';
  path?: string;
  content: string;
  tokenCount: number;
  score: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Assembles a token-budget-aware context bundle from the role prompt, project
 * files, and memory. Deterministic and fully inspectable — every included chunk
 * is reported as a {@link ContextSource} with its own token count and score.
 *
 * See docs/specs/context-compiler.md for the full algorithm.
 */
export class ContextCompiler {
  compile(options: CompileOptions): CompiledContext {
    const {
      role,
      task,
      project,
      projectRoot = process.cwd(),
      memory,
      contextWindow = DEFAULT_CONTEXT_WINDOW,
      memoryLimit = 10,
      weights = DEFAULT_WEIGHTS,
      countTokens = estimateTokens,
      maxAgeMs = DEFAULT_MAX_AGE_MS,
      largeChunkTokens = DEFAULT_LARGE_CHUNK_TOKENS,
      headroom = DEFAULT_HEADROOM,
    } = options;

    const reference = now();

    // 1. Pinned role prompt — always included, counts against the budget first.
    const roleTokens = countTokens(role.system_prompt);
    const effectiveBudget = Math.min(
      role.token_budget,
      Math.floor((1 - headroom) * contextWindow),
    );
    let remaining = Math.max(0, effectiveBudget - roleTokens);
    if (roleTokens > effectiveBudget) {
      logger.warn(
        'role system_prompt alone',
        roleTokens,
        'tokens exceeds effective budget',
        effectiveBudget,
      );
    }

    // 2-4. Build candidates from files and memory, scored by relevance.
    const fileCandidates = this.scoreFiles(role, task, projectRoot, {
      weights,
      countTokens,
      maxAgeMs,
      largeChunkTokens,
      reference,
    });

    const memoryCandidates = this.scoreMemory(task, project, memory, memoryLimit, {
      weights,
      countTokens,
      maxAgeMs,
      largeChunkTokens,
      reference,
    });

    // 5. Rank all candidates together and greedily pack into the budget.
    const ranked = [...fileCandidates, ...memoryCandidates].sort(
      (a, b) => b.score - a.score,
    );

    const includedFiles: ContextSource[] = [];
    const includedMemory: ContextSource[] = [];
    for (const candidate of ranked) {
      if (candidate.tokenCount > remaining) {
        logger.debug('skip', candidate.type, candidate.path ?? '', 'too large for remaining budget');
        continue;
      }
      remaining -= candidate.tokenCount;
      const source: ContextSource = {
        type: candidate.type,
        content: candidate.content,
        token_count: candidate.tokenCount,
        relevance_score: candidate.score,
        ...(candidate.path !== undefined ? { path: candidate.path } : {}),
      };
      if (candidate.type === 'file') includedFiles.push(source);
      else includedMemory.push(source);
    }

    // 6-7. Assemble: role prompt, then file context, then "What you should know".
    const systemPrompt = this.assemble(role, includedFiles, includedMemory);

    // 8. Build the source manifest (role first) and return.
    const roleSource: ContextSource = {
      type: 'role',
      content: role.system_prompt,
      token_count: roleTokens,
      relevance_score: 1, // pinned; included structurally, not by score
    };
    const sources: ContextSource[] = [roleSource, ...includedFiles, ...includedMemory];
    const tokenCount = countTokens(systemPrompt);

    logger.debug(
      'compiled context',
      'files',
      includedFiles.length,
      'memory',
      includedMemory.length,
      'tokens',
      tokenCount,
    );

    return {
      system_prompt: systemPrompt,
      token_count: tokenCount,
      sources,
    };
  }

  /** Resolve `context_includes` minus `context_excludes`, read + score each file. */
  private scoreFiles(
    role: RoleTemplate,
    task: string,
    projectRoot: string,
    ctx: ScoreContext,
  ): Candidate[] {
    if (role.context_includes.length === 0) return [];

    let matches: string[];
    try {
      matches = globSync(role.context_includes, {
        cwd: projectRoot,
        ignore: role.context_excludes,
        nodir: true,
        dot: false,
      });
    } catch (err) {
      logger.warn('glob failed', (err as Error).message);
      return [];
    }

    const candidates: Candidate[] = [];
    for (const rel of matches) {
      const abs = join(projectRoot, rel);
      let content: string;
      let mtimeMs: number;
      try {
        content = readFileSync(abs, 'utf-8');
        mtimeMs = statSync(abs).mtimeMs;
      } catch (err) {
        logger.debug('skip unreadable file', rel, (err as Error).message);
        continue;
      }
      const tokenCount = ctx.countTokens(content);
      const score = this.score(task, content, tokenCount, mtimeMs, ctx);
      candidates.push({ type: 'file', path: rel, content, tokenCount, score });
    }
    return candidates;
  }

  /** Pull memory via keyword search and score each entry. */
  private scoreMemory(
    task: string,
    project: string,
    memory: MemoryStore | undefined,
    limit: number,
    ctx: ScoreContext,
  ): Candidate[] {
    if (!memory) return [];
    let entries: MemoryEntry[];
    try {
      entries = memory.search(task, project, limit);
    } catch (err) {
      logger.warn('memory search failed', (err as Error).message);
      return [];
    }
    return entries.map((entry) => {
      const text = `${entry.content} ${entry.tags.join(' ')}`;
      const tokenCount = ctx.countTokens(entry.content);
      const score = this.score(task, text, tokenCount, entry.created_at, ctx);
      return { type: 'memory' as const, content: entry.content, tokenCount, score };
    });
  }

  /** Weighted relevance: keyword overlap + recency + inverse size. */
  private score(
    task: string,
    text: string,
    tokenCount: number,
    timestampMs: number,
    ctx: ScoreContext,
  ): number {
    const keyword = keywordOverlap(task, text);
    const ageMs = Math.max(0, ctx.reference - timestampMs);
    const recency = clamp(1 - ageMs / ctx.maxAgeMs, 0, 1);
    const sizePenalty = clamp(tokenCount / ctx.largeChunkTokens, 0, 1);
    return (
      ctx.weights.keyword * keyword +
      ctx.weights.recency * recency +
      ctx.weights.size * (1 - sizePenalty)
    );
  }

  /** Render the final system prompt: role, file context, memory section. */
  private assemble(
    role: RoleTemplate,
    files: ContextSource[],
    memory: ContextSource[],
  ): string {
    const parts: string[] = [role.system_prompt.trim()];

    if (files.length > 0) {
      parts.push('# Project context');
      for (const file of files) {
        parts.push(`## ${file.path ?? 'file'}\n\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    if (memory.length > 0) {
      parts.push('# What you should know');
      parts.push(memory.map((m) => `- ${m.content}`).join('\n'));
    }

    return parts.join('\n\n');
  }
}

/** Shared, per-compile scoring parameters threaded into the scorers. */
interface ScoreContext {
  weights: CompilerWeights;
  countTokens: TokenCounter;
  maxAgeMs: number;
  largeChunkTokens: number;
  reference: number;
}
