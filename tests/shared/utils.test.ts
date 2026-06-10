import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  generateId,
  tokenize,
  keywordOverlap,
  expandHome,
  now,
  hoursToMs,
  daysToMs,
} from '../../src/shared/utils.js';

describe('generateId', () => {
  it('returns unique hex ids', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });

  it('applies an optional prefix', () => {
    expect(generateId('mem')).toMatch(/^mem_[0-9a-f]+$/);
  });
});

describe('tokenize', () => {
  it('lowercases and strips stopwords', () => {
    expect(tokenize('The Quick Brown Fox')).toEqual(['quick', 'brown', 'fox']);
  });

  it('drops single-char tokens and punctuation', () => {
    expect(tokenize('a, b! hello-world')).toEqual(['hello', 'world']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('keywordOverlap', () => {
  it('scores full overlap as 1', () => {
    expect(keywordOverlap('auth token', 'refresh the auth token here')).toBe(1);
  });

  it('scores no overlap as 0', () => {
    expect(keywordOverlap('database', 'frontend css layout')).toBe(0);
  });

  it('scores partial overlap', () => {
    expect(keywordOverlap('auth token', 'auth only')).toBeCloseTo(0.5);
  });

  it('returns 0 when the query has no usable keywords', () => {
    expect(keywordOverlap('a an the', 'anything here')).toBe(0);
  });
});

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands a tilde-prefixed path', () => {
    expect(expandHome('~/agentctx/memory.db')).toBe(join(homedir(), 'agentctx/memory.db'));
  });

  it('leaves absolute paths untouched', () => {
    expect(expandHome('/tmp/x')).toBe('/tmp/x');
  });
});

describe('time helpers', () => {
  it('now() returns a number', () => {
    expect(typeof now()).toBe('number');
  });

  it('converts hours to ms', () => {
    expect(hoursToMs(8)).toBe(8 * 60 * 60 * 1000);
  });

  it('converts days to ms', () => {
    expect(daysToMs(90)).toBe(90 * 24 * 60 * 60 * 1000);
  });
});
