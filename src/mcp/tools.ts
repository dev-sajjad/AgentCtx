import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import {
  ClaudeMdManager,
  suggestForClaudeMd,
  applySuggestions,
  formatSuggestions,
} from '../claudemd/index.js';
import type { MemoryStore } from '../memory/index.js';
import type { RoleManager } from '../roles/index.js';
import type { ContextCompiler } from '../compiler/index.js';
import type { BudgetTracker } from '../budget/index.js';
import type { DebugStore, DebugInspector } from '../debug/index.js';
import { ChainLoader, ChainRunner } from '../chains/index.js';
import type { TokenCounter } from '../shared/tokens.js';
import { expiryForLayer } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import type {
  AgentChain,
  CompiledContext,
  MemoryLayer,
  ProjectConfig,
  RoleTemplate,
} from '../shared/types.js';

/**
 * MCP tool handlers. Kept free of the MCP SDK *server* import so they are pure
 * and directly unit-testable; `src/mcp/index.ts` wires them to a transport.
 */
export interface McpDeps {
  memory: MemoryStore;
  roles: RoleManager;
  compiler: ContextCompiler;
  budget: BudgetTracker;
  debugStore: DebugStore;
  inspector: DebugInspector;
  projectRoot: string;
  project: string;
  config: ProjectConfig | null;
  countTokens: TokenCounter;
  /** Mutable per-connection session state. */
  session: { activeRole: string };
}

function text(message: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: message }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Compile a context for a role + task and record the run. Shared by two tools. */
function compileFor(
  deps: McpDeps,
  roleName: string,
  task: string,
): { role: RoleTemplate; compiled: CompiledContext } | { error: string } {
  let role: RoleTemplate;
  try {
    role = deps.roles.resolve(roleName, deps.projectRoot);
  } catch (err) {
    return { error: (err as Error).message };
  }

  const compiled = deps.compiler.compile({
    role,
    task,
    project: deps.project,
    projectRoot: deps.projectRoot,
    memory: deps.memory,
    countTokens: deps.countTokens,
  });

  try {
    deps.debugStore.save({ command: 'mcp:compile', role: role.name, task, project: deps.project, compiled });
  } catch (err) {
    logger.debug('mcp: failed to record run:', (err as Error).message);
  }

  return { role, compiled };
}

export interface AgentCtxHandlers {
  memorySave(args: { content: string; layer?: MemoryLayer; tags?: string[] }): CallToolResult;
  memorySearch(args: { query: string; limit?: number }): CallToolResult;
  memoryList(args: { layer?: MemoryLayer }): CallToolResult;
  roleList(): CallToolResult;
  roleSwitch(args: { name: string }): CallToolResult;
  contextCompile(args: { task: string; role?: string }): CallToolResult;
  budgetCheck(args: { task?: string; role?: string; model?: string; history?: number }): CallToolResult;
  debugLast(): CallToolResult;
  claudemdRead(): CallToolResult;
  claudemdSuggest(args: { apply?: boolean; section?: string }): CallToolResult;
  chainRun(args: { name: string; input?: string }): Promise<CallToolResult>;
}

