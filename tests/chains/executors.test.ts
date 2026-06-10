import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  claudeCliExecutor,
  commandExecutor,
  type StepExecutionContext,
} from '../../src/chains/index.js';
import type { RoleTemplate } from '../../src/shared/types.js';

function fakeCtx(task: string, system: string): StepExecutionContext {
  const role: RoleTemplate = {
    name: 'r',
    description: '',
    system_prompt: 'x',
    context_includes: [],
    context_excludes: [],
    token_budget: 1000,
  };
  return {
    step: { id: 's', role: 'r', task },
    role,
    task,
    compiled: { system_prompt: system, token_count: 1, sources: [] },
    vars: {},
  };
}

describe('commandExecutor', () => {
  it('passes the prompt on stdin and returns trimmed stdout', async () => {
    const script =
      'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write("LEN:"+d.length))';
    const exec = commandExecutor({ command: process.execPath, args: ['-e', script] });
    // prompt = "SYSTEM" + "\n\n" + "task" = 12 chars
    expect(await exec(fakeCtx('task', 'SYSTEM'))).toBe('LEN:12');
  });

  it('rejects with a clear error when the command is missing', async () => {
    const exec = commandExecutor({ command: 'agentctx-nonexistent-bin-xyz' });
    await expect(exec(fakeCtx('t', 's'))).rejects.toThrow(/not found/);
  });
});

describe('claudeCliExecutor', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentctx-exec-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('invokes the configured binary and returns its output', async () => {
    const stub = join(dir, 'claude-stub.sh');
    writeFileSync(stub, '#!/bin/sh\necho STUB-OK\n');
    chmodSync(stub, 0o755);

    const exec = claudeCliExecutor({ command: stub });
    expect(await exec(fakeCtx('do the thing', 'context'))).toBe('STUB-OK');
  });

  it('rejects when the claude binary is missing', async () => {
    const exec = claudeCliExecutor({ command: 'agentctx-nonexistent-claude-xyz' });
    await expect(exec(fakeCtx('t', 's'))).rejects.toThrow(/not found/);
  });
});
