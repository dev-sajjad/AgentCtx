import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ChainLoader,
  ChainRunner,
  interpolate,
  type StepExecutor,
  type StepExecutionContext,
} from '../../src/chains/index.js';
import { RoleManager } from '../../src/roles/index.js';
import { ContextCompiler } from '../../src/compiler/index.js';
import { estimateTokens } from '../../src/shared/tokens.js';
import type { AgentChain } from '../../src/shared/types.js';

describe('interpolate', () => {
  it('substitutes known vars and reports missing ones', () => {
    const { text, missing } = interpolate('plan for {{input}} using {{ctx}}', { input: 'auth' });
    expect(text).toBe('plan for auth using {{ctx}}');
    expect(missing).toEqual(['ctx']);
  });
});

describe('ChainLoader', () => {
  it('validates a well-formed chain', () => {
    const chain = new ChainLoader().validate({
      name: 'c',
      steps: [{ id: 's1', role: 'r', task: 't', output_key: 'o' }],
    });
    expect(chain.steps).toHaveLength(1);
  });

  it('throws on an invalid chain', () => {
    expect(() => new ChainLoader().validate({ name: 'c' })).toThrow(/Invalid chain/);
  });
});

describe('ChainRunner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentctx-chain-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'CLAUDE.md'), '# rules\nuse JWT auth\n');
    writeFileSync(join(root, 'src', 'auth.ts'), 'export const x = "auth token";\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeRunner(executor: StepExecutor): ChainRunner {
    return new ChainRunner({
      roles: new RoleManager(),
      compiler: new ContextCompiler(),
      projectRoot: root,
      project: 'demo',
      countTokens: estimateTokens,
      executor,
    });
  }

  it('threads each step output into the next step via {{output_key}}', async () => {
    const calls: StepExecutionContext[] = [];
    const executor: StepExecutor = (ctx) => {
      calls.push(ctx);
      return `out:${ctx.step.id}`;
    };
    const chain: AgentChain = {
      name: 'thread',
      steps: [
        { id: 'plan', role: 'backend-engineer', task: 'plan {{input}}', output_key: 'plan' },
        { id: 'build', role: 'backend-engineer', task: 'use {{plan}}', output_key: 'impl' },
      ],
    };

    const result = await makeRunner(executor).run(chain, 'rate limiting');

    expect(calls[0]?.task).toBe('plan rate limiting');
    expect(calls[1]?.task).toBe('use out:plan');
    expect(result.vars.plan).toBe('out:plan');
    expect(result.vars.impl).toBe('out:build');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.token_count).toBeGreaterThan(0);
  });

  it('applies a step context_includes override', async () => {
    const calls: StepExecutionContext[] = [];
    const executor: StepExecutor = (ctx) => {
      calls.push(ctx);
      return 'done';
    };
    const chain: AgentChain = {
      name: 'override',
      steps: [{ id: 'only', role: 'backend-engineer', task: 't', context_includes: ['CLAUDE.md'] }],
    };

    await makeRunner(executor).run(chain, '');

    const filePaths = calls[0]?.compiled.sources.filter((s) => s.type === 'file').map((s) => s.path);
    expect(filePaths).toEqual(['CLAUDE.md']); // src/auth.ts excluded by the override
  });

  it('fails fast and records the error when a role is unknown', async () => {
    const executor: StepExecutor = () => 'unused';
    const chain: AgentChain = {
      name: 'bad',
      steps: [
        { id: 'broken', role: 'ghost-role', task: 't', output_key: 'a' },
        { id: 'never', role: 'backend-engineer', task: '{{a}}' },
      ],
    };

    const result = await makeRunner(executor).run(chain, '');

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.error).toMatch(/Unknown built-in role/);
  });
});
