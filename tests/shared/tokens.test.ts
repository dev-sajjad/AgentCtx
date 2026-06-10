import { describe, it, expect } from 'vitest';
import { estimateTokens, countTokens } from '../../src/shared/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~4 chars per token for prose', () => {
    // 11 chars -> ceil(11/4) = 3; 2 words -> chars wins
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('floors at the whitespace word count', () => {
    // 7 chars -> ceil(7/4) = 2, but 4 words -> word floor wins
    expect(estimateTokens('a b c d')).toBe(4);
  });

  it('is monotonic — longer text never counts fewer tokens', () => {
    expect(estimateTokens('short')).toBeLessThanOrEqual(
      estimateTokens('short but considerably longer string of text'),
    );
  });
});

describe('countTokens', () => {
  // Backed by tiktoken; falls back to the heuristic if the encoder is
  // unavailable. Assertions are robust to either path.
  it('returns 0 for empty input', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns a positive count for non-empty input', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  it('is deterministic for the same input', () => {
    expect(countTokens('the quick brown fox')).toBe(countTokens('the quick brown fox'));
  });
});
