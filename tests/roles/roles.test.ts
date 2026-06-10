import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleManager } from '../../src/roles/index.js';

const ROLE_YAML = (name: string): string =>
  `name: ${name}\ndescription: test role\nsystem_prompt: You are ${name}.\ncontext_includes: []\ncontext_excludes: []\ntoken_budget: 1000\n`;

describe('RoleManager built-ins', () => {
  it('lists the shipped built-in roles', () => {
    const names = new RoleManager().listBuiltIn();
    expect(names).toContain('backend-engineer');
    expect(names).toContain('security-auditor');
    expect(names).toContain('qa-engineer');
  });

  it('throws a helpful error for an unknown built-in', () => {
    expect(() => new RoleManager().loadBuiltIn('nope')).toThrow(/Unknown built-in role/);
  });
});

describe('RoleManager project roles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agentctx-roles-'));
    mkdirSync(join(root, '.agentctx', 'roles'), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolve() falls back to a built-in when no project role exists', () => {
    const role = new RoleManager().resolve('backend-engineer', root);
    expect(role.name.toLowerCase()).toContain('backend');
  });

  it('resolve() prefers a project role over a built-in of the same name', () => {
    writeFileSync(join(root, '.agentctx', 'roles', 'backend-engineer.yaml'), ROLE_YAML('Project Backend'));
    const role = new RoleManager().resolve('backend-engineer', root);
    expect(role.name).toBe('Project Backend');
  });

  it('listProject() returns installed project role names', () => {
    writeFileSync(join(root, '.agentctx', 'roles', 'custom.yaml'), ROLE_YAML('Custom'));
    expect(new RoleManager().listProject(root)).toEqual(['custom']);
  });

  it('listProject() is empty when no project roles dir content exists', () => {
    rmSync(join(root, '.agentctx', 'roles'), { recursive: true, force: true });
    expect(new RoleManager().listProject(root)).toEqual([]);
  });
});
