# AgentCtx — Claude Code Project Instructions

## Project overview

AgentCtx is a context and agent management tool for agentic programming workflows.
It helps Claude Code, Codex, Cursor, and other LLM-based tools manage context windows,
persistent memory, role personas, token budgets, and multi-agent chains.

Stack: Node.js 18+, TypeScript, SQLite (better-sqlite3), Commander.js (CLI),
LanceDB (optional vector search), Zod (schema validation), Vitest (tests).

---

## Architecture decisions

- **Local-first**: all data stays on disk by default. No cloud dependencies required.
- **SQLite for memory**: use `better-sqlite3` (sync API, simpler than async drivers).
- **MCP server**: expose all AgentCtx capabilities as MCP tools via `@modelcontextprotocol/sdk`.
- **Role templates as YAML**: human-readable, git-friendly, easy for the community to share.
- **Agent chains as YAML**: same reason — composable and shareable without code.
- **No magic**: every prompt assembled by the context compiler must be inspectable via `agentctx debug last`.
- **Zod everywhere**: validate all config files, role templates, and chain definitions at load time.

---

## Project structure

```
src/
  cli/           Commander.js entry point and subcommand registrations
  compiler/      Context compiler — assembles prompts from files, memory, roles
  memory/        SQLite store with short/mid/long-term layers
  roles/         YAML loader, validator, and built-in role registry
  chains/        Chain runner — executes multi-step agent pipelines
  mcp/           MCP server — exposes AgentCtx tools for Claude Code
  debug/         Debug inspector — stores and diffs prompts per session
  integrations/  Thin adapters for Claude Code, Codex, Cursor
  shared/        Shared types (TypeScript interfaces), constants, utils

templates/
  roles/         Built-in role YAML files shipped with the package
  claudemd/      Scaffolding templates for CLAUDE.md generation

docs/specs/      Feature specifications — read these before implementing a feature
tests/           Vitest unit and integration tests
```

---

## Commands

```bash
npm run build          # compile TypeScript to dist/
npm run dev            # watch mode (tsx watch)
npm test               # run all tests (vitest)
npm run test:watch     # vitest watch mode
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run typecheck      # tsc --noEmit
```

To test the CLI locally during development:

```bash
npm run build
node dist/cli/index.js init
# or link globally:
npm link
agentctx init
```

---

## Coding conventions

- **TypeScript strict mode** is on. No `any`, no `// @ts-ignore` without a comment explaining why.
- **Explicit error handling**: use `Result<T, E>` pattern or throw typed errors — no silent failures.
- **No console.log in library code**: use the `Logger` util in `src/shared/logger.ts` which respects `--silent` and `--verbose` flags.
- **Async only where needed**: SQLite operations use `better-sqlite3` (synchronous). Don't wrap them in `Promise`.
- **File size**: if a file exceeds 300 lines, split it. Each module does one thing.
- **Exports**: every module has a barrel `index.ts`. Never import from deep paths like `../../memory/store/sqlite-adapter`.
- **Test file location**: tests live in `tests/` mirroring the `src/` structure — e.g. `src/compiler/context-compiler.ts` → `tests/compiler/context-compiler.test.ts`.

---

## Off-limits

- **Never touch**: `dist/` (generated), `.agentctx/memory.db` (live data)
- **Always ask before**: changing the MCP tool schema (breaking change for integrators), modifying the SQLite migration files
- **Do not** add cloud/network dependencies to the core library without a feature flag. The tool must work fully offline.

---

## Key interfaces (source of truth)

Before implementing any feature, check these types in `src/shared/types.ts`:

```typescript
interface MemoryEntry {
  id: string;
  layer: 'short' | 'mid' | 'long';
  content: string;
  tags: string[];
  project: string;
  created_at: number;
  expires_at: number | null;
}

interface RoleTemplate {
  name: string;
  description: string;
  system_prompt: string;
  context_includes: string[];
  context_excludes: string[];
  token_budget: number;
}

interface AgentChain {
  name: string;
  steps: ChainStep[];
}

interface ChainStep {
  id: string;
  role: string;
  task: string;
  context_includes?: string[];
  output_key: string;
}

interface CompiledContext {
  system_prompt: string;
  token_count: number;
  sources: ContextSource[];
}
```

