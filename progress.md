# AgentCtx — Build Progress

Living log of how AgentCtx is being built: the approach, what's done, and what's open.

Last updated: 2026-06-10

---

## Overview

AgentCtx is a local-first context and agent manager for agentic coding tools (Claude Code, Codex,
Cursor, any LLM CLI). It manages context windows, persistent memory, role personas, token budgets,
multi-agent chains, and prompt inspection — exposed as both a CLI and an MCP server.

Stack: Node.js 18+, TypeScript (strict, ESM/NodeNext), SQLite (`better-sqlite3`), Commander.js,
Zod, tiktoken, glob, `@modelcontextprotocol/sdk`, Vitest.

---

## Approach

- **One engine per session, vertically.** Each session ships a complete, tested module (types →
  implementation → CLI/MCP wiring → tests → live smoke test), not a half-built layer.
- **Foundation as a contract.** `src/shared/types.ts` is the single source of truth (Zod-first:
  schemas defined once, TS types derived via `z.infer`). Everything depends on it.
- **Local-first, offline.** No cloud/API key required for the tool itself. SQLite on disk, tiktoken
  for token estimates, agents invoked via local CLIs.
- **Injectable seams over hard-coding.** The expensive/external pieces are pluggable so tests stay
  deterministic and offline and real integrations drop in later:
  - token counting → `countTokens` option (default heuristic, CLI injects tiktoken)
  - chain step execution → `StepExecutor` (default dry-run, real = claude CLI / any command)
  - the SQLite handle → `MemoryStore(db?)` and lazy `getDefaultDb()` (no import side effects)
- **No magic.** Every compiled prompt is recorded and inspectable via `agentctx debug`.
- **Verify every session.** Gates: `npm run typecheck && npm test && npm run build`, plus a live
  CLI/MCP smoke run.

### Key decisions

| Decision | Why |
|---|---|
| ESM + NodeNext (`.js` import suffixes) | Matches the MCP SDK's ESM-first API; modern Node |
| Zod-first types (`z.infer`) | One source of truth; no drift between schema and interface |
| DB default `~/.agentctx/memory.db`, lazy getter | Cross-project memory; no file created on import (testable) |
| tiktoken behind an injectable counter | Real counts in the CLI, fast heuristic in lib/tests; tiktoken is ~10–20% approximate for Claude |
| MCP handlers split from transport (`tools.ts` vs `index.ts`) | Unit-test handlers without loading the SDK server |
| `StepExecutor` seam, dry-run default | Chains testable offline; real agent call opt-in, no surprise quota burn |
| Role resolution `resolve(name, root)` | Project `.agentctx/roles/` shadows built-ins, across compile/chains/MCP |

---

## Project layout

```
src/
  cli/         Commander entry — all commands wired
  compiler/    Context compiler (glob → score → pack)
  memory/      SQLite store (db.ts singleton/migrate + MemoryStore)
  roles/       RoleManager (built-in + project role resolution)
  chains/      ChainLoader, ChainRunner, executors (claude CLI / command)
  budget/      BudgetTracker (tiktoken breakdown + warnings)
  debug/       DebugStore (persist runs) + DebugInspector (format/diff)
  mcp/         MCP server (index.ts) + tool handlers (tools.ts)
  shared/      types.ts, logger.ts, utils.ts, tokens.ts, config.ts
templates/roles/   3 built-in role YAMLs
docs/specs/        context-compiler, memory-store, token-budget
tests/             mirrors src/ (10 test files)
.agentctx/         config.json, chains/feature-build.yaml
```

---

## Steps done (chronological)

### 1. Scaffold + foundation
- Project structure, `package.json` (ESM, bin `agentctx`), `tsconfig.json` (strict, NodeNext,
  rootDir `src`) + `tsconfig.test.json` (typecheck incl. tests), `.eslintrc.json`, `.gitignore`,
  `vitest.config.ts`, `.agentctx/config.json`.
- `shared/types.ts` (Zod-first), `shared/logger.ts` (LOG_LEVEL, stdout/stderr), `shared/utils.ts`
  (id, tokenize, keywordOverlap, expandHome, time helpers).
- `memory/db.ts` (migrate + lazy `getDefaultDb` + `createDb`), `memory/index.ts` (MemoryStore:
  save/search/list/delete/prune), `roles/index.ts` (RoleManager), CLI skeleton, 3 role YAMLs,
  3 spec docs.
- Deps installed; build + tests green.

### 2. Context compiler
- `compiler/index.ts`: resolve `context_includes` globs minus excludes → score each file/memory
  chunk (`0.6·keyword + 0.25·recency + 0.15·(1-size)`) → pin role prompt → greedy pack into
  `min(role.token_budget, 0.75·window)` → assemble system prompt + source manifest.
- `shared/tokens.ts`: `estimateTokens` heuristic + injectable `countTokens`.
- Wired CLI `compile`; tests for compiler + tokens.

