import { L as LiveGraph } from '../types-CoW0gQl3.js';
import '../types-BBhqYGhE.js';

/**
 * Inference — Types
 *
 * Type definitions for the LLM inference layer.
 * Pluggable adapter pattern: yaml-flow never calls an LLM directly.
 * The caller provides an InferenceAdapter that talks to their LLM of choice.
 */

/**
 * The caller implements this to connect any LLM provider.
 * yaml-flow builds the prompt; the adapter sends it and returns the raw response.
 */
interface InferenceAdapter {
    /** Send a prompt to an LLM and return the raw text response */
    analyze(prompt: string): Promise<string>;
}
/**
 * Optional inference metadata on a TaskConfig.
 * Tells the LLM what to look for when judging completion.
 */
interface InferenceHints {
    /** Human-readable completion criteria (e.g., "Azure infrastructure setup completed") */
    criteria?: string;
    /** Keywords to help the LLM understand the domain */
    keywords?: string[];
    /** Suggested checks for verification (e.g., ["scan logs for 'Deployment Succeeded'"]) */
    suggestedChecks?: string[];
    /** Whether the LLM should attempt to auto-detect completion for this node */
    autoDetectable?: boolean;
}
interface InferenceOptions {
    /** Only return suggestions above this confidence threshold (default: 0.5) */
    threshold?: number;
    /** Only analyze these specific nodes (default: all non-completed autoDetectable nodes) */
    scope?: string[];
    /** Additional context to inject into the prompt (e.g., deployment logs, test output) */
    context?: string;
    /** Custom system prompt prefix (optional — uses a sensible default) */
    systemPrompt?: string;
}
interface InferenceResult {
    /** Individual suggestions for node completions */
    suggestions: InferredCompletion[];
    /** The prompt that was sent to the LLM (for audit/debug) */
    promptUsed: string;
    /** The raw text response from the LLM */
    rawResponse: string;
    /** Nodes that were analyzed */
    analyzedNodes: string[];
}
interface InferredCompletion {
    /** The task/node name */
    taskName: string;
    /** Confidence score from the LLM (0.0 - 1.0) */
    confidence: number;
    /** LLM's reasoning for why it thinks this node is complete */
    reasoning: string;
    /** Always 'llm-inferred' — distinguishes from manual/automated completions */
    detectionMethod: 'llm-inferred';
}
interface InferAndApplyResult {
    /** The updated LiveGraph with inferred completions applied */
    live: LiveGraph;
    /** The full inference result (including suggestions below threshold) */
    inference: InferenceResult;
    /** Only the suggestions that were actually applied (above threshold) */
    applied: InferredCompletion[];
    /** Suggestions that were skipped (below threshold) */
    skipped: InferredCompletion[];
}

/**
 * Inference — Core
 *
 * LLM inference layer for continuous-event-graph.
 * Pluggable adapter pattern: yaml-flow builds the prompt and parses the
 * response; the caller provides the LLM via an InferenceAdapter.
 *
 * Core pattern:
 *   buildInferencePrompt(live)            → prompt string     (pure, sync)
 *   inferCompletions(live, adapter, opts)  → InferenceResult   (async, calls LLM)
 *   applyInferences(live, result, thresh)  → LiveGraph          (pure, sync)
 *   inferAndApply(live, adapter, opts)     → InferAndApplyResult (async, convenience)
 */

/**
 * Build an LLM prompt from the current LiveGraph state.
 * Includes only nodes that are:
 *   - Not yet completed
 *   - Have `inference.autoDetectable` set to true (or are in scope)
 *
 * Pure function — no side effects.
 */
declare function buildInferencePrompt(live: LiveGraph, options?: InferenceOptions): string;
/**
 * Ask an LLM to analyze the current graph state and suggest completions.
 *
 * Builds a prompt from the LiveGraph, sends it through the adapter,
 * parses the structured response, and returns an InferenceResult.
 */
declare function inferCompletions(live: LiveGraph, adapter: InferenceAdapter, options?: InferenceOptions): Promise<InferenceResult>;
/**
 * Apply inferred completions to a LiveGraph.
 * Only applies suggestions at or above the given confidence threshold.
 *
 * Under the hood, this fires `task-started` + `task-completed` events
 * for each accepted suggestion (if the task isn't already running/completed).
 *
 * Pure function — returns a new LiveGraph.
 */
