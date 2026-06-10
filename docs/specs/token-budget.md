# Token Budget

Real-time accounting of how much of the model's context window a compiled context consumes, with
warnings and trim suggestions. Drives `agentctx budget`.

## Counting tokens with tiktoken

Use [`tiktoken`](https://github.com/openai/tiktoken) as the token estimator. Default to a
`cl100k_base` / `o200k_base` encoder.

> **Caveat (state this plainly to users):** tiktoken uses **OpenAI BPE encodings**. Counts for
> **Claude models are APPROXIMATE** — typically within ~10–20% of the true count. The **exact**
> count comes from the Anthropic count-tokens API. tiktoken is chosen because it is **good enough
> for live budgeting** and is **fully offline** (no API round-trip per keystroke). Surface the
> approximation in the UI (e.g. a `~` prefix or footnote) so users don't treat estimates as exact.

Counting helper: `countTokens(text, model?) → number`, picking the encoder for the model and
falling back to the default estimator.

## Breakdown format

Per-source rows, each showing **tokens**, **percent of the context window**, and a **bar**, then
**Total used** and **Remaining**. Mirror the README budget table:

```
Context window: claude-sonnet-4-6 (200,000 tokens)
─────────────────────────────────────────────────────
System prompt        2,340 tokens   1.2%  ████
Role template          890 tokens   0.4%  ██
CLAUDE.md              450 tokens   0.2%  █
Memory (injected)    1,200 tokens   0.6%  ███
Files (src/api)     18,400 tokens   9.2%  ████████████████████
Conversation history 4,100 tokens   2.1%  █████
─────────────────────────────────────────────────────
Total used          27,380 tokens  13.7%
Remaining          172,620 tokens  86.3%  ✓ healthy

Suggestions: none
```

Rows (in order): **System prompt**, **Role template**, **CLAUDE.md**, **Memory (injected)**,
**Files**, **Conversation history**. Source rows map naturally from a `CompiledContext`'s
`ContextSource[]` (grouped by `type` / origin); conversation history is supplied by the caller.
`percent = tokens / contextWindow`. Bar length scales with percent. `Remaining = window − total`.

## Warning thresholds

- `token_warning_threshold` (global config, default **0.75**): **warn when usage ≥ 75%** of the
  model context window. Status line flips from `✓ healthy` to a warning.
- **Hard ceiling** at the window size — usage must never exceed `contextWindow`.
- When over threshold, emit **trim suggestions**:
  1. Drop the lowest-`relevance_score` `ContextSource`s (from the compiled manifest).
  2. Summarize / truncate conversation history.
  3. Lower the role's `token_budget`.

`agentctx budget --warn-only` (per README hook usage) should exit non-zero or print only the
warning when over threshold, for use in pre-prompt hooks.

## Model windows

The window depends on the model. Keep a small lookup keyed by model id with a safe default:

```ts
const MODEL_WINDOWS: Record<string, number> = {
  'claude-sonnet-4-6': 200_000,   // example; current Claude Sonnet ~200k window
  // add other Claude / model ids as needed
};
const DEFAULT_WINDOW = 200_000;   // safe fallback for unknown model ids

function contextWindow(model: string): number {
  return MODEL_WINDOWS[model] ?? DEFAULT_WINDOW;
}
```

The model id comes from `GlobalConfig.default_model` unless overridden per invocation.
