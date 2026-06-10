import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MemoryStore } from '../memory/index.js';
import { RoleManager } from '../roles/index.js';
import { ContextCompiler } from '../compiler/index.js';
import { BudgetTracker } from '../budget/index.js';
import { DebugStore, DebugInspector } from '../debug/index.js';
import { countTokens } from '../shared/tokens.js';
import { loadProjectConfig, resolveProjectName } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { createHandlers, type McpDeps } from './tools.js';

export { createHandlers, type McpDeps, type AgentCtxHandlers } from './tools.js';

const LAYER = z.enum(['short', 'mid', 'long']);

/**
 * Register all AgentCtx tools on an MCP server. Separated from {@link startMcpServer}
 * so a server can be wired against custom dependencies (e.g. in tests).
 *
 * NOTE: stdio transport uses stdout for JSON-RPC — handlers and this module must
 * never write to stdout (no `logger.info`/`log`). Only `debug`/`warn`/`error`
 * (stderr) are safe.
 */
export function registerAgentCtxTools(server: McpServer, deps: McpDeps): void {
  const h = createHandlers(deps);

  server.registerTool(
    'memory_save',
    {
      description: 'Save a fact to the project memory store',
      inputSchema: { content: z.string(), layer: LAYER.optional(), tags: z.array(z.string()).optional() },
    },
    (args) => h.memorySave(args),
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Keyword search across the project memory store',
      inputSchema: { query: z.string(), limit: z.number().int().positive().optional() },
    },
    (args) => h.memorySearch(args),
  );

  server.registerTool(
    'memory_list',
    {
      description: 'List recent memory entries, optionally filtered by layer',
      inputSchema: { layer: LAYER.optional() },
    },
    (args) => h.memoryList(args),
  );

  server.registerTool(
    'role_list',
    { description: 'List available built-in role templates' },
    () => h.roleList(),
  );

  server.registerTool(
    'role_switch',
    { description: 'Switch the active role template for this session', inputSchema: { name: z.string() } },
    (args) => h.roleSwitch(args),
  );

  server.registerTool(
    'context_compile',
    {
      description: 'Compile a context bundle for a task and return the assembled prompt',
      inputSchema: { task: z.string(), role: z.string().optional() },
    },
    (args) => h.contextCompile(args),
  );

  server.registerTool(
    'budget_check',
    {
      description: 'Compile a context and return its token budget breakdown',
      inputSchema: {
        task: z.string().optional(),
        role: z.string().optional(),
        model: z.string().optional(),
        history: z.number().int().nonnegative().optional(),
      },
    },
    (args) => h.budgetCheck(args),
  );

  server.registerTool(
    'debug_last',
    { description: 'Return the full prompt and manifest from the last compiled run' },
    () => h.debugLast(),
  );

  server.registerTool(
    'claudemd_read',
    { description: 'Read the project CLAUDE.md' },
    () => h.claudemdRead(),
  );

  server.registerTool(
    'chain_run',
    { description: 'Run a named agent chain (not yet implemented)', inputSchema: { name: z.string() } },
    (args) => h.chainRun(args),
  );
}

/** Build the default dependency set rooted at the current working directory. */
function buildDeps(): McpDeps {
  const projectRoot = process.cwd();
  const config = loadProjectConfig(projectRoot);
  return {
    memory: new MemoryStore(),
    roles: new RoleManager(),
    compiler: new ContextCompiler(),
    budget: new BudgetTracker(),
    debugStore: new DebugStore(),
    inspector: new DebugInspector(),
    projectRoot,
    project: resolveProjectName(projectRoot, config),
    config,
    countTokens,
    session: { activeRole: config?.default_role ?? 'backend-engineer' },
  };
}

/** Start the AgentCtx MCP server over stdio. Blocks until the transport closes. */
export async function startMcpServer(): Promise<void> {
  const deps = buildDeps();
  const server = new McpServer({ name: 'agentctx', version: '0.1.0' });
  registerAgentCtxTools(server, deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the JSON-RPC channel.
  logger.debug('AgentCtx MCP server connected over stdio; project:', deps.project);
}