declare function applyInferences(live: LiveGraph, result: InferenceResult, threshold?: number): LiveGraph;
/**
 * Convenience: infer completions and apply them in one step.
 * Returns the updated LiveGraph + full audit trail of what was inferred vs applied.
 */
declare function inferAndApply(live: LiveGraph, adapter: InferenceAdapter, options?: InferenceOptions): Promise<InferAndApplyResult>;

/**
 * Inference — Built-in Adapter Factories
 *
 * Ready-made adapter constructors for common LLM interfaces.
 * Each returns an InferenceAdapter.
 *
 * CLI adapters spawn a child process and capture stdout.
 * HTTP adapters POST to an endpoint and read the response.
 */

interface CliAdapterOptions {
    /** The command to execute (e.g., 'gh', 'ollama', 'llm') */
    command: string;
    /**
     * Arguments builder: receives the prompt and returns the args array.
     * The prompt is passed as an argument — NOT via stdin — unless you override.
     *
     * @example gh copilot:  (prompt) => ['copilot', 'suggest', '-t', 'shell', prompt]
     * @example ollama:      (prompt) => ['run', 'llama3', prompt]
     * @example llm cli:     (prompt) => ['--model', 'gpt-4o', prompt]
     */
    args: (prompt: string) => string[];
    /** Max execution time in ms (default: 60000) */
    timeout?: number;
    /** Working directory for the child process */
    cwd?: string;
    /** Environment variables to pass to the child process */
    env?: Record<string, string>;
    /**
     * If true, pass the prompt via stdin instead of as a CLI argument.
     * Useful for long prompts that exceed shell argument limits.
     * Default: false
     */
    stdin?: boolean;
}
/**
 * Create an InferenceAdapter that executes a local CLI command.
 * The prompt is passed as a CLI argument (or via stdin if opts.stdin=true).
 * stdout is captured as the LLM response.
 *
 * @example
 * // GitHub Copilot CLI
 * const adapter = createCliAdapter({
 *   command: 'gh',
 *   args: (prompt) => ['copilot', 'suggest', '-t', 'shell', prompt],
 * });
 *
 * @example
 * // Ollama (local LLM)
 * const adapter = createCliAdapter({
 *   command: 'ollama',
 *   args: (prompt) => ['run', 'llama3', prompt],
 * });
 *
 * @example
 * // Simon Willison's llm CLI
 * const adapter = createCliAdapter({
 *   command: 'llm',
 *   args: (prompt) => ['--model', 'gpt-4o', prompt],
 * });
 *
 * @example
 * // Any script (stdin mode for long prompts)
 * const adapter = createCliAdapter({
 *   command: 'python',
 *   args: () => ['my_llm_script.py'],
 *   stdin: true,
 * });
 */
declare function createCliAdapter(opts: CliAdapterOptions): InferenceAdapter;
interface HttpAdapterOptions {
    /** The endpoint URL to POST to */
    url: string;
    /** Additional headers (Authorization, etc.) */
    headers?: Record<string, string>;
    /**
     * Build the request body from the prompt.
     * Default: `{ prompt }`
     */
    buildBody?: (prompt: string) => unknown;
    /**
     * Extract the response text from the parsed JSON response.
     * Default: `(json) => json.response ?? json.text ?? json.content ?? JSON.stringify(json)`
     */
    extractResponse?: (json: Record<string, unknown>) => string;
    /** Request timeout in ms (default: 60000) */
    timeout?: number;
}
/**
 * Create an InferenceAdapter that POSTs to an HTTP endpoint.
 *
 * @example
 * // Ollama HTTP API
 * const adapter = createHttpAdapter({
 *   url: 'http://localhost:11434/api/generate',
 *   buildBody: (prompt) => ({ model: 'llama3', prompt, stream: false }),
 *   extractResponse: (json) => json.response as string,
 * });
 *
 * @example
 * // Custom API with auth
 * const adapter = createHttpAdapter({
 *   url: 'https://my-llm.example.com/analyze',
 *   headers: { Authorization: `Bearer ${process.env.API_KEY}` },
 * });
 */
declare function createHttpAdapter(opts: HttpAdapterOptions): InferenceAdapter;

export { type CliAdapterOptions, type HttpAdapterOptions, type InferAndApplyResult, type InferenceAdapter, type InferenceHints, type InferenceOptions, type InferenceResult, type InferredCompletion, applyInferences, buildInferencePrompt, createCliAdapter, createHttpAdapter, inferAndApply, inferCompletions };
