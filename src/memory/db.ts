import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { expandHome } from '../shared/utils.js';
import { logger } from '../shared/logger.js';

/**
 * SQLite persistence for the memory module.
 *
 * IMPORTANT: this module performs NO filesystem or database work at import time.
 * A database is only opened when `createDb` / `getDefaultDb` is called.
 */

/** Sentinel path that opens an ephemeral in-memory database (no file on disk). */
const IN_MEMORY = ':memory:';

/** Create the `memory` table and its indexes if they do not already exist. */
export function migrate(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT NOT NULL,
      project TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_project ON memory (project);
    CREATE INDEX IF NOT EXISTS idx_memory_project_layer ON memory (project, layer);
  `);
}

/**
 * Resolve the on-disk location of the memory database.
 * Honors `AGENTCTX_DB_PATH`, falling back to `~/.agentctx/memory.db`.
 */
export function resolveDbPath(): string {
  const override = process.env.AGENTCTX_DB_PATH;
  if (override) return expandHome(override);
  return expandHome('~/.agentctx/memory.db');
}

/**
 * Open a database at `path`, ensuring the parent directory exists for real file
 * paths. The special `:memory:` path is opened without touching the filesystem.
 */
export function createDb(path: string): DatabaseType {
  let target = path;
  if (path !== IN_MEMORY) {
    target = expandHome(path);
    mkdirSync(dirname(target), { recursive: true });
  }
  logger.debug('opening memory db at path', target);
  const db = new Database(target);
  migrate(db);
  return db;
}

let defaultDb: DatabaseType | undefined;

/**
 * Lazily create and memoize the process-wide default database. The database is
 * opened on first call only — never at module load.
 */
export function getDefaultDb(): DatabaseType {
  if (!defaultDb) {
    defaultDb = createDb(resolveDbPath());
  }
  return defaultDb;
}
