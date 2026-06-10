import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { createHandlers, type AgentCtxHandlers, type McpDeps } from '../../src/mcp/tools.js';
import { MemoryStore } from '../../src/memory/index.js';
import { migrate } from '../../src/memory/db.js';
import { RoleManager } from '../../src/roles/index.js';
import { ContextCompiler } from '../../src/compiler/index.js';
import { BudgetTracker } from '../../src/budget/index.js';
import { DebugStore, DebugInspector } from '../../src/debug/index.js';
import { estimateTokens } from '../../src/shared/tokens.js';

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

let root: string;
let deps: McpDeps;
let handlers: AgentCtxHandlers;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentctx-mcp-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'CLAUDE.md'), '# Project rules\nuse JWT auth on port 3000\n');
  writeFileSync(join(root, 'src', 'auth.ts'), 'export const refreshAuthToken = () => "auth token jwt";\n');

  const db = new Database(':memory:');
  migrate(db);

  deps = {
    memory: new MemoryStore(db),
    roles: new RoleManager(),
    compiler: new ContextCompiler(),
    budget: new BudgetTracker(),
    debugStore: new DebugStore(join(root, '.agentctx', 'runs')),
    inspector: new DebugInspector(),
    projectRoot: root,
    project: 'demo',
    config: null,
    countTokens: estimateTokens,
    session: { activeRole: 'backend-engineer' },
  };
  handlers = createHandlers(deps);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('memory tools', () => {
  it('saves and searches memory', () => {
    expect(textOf(handlers.memorySave({ content: 'auth tokens use JWT', layer: 'mid', tags: ['auth'] }))).toContain(
      'Saved memory',
    );
    expect(textOf(handlers.memorySearch({ query: 'auth jwt' }))).toContain('auth tokens use JWT');
  });

  it('computes layer expiry (long never expires, short does)', () => {
    handlers.memorySave({ content: 'permanent', layer: 'long' });
    handlers.memorySave({ content: 'temp', layer: 'short' });
    const entries = deps.memory.list('demo');
    expect(entries.find((e) => e.content === 'permanent')?.expires_at).toBeNull();
    expect(entries.find((e) => e.content === 'temp')?.expires_at).not.toBeNull();
  });

  it('lists memory entries', () => {
    expect(textOf(handlers.memoryList({}))).toContain('No memory entries');
    handlers.memorySave({ content: 'a useful note', layer: 'mid' });
    expect(textOf(handlers.memoryList({}))).toContain('a useful note');
  });
});

describe('role tools', () => {
  it('lists built-in roles', () => {
    expect(textOf(handlers.roleList())).toContain('backend-engineer');
  });

  it('switches to a valid role and rejects an unknown one', () => {
    expect(textOf(handlers.roleSwitch({ name: 'security-auditor' }))).toContain('security-auditor');
    expect(deps.session.activeRole).toBe('security-auditor');
    expect(handlers.roleSwitch({ name: 'ghost' }).isError).toBe(true);
  });
});

describe('compile / budget / debug tools', () => {
  it('compiles a context and records a run', () => {
    const out = textOf(handlers.contextCompile({ task: 'fix the auth token bug' }));
    expect(out).toContain('Compiled context');
    expect(out).toContain('system prompt');
    expect(deps.debugStore.last()).not.toBeNull();
  });

  it('reports a token budget', () => {
    const out = textOf(handlers.budgetCheck({ task: 'auth' }));
    expect(out).toContain('Context window');
    expect(out).toContain('Total used');
  });

  it('debug_last reflects the most recent compile', () => {
    expect(textOf(handlers.debugLast())).toContain('No runs recorded');
    handlers.contextCompile({ task: 'auth token' });
    expect(textOf(handlers.debugLast())).toContain('system prompt');
  });

  it('rejects an unknown role at compile time', () => {
    expect(handlers.contextCompile({ task: 'x', role: 'ghost' }).isError).toBe(true);
  });
});

describe('claudemd / chain tools', () => {
  it('reads CLAUDE.md', () => {
    expect(textOf(handlers.claudemdRead())).toContain('use JWT auth on port 3000');
  });

  it('chain_run runs a named chain and errors on an unknown one', async () => {
    mkdirSync(join(root, '.agentctx', 'chains'), { recursive: true });
    writeFileSync(
      join(root, '.agentctx', 'chains', 'demo.yaml'),
      'name: Demo\nsteps:\n  - id: plan\n    role: backend-engineer\n    task: "plan {{input}}"\n    output_key: plan\n',
    );

    const ok = await handlers.chainRun({ name: 'demo', input: 'x' });
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('plan');

    const bad = await handlers.chainRun({ name: 'ghost' });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Unknown chain');
  });
});
