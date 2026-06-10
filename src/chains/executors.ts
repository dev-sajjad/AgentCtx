import { spawn } from 'node:child_process';

import type { StepExecutor, StepExecutionContext } from './index.js';
import { logger } from '../shared/logger.js';

/**
 * Real step executors — they invoke an actual agent instead of the no-op
 * {@link dryRunExecutor}. All are local-first: they shell out to a CLI already
 * on the user's machine, so no API key or cloud setup is required beyond the
 * tool itself.
 *
 *  - {@link claudeCliExecutor}: runs `claude -p` (Claude Code headless). Uses the
 *    user's existing Claude Code auth — the zero-config path for the community.
 *  - {@link commandExecutor}: runs any command (codex, ollama, cursor, a custom
 *    script), passing the prompt via stdin or as an argument.
 */

interface RunProcessOptions {
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Spawn a process, optionally feeding stdin, and resolve with trimmed stdout. */
function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        reject(new Error(`'${command}' not found — is it installed and on your PATH?`));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${command} exited with code ${code ?? 'null'}: ${stderr.trim() || stdout.trim()}`));
      }
    });

    if (options.stdin !== undefined) {
      child.stdin?.write(options.stdin);
      child.stdin?.end();
    }
  });
}

export interface ClaudeCliOptions {
  /** Binary to invoke. Default `claude`. */
  command?: string;
  /** Model id, passed as `--model`. */
  model?: string;
  /** Extra args appended verbatim. */
  extraArgs?: string[];
  /** Working directory for the spawned process. */
  cwd?: string;
  /** Per-step timeout (ms). Default 120s. */
  timeoutMs?: number;
}

/**
 * Executor that runs each step through the Claude Code CLI in headless mode:
 * `claude -p "<task>" --append-system-prompt "<compiled context>"`. The compiled
 * context becomes the system prompt; the step's task is the user turn.
 */
export function claudeCliExecutor(options: ClaudeCliOptions = {}): StepExecutor {
  const command = options.command ?? 'claude';
  return (ctx: StepExecutionContext) => {
    const args = ['-p', ctx.task, '--append-system-prompt', ctx.compiled.system_prompt];
    if (options.model !== undefined) args.push('--model', options.model);
    if (options.extraArgs) args.push(...options.extraArgs);
    logger.debug('claude executor: running step', ctx.step.id, 'task chars', ctx.task.length);
    return runProcess(command, args, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  };
}

export interface CommandExecutorOptions {
  /** Binary to invoke (e.g. `codex`, `ollama`, a script). */
  command: string;
  /** Fixed args placed before the prompt. */
  args?: string[];
  /** How to deliver the prompt. Default `stdin`. */
  promptVia?: 'stdin' | 'arg';
  /** Build the prompt text. Default: `<system_prompt>\n\n<task>`. */
  buildPrompt?: (ctx: StepExecutionContext) => string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Executor that runs an arbitrary agent CLI. The prompt (compiled context plus
 * the task) is delivered on stdin by default, or appended as a final argument.
 */
export function commandExecutor(options: CommandExecutorOptions): StepExecutor {
  const buildPrompt =
    options.buildPrompt ?? ((ctx) => `${ctx.compiled.system_prompt}\n\n${ctx.task}`);
  const via = options.promptVia ?? 'stdin';
  return (ctx: StepExecutionContext) => {
    const prompt = buildPrompt(ctx);
    const args = [...(options.args ?? [])];
    if (via === 'arg') args.push(prompt);
    return runProcess(options.command, args, {
      ...(via === 'stdin' ? { stdin: prompt } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  };
}

/**
 * Preset for a local Ollama model: `ollama run <model>`, prompt on stdin. Fully
 * offline once the model is pulled. Example: `ollamaExecutor('llama3')`.
 */
export function ollamaExecutor(model: string, options: { cwd?: string; timeoutMs?: number } = {}): StepExecutor {
  return commandExecutor({ command: 'ollama', args: ['run', model], promptVia: 'stdin', ...options });
}
