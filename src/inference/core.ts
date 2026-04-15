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

import type { LiveGraph } from '../continuous-event-graph/types.js';
import type {
  InferenceAdapter,
  InferenceOptions,
  InferenceResult,
  InferredCompletion,
  InferAndApplyResult,
} from './types.js';
import { getAllTasks } from '../event-graph/graph-helpers.js';
import { getRequires, getProvides } from '../event-graph/graph-helpers.js';
import { applyEvent } from '../continuous-event-graph/core.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_THRESHOLD = 0.5;

const DEFAULT_SYSTEM_PROMPT = `You are a workflow completion analyzer. Given a graph of tasks with their current states, evidence, and inference hints, determine which tasks appear to be completed based on the available evidence.

For each task you analyze, provide a JSON response. Be conservative — only mark tasks as completed when the evidence strongly supports it.`;

// ============================================================================
// buildInferencePrompt — pure, sync
// ============================================================================

/**
 * Build an LLM prompt from the current LiveGraph state.
 * Includes only nodes that are:
 *   - Not yet completed
 *   - Have `inference.autoDetectable` set to true (or are in scope)
 *
 * Pure function — no side effects.
 */
export function buildInferencePrompt(
  live: LiveGraph,
  options: InferenceOptions = {},
): string {
  const { scope, context, systemPrompt } = options;
  const graphTasks = getAllTasks(live.config);
  const { state } = live;

  // Determine which nodes to analyze
  const candidates = getAnalyzableCandidates(live, scope);

  if (candidates.length === 0) {
    return '';
  }

  const lines: string[] = [];

  // System context
  lines.push(systemPrompt || DEFAULT_SYSTEM_PROMPT);
  lines.push('');

  // Graph overview
  lines.push('## Graph State');
  lines.push('');
  lines.push(`Available tokens: ${state.availableOutputs.length > 0 ? state.availableOutputs.join(', ') : '(none)'}`);
  lines.push('');

  // Completed tasks (for context)
  const completedTasks = Object.entries(state.tasks)
    .filter(([_, ts]) => ts.status === 'completed')
    .map(([name]) => name);
  if (completedTasks.length > 0) {
    lines.push(`Completed tasks: ${completedTasks.join(', ')}`);
    lines.push('');
  }

  // Candidate nodes
  lines.push('## Tasks to Analyze');
  lines.push('');

  for (const taskName of candidates) {
    const taskConfig = graphTasks[taskName];
    const taskState = state.tasks[taskName];

    lines.push(`### ${taskName}`);
    if (taskConfig.description) {
      lines.push(`Description: ${taskConfig.description}`);
    }

    const requires = getRequires(taskConfig);
    const provides = getProvides(taskConfig);
    if (requires.length > 0) lines.push(`Requires: ${requires.join(', ')}`);
    if (provides.length > 0) lines.push(`Provides: ${provides.join(', ')}`);
    lines.push(`Current status: ${taskState?.status || 'not-started'}`);

    // Inference hints
    const hints = taskConfig.inference;
    if (hints) {
      if (hints.criteria) lines.push(`Completion criteria: ${hints.criteria}`);
      if (hints.keywords?.length) lines.push(`Keywords: ${hints.keywords.join(', ')}`);
      if (hints.suggestedChecks?.length) lines.push(`Suggested checks: ${hints.suggestedChecks.join('; ')}`);
    }

    lines.push('');
  }

  // Additional evidence/context
  if (context) {
    lines.push('## Additional Context / Evidence');
    lines.push('');
    lines.push(context);
    lines.push('');
  }

  // Response format instructions
  lines.push('## Response Format');
  lines.push('');
  lines.push('Respond with a JSON array of objects, one per task you have evidence for:');
  lines.push('```json');
  lines.push('[');
  lines.push('  {');
  lines.push('    "taskName": "task-name",');
  lines.push('    "confidence": 0.0 to 1.0,');
  lines.push('    "reasoning": "explanation of why you believe this task is complete or not"');
  lines.push('  }');
  lines.push(']');
  lines.push('```');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Only include tasks from the "Tasks to Analyze" section');
  lines.push('- confidence 0.0 = no evidence of completion, 1.0 = certain it is complete');
  lines.push('- If you have no evidence for a task, omit it from the array');
  lines.push('- Be conservative — require clear evidence before high confidence');
  lines.push('- Respond ONLY with the JSON array, no additional text');

  return lines.join('\n');
}

// ============================================================================
// inferCompletions — async, calls LLM
// ============================================================================

/**
 * Ask an LLM to analyze the current graph state and suggest completions.
 *
 * Builds a prompt from the LiveGraph, sends it through the adapter,
 * parses the structured response, and returns an InferenceResult.
 */
export async function inferCompletions(
  live: LiveGraph,
  adapter: InferenceAdapter,
  options: InferenceOptions = {},
): Promise<InferenceResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const analyzedNodes = getAnalyzableCandidates(live, options.scope);

  // Nothing to analyze
  if (analyzedNodes.length === 0) {
    return { suggestions: [], promptUsed: '', rawResponse: '', analyzedNodes: [] };
  }

  const prompt = buildInferencePrompt(live, options);
  const rawResponse = await adapter.analyze(prompt);
  const suggestions = parseInferenceResponse(rawResponse, analyzedNodes, threshold);

  return {
    suggestions,
    promptUsed: prompt,
    rawResponse,
    analyzedNodes,
  };
}