/** Build the tool handlers bound to a set of dependencies. */
export function createHandlers(deps: McpDeps): AgentCtxHandlers {
  return {
    memorySave(args) {
      const layer: MemoryLayer = args.layer ?? 'mid';
      const tags = args.tags ?? [];
      const expires_at = expiryForLayer(layer, deps.config);
      const entry = deps.memory.save({
        layer,
        content: args.content,
        tags,
        project: deps.project,
        expires_at,
      });
      return text(`Saved memory ${entry.id} (layer=${layer}, project=${deps.project}).`);
    },

    memorySearch(args) {
      const results = deps.memory.search(args.query, deps.project, args.limit ?? 10);
      if (results.length === 0) return text(`No memory entries match "${args.query}".`);
      const body = results
        .map((e) => `- [${e.layer}] ${e.content}${e.tags.length ? ` (tags: ${e.tags.join(', ')})` : ''}`)
        .join('\n');
      return text(`${results.length} result(s):\n${body}`);
    },

    memoryList(args) {
      const results = deps.memory.list(deps.project, args.layer);
      if (results.length === 0) return text('No memory entries.');
      const body = results.map((e) => `- [${e.layer}] ${e.content}`).join('\n');
      return text(`${results.length} entr${results.length === 1 ? 'y' : 'ies'}:\n${body}`);
    },

    roleList() {
      const names = deps.roles.listBuiltIn();
      if (names.length === 0) return text('No built-in roles found.');
      return text(`Available roles: ${names.join(', ')}`);
    },

    roleSwitch(args) {
      try {
        deps.roles.resolve(args.name, deps.projectRoot);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      deps.session.activeRole = args.name;
      return text(`Active role set to "${args.name}".`);
    },

    contextCompile(args) {
      const roleName = args.role ?? deps.session.activeRole;
      const result = compileFor(deps, roleName, args.task);
      if ('error' in result) return errorResult(result.error);
      const { role, compiled } = result;
      const manifest = compiled.sources
        .map((s) => `  [${s.type}] ${s.path ?? s.type} — ${s.token_count}t`)
        .join('\n');
      return text(
        `Compiled context (role=${role.name}, ${compiled.token_count} tokens, ${compiled.sources.length} sources)\n${manifest}\n\n----- system prompt -----\n${compiled.system_prompt}`,
      );
    },

    budgetCheck(args) {
      const roleName = args.role ?? deps.session.activeRole;
      const result = compileFor(deps, roleName, args.task ?? '');
      if ('error' in result) return errorResult(result.error);
      const report = deps.budget.analyze(result.compiled, {
        model: args.model,
        historyTokens: args.history ?? 0,
      });
      return text(deps.budget.format(report));
    },

    debugLast() {
      const record = deps.debugStore.last();
      if (!record) return text('No runs recorded yet.');
      return text(deps.inspector.formatRun(record));
    },

    claudemdRead() {
      const mgr = new ClaudeMdManager(deps.projectRoot);
      const content = mgr.read();
      if (content === null) return errorResult('No CLAUDE.md found in the project root.');
      return text(content);
    },

    claudemdSuggest(args) {
      const mgr = new ClaudeMdManager(deps.projectRoot);
      const content = mgr.read();
      if (content === null) return errorResult('No CLAUDE.md found in the project root.');
      const memories = deps.memory.list(deps.project);
      const set = suggestForClaudeMd(content, memories, args.section ? { section: args.section } : {});
      if (args.apply) {
        if (set.additions.length === 0) return text('Nothing to apply — CLAUDE.md already covers stored memory.');
        mgr.write(applySuggestions(content, set));
        return text(`Added ${set.additions.length} fact(s) under "## ${set.section}".`);
      }
      return text(formatSuggestions(set));
    },

    async chainRun(args) {
      let chain: AgentChain;
      try {
        chain = new ChainLoader().loadNamed(args.name, deps.projectRoot);
      } catch (err) {
        return errorResult((err as Error).message);
      }
      const runner = new ChainRunner({
        roles: deps.roles,
        compiler: deps.compiler,
        memory: deps.memory,
        projectRoot: deps.projectRoot,
        project: deps.project,
        countTokens: deps.countTokens,
      });
      const result = await runner.run(chain, args.input ?? '');
      const body = result.steps
        .map((s) =>
          s.error !== undefined
            ? `  ✗ ${s.id}: ${s.error}`
            : `  ✓ ${s.id} (role=${s.role}, ${s.token_count}t)${s.output_key ? ` → ${s.output_key}` : ''}`,
        )
        .join('\n');
      return text(`Chain "${result.chain}" ran ${result.steps.length} step(s):\n${body}`);
    },
  };
}
