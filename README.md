# AgentCtx — Agent Context Manager

> Manage context windows, memory, roles, token budgets, and multi-agent chains for Claude Code,
> Codex, Cursor, and any LLM-based agentic tool — local-first, fully offline.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)

---

## 1. About AgentCtx

Every agentic coding session starts from scratch. You re-paste architecture notes, re-explain
conventions, and watch the agent drift as the context window fills with irrelevant history.

**AgentCtx fixes this at the infrastructure level.** It sits next to your agentic tools and gives
them:

- **Persistent memory** — a layered SQLite store of project facts that survives across sessions.
- **A context compiler** — assembles the smallest high-relevance prompt that fits a token budget.
- **Role templates** — pre-built and custom personas so the agent knows *who it is*.
- **A token budget tracker** — see exactly how much of the window you're using, with warnings.
- **Multi-agent chains** — compose agents as YAML pipelines; output of one step feeds the next.
- **A debug inspector** — replay and diff the exact prompts that were assembled.
- **An MCP server** — expose all of the above as native tools inside Claude Code.

### Design principles

- **Local-first / offline.** All data stays on disk (`~/.agentctx/memory.db`). No cloud, no API
  key required for the tool itself.
- **No magic.** Every compiled prompt is recorded and inspectable (`agentctx debug`).
- **Injectable seams.** Token counting and agent execution are pluggable — deterministic for tests,
  real integrations drop in cleanly.

### Status

Core is feature-complete and tested (86 tests): memory, roles, context compiler, token budget,
debug inspector, MCP server (11 tools), and multi-agent chains with real agent execution.

Stack: Node.js 20+, TypeScript (strict, ESM), SQLite (`better-sqlite3`), Commander.js, Zod, tiktoken,
`@modelcontextprotocol/sdk`, Vitest.

---

## Install

```bash
npm install -g @dev-sajjad/agentctx     # global CLI; provides the `agentctx` command
```

Or build from source:

```bash
git clone https://github.com/dev-sajjad/AgentCtx agentctx
cd agentctx
npm install
npm run build           # compiles to dist/

# option A: run directly
node dist/cli/index.js --help

# option B: global `agentctx` command
npm link
agentctx --help
```

> Examples below use `agentctx`. If you didn't `npm link`, substitute
> `node dist/cli/index.js` for `agentctx`.

---

## Quickstart

```bash
cd your-project
agentctx init                                   # scaffold .agentctx/ + starter CLAUDE.md
agentctx memory add "API uses JWT on port 3000" -l mid -t auth,api
agentctx role use backend-engineer
agentctx compile -t "add pagination to the users endpoint"   # see the assembled context
agentctx budget -t "add pagination to the users endpoint"    # see token usage
```

This creates:

```
your-project/
├── CLAUDE.md                  # starter, if none existed
└── .agentctx/
    ├── config.json            # project config (commit this)
    ├── roles/                 # custom project role templates
    └── chains/                # agent chain definitions
# ~/.agentctx/memory.db        # global SQLite memory store (gitignored)
```

---

## 2. Using AgentCtx in different scenarios

### Scenario A — Inside Claude Code (MCP server)

Expose AgentCtx as native tools in Claude Code so it can save memory, compile context, and check
budgets mid-session.

```bash
npm run build
claude mcp add agentctx -s user -- node "/absolute/path/to/agentctx/dist/cli/index.js" mcp
# (-s user = available in all projects; -s project writes .mcp.json in one repo)
```

In a session, run `/mcp` to confirm `agentctx` is connected, then just ask:

```
> save to agentctx memory: we use Zod for input validation
> search agentctx memory for auth
> compile a context for the pagination task
> check the token budget
> show the last compiled prompt
```

### Scenario B — Standalone CLI (any tool / no MCP)

Use the CLI to build and inspect context, then feed it to whatever agent you like.

```bash
agentctx compile -r backend-engineer -t "fix the auth bug" --preview > context.txt
# paste context.txt into your tool, or pipe it onward
```

