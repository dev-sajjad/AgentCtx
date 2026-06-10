import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { ProjectConfigSchema, type MemoryLayer, type ProjectConfig } from './types.js';
import { daysToMs, hoursToMs, now } from './utils.js';
import { logger } from './logger.js';

/**
 * Project configuration helpers. Single place that reads and validates
 * `.agentctx/config.json`, shared by the CLI and the MCP server.
 */

/** Read and validate `<root>/.agentctx/config.json`. Returns null if absent/invalid. */
export function loadProjectConfig(root: string): ProjectConfig | null {
  const path = join(root, '.agentctx', 'config.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return ProjectConfigSchema.parse(raw);
  } catch (err) {
    logger.error('invalid .agentctx/config.json:', (err as Error).message);
    return null;
  }
}

/** Project name from config, falling back to the root directory's basename. */
export function resolveProjectName(root: string, config: ProjectConfig | null): string {
  return config?.project_name ?? basename(root);
}

/**
 * Compute `expires_at` for a memory entry from its layer and the project's TTL
 * config. `long` never expires (null); `short`/`mid` use the configured windows
 * (default 8h / 90d).
 */
export function expiryForLayer(
  layer: MemoryLayer,
  config: ProjectConfig | null,
  reference: number = now(),
): number | null {
  if (layer === 'long') return null;
  const shortHours = config?.memory_layers?.short_term_ttl_hours ?? 8;
  const midDays = config?.memory_layers?.mid_term_ttl_days ?? 90;
  return layer === 'short' ? reference + hoursToMs(shortHours) : reference + daysToMs(midDays);
}
