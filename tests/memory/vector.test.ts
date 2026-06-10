import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/memory/db.js';
import { MemoryStore } from '../../src/memory/index.js';
import { VectorIndex, hashingEmbedder, cosine } from '../../src/memory/vector.js';

describe('hashingEmbedder', () => {
  const embed = hashingEmbedder(64);

  it('is deterministic and fixed-dimension', () => {
    expect(embed('auth token jwt')).toEqual(embed('auth token jwt'));
    expect(embed('auth token jwt')).toHaveLength(64);
  });

  it('is L2-normalized for non-empty text', () => {
    const v = embed('hello world');
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns a zero vector for empty/stopword-only text', () => {
    expect(hashingEmbedder(8)('')).toEqual(new Array<number>(8).fill(0));
  });
});

describe('cosine', () => {
  it('is 1 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it('is 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe('VectorIndex', () => {
  function setup() {
    const db = new Database(':memory:');
    migrate(db);
    return { store: new MemoryStore(db), vi: new VectorIndex(db, hashingEmbedder(256)) };
  }

  it('ranks the closest entry first, scoped to the project', () => {
    const { store, vi } = setup();
    const a = store.save({ layer: 'mid', content: 'auth tokens use JWT on port 3000', tags: ['auth'], project: 'demo', expires_at: null });
    const b = store.save({ layer: 'mid', content: 'frontend css grid layout colors', tags: [], project: 'demo', expires_at: null });
    const other = store.save({ layer: 'mid', content: 'auth jwt token', tags: [], project: 'OTHER', expires_at: null });
    vi.indexEntry(a);
    vi.indexEntry(b);
    vi.indexEntry(other);

    const results = vi.search('auth jwt token', 'demo', 10);
    expect(results[0]?.id).toBe(a.id);
    expect(results.map((r) => r.id)).not.toContain(other.id);
  });

  it('reindex backfills embeddings and search finds them', () => {
    const { store, vi } = setup();
    store.save({ layer: 'mid', content: 'deploy via github actions', tags: [], project: 'demo', expires_at: null });
    expect(vi.reindex(store.list('demo'))).toBe(1);
    expect(vi.search('github deploy', 'demo')[0]?.content).toContain('github');
  });
});