// ============================================================================
// applyInferences — pure, sync
// ============================================================================

/**
 * Apply inferred completions to a LiveGraph.
 * Only applies suggestions at or above the given confidence threshold.
 *
 * Under the hood, this fires `task-started` + `task-completed` events
 * for each accepted suggestion (if the task isn't already running/completed).
 *
 * Pure function — returns a new LiveGraph.
 */
export function applyInferences(
  live: LiveGraph,
  result: InferenceResult,
  threshold: number = DEFAULT_THRESHOLD,
): LiveGraph {
  let current = live;

  for (const suggestion of result.suggestions) {
    if (suggestion.confidence < threshold) continue;

    const taskState = current.state.tasks[suggestion.taskName];
    if (!taskState) continue;

    // Skip already completed or running tasks
    if (taskState.status === 'completed' || taskState.status === 'running') continue;

    // Apply start + complete events
    const now = new Date().toISOString();
    current = applyEvent(current, {
      type: 'task-started',
      taskName: suggestion.taskName,
      timestamp: now,
    });
    current = applyEvent(current, {
      type: 'task-completed',
      taskName: suggestion.taskName,
      timestamp: now,
      result: 'llm-inferred',
    });
  }

  return current;
}

// ============================================================================
// inferAndApply — async, convenience
// ============================================================================

/**
 * Convenience: infer completions and apply them in one step.
 * Returns the updated LiveGraph + full audit trail of what was inferred vs applied.
 */
export async function inferAndApply(
  live: LiveGraph,
  adapter: InferenceAdapter,
  options: InferenceOptions = {},
): Promise<InferAndApplyResult> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const inference = await inferCompletions(live, adapter, options);
  const updated = applyInferences(live, inference, threshold);

  const applied = inference.suggestions.filter(s => s.confidence >= threshold);
  const skipped = inference.suggestions.filter(s => s.confidence < threshold);

  return {
    live: updated,
    inference,
    applied,
    skipped,
  };
}

// ============================================================================
// Internals
// ============================================================================

/**
 * Determine which nodes should be analyzed.
 * - If scope is provided, use those (filtered to non-completed with hints)
 * - Otherwise, find all non-completed nodes with `inference.autoDetectable === true`
 */
function getAnalyzableCandidates(live: LiveGraph, scope?: string[]): string[] {
  const graphTasks = getAllTasks(live.config);
  const { state } = live;

  const candidates: string[] = [];

  for (const [name, config] of Object.entries(graphTasks)) {
    const taskState = state.tasks[name];

    // Skip completed/running tasks
    if (taskState?.status === 'completed' || taskState?.status === 'running') continue;

    if (scope) {
      // If scope is provided, include if name is in scope
      if (scope.includes(name)) candidates.push(name);
    } else {
      // Otherwise, include only if autoDetectable
      if (config.inference?.autoDetectable) candidates.push(name);
    }
  }

  return candidates;
}

/**
 * Parse the LLM's raw response into structured InferredCompletion objects.
 * Handles edge cases: markdown fences, preamble text, malformed JSON.
 */
function parseInferenceResponse(
  rawResponse: string,
  validNodes: string[],
  _threshold: number,
): InferredCompletion[] {
  const validSet = new Set(validNodes);

  try {
    // Try to extract JSON from the response (handle markdown fences, preamble, etc.)
    const jsonStr = extractJson(rawResponse);
    if (!jsonStr) return [];

    const parsed = JSON.parse(jsonStr);

    // Must be an array
    if (!Array.isArray(parsed)) return [];

    const suggestions: InferredCompletion[] = [];

    for (const item of parsed) {
      // Validate shape
      if (!item || typeof item !== 'object') continue;
      if (typeof item.taskName !== 'string') continue;
      if (typeof item.confidence !== 'number') continue;

      // Must reference a valid node
      if (!validSet.has(item.taskName)) continue;

      // Clamp confidence to [0, 1]
      const confidence = Math.max(0, Math.min(1, item.confidence));

      suggestions.push({
        taskName: item.taskName,
        confidence,
        reasoning: typeof item.reasoning === 'string' ? item.reasoning : '',
        detectionMethod: 'llm-inferred',
      });
    }

    return suggestions;
  } catch {
    // JSON parse failed — return empty
    return [];
  }
}

/**
 * Extract JSON array from raw LLM text.
 * Handles: bare JSON, markdown-fenced JSON, preamble/postamble text.
 */
function extractJson(text: string): string | null {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();

  // Try 1: Markdown fence (```json ... ``` or ``` ... ```)
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try 2: Find first [ ... last ]
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1);
  }

  // Try 3: Maybe it's bare JSON
  if (trimmed.startsWith('[')) return trimmed;

  return null;
}
