import { existsSync, readFileSync } from 'node:fs';

import { GlobalConfigSchema, type GlobalConfig } from './types.js';
import { expandHome } from './utils.js';
import { logger } from './logger.js';

/**
 * Global, cross-project settings stored at `~/.agentctx/global-config.json`
 * (override the path with the `AGENTCTX_GLOBAL_CONFIG` env var).
 *
 * Fields (see {@link GlobalConfigSchema}): `default_model`,
 * `token_warning_threshold`, `memory_backend`, `vector_search`, `telemetry`.
 * A missing or invalid file resolves to schema defaults.
 */

export function globalConfigPath(): string {
  return process.env.AGENTCTX_GLOBAL_CONFIG ?? expandHome('~/.agentctx/global-config.json');
}

export function loadGlobalConfig(): GlobalConfig {
  const path = globalConfigPath();
  if (!existsSync(path)) return GlobalConfigSchema.parse({});
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return GlobalConfigSchema.parse(raw);
  } catch (err) {
    logger.error('invalid global-config.json, using defaults:', (err as Error).message);
    return GlobalConfigSchema.parse({});
  }
}
