import { z } from 'zod';

/**
 * Single source of truth for AgentCtx data shapes.
 *
 * Zod-first: every schema below derives its TypeScript type via `z.infer`.
 * Import the type for compile-time use, the schema to validate untrusted input
 * (YAML files, JSON config, MCP tool args) at load time.
 */

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export const MemoryLayerSchema = z.enum(['short', 'mid', 'long']);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

export const MemoryEntrySchema = z.object({
  id: z.string(),
  layer: MemoryLayerSchema,
  content: z.string(),
  tags: z.array(z.string()),
  project: z.string(),
  created_at: z.number(),
  expires_at: z.number().nullable(),
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const RoleTemplateSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  system_prompt: z.string().min(1),
  context_includes: z.array(z.string()),
  context_excludes: z.array(z.string()),
  token_budget: z.number().int().positive(),
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

// ---------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------

export const ChainStepSchema = z.object({
  id: z.string(),
  role: z.string(),
  task: z.string(),
  context_includes: z.array(z.string()).optional(),
  /** Variable name under which this step's output is stored for later steps. */
  output_key: z.string().optional(),
});
export type ChainStep = z.infer<typeof ChainStepSchema>;

export const AgentChainSchema = z.object({
  name: z.string(),
  steps: z.array(ChainStepSchema),
});
export type AgentChain = z.infer<typeof AgentChainSchema>;

// ---------------------------------------------------------------------------
// Compiled context
// ---------------------------------------------------------------------------

export const ContextSourceSchema = z.object({
  type: z.enum(['file', 'memory', 'role']),
  path: z.string().optional(),
  content: z.string(),
  token_count: z.number(),
  relevance_score: z.number(),
});
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const CompiledContextSchema = z.object({
  system_prompt: z.string(),
  token_count: z.number(),
  sources: z.array(ContextSourceSchema),
});
export type CompiledContext = z.infer<typeof CompiledContextSchema>;

// ---------------------------------------------------------------------------
// Debug runs
// ---------------------------------------------------------------------------

/** One persisted compile/budget invocation, replayable via `agentctx debug`. */
export const RunRecordSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  command: z.string(),
  role: z.string(),
  task: z.string(),
  project: z.string(),
  model: z.string().optional(),
  compiled: CompiledContextSchema,
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const MemoryLayersConfigSchema = z.object({
  short_term_ttl_hours: z.number().default(8),
  mid_term_ttl_days: z.number().default(90),
});
export type MemoryLayersConfig = z.infer<typeof MemoryLayersConfigSchema>;

/** `.agentctx/config.json` — per-project settings (committed). */
export const ProjectConfigSchema = z.object({
  project_name: z.string(),
  default_role: z.string().optional(),
  claudemd_sync: z.boolean().default(true),
  /** Override the default `~/.agentctx/memory.db` location. */
  memory_db_path: z.string().optional(),
  memory_layers: MemoryLayersConfigSchema.default({
    short_term_ttl_hours: 8,
    mid_term_ttl_days: 90,
  }),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** `~/.agentctx/global-config.json` — settings across all projects. */
export const GlobalConfigSchema = z.object({
  default_model: z.string().default('claude-sonnet-4-6'),
  token_warning_threshold: z.number().default(0.75),
  memory_backend: z.enum(['sqlite']).default('sqlite'),
  vector_search: z.boolean().default(false),
  telemetry: z.boolean().default(false),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
