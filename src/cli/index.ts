#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { logger } from '../shared/logger.js';
import { RoleManager } from '../roles/index.js';
import { ContextCompiler } from '../compiler/index.js';
import { MemoryStore, VectorIndex, getDefaultDb } from '../memory/index.js';
import { BudgetTracker } from '../budget/index.js';
import { DebugStore, DebugInspector } from '../debug/index.js';
import { ChainRunner, ChainLoader, claudeCliExecutor, type StepExecutor } from '../chains/index.js';
import { startMcpServer } from '../mcp/index.js';
import { countTokens } from '../shared/tokens.js';
import { loadProjectConfig, resolveProjectName, expiryForLayer } from '../shared/config.js';
import { loadGlobalConfig, globalConfigPath } from '../shared/global-config.js';
import { exportIntegration } from '../integrations/index.js';
import type {
  AgentChain,
  CompiledContext,
  MemoryLayer,
  ProjectConfig,
  RoleTemplate,
} from '../shared/types.js';

/** AgentCtx CLI entry point — wires each command to its module. */

interface MemoryListOptions {
  layer?: string;
}

interface CompileOptions {
  role?: string;
  task?: string;
  preview?: boolean;
}

interface BudgetOptions {
  role?: string;
  task?: string;
  model?: string;
  history?: string;
  threshold?: string;
  warnOnly?: boolean;
}

interface BuiltContext {
  role: RoleTemplate;
  compiled: CompiledContext;
}

/** Resolve a role (project `.agentctx/roles/` then built-in); null on failure. */
function loadRole(name: string): RoleTemplate | null {
  try {
    return new RoleManager().resolve(name, process.cwd());
  } catch (err) {
    logger.error((err as Error).message);
    return null;
  }
}

/**
 * Resolve role + config and compile a context bundle for a task. Shared by
 * `compile` and `budget`. Injects the tiktoken-backed counter so token counts
 * match what `budget` displays. Returns null on failure (already logged).
 */
function buildContext(
  command: string,
  roleName: string | undefined,
  task: string,
): BuiltContext | null {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const resolvedRole = roleName ?? config?.default_role ?? 'backend-engineer';
  const project = resolveProjectName(root, config);

  const role = loadRole(resolvedRole);
  if (!role) return null;

  const compiled = new ContextCompiler().compile({
    role,
    task,
    project,
    projectRoot: root,
    memory: new MemoryStore(),
    countTokens,
  });

  // Record the run so `agentctx debug` can replay/diff it. Best-effort.
  try {
    new DebugStore().save({ command, role: role.name, task, project, compiled });
  } catch (err) {
    logger.debug('failed to record run:', (err as Error).message);
  }

  return { role, compiled };
}

/** Real implementation of `agentctx compile`. */
function runCompile(options: CompileOptions): void {
  if (!options.task) {
    logger.error('compile requires --task <task>');
    process.exitCode = 1;
    return;
  }

  const built = buildContext('compile', options.role, options.task);
  if (!built) {
    process.exitCode = 1;
    return;
  }
  const { role, compiled } = built;

  logger.info(
    `compiled context for role "${role.name}" — ${compiled.token_count} tokens, ${compiled.sources.length} sources`,
  );
  for (const source of compiled.sources) {
    const label = source.path ?? source.type;
    logger.info(
      `  [${source.type}] ${label} — ${source.token_count}t score=${source.relevance_score.toFixed(3)}`,
    );
  }
  if (options.preview) {
    logger.info('\n----- preview -----\n' + compiled.system_prompt);
  }
}

/** Parse a numeric CLI option, returning undefined if absent or invalid. */
function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Real implementation of `agentctx budget`. */
function runBudget(options: BudgetOptions): void {
  const built = buildContext('budget', options.role, options.task ?? '');
  if (!built) {
    process.exitCode = 1;
    return;
  }

  const global = loadGlobalConfig();
  const tracker = new BudgetTracker();
  const report = tracker.analyze(built.compiled, {
    model: options.model ?? global.default_model,
    historyTokens: parseNumber(options.history) ?? 0,
    warningThreshold: parseNumber(options.threshold) ?? global.token_warning_threshold,
  });

  if (options.warnOnly) {
    if (report.status !== 'healthy') {
      logger.warn(
        `token budget ${report.status}: ${report.totalUsed.toLocaleString('en-US')}/${report.contextWindow.toLocaleString('en-US')} tokens (${(report.totalPercent * 100).toFixed(1)}%)`,
      );
      process.exitCode = 1;
    }
    return;
  }

  logger.info('\n' + tracker.format(report));
}

