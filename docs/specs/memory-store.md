# Memory Store

Local-first persistent memory for AgentCtx. SQLite-backed, **nothing leaves disk**. Memory is
saved into one of three layers with different lifetimes and surfaced to the context compiler via
keyword search.

## SQLite schema

```sql
CREATE TABLE IF NOT EXISTS memory (
  id         TEXT    PRIMARY KEY,
  layer      TEXT    NOT NULL,            -- 'short' | 'mid' | 'long'
  content    TEXT    NOT NULL,
  tags       TEXT    NOT NULL,            -- JSON array, e.g. ["api","auth"]
  project    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,            -- epoch ms
  expires_at INTEGER                      -- epoch ms, NULL = never expires
);

CREATE INDEX IF NOT EXISTS idx_memory_project       ON memory (project);
CREATE INDEX IF NOT EXISTS idx_memory_project_layer ON memory (project, layer);
```

`tags` is stored as a JSON string and parsed back to `string[]` on read so rows map cleanly to
`MemoryEntry`. DB lives at `~/.agentctx/memory.db` unless overridden by
`ProjectConfig.memory_db_path`.

## Layers and TTLs

| Layer   | Meaning                                   | TTL                          |
|---------|-------------------------------------------|------------------------------|
| `short` | Current-task notes / scratch              | 8h (`short_term_ttl_hours`)  |
| `mid`   | Project conventions and decisions         | 90d (`mid_term_ttl_days`)    |
| `long`  | Cross-project preferences                 | never (`expires_at = null`)  |

`expires_at` is **computed at save time** from the layer and `memory_layers` config:

```
short → now() + hoursToMs(config.short_term_ttl_hours)   // default 8h
mid   → now() + daysToMs(config.mid_term_ttl_days)        // default 90d
long  → null
```

(`now`, `hoursToMs`, `daysToMs` are shared utils.)

## Search algorithm (current)

1. `tokenize(query)` to get distinct query terms.
2. Build a SQL query scoped to `project`, OR-joining a `content LIKE %term%` clause per term
   (parameterized). Returns a candidate superset.
3. **Re-rank in JS** by `keywordOverlap(query, content + " " + tags.join(" "))`.
4. **Tie-break by `created_at` descending** (newer wins on equal score).
5. Apply `limit`.

Terms come from `tokenize`, so stopwords / single-char tokens are already dropped. Entries
matching zero terms are excluded.

**Planned upgrades (not v1):**
- **FTS5** — replace the `LIKE` scan with a SQLite full-text index for speed/relevance.
- **LanceDB vector search** — future semantic search, gated by the `vector_search` config flag
  (off by default).

## Prune rules

```sql
DELETE FROM memory WHERE expires_at IS NOT NULL AND expires_at < now();
```

`long` entries (`expires_at IS NULL`) are never pruned. Run prune **on store startup** and
**after writes** to keep expired short/mid entries from leaking into search results.

## API surface (`MemoryStore` class)

| Method   | Signature (intent)                                                         |
|----------|----------------------------------------------------------------------------|
| `save`   | `save({ layer, content, tags, project }) → MemoryEntry` — generates `id`, computes `created_at`/`expires_at`, inserts. |
| `search` | `search(query, { project, limit }) → MemoryEntry[]` — algorithm above.      |
| `list`   | `list({ project, layer? }) → MemoryEntry[]` — all entries for a project, optionally filtered by layer, newest first. |
| `delete` | `delete(id) → boolean` — remove a single entry by id.                       |
| `prune`  | `prune() → number` — delete expired entries, return count removed.          |

**Local-first guarantee:** all operations are local SQLite reads/writes; no network calls.