### Scenario C — Custom team role

Ship a reusable persona for your repo.

```bash
agentctx role install ./team-roles/python-django.yaml
agentctx role use python-django
agentctx compile -t "add a REST endpoint for invoices"
```

### Scenario D — Multi-agent pipeline (real agents)

Run a plan → implement → review → test pipeline where each step is a real Claude call.

```bash
agentctx chain run feature-build --executor claude --input "add rate limiting to login"
```

### Scenario E — CI / pre-prompt budget guard

Fail fast when a compiled context would blow the window (e.g. a Claude Code `PreToolUse` hook).

```bash
agentctx budget -t "$TASK" --warn-only     # exits non-zero + prints a warning when over threshold
```

---

## 3. Functionality reference

Each feature below: what it does, then a runnable example.

### `init` — scaffold a project

Creates `.agentctx/{config.json, roles/, chains/}` and a starter `CLAUDE.md`. Idempotent — existing
files are skipped unless `--force`.

```bash
agentctx init                      # project name = directory name
agentctx init --name my-service    # explicit name
agentctx init --force              # overwrite an existing config.json
```

### Memory store

Three layers, each with a TTL applied automatically at save time:

| Layer | Use | TTL |
|---|---|---|
| `short` | current-task notes | 8 hours |
| `mid` | project conventions, decisions | 90 days |
| `long` | cross-project preferences | never expires |

Stored in SQLite (`~/.agentctx/memory.db`), scoped per project. Search is keyword-based
(tokenize → SQL `LIKE` → re-rank by keyword overlap).

```bash
# add (default layer = mid)
agentctx memory add "API uses JWT on port 3000" -l mid -t auth,api
agentctx memory add "deploy via GitHub Actions" -l long
agentctx memory add "current task: pagination" -l short

# search (keyword, project-scoped)
agentctx memory search "auth jwt"
agentctx memory search "deploy" -n 5      # limit results

# list (optionally filter by layer)
agentctx memory list
agentctx memory list -l mid
```

```
$ agentctx memory search "auth jwt"
[mid] API uses JWT on port 3000  (auth, api)
```

**Vector search (optional).** Set `"vector_search": true` in `~/.agentctx/global-config.json` to rank
by embedding similarity instead of keyword `LIKE` — it surfaces relevant entries even when the query
shares no literal words. The default embedder is a zero-dependency local hashing embedder (fully
offline; pluggable for a real semantic model). Backfill existing entries once with:

```bash
agentctx memory reindex
```

### Roles

A role template is a YAML persona with a system prompt, context globs, and a token budget. Three are
built in (`backend-engineer`, `security-auditor`, `qa-engineer`). Project roles in
`.agentctx/roles/` shadow built-ins of the same name.

```bash
agentctx role list                         # built-in + project roles (active marked *)
agentctx role use security-auditor         # persists default_role to .agentctx/config.json
agentctx role install ./my-role.yaml       # validates + copies into .agentctx/roles/
```

Role YAML format:

```yaml
# .agentctx/roles/python-django.yaml
name: Python/Django Developer
description: Django + DRF + pytest focus
system_prompt: |
  You are a senior Python/Django engineer.
  Prefer explicit, tested code and thin views.
  Ask before touching migrations or auth.
context_includes:
  - "**/*.py"
  - CLAUDE.md
context_excludes:
  - "**/.venv/**"
  - "**/migrations/**"
token_budget: 60000
```

### Context compiler

Assembles a system prompt for a role + task within a token budget, and reports exactly what went in.

How it works:
1. Resolve the role's `context_includes` globs, minus `context_excludes`.
2. Score every file and memory chunk: `0.6·keywordOverlap + 0.25·recency + 0.15·(1 − sizePenalty)`.
3. Pin the role's `system_prompt`, then greedily pack the highest-scoring chunks into the budget
   (`min(role.token_budget, 0.75 × context_window)` — leaving ≥25% headroom).
4. Append a "What you should know" block from the top memory entries.