interface DebugListOptions {
  limit?: string;
}

/** `agentctx debug last` — show the most recent recorded run. */
function runDebugLast(): void {
  const record = new DebugStore().last();
  if (!record) {
    logger.info('no runs recorded yet — run `agentctx compile` or `agentctx budget` first');
    return;
  }
  logger.info('\n' + new DebugInspector().formatRun(record));
}

/** `agentctx debug diff` — diff the two most recent recorded runs. */
function runDebugDiff(): void {
  const pair = new DebugStore().lastTwo();
  if (!pair) {
    logger.info('need at least two recorded runs to diff');
    return;
  }
  const inspector = new DebugInspector();
  const result = inspector.diff(pair.previous, pair.latest);
  logger.info('\n' + inspector.formatDiff(pair.previous, pair.latest, result));
}

/** `agentctx debug list` — list recent recorded runs. */
function runDebugList(options: DebugListOptions): void {
  const limit = parseNumber(options.limit) ?? 10;
  const records = new DebugStore().list(limit);
  if (records.length === 0) {
    logger.info('no runs recorded yet');
    return;
  }
  for (const r of records) {
    logger.info(
      `${new Date(r.created_at).toISOString()}  ${r.id}  [${r.command}]  role=${r.role}  ${r.compiled.token_count}t  task="${r.task || '(none)'}"`,
    );
  }
}

interface ChainRunOptions {
  input?: string;
  file?: string;
  executor?: string;
  model?: string;
}

/** Resolve the chosen executor. Returns undefined for the default (dry-run). */
function resolveExecutor(options: ChainRunOptions, cwd: string): StepExecutor | null | undefined {
  const choice = options.executor ?? 'dry-run';
  if (choice === 'dry-run') return undefined;
  if (choice === 'claude') {
    logger.info('running steps via the claude CLI (uses your Claude Code auth and quota)…');
    return claudeCliExecutor({ cwd, ...(options.model !== undefined ? { model: options.model } : {}) });
  }
  logger.error(`unknown executor "${choice}" (use: dry-run | claude)`);
  return null; // signal error
}

/** Load a chain by name (from `.agentctx/chains/`) or `--file` path. */
function loadChain(name: string, file: string | undefined, root: string): AgentChain | null {
  const loader = new ChainLoader();
  try {
    return file !== undefined ? loader.loadFromFile(file) : loader.loadNamed(name, root);
  } catch (err) {
    logger.error((err as Error).message);
    return null;
  }
}

/** `agentctx chain run <name>` — run a chain end to end (dry-run executor). */
async function runChain(name: string, options: ChainRunOptions): Promise<void> {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);

  const chain = loadChain(name, options.file, root);
  if (!chain) {
    process.exitCode = 1;
    return;
  }

  const executor = resolveExecutor(options, root);
  if (executor === null) {
    process.exitCode = 1;
    return;
  }

  const runner = new ChainRunner({
    roles: new RoleManager(),
    compiler: new ContextCompiler(),
    memory: new MemoryStore(),
    projectRoot: root,
    project,
    countTokens,
    ...(executor !== undefined ? { executor } : {}),
  });

  const result = await runner.run(chain, options.input ?? '');
  logger.info(
    `chain "${result.chain}" — ${result.steps.length} step(s), input="${result.input || '(none)'}"`,
  );
  for (const step of result.steps) {
    if (step.error !== undefined) {
      logger.error(`  ✗ ${step.id} (role=${step.role}) — ${step.error}`);
      continue;
    }
    logger.info(
      `  ✓ ${step.id} (role=${step.role}) — ${step.token_count}t${step.output_key ? ` → ${step.output_key}` : ''}`,
    );
    logger.info(`      ${step.output}`);
  }
}

// ---------------------------------------------------------------------------
// init / memory / role implementations
// ---------------------------------------------------------------------------

interface InitOptions {
  name?: string;
  force?: boolean;
}

interface MemoryAddOptions {
  layer?: string;
  tags?: string;
}

interface MemorySearchOptions {
  limit?: string;
}

const VALID_LAYERS: readonly MemoryLayer[] = ['short', 'mid', 'long'];

/** undefined = not provided, null = invalid, else the validated layer. */
function asLayer(value: string | undefined): MemoryLayer | null | undefined {
  if (value === undefined) return undefined;
  return (VALID_LAYERS as readonly string[]).includes(value) ? (value as MemoryLayer) : null;
}

