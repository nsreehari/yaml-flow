/**
 * Inference — Types
 *
 * Type definitions for the LLM inference layer.
 * Pluggable adapter pattern: yaml-flow never calls an LLM directly.
 * The caller provides an InferenceAdapter that talks to their LLM of choice.
 */

import type { LiveGraph } from '../continuous-event-graph/types.js';

// ============================================================================
// Adapter — the pluggable LLM bridge
// ============================================================================

/**
 * The caller implements this to connect any LLM provider.
 * yaml-flow builds the prompt; the adapter sends it and returns the raw response.
 */
export interface InferenceAdapter {
  /** Send a prompt to an LLM and return the raw text response */
  analyze(prompt: string): Promise<string>;
}

// ============================================================================
// TaskConfig extension — inference hints on a node
// ============================================================================

/**
 * Optional inference metadata on a TaskConfig.
 * Tells the LLM what to look for when judging completion.
 */
export interface InferenceHints {
  /** Human-readable completion criteria (e.g., "Azure infrastructure setup completed") */
  criteria?: string;
  /** Keywords to help the LLM understand the domain */
  keywords?: string[];
  /** Suggested checks for verification (e.g., ["scan logs for 'Deployment Succeeded'"]) */
  suggestedChecks?: string[];
  /** Whether the LLM should attempt to auto-detect completion for this node */
  autoDetectable?: boolean;
}

// ============================================================================
// Options — control inference behavior
// ============================================================================

export interface InferenceOptions {
  /** Only return suggestions above this confidence threshold (default: 0.5) */
  threshold?: number;
  /** Only analyze these specific nodes (default: all non-completed autoDetectable nodes) */
  scope?: string[];
  /** Additional context to inject into the prompt (e.g., deployment logs, test output) */
  context?: string;
  /** Custom system prompt prefix (optional — uses a sensible default) */
  systemPrompt?: string;
}

// ============================================================================
// Results — structured inference output
// ============================================================================

export interface InferenceResult {
  /** Individual suggestions for node completions */
  suggestions: InferredCompletion[];
  /** The prompt that was sent to the LLM (for audit/debug) */
  promptUsed: string;
  /** The raw text response from the LLM */
  rawResponse: string;
  /** Nodes that were analyzed */
  analyzedNodes: string[];
}

export interface InferredCompletion {
  /** The task/node name */
  taskName: string;
  /** Confidence score from the LLM (0.0 - 1.0) */
  confidence: number;
  /** LLM's reasoning for why it thinks this node is complete */
  reasoning: string;
  /** Always 'llm-inferred' — distinguishes from manual/automated completions */
  detectionMethod: 'llm-inferred';
}

// ============================================================================
// Apply result — what inferAndApply returns
// ============================================================================

export interface InferAndApplyResult {
  /** The updated LiveGraph with inferred completions applied */
  live: LiveGraph;
  /** The full inference result (including suggestions below threshold) */
  inference: InferenceResult;
  /** Only the suggestions that were actually applied (above threshold) */
  applied: InferredCompletion[];
  /** Suggestions that were skipped (below threshold) */
  skipped: InferredCompletion[];
}
