import type { Database as DatabaseType } from 'better-sqlite3';
import type { MemoryEntry, MemoryLayer } from '../shared/types.js';
import { generateId, keywordOverlap, now, tokenize } from '../shared/utils.js';
import { logger } from '../shared/logger.js';
import { getDefaultDb } from './db.js';

/** Raw shape of a `memory` table row as returned by better-sqlite3. */
interface MemoryRow {
  id: string;
  layer: string;
  content: string;
  tags: string;
  project: string;
  created_at: number;
  expires_at: number | null;
}

/**
 * Layered, keyword-searchable memory backed by SQLite.
 *
 * Pass a `db` for tests/isolation; omit it to lazily bind to the shared default
 * database (only opened when first needed).
 */
export class MemoryStore {
  private readonly db: DatabaseType;

  constructor(db?: DatabaseType) {
    this.db = db ?? getDefaultDb();
  }

  private rowToEntry(row: MemoryRow): MemoryEntry {
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

  /** Persist a new entry, assigning its `id` and `created_at`. */
  save(entry: Omit<MemoryEntry, 'id' | 'created_at'>): MemoryEntry {
    const full: MemoryEntry = {
      id: generateId('mem'),
      created_at: now(),
      layer: entry.layer,
      content: entry.content,
      tags: entry.tags,
      project: entry.project,
      expires_at: entry.expires_at,
    };
    this.db
      .prepare(
        `INSERT INTO memory (id, layer, content, tags, project, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.layer,
        full.content,
        JSON.stringify(full.tags),
        full.project,
        full.created_at,
        full.expires_at,
      );
    logger.debug('saved memory entry', full.id, 'project', full.project);
    return full;
  }

  /**
   * Keyword search within a project. Matches any query term against `content`
   * via SQL LIKE, then re-ranks in JS by keyword overlap (tie-break: newest).
   */
  search(query: string, project: string, limit = 10): MemoryEntry[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const where = terms.map(() => 'content LIKE ?').join(' OR ');
    const params = terms.map((t) => `%${t}%`);
    const rows = this.db
      .prepare(`SELECT * FROM memory WHERE project = ? AND (${where})`)
      .all(project, ...params) as MemoryRow[];

    const entries = rows.map((r) => this.rowToEntry(r));
    entries.sort((a, b) => {
      const sa = keywordOverlap(query, `${a.content} ${a.tags.join(' ')}`);
      const sb = keywordOverlap(query, `${b.content} ${b.tags.join(' ')}`);
      if (sb !== sa) return sb - sa;
      return b.created_at - a.created_at;
    });

    logger.debug('search', query, 'project', project, 'matched', entries.length);
    return entries.slice(0, limit);
  }

  /** List entries for a project (optionally a single layer), newest first. */
  list(project: string, layer?: MemoryLayer): MemoryEntry[] {
    let rows: MemoryRow[];
    if (layer) {
      rows = this.db
        .prepare(
          'SELECT * FROM memory WHERE project = ? AND layer = ? ORDER BY created_at DESC',
        )
        .all(project, layer) as MemoryRow[];
    } else {
      rows = this.db
        .prepare('SELECT * FROM memory WHERE project = ? ORDER BY created_at DESC')
        .all(project) as MemoryRow[];
    }
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Delete a single entry by id. No-op if it does not exist. */
  delete(id: string): void {
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(id);
    logger.debug('deleted memory entry', id);
  }

  /** Remove every expired entry. Returns the number of rows deleted. */
  prune(): number {
    const info = this.db
      .prepare('DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < ?')
      .run(now());
    logger.debug('pruned expired memory entries', info.changes);
    return info.changes;
  }
}

export { getDefaultDb, createDb, migrate, resolveDbPath } from './db.js';
export { VectorIndex, hashingEmbedder, cosine, type Embedder } from './vector.js';
