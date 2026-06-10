# Context Compiler

## Purpose

Assemble the **smallest high-relevance system prompt** for a given task that fits within a
token budget. The compiler is deterministic and fully inspectable: every decision (which
chunks were included, their scores, their token counts) is recoverable via
`agentctx debug last`.

The output is a `CompiledContext`, which is what actually gets sent to the agent.

## Inputs

- The **active `RoleTemplate`** (its `system_prompt`, `context_includes`, `context_excludes`,
  `token_budget`).
- The **task string** the user is working on.
- The **`MemoryStore`** (for keyword search over saved memory entries).
- The **project files** matched by `context_includes` globs, minus those matched by
  `context_excludes`, resolved relative to the project root.

## Pipeline

1. **Load the active `RoleTemplate`** (selected role, or `default_role` from project config).
2. **Resolve globs.** Expand each pattern in `context_includes` relative to the project root,
   then remove any file matched by a `context_excludes` pattern. Produces a deduped file list.
3. **Score each file** by relevance (see *Scoring* below). Read file contents; very large files
   may be chunked, but the v1 implementation may treat one file = one chunk.
4. **Pull memory entries** via `MemoryStore.search(task, { project, limit })` — keyword search
   over the current project's memory.
5. **Rank all chunks** (files + memory) by `relevance_score` descending and **greedily pack**
   into the budget, highest-score-first (see *Token packing*).
6. **Prepend the role `system_prompt`.** It is always included and its tokens count against the
   budget. It is pinned (never dropped).
7. **Append a "What you should know" block** built from the top memory entries that were packed,
   rendered as a short bulleted section after the file context.
8. **Return a `CompiledContext`** with a source manifest. Each packed chunk becomes one
   `ContextSource` (`type`, optional `path`, `content`, `token_count`, `relevance_score`). The
   role prompt is a `ContextSource` with `type: 'role'`.

## Scoring algorithm

Each candidate chunk gets:

```
relevance_score = w_kw      * keywordOverlap(task, chunk)
                + w_recency * recency
                + w_size    * (1 - sizePenalty)
```

Default weights: `w_kw = 0.6`, `w_recency = 0.25`, `w_size = 0.15` (must sum to 1.0).

- **`keywordOverlap(task, chunk)`** — shared util; fraction (0..1) of distinct task keywords
  present in the chunk. For files use the file content (optionally path); for memory use
  `content + tags`.
- **`recency`** — newer scores higher, normalized to 0..1. For files use mtime; for memory use
  `created_at`. Suggested: `recency = clamp(1 - ageMs / maxAgeMs, 0, 1)` with `maxAgeMs` an
  agreed horizon (e.g. 90 days), so anything older than the horizon scores ~0.
- **`sizePenalty`** — very large chunks are penalized (they crowd out everything else).
  Suggested: `sizePenalty = clamp(token_count / largeFileTokens, 0, 1)` with
  `largeFileTokens` e.g. 8000, so a small file → penalty ~0 → full size credit.

**Pinning:** the role `system_prompt` is pinned with an effective score of `∞` (always included
first, before greedy packing of everything else).

## Token packing

- Compute the **effective budget**:
  `effectiveBudget = min(role.token_budget, 0.75 * contextWindow)`.
  This leaves **≥25% headroom** of the model's context window for conversation history and the
  model's response, so the compiler never fills the window by itself.
- Subtract the pinned role `system_prompt` token count from the effective budget first.
- Sort remaining chunks by `relevance_score` **descending**.
- Walk the sorted list; for each chunk, if adding its `token_count` would exceed the remaining
  budget, **skip it and continue** (a smaller, lower-ranked chunk may still fit). Otherwise add
  it and decrement the remaining budget.
- Token counts come from the token-budget estimator (`tiktoken`); see `token-budget.md`.

## Output

A `CompiledContext`:

```ts
{
  system_prompt: string;      // role prompt + packed file context + "What you should know"
  token_count: number;        // total tokens of the assembled prompt
  sources: ContextSource[];   // one per included chunk, role first
}
```

Each included chunk is a `ContextSource` carrying its own `token_count` and `relevance_score`,
so `agentctx debug last` can render the full manifest of what was and was not included.
