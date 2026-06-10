import { get_encoding, type Tiktoken } from 'tiktoken';

import { logger } from './logger.js';

/**
 * Token counting.
 *
 * Two functions:
 *  - `estimateTokens` — a deterministic, dependency-free HEURISTIC (~4 chars per
 *    token). Always available, never throws. Used by the compiler by default so
 *    library/test paths stay fast and fully offline.
 *  - `countTokens` — backed by `tiktoken` (OpenAI BPE) for a closer estimate.
 *    Lazily loads and caches a `cl100k_base` encoder; falls back to
 *    `estimateTokens` if the encoder cannot load or fails.
 *
 * IMPORTANT (per docs/specs/token-budget.md): tiktoken uses OpenAI encodings, so
 * counts for Claude models are APPROXIMATE — typically within ~10–20% of the true
 * count (exact = the Anthropic count-tokens API). Good enough for live budgeting,
 * fully offline. Surface the approximation in any UI (e.g. a `~` prefix).
 */
export type TokenCounter = (text: string) => number;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const byChars = Math.ceil(text.length / 4);
  const byWords = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(byChars, byWords);
}

let cachedEncoder: Tiktoken | null = null;
let encoderUnavailable = false;

function getEncoder(): Tiktoken | null {
  if (encoderUnavailable) return null;
  if (cachedEncoder) return cachedEncoder;
  try {
    cachedEncoder = get_encoding('cl100k_base');
    return cachedEncoder;
  } catch (err) {
    encoderUnavailable = true;
    logger.debug('tiktoken unavailable, falling back to heuristic:', (err as Error).message);
    return null;
  }
}

/**
 * Count tokens with tiktoken, falling back to {@link estimateTokens}. The
 * `model` argument is reserved for per-model encoder selection; for now all
 * Claude/unknown models use `cl100k_base`.
 */
export function countTokens(text: string, _model?: string): number {
  if (text.length === 0) return 0;
  const encoder = getEncoder();
  if (!encoder) return estimateTokens(text);
  try {
    return encoder.encode(text).length;
  } catch (err) {
    logger.debug('tiktoken encode failed, using heuristic:', (err as Error).message);
    return estimateTokens(text);
  }
}