### 3. Token budget tracker
- `budget/index.ts`: `BudgetTracker.analyze` groups sources → rows (tokens/%/bar), total/remaining,
  status (healthy/warning/over @0.75), trim suggestions; `MODEL_WINDOWS` lookup.
- `shared/tokens.ts`: real `countTokens` via tiktoken (`cl100k_base`, lazy, falls back to heuristic).
- Wired CLI `budget` (+ `--warn-only`); CLI injects tiktoken so compile/budget counts match.

### 4. Debug inspector
- `shared/types.ts`: `RunRecord`. `debug/index.ts`: `DebugStore` (persist one JSON per run under
  `.agentctx/runs/`), `DebugInspector` (formatRun + LCS `diffLines` + formatDiff).
- `buildContext` records every compile/budget run; wired CLI `debug last/diff/list`.

### 5. MCP server
- Verified SDK 1.29 API from installed types (`McpServer.registerTool`, Zod raw-shape inputs;
  zod v4 compatible).
- `mcp/tools.ts` (10 handlers, no server import) + `mcp/index.ts` (register + `startMcpServer`
  over stdio). `shared/config.ts` (loadProjectConfig/resolveProjectName/expiryForLayer), reused
  by CLI. Wired CLI `mcp`. Stdout kept pure JSON-RPC (logging only to stderr in the MCP path).

### 6. Chain runner
- `chains/index.ts`: `ChainLoader` (YAML → validate), `interpolate` (`{{input}}`/`{{output_key}}`),
  `ChainRunner` (per step: interpolate → resolve role → compile → execute → thread output).
  `output_key` made optional. Wired CLI `chain run` + MCP `chain_run`; example
  `.agentctx/chains/feature-build.yaml`.

### 7. Real StepExecutor
- `chains/executors.ts`: `claudeCliExecutor` (`claude -p --append-system-prompt`, uses Claude Code
  auth — zero config) and `commandExecutor` (any agent CLI, prompt via stdin/arg). Runner now
  catches executor failures (fail-fast + record). Wired CLI `chain run --executor claude`.

### 8. CLI memory/role + init  ← most recent
- Wired `init` (scaffold `.agentctx/` + starter CLAUDE.md, idempotent), `memory add/search/list`,
  `role use/list/install`. Removed all CLI stubs.
- `RoleManager.resolve(name, projectRoot)` + `listProject` — project `.agentctx/roles/` shadow
  built-ins, applied across compile/chains/MCP. `role use` persists `default_role` to config;
  `role install` copies a local YAML into the project.

---

## Verification (current)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **73 passing** (10 files) |
| `npm run build` | 0 errors |
| live CLI/MCP smoke | init→memory→role, compile, budget, debug, chain (dry-run + claude), MCP tools/list+call — all working |

---

## Current status & active work

**No active failure.** As of the last session, typecheck, all 73 tests, and the build are green, and
the full first-run flow works end-to-end. The CLI has no remaining stubs.

Last completed: wiring CLI `memory`/`role` and adding `init` (+ project-aware role resolution).

Transient issues encountered and resolved (not currently failing):
- The Bash working directory was once left inside `node_modules/...` after inspecting the MCP SDK,
  which made `npm run typecheck` report "Missing script". Fixed by `cd` back to the project root.
- `package.json` was reformatted/pinned externally during a dependency install (deps now pinned,
  e.g. zod ^4.4.3, typescript ^6, eslint ^8); scripts intact, taken as intentional.

If a failure appears next session, record it here with: the command, the exact error output, and the
hypothesis being tested.

---

## Remaining work (extensions, not blockers)

- Global config `~/.agentctx/global-config.json` (`default_model`, `token_warning_threshold`).
- CLAUDE.md manager: only `claudemd_read` + the init scaffold exist; `edit`/`validate`/`sync` not built.
- Vector search (LanceDB), flagged off via `vector_search`.
- `debug replay` / `debug export`.
- Remote role-registry install (`role install agentctx/<name>`); today only local `.yaml` paths.
- Integration adapters (Codex, Cursor) under `src/integrations/` (currently a stub).
- Lint: `.eslintrc.json` present but lint isn't part of the verify gates.

---

## How to use it

### With Claude Code (MCP)
```bash
npm run build
claude mcp add agentctx -s user -- node "/Users/sajjadhussain/Development/Agents Context Manager/dist/cli/index.js" mcp
# then in a session: /mcp   (lists agentctx + 10 tools)
```
Tools: memory_save, memory_search, memory_list, role_list, role_switch, context_compile,
budget_check, debug_last, claudemd_read, chain_run.

### Standalone CLI
```bash
node dist/cli/index.js init --name my-project
node dist/cli/index.js memory add "API uses JWT on port 3000" -l mid -t auth,api
node dist/cli/index.js role use backend-engineer
node dist/cli/index.js compile -t "fix the auth bug"
node dist/cli/index.js budget -t "fix the auth bug" --history 4000
node dist/cli/index.js debug diff
node dist/cli/index.js chain run feature-build --executor claude --input "add rate limiting"
```
(`npm link` once to get a global `agentctx` command instead of `node dist/cli/index.js`.)
