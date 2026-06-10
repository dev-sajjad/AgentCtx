import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';

import { RoleTemplateSchema, type RoleTemplate } from '../shared/types.js';
import { logger } from '../shared/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(HERE, '..', '..', 'templates', 'roles');

/**
 * Loads, validates, and resolves role templates.
 *
 * Templates come from two places:
 *  - built-in YAML shipped in `templates/roles` (resolved relative to this
 *    module so it works under both `tsx` (src) and the compiled `dist` tree);
 *  - arbitrary files passed by path via {@link loadFromFile}.
 *
 * All loads run untrusted YAML through {@link RoleTemplateSchema} before the
 * data is handed back, so callers always receive a fully-validated
 * {@link RoleTemplate}.
 */
export class RoleManager {
  /**
   * Validate an arbitrary parsed value against the role schema.
   *
   * @throws Error with each Zod issue formatted as `  - <path>: <message>`.
   */
  validate(raw: unknown): RoleTemplate {
    const result = RoleTemplateSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error('Invalid role template:\n' + issues);
    }
    return result.data;
  }

  /**
   * Read a YAML file from disk, parse it, and validate it.
   *
   * @throws Error wrapping any read/parse/validation failure with the path.
   */
  loadFromFile(path: string): RoleTemplate {
    logger.debug('Loading role template from file:', path);
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed: unknown = parse(raw);
      return this.validate(parsed);
    } catch (err) {
      throw new Error(`Failed to load role template at ${path}: ${(err as Error).message}`);
    }
  }

  /**
   * Resolve a built-in role template by name (without extension).
   *
   * @throws Error naming the missing role and listing the available built-ins.
   */
  loadBuiltIn(name: string): RoleTemplate {
    const p = join(BUILTIN_DIR, `${name}.yaml`);
    logger.debug('Resolving built-in role:', name, '->', p);
    if (!existsSync(p)) {
      const available = this.listBuiltIn();
      throw new Error(
        `Unknown built-in role "${name}". Available roles: ${available.join(', ')}`,
      );
    }
    return this.loadFromFile(p);
  }

  /**
   * List the names of all built-in role templates, sorted.
   *
   * @returns Sorted names with the `.yaml`/`.yml` extension stripped, or an
   * empty array if the built-in directory does not exist.
   */
  listBuiltIn(): string[] {
    if (!existsSync(BUILTIN_DIR)) {
      logger.debug('Built-in roles directory missing:', BUILTIN_DIR);
      return [];
    }
    const names = readdirSync(BUILTIN_DIR)
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      .map((file) => file.replace(/\.(ya?ml)$/, ''))
      .sort();
    logger.debug('Discovered built-in roles:', names);
    return names;
  }

  /**
   * Resolve a role by name, preferring a project-level template in
   * `<projectRoot>/.agentctx/roles/` over a built-in of the same name.
   */
  resolve(name: string, projectRoot: string): RoleTemplate {
    const projectPath = join(projectRoot, '.agentctx', 'roles', `${name}.yaml`);
    if (existsSync(projectPath)) {
      logger.debug('Resolving project role:', name, '->', projectPath);
      return this.loadFromFile(projectPath);
    }
    return this.loadBuiltIn(name);
  }

  /** List project-level role names from `<projectRoot>/.agentctx/roles/`, sorted. */
  listProject(projectRoot: string): string[] {
    const dir = join(projectRoot, '.agentctx', 'roles');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
      .map((file) => file.replace(/\.(ya?ml)$/, ''))
      .sort();
  }
}
