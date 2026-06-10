import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

import {
  AgentChainSchema,
  type AgentChain,
  type ChainStep,
  type CompiledContext,
  type RoleTemplate,
} from '../shared/types.js';
import type { TokenCounter } from '../shared/tokens.js';
import type { MemoryStore } from '../memory/index.js';
import type { RoleManager } from '../roles/index.js';
import type { ContextCompiler } from '../compiler/index.js';
import { logger } from '../shared/logger.js';

/**
 * Multi-step agent pipelines. A chain is a list of {@link ChainStep}s run in
 * order; each step compiles a context for its role + task, runs through an
 * executor, and (optionally) stores its output under `output_key` so later
 * steps can interpolate it via `{{output_key}}`. `{{input}}` is the chain input.
 *
 * The executor is injectable: the actual agent/LLM call lives behind
 * {@link StepExecutor}. The default {@link dryRunExecutor} compiles but does not
 * invoke any agent — wire a real executor (claude CLI / API) to run for real.
 */

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export class ChainLoader {
  /** Validate a parsed value against the chain schema, with readable errors. */
  validate(raw: unknown): AgentChain {
    const result = AgentChainSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error('Invalid chain definition:\n' + issues);
    }
    return result.data;
  }

  /** Read, parse, and validate a chain YAML file. */
  loadFromFile(path: string): AgentChain {
    logger.debug('Loading chain from file:', path);
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed: unknown = parse(raw);
      return this.validate(parsed);
    } catch (err) {
      throw new Error(`Failed to load chain at ${path}: ${(err as Error).message}`);
    }
  }

  /** Resolve a named chain from `<root>/.agentctx/chains/<name>.yaml`. */
  loadNamed(name: string, root: string): AgentChain {
    const path = join(root, '.agentctx', 'chains', `${name}.yaml`);
    if (!existsSync(path)) {
      throw new Error(`Unknown chain "${name}" (expected ${path})`);
    }
    return this.loadFromFile(path);
  }
}

// ---------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------

/**
 * Replace `{{key}}` placeholders with values from `vars`. Unknown keys are left
 * literal and reported in `missing` so unresolved references stay visible.
 */
export function interpolate(
  template: string,
  vars: Record<string, string>,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key]!;
    missing.push(key);
    return `{{${key}}}`;
  });
  return { text, missing };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export interface StepExecutionContext {
  step: ChainStep;
  role: RoleTemplate;
  task: string;
  compiled: CompiledContext;
  vars: Record<string, string>;
}

/** Runs a single step. Return value becomes the step output. */
export type StepExecutor = (ctx: StepExecutionContext) => string | Promise<string>;

/** Default executor: compiles context but invokes no agent. */
export const dryRunExecutor: StepExecutor = (ctx) =>
  `[dry-run] step "${ctx.step.id}" (role=${ctx.role.name}) — compiled ${ctx.compiled.token_count} tokens; ` +
  `no agent invoked. Inject a StepExecutor to run a real agent.`;

export interface StepResult {
  id: string;
  role: string;
  task: string;
  output_key?: string;
  token_count: number;
  output: string;
  error?: string;
}

export interface ChainRunResult {
  chain: string;
  input: string;
  steps: StepResult[];
  /** Final variable map: `input` plus every step's stored `output_key`. */
  vars: Record<string, string>;
}

export interface ChainRunnerDeps {
  roles: RoleManager;
  compiler: ContextCompiler;
  memory?: MemoryStore;
  projectRoot: string;
  project: string;
  countTokens?: TokenCounter;
  /** Step executor. Defaults to {@link dryRunExecutor}. */
  executor?: StepExecutor;
}

export class ChainRunner {
  private readonly deps: ChainRunnerDeps;

  constructor(deps: ChainRunnerDeps) {
    this.deps = deps;
  }

  /** Run every step in order, threading outputs forward. Fail-fast on error. */
  async run(chain: AgentChain, input = ''): Promise<ChainRunResult> {
    const executor = this.deps.executor ?? dryRunExecutor;
    const vars: Record<string, string> = { input };
    const steps: StepResult[] = [];

    for (const step of chain.steps) {
      const { text: task, missing } = interpolate(step.task, vars);
      if (missing.length > 0) {
        logger.warn('chain step', step.id, 'has unresolved vars:', missing.join(', '));
      }

      let role: RoleTemplate;
      try {
        role = this.deps.roles.resolve(step.role, this.deps.projectRoot);
      } catch (err) {
        const message = (err as Error).message;
        logger.error('chain step', step.id, 'role load failed:', message);
        steps.push({
          id: step.id,
          role: step.role,
          task,
          token_count: 0,
          output: '',
          error: message,
          ...(step.output_key !== undefined ? { output_key: step.output_key } : {}),
        });
        break; // fail-fast — later steps likely depend on this one's output
      }

      const effectiveRole: RoleTemplate =
        step.context_includes !== undefined
          ? { ...role, context_includes: step.context_includes }
          : role;

      const compiled = this.deps.compiler.compile({
        role: effectiveRole,
        task,
        project: this.deps.project,
        projectRoot: this.deps.projectRoot,
        ...(this.deps.memory !== undefined ? { memory: this.deps.memory } : {}),
        ...(this.deps.countTokens !== undefined ? { countTokens: this.deps.countTokens } : {}),
      });

      let output: string;
      try {
        output = await executor({ step, role: effectiveRole, task, compiled, vars });
      } catch (err) {
        const message = (err as Error).message;
        logger.error('chain step', step.id, 'executor failed:', message);
        steps.push({
          id: step.id,
          role: step.role,
          task,
          token_count: compiled.token_count,
          output: '',
          error: message,
          ...(step.output_key !== undefined ? { output_key: step.output_key } : {}),
        });
        break; // fail-fast
      }

      if (step.output_key !== undefined) vars[step.output_key] = output;

      steps.push({
        id: step.id,
        role: step.role,
        task,
        token_count: compiled.token_count,
        output,
        ...(step.output_key !== undefined ? { output_key: step.output_key } : {}),
      });
    }

    return { chain: chain.name, input, steps, vars };
  }
}

export {
  claudeCliExecutor,
  commandExecutor,
  ollamaExecutor,
  type ClaudeCliOptions,
  type CommandExecutorOptions,
} from './executors.js';
