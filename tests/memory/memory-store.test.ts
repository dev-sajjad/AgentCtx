import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/memory/db.js';
import { MemoryStore } from '../../src/memory/index.js';
import { now } from '../../src/shared/utils.js';

let store: MemoryStore;

beforeEach(() => {
  const db = new Database(':memory:');
  migrate(db);
  store = new MemoryStore(db);
});

describe('MemoryStore.save', () => {
  it('returns an id and created_at, and the entry is retrievable via list', () => {
    const saved = store.save({
      layer: 'short',
      content: 'deploy the staging server tonight',
      tags: ['ops'],
      project: 'proj-a',
      expires_at: null,
    });

    expect(saved.id).toMatch(/^mem_/);
    expect(typeof saved.created_at).toBe('number');

    const listed = store.list('proj-a');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(saved.id);
    expect(listed[0]?.content).toBe('deploy the staging server tonight');
    expect(listed[0]?.tags).toEqual(['ops']);
  });
});

describe('MemoryStore.search', () => {
  it('finds an entry by a content keyword, excludes non-matches, and scopes by project', () => {
    store.save({
      layer: 'mid',
      content: 'the database migration uses sqlite',
      tags: ['db'],
      project: 'proj-a',
      expires_at: null,
    });
    store.save({
      layer: 'mid',
      content: 'remember to water the plants',
      tags: ['home'],
      project: 'proj-a',
      expires_at: null,
    });
    store.save({
      layer: 'mid',
      content: 'sqlite database tuning notes',
      tags: ['db'],
      project: 'proj-b',
      expires_at: null,
    });

    const results = store.search('sqlite database', 'proj-a');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('the database migration uses sqlite');
    expect(results.every((r) => r.project === 'proj-a')).toBe(true);
  });

  it('respects the limit arg', () => {
    for (let i = 0; i < 5; i += 1) {
      store.save({
        layer: 'short',
        content: `caching strategy variant ${i}`,
        tags: [],
        project: 'proj-a',
        expires_at: null,
      });
    }

    const results = store.search('caching strategy', 'proj-a', 2);
    expect(results).toHaveLength(2);
  });
});

describe('MemoryStore.list', () => {
  it('filters by layer', () => {
    store.save({
      layer: 'short',
      content: 'short lived note',
      tags: [],
      project: 'proj-a',
      expires_at: null,
    });
    store.save({
      layer: 'long',
      content: 'long lived note',
      tags: [],
      project: 'proj-a',
      expires_at: null,
    });

    const longOnly = store.list('proj-a', 'long');
    expect(longOnly).toHaveLength(1);
    expect(longOnly[0]?.layer).toBe('long');
    expect(longOnly[0]?.content).toBe('long lived note');
  });
});

describe('MemoryStore.prune', () => {
  it('deletes expired entries, keeps non-expiring ones, and returns the count', () => {
    const expired = store.save({
      layer: 'short',
      content: 'this expired already',
      tags: [],
      project: 'proj-a',
      expires_at: 1000,
    });
    store.save({
      layer: 'long',
      content: 'this never expires',
      tags: [],
      project: 'proj-a',
      expires_at: null,
    });
    store.save({
      layer: 'short',
      content: 'this expires far in the future',
      tags: [],
      project: 'proj-a',
      expires_at: now() + 1_000_000,
    });

    const removed = store.prune();
    expect(removed).toBe(1);

    const remaining = store.list('proj-a');
    expect(remaining).toHaveLength(2);
    expect(remaining.some((r) => r.id === expired.id)).toBe(false);
  });
});