```bash
agentctx compile -r backend-engineer -t "add pagination to the users endpoint"
agentctx compile -t "fix auth bug" --preview     # also print the full assembled prompt
```

```
$ agentctx compile -r backend-engineer -t "add pagination..."
compiled context for role "backend-engineer" — 11815 tokens, 15 sources
  [role] role — 138t score=1.000
  [file] CLAUDE.md — 2194t score=0.509
  [file] src/api/users.ts — 1860t score=0.515
  ...
```

> Token counts use tiktoken, which is **approximate for Claude** (~10–20% off; exact counts come
> from the Anthropic count-tokens API). Good enough for live budgeting, fully offline.

### Token budget tracker

Groups a compiled context into a per-source breakdown against the model's window, with a status and
trim suggestions.

```bash
agentctx budget -t "add pagination" --history 4000        # include conversation-history tokens
agentctx budget -t "add pagination" -m claude-opus-4-8    # pick the model window
agentctx budget -t "add pagination" --threshold 0.6       # custom warning threshold (default 0.75)
agentctx budget -t "add pagination" --warn-only           # CI/hook mode: warn + non-zero exit
```

```
Context window: claude-sonnet-4-6 (200,000 tokens)
────────────────────────────────────────────────────────────
Role template            ~108 tokens   0.1%
CLAUDE.md              ~2,075 tokens   1.0%
Files                 ~11,245 tokens   5.6%  ██
Conversation history   ~4,000 tokens   2.0%  █
────────────────────────────────────────────────────────────
Total used            ~17,428 tokens   8.7%  ███
Remaining            ~182,572 tokens  91.3%  ✓ healthy

Suggestions: none
```

### Debug inspector

Every `compile` and `budget` run is recorded to `.agentctx/runs/`. Replay or diff them — "no magic".

```bash
agentctx debug last      # full metadata + source manifest + system prompt of the last run
agentctx debug list      # recent runs (one line each), -n to limit
agentctx debug diff      # diff the last two runs: token delta, +/- sources, prompt line diff
```

```
$ agentctx debug diff
Diff: run_a14f… (older) → run_0d76… (newer)
Tokens: 16699 → 21582 (Δ +4883)
Sources: +6 added, -1 removed, ~1 changed
Added:
  + [file] tests/memory/memory-store.test.ts (933t)
Removed:
  - [file] package.json (412t)
```

### Agent chains

Define a multi-step pipeline as YAML. Each step compiles a context for its role + task; `{{input}}`
and prior steps' `{{output_key}}` are interpolated into later tasks.

```yaml
# .agentctx/chains/feature-build.yaml
name: Feature build pipeline
steps:
  - id: plan
    role: backend-engineer
    task: "Write a short technical plan for: {{input}}"
    output_key: plan

  - id: implement
    role: backend-engineer
    task: "Implement the following plan:\n{{plan}}"
    context_includes: ["src/**/*.ts"]      # overrides the role's globs for this step
    output_key: implementation

  - id: review
    role: security-auditor
    task: "Review this implementation for security issues:\n{{implementation}}"
    output_key: review_notes

  - id: test
    role: qa-engineer
    task: "Write tests for this implementation:\n{{implementation}}"
```

Run it. The **executor** decides what actually happens per step:

```bash
# dry-run (default): compiles each step, invokes NO agent — safe for inspecting the pipeline
agentctx chain run feature-build --input "add rate limiting to login"

# claude: each step is a real Claude call via the claude CLI (uses your Claude Code auth, no API key)
agentctx chain run feature-build -e claude -i "add rate limiting to login"
agentctx chain run feature-build -e claude -m claude-opus-4-8 -i "add rate limiting"

# load a chain from an explicit path instead of .agentctx/chains/
agentctx chain run anything -f ./pipelines/review.yaml -i "..."
```

Need a different agent (Codex, Ollama, a script)? Use the programmatic `commandExecutor` (see
Library usage) — it pipes the compiled prompt to any command.

### MCP server

Runs over stdio and exposes 11 tools to Claude Code. See Scenario A to connect it.