function writeProjectConfig(root: string, config: ProjectConfig): void {
  writeFileSync(join(root, '.agentctx', 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function claudemdTemplate(name: string): string {
  return (
    `# ${name}\n\n` +
    '## Architecture\n\n_Describe the stack and key decisions._\n\n' +
    '## Coding conventions\n\n_List the conventions agents must follow._\n\n' +
    '## Commands\n\n- Build: ``\n- Test: ``\n- Lint: ``\n\n' +
    '## Off-limits\n\n- Never edit:\n- Always ask before:\n'
  );
}

/** `agentctx init` — scaffold `.agentctx/` and a starter CLAUDE.md. Idempotent. */
function runInit(options: InitOptions): void {
  const root = process.cwd();
  const name = options.name ?? basename(root);
  const dir = join(root, '.agentctx');
  const created: string[] = [];
  const skipped: string[] = [];

  mkdirSync(join(dir, 'roles'), { recursive: true });
  mkdirSync(join(dir, 'chains'), { recursive: true });

  const configPath = join(dir, 'config.json');
  if (existsSync(configPath) && !options.force) {
    skipped.push('.agentctx/config.json');
  } else {
    writeProjectConfig(root, {
      project_name: name,
      default_role: 'backend-engineer',
      claudemd_sync: true,
      memory_layers: { short_term_ttl_hours: 8, mid_term_ttl_days: 90 },
    });
    created.push('.agentctx/config.json');
  }

  const claudemdPath = join(root, 'CLAUDE.md');
  if (existsSync(claudemdPath)) {
    skipped.push('CLAUDE.md');
  } else {
    writeFileSync(claudemdPath, claudemdTemplate(name), 'utf-8');
    created.push('CLAUDE.md');
  }

  for (const f of created) logger.info('created', f);
  for (const f of skipped) logger.info('exists, skipped', f);
  logger.info(
    `AgentCtx ready (project "${name}"). Try: agentctx role list • agentctx memory add "…" • agentctx compile -t "…"`,
  );
}

/** `agentctx memory add <content>`. */
function runMemoryAdd(content: string, options: MemoryAddOptions): void {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);

  const layerResult = asLayer(options.layer);
  if (layerResult === null) {
    logger.error(`invalid layer "${options.layer}" (use: short | mid | long)`);
    process.exitCode = 1;
    return;
  }
  const layer: MemoryLayer = layerResult ?? 'mid';
  const tags = options.tags
    ? options.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  const entry = new MemoryStore().save({
    layer,
    content,
    tags,
    project,
    expires_at: expiryForLayer(layer, config),
  });
  if (loadGlobalConfig().vector_search) {
    new VectorIndex(getDefaultDb()).indexEntry(entry);
  }
  logger.info(
    `saved ${entry.id} (layer=${layer}, project=${project}${tags.length ? `, tags=${tags.join(',')}` : ''})`,
  );
}

/** `agentctx memory search <query>`. */
function runMemorySearch(query: string, options: MemorySearchOptions): void {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);
  const limit = parseNumber(options.limit) ?? 10;

  const results = loadGlobalConfig().vector_search
    ? new VectorIndex(getDefaultDb()).search(query, project, limit)
    : new MemoryStore().search(query, project, limit);
  if (results.length === 0) {
    logger.info(`no memory entries match "${query}"`);
    return;
  }
  for (const e of results) {
    logger.info(`[${e.layer}] ${e.content}${e.tags.length ? `  (${e.tags.join(', ')})` : ''}`);
  }
}

/** `agentctx memory reindex` — rebuild vector embeddings for this project. */
function runMemoryReindex(): void {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);
  const entries = new MemoryStore().list(project);
  const n = new VectorIndex(getDefaultDb()).reindex(entries);
  logger.info(`reindexed ${n} memory entries for "${project}"`);
}

/** `agentctx memory list`. */
function runMemoryList(options: MemoryListOptions): void {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);

  const layerResult = asLayer(options.layer);
  if (layerResult === null) {
    logger.error(`invalid layer "${options.layer}" (use: short | mid | long)`);
    process.exitCode = 1;
    return;
  }
  const results = new MemoryStore().list(project, layerResult ?? undefined);
  if (results.length === 0) {
    logger.info('no memory entries');
    return;
  }
  for (const e of results) {
    logger.info(`[${e.layer}] ${e.content}${e.tags.length ? `  (${e.tags.join(', ')})` : ''}`);
  }
}