---

## MCP tools (exposed to Claude Code)

When building or modifying the MCP server in `src/mcp/`, these are the tools to implement:

| Tool name | Description |
|---|---|
| `memory_save` | Save a fact to the mid-term memory store |
| `memory_search` | Semantic or keyword search across all memory layers |
| `memory_list` | List recent memory entries, optionally filtered by layer |
| `budget_check` | Return current token usage breakdown |
| `role_switch` | Switch the active role template for this session |
| `role_list` | List available role templates |
| `context_compile` | Run the context compiler and return the assembled prompt |
| `claudemd_read` | Read and parse the current CLAUDE.md |
| `claudemd_suggest` | Suggest additions to CLAUDE.md based on recent session activity |
| `chain_run` | Execute a named agent chain |
| `debug_last` | Return the full prompt from the last run |

---

## How context compilation works

The compiler runs in this order:

1. Load the active `RoleTemplate` — provides the base system prompt and file globs
2. Resolve `context_includes` globs relative to the project root
3. Score each file by relevance to the current task (keyword overlap, recency, size)
4. Pull memory entries matching the task via keyword search (or vector search if enabled)
5. Rank all chunks by score and greedily pack into the token budget (highest score first)
6. Prepend the role system prompt (always included — counts against budget)
7. Append a "what you should know" block with the top memory entries
8. Return `CompiledContext` with the assembled string and a source manifest

The token budget is `RoleTemplate.token_budget` or the global default. Leave at least 25% headroom for the conversation history and the model's response.

---

## Testing expectations

- Every public function in `src/` must have at least one unit test.
- Integration tests live in `tests/integration/` and use a temp directory for SQLite.
- Use `vi.mock()` to mock file system calls and API calls — tests must run offline.
- Run `npm test` before considering any task complete. All tests must pass.

---

## Implementing a new feature — checklist

Before starting:
- [ ] Read the relevant spec in `docs/specs/` if one exists
- [ ] Check `src/shared/types.ts` for existing interfaces
- [ ] Check if a similar pattern already exists in `src/`

While building:
- [ ] Add or update types in `src/shared/types.ts`
- [ ] Implement the feature with explicit error handling
- [ ] Export from the module's `index.ts`
- [ ] Add CLI command in `src/cli/` if user-facing
- [ ] Add MCP tool in `src/mcp/` if useful for Claude Code integration
- [ ] Write tests in `tests/`

Before finishing:
- [ ] `npm run typecheck` — no type errors
- [ ] `npm run lint` — no lint errors
- [ ] `npm test` — all tests pass
- [ ] Update `README.md` if the public interface changed

---

## Common patterns

**Loading and validating a YAML file with Zod:**

```typescript
import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { RoleTemplateSchema } from '../shared/types';

export function loadRoleTemplate(path: string): RoleTemplate {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw);
  return RoleTemplateSchema.parse(parsed); // throws ZodError if invalid
}
```

**Writing to the SQLite memory store:**

```typescript
import db from '../memory/db'; // singleton better-sqlite3 instance

const insert = db.prepare(`
  INSERT INTO memory (id, layer, content, tags, project, created_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
insert.run(id, layer, content, JSON.stringify(tags), project, Date.now(), expiresAt);
```

**Registering an MCP tool:**

```typescript
server.tool('memory_save', {
  description: 'Save a fact to the project memory store',
  inputSchema: z.object({
    content: z.string(),
    layer: z.enum(['short', 'mid', 'long']).default('mid'),
    tags: z.array(z.string()).default([]),
  }),
}, async ({ content, layer, tags }) => {
  const entry = memoryStore.save({ content, layer, tags });
  return { content: [{ type: 'text', text: `Saved memory: ${entry.id}` }] };
});
```

---

## Session notes

*Claude Code appends auto-memory entries here during development sessions.*