| Tool | Does |
|---|---|
| `memory_save` | save a fact (layer + tags) |
| `memory_search` | keyword search memory |
| `memory_list` | list entries, optional layer filter |
| `role_list` | list available roles |
| `role_switch` | set the active role for the session |
| `context_compile` | compile + return the assembled prompt |
| `budget_check` | compile + return the token breakdown |
| `debug_last` | full prompt/manifest of the last run |
| `claudemd_read` | read the project CLAUDE.md |
| `claudemd_suggest` | propose CLAUDE.md additions from memory (`apply=true` writes them) |
| `chain_run` | run a named chain (dry-run) |

```bash
agentctx mcp        # start the server (normally launched by Claude Code, not by hand)
```

---

## Configuration

`.agentctx/config.json` — per-project (commit this):

```json
{
  "project_name": "your-project",
  "default_role": "backend-engineer",
  "claudemd_sync": true,
  "memory_layers": {
    "short_term_ttl_hours": 8,
    "mid_term_ttl_days": 90
  }
}
```

Memory DB location: `~/.agentctx/memory.db` by default; override with the `AGENTCTX_DB_PATH` env var.
Logging verbosity: `LOG_LEVEL=silent|info|verbose|debug`.

---

## Library usage (programmatic)

Every module is exported and usable directly from TypeScript/Node.

```ts
import {
  MemoryStore,
  RoleManager,
  ContextCompiler,
  BudgetTracker,
  ChainRunner,
  commandExecutor,
} from '@dev-sajjad/agentctx';
// the MCP server lives on a subpath: import { startMcpServer } from '@dev-sajjad/agentctx/mcp';

const role = new RoleManager().loadBuiltIn('backend-engineer');

const compiled = new ContextCompiler().compile({
  role,
  task: 'add pagination',
  project: 'my-app',
  projectRoot: process.cwd(),
  memory: new MemoryStore(),
});

const report = new BudgetTracker().analyze(compiled, { historyTokens: 4000 });
console.log(report.status, report.totalUsed);

// Run a chain against any agent CLI (here: a hypothetical local model)
const runner = new ChainRunner({
  roles: new RoleManager(),
  compiler: new ContextCompiler(),
  projectRoot: process.cwd(),
  project: 'my-app',
  executor: commandExecutor({ command: 'ollama', args: ['run', 'llama3'] }),
});
```

---

## Development

```bash
npm run build       # tsc -> dist/
npm run dev         # tsx watch
npm test            # vitest (86 tests)
npm run typecheck   # tsc -p tsconfig.test.json (incl. tests)
npm run lint        # eslint . --ext .ts
npm run verify      # typecheck + lint + test + build (the full gate)
```

See [progress.md](progress.md) for the build log and design decisions.

---

## Releasing

Releases publish to npm from CI via **OpenID Connect (OIDC) trusted publishing** — no `NPM_TOKEN`
secret, short-lived credentials, and a signed provenance attestation on every release.

Pushing a `v*` tag triggers [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which
runs the full `verify` gate and then `npm publish`:

```bash
npm version patch        # bump 0.1.x — also makes a commit + a v0.1.x git tag
git push --follow-tags   # the tag push triggers the publish workflow
```

Use `npm version minor` / `major` as appropriate. This relies on the npm package's **Trusted
Publisher** being configured once (npmjs.com → package → Settings) to point at
`dev-sajjad/AgentCtx` with workflow `publish.yml`. Separately, [`ci.yml`](.github/workflows/ci.yml)
runs typecheck + lint + test + build on every push and PR (Node 20 and 22).

---

## Roadmap

Built: memory · roles · context compiler · token budget · debug inspector · MCP server · chains ·
real agent execution · vector search · global config · Cursor/Codex export · CLI.

Planned: CLAUDE.md manager (`edit`/`validate`/`sync`), `debug replay`/`export`, remote role registry,
semantic embedder (transformers.js) + LanceDB vector backend.

---

## License

MIT — use it, fork it, share it.
