import type { Database as DatabaseType } from 'better-sqlite3';

import type { MemoryEntry, MemoryLayer } from '../shared/types.js';
import { tokenize } from '../shared/utils.js';
import { logger } from '../shared/logger.js';

/**
 * Vector search over memory, flagged behind the `vector_search` global config.
 *
 * The embedder is injectable. The default {@link hashingEmbedder} is a zero-dep,
 * fully-offline lexical embedding (feature hashing) — a real vector space that
 * ranks by term overlap, a step up from SQL LIKE. For true semantic search,
 * inject an embedder backed by a local model (e.g. transformers.js) or an API.
 *
 * Vectors are stored as JSON in the `memory_embeddings` table; ranking is cosine
 * similarity computed in JS. (LanceDB can replace this storage layer later.)
 */

/** Maps text to a fixed-length embedding vector. */
export type Embedder = (text: string) => number[];

/** FNV-1a hash, returned as an unsigned 32-bit int. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Zero-dependency lexical embedder via feature hashing with signed buckets,
 * L2-normalized. Deterministic and offline. `dim` trades collisions for size.
 */
export function hashingEmbedder(dim = 256): Embedder {
  return (text: string): number[] => {
    const vec = new Array<number>(dim).fill(0);
    for (const token of tokenize(text)) {
      const h = hashString(token);
      const idx = h % dim;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vec[idx] = vec[idx]! + sign;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
    return vec;
  };
}

/** Cosine similarity of two vectors (0 if either is zero-length/empty). */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface JoinRow {
  id: string;
  layer: string;
  content: string;
  tags: string;
  project: string;
  created_at: number;
  expires_at: number | null;
  vector: string;
}

/** Stores and searches memory embeddings in the same SQLite database. */
export class VectorIndex {
  private readonly db: DatabaseType;
  private readonly embed: Embedder;

  constructor(db: DatabaseType, embedder: Embedder = hashingEmbedder()) {
    this.db = db;
    this.embed = embedder;
  }

  /** Upsert the embedding for an id from arbitrary text. */
  index(id: string, text: string): void {
    const vector = JSON.stringify(this.embed(text));
    this.db
      .prepare(
        `INSERT INTO memory_embeddings (id, vector) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET vector = excluded.vector`,
      )
      .run(id, vector);
  }

  /** Index a memory entry (content + tags). */
  indexEntry(entry: MemoryEntry): void {
    this.index(entry.id, `${entry.content} ${entry.tags.join(' ')}`);
  }

  /** (Re)build embeddings for a batch of entries. Returns the count indexed. */
  reindex(entries: MemoryEntry[]): number {
    for (const entry of entries) this.indexEntry(entry);
    logger.debug('reindexed embeddings', entries.length);
    return entries.length;
  }

  /** Semantic-ish search within a project, ranked by cosine similarity. */
  search(query: string, project: string, limit = 10): MemoryEntry[] {
    const q = this.embed(query);
    const rows = this.db
      .prepare(
        `SELECT m.id, m.layer, m.content, m.tags, m.project, m.created_at, m.expires_at, e.vector
         FROM memory m JOIN memory_embeddings e ON m.id = e.id
         WHERE m.project = ?`,
      )
      .all(project) as JoinRow[];

    const scored = rows.map((row) => ({
      entry: this.rowToEntry(row),
      score: cosine(q, JSON.parse(row.vector) as number[]),
    }));
    scored.sort((a, b) => b.score - a.score || b.entry.created_at - a.entry.created_at);
    return scored.slice(0, limit).map((s) => s.entry);
  }

  private rowToEntry(row: JoinRow): MemoryEntry {
    return {
      id: row.id,
      layer: row.layer as MemoryLayer,
      content: row.content,
      tags: JSON.parse(row.tags) as string[],
      project: row.project,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }
}