/** `agentctx role use <name>` — persist the active role to config. */
function runRoleUse(name: string): void {
  const root = process.cwd();
  const config = loadProjectConfig(root);
  if (!config) {
    logger.error('no .agentctx/config.json found — run `agentctx init` first');
    process.exitCode = 1;
    return;
  }
  try {
    new RoleManager().resolve(name, root);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  writeProjectConfig(root, { ...config, default_role: name });
  logger.info(`active role set to "${name}" (saved to .agentctx/config.json)`);
}

/** `agentctx role list` — built-in + project roles, active marked with `*`. */
function runRoleList(): void {
  const root = process.cwd();
  const active = loadProjectConfig(root)?.default_role;
  const rm = new RoleManager();
  const builtins = rm.listBuiltIn();
  const projectRoles = rm.listProject(root);

  logger.info('Built-in roles:');
  for (const n of builtins) logger.info(`  ${n === active ? '*' : ' '} ${n}`);
  if (projectRoles.length > 0) {
    logger.info('Project roles (.agentctx/roles):');
    for (const n of projectRoles) logger.info(`  ${n === active ? '*' : ' '} ${n}`);
  }
}

/** `agentctx role install <ref>` — copy a local role YAML into the project. */
function runRoleInstall(ref: string): void {
  const root = process.cwd();
  if (!ref.endsWith('.yaml') && !ref.endsWith('.yml')) {
    logger.error('only local .yaml/.yml paths are supported (registry/URL install not implemented)');
    process.exitCode = 1;
    return;
  }
  if (!existsSync(ref)) {
    logger.error(`file not found: ${ref}`);
    process.exitCode = 1;
    return;
  }
  let role: RoleTemplate;
  try {
    role = new RoleManager().loadFromFile(ref);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const destDir = join(root, '.agentctx', 'roles');
  mkdirSync(destDir, { recursive: true });
  const slug = basename(ref).replace(/\.(ya?ml)$/, '');
  copyFileSync(ref, join(destDir, `${slug}.yaml`));
  logger.info(`installed role "${role.name}" → .agentctx/roles/${slug}.yaml (use it: agentctx role use ${slug})`);
}

/** `agentctx config show` — print effective global + project config. */
function runConfigShow(): void {
  const root = process.cwd();
  const project = loadProjectConfig(root);
  logger.info(`Global config (${globalConfigPath()}):`);
  logger.info(JSON.stringify(loadGlobalConfig(), null, 2));
  logger.info('Project config (.agentctx/config.json):');
  logger.info(project ? JSON.stringify(project, null, 2) : '(none — run `agentctx init`)');
}

interface ExportOptions {
  role?: string;
  task?: string;
}

/** `agentctx export <cursor|codex>` — write a rules file for another tool. */
function runExport(tool: string, options: ExportOptions): void {
  if (tool !== 'cursor' && tool !== 'codex') {
    logger.error('export target must be: cursor | codex (claude-code uses CLAUDE.md via init)');
    process.exitCode = 1;
    return;
  }
  const root = process.cwd();
  const config = loadProjectConfig(root);
  const project = resolveProjectName(root, config);
  const role = loadRole(options.role ?? config?.default_role ?? 'backend-engineer');
  if (!role) {
    process.exitCode = 1;
    return;
  }
  const store = new MemoryStore();
  const notes = (
    options.task ? store.search(options.task, project, 5) : store.list(project).slice(0, 5)
  ).map((e) => e.content);

  const path = exportIntegration(tool, { role, notes }, root);
  logger.info(`wrote ${tool} rules → ${path} (role: ${role.name}, ${notes.length} memory notes)`);
}

const program = new Command();

program
  .name('agentctx')
  .description(
    'Agent Context Manager — manage context windows, memory, roles, and agent chains for LLM-based agentic tools.',
  )
  .version('0.1.0')
  .showHelpAfterError();

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('initialize an AgentCtx project in the current directory')
  .option('-n, --name <name>', 'project name (default: directory name)')
  .option('--force', 'overwrite an existing .agentctx/config.json')
  .action((options: InitOptions): void => {
    runInit(options);
  });

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

const memory = program.command('memory').description('manage layered agent memory');

memory
  .command('add')
  .description('add a memory entry')
  .argument('<content>', 'memory content to store')
  .option('-l, --layer <layer>', 'memory layer (short | mid | long), default mid')
  .option('-t, --tags <tags>', 'comma-separated tags')
  .action((content: string, options: MemoryAddOptions): void => {
    runMemoryAdd(content, options);
  });

memory
  .command('search')
  .description('search stored memory entries')
  .argument('<query>', 'search query')
  .option('-n, --limit <n>', 'max results (default 10)')
  .action((query: string, options: MemorySearchOptions): void => {
    runMemorySearch(query, options);
  });

memory
  .command('list')
  .description('list stored memory entries')
  .option('-l, --layer <layer>', 'filter by memory layer (short | mid | long)')
  .action((options: MemoryListOptions): void => {
    runMemoryList(options);
  });

memory
  .command('reindex')
  .description('rebuild vector embeddings for this project (used when vector_search is on)')
  .action((): void => {
    runMemoryReindex();
  });

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

const role = program.command('role').description('manage and apply role templates');

role
  .command('use')
  .description('set the active role (persisted to .agentctx/config.json)')
  .argument('<name>', 'role name to activate')
  .action((name: string): void => {
    runRoleUse(name);
  });

role
  .command('list')
  .description('list available role templates')
  .action((): void => {
    runRoleList();
  });

role
  .command('install')
  .description('install a role template from a local .yaml file')
  .argument('<ref>', 'path to a role .yaml/.yml file')
  .action((ref: string): void => {
    runRoleInstall(ref);
  });

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

program
  .command('budget')
  .description('show token usage breakdown for a compiled context')
  .option('-r, --role <role>', 'role template to compile for')
  .option('-t, --task <task>', 'task description to compile for')
  .option('-m, --model <model>', 'model id (selects the context window)')
  .option('--history <tokens>', 'conversation-history tokens to include')
  .option('--threshold <fraction>', 'warning threshold (0..1), default 0.75')
  .option('--warn-only', 'print only a warning when over threshold; exit non-zero')
  .action((options: BudgetOptions): void => {
    runBudget(options);
  });

// ---------------------------------------------------------------------------
// compile
// ---------------------------------------------------------------------------

program
  .command('compile')
  .description('compile a context bundle for a role and task')
  .option('-r, --role <role>', 'role template to compile for')
  .option('-t, --task <task>', 'task description to compile for')
  .option('--preview', 'preview the compiled context without writing it')
  .action((options: CompileOptions): void => {
    runCompile(options);
  });

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

const debug = program.command('debug').description('inspect recent context compilations');

debug
  .command('last')
  .description('show the most recent compiled context')
  .action((): void => {
    runDebugLast();
  });

debug
  .command('diff')
  .description('diff the two most recent compiled contexts')
  .action((): void => {
    runDebugDiff();
  });

debug
  .command('list')
  .description('list recent recorded runs')
  .option('-n, --limit <n>', 'max runs to show (default 10)')
  .action((options: DebugListOptions): void => {
    runDebugList(options);
  });

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

program
  .command('mcp')
  .description('start the AgentCtx MCP server (stdio)')
  .action(async (): Promise<void> => {
    try {
      await startMcpServer();
    } catch (err) {
      // stderr-safe: the stdio transport owns stdout.
      logger.error('failed to start MCP server:', (err as Error).message);
      process.exitCode = 1;
    }
  });

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

const chain = program.command('chain').description('run multi-step agent chains');

chain
  .command('run')
  .description('run a named agent chain')
  .argument('<name>', 'chain name to run (from .agentctx/chains/)')
  .option('-i, --input <text>', 'input value bound to {{input}}')
  .option('-f, --file <path>', 'load the chain from an explicit file path instead')
  .option('-e, --executor <type>', 'step executor: dry-run (default) | claude', 'dry-run')
  .option('-m, --model <model>', 'model id for the claude executor')
  .action(async (name: string, options: ChainRunOptions): Promise<void> => {
    await runChain(name, options);
  });

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const config = program.command('config').description('inspect AgentCtx configuration');

config
  .command('show')
  .description('print the effective global and project configuration')
  .action((): void => {
    runConfigShow();
  });

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

program
  .command('export')
  .description('export the active role + memory as rules for another tool')
  .argument('<tool>', 'cursor | codex')
  .option('-r, --role <role>', 'role to export (default: active role)')
  .option('-t, --task <task>', 'task used to select relevant memory notes')
  .action((tool: string, options: ExportOptions): void => {
    runExport(tool, options);
  });

program.parse(process.argv);
