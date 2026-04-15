/**
 * Inference — Public API
 *
 * LLM inference layer for continuous-event-graph.
 * Pluggable adapter pattern: caller provides the LLM via InferenceAdapter.
 *
 * Core pattern:
 *   buildInferencePrompt(live)            → prompt string     (pure, sync)
 *   inferCompletions(live, adapter, opts)  → InferenceResult   (async, calls LLM)
 *   applyInferences(live, result, thresh)  → LiveGraph          (pure, sync)
 *   inferAndApply(live, adapter, opts)     → InferAndApplyResult (async, convenience)
 */

// Core functions
export {
  buildInferencePrompt,
  inferCompletions,
  applyInferences,
  inferAndApply,
} from './core.js';

// Built-in adapter factories
export {
  createCliAdapter,
  createHttpAdapter,
} from './adapters.js';

// Types
export type {
  InferenceAdapter,
  InferenceHints,
  InferenceOptions,
  InferenceResult,
  InferredCompletion,
  InferAndApplyResult,
} from './types.js';

export type {
  CliAdapterOptions,
  HttpAdapterOptions,
} from './adapters.js';
