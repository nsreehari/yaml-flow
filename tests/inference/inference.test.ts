import { describe, it, expect, vi } from 'vitest';
import {
  buildInferencePrompt,
  inferCompletions,
  applyInferences,
  inferAndApply,
} from '../../src/inference/index.js';
import type { InferenceAdapter, InferenceResult } from '../../src/inference/index.js';
import {
  createLiveGraph,
  applyEvent,
  schedule,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig, TaskConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(tasks: Record<string, TaskConfig>): GraphConfig {
  return {
    settings: { completion: 'manual' as any },
    tasks,
  };
}

function ts(): string {
  return new Date().toISOString();
}

/** Create a mock adapter that returns a canned response */
function mockAdapter(response: string): InferenceAdapter {
  return { analyze: vi.fn().mockResolvedValue(response) };
}

/** Create a mock adapter returning structured JSON */
function mockJsonAdapter(suggestions: { taskName: string; confidence: number; reasoning: string }[]): InferenceAdapter {
  return { analyze: vi.fn().mockResolvedValue(JSON.stringify(suggestions)) };
}

// ============================================================================
// buildInferencePrompt
// ============================================================================

describe('buildInferencePrompt', () => {
  it('builds a prompt with autoDetectable nodes', () => {
    const live = createLiveGraph(makeConfig({
      fetch: {
        provides: ['data'],
        inference: { criteria: 'Data fetched from API', autoDetectable: true },
      },
      process: {
        requires: ['data'],
        provides: ['result'],
        inference: { criteria: 'Data processed', autoDetectable: true },
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('fetch');
    expect(prompt).toContain('process');
    expect(prompt).toContain('Data fetched from API');
    expect(prompt).toContain('Data processed');
    expect(prompt).toContain('JSON');
  });

  it('excludes nodes without autoDetectable', () => {
    const live = createLiveGraph(makeConfig({
      auto: {
        provides: ['x'],
        inference: { criteria: 'auto task', autoDetectable: true },
      },
      manual: {
        provides: ['y'],
        inference: { criteria: 'manual task', autoDetectable: false },
      },
      noHints: {
        provides: ['z'],
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('auto');
    expect(prompt).not.toContain('### manual');
    expect(prompt).not.toContain('### noHints');
  });

  it('excludes completed tasks', () => {
    let live = createLiveGraph(makeConfig({
      fetch: {
        provides: ['data'],
        inference: { criteria: 'Data fetched', autoDetectable: true },
      },
      process: {
        requires: ['data'],
        provides: ['result'],
        inference: { criteria: 'Data processed', autoDetectable: true },
      },
    }), 'e1');

    // Complete fetch
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'fetch', timestamp: ts() });

    const prompt = buildInferencePrompt(live);
    expect(prompt).not.toContain('### fetch');
    expect(prompt).toContain('### process');
    expect(prompt).toContain('Completed tasks: fetch');
  });

  it('returns empty string when no candidates', () => {
    const live = createLiveGraph(makeConfig({
      noHints: { provides: ['x'] },
    }), 'e1');

    const prompt = buildInferencePrompt(live);
    expect(prompt).toBe('');
  });

  it('includes scope override — analyzes specific nodes', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'], inference: { criteria: 'A done', autoDetectable: true } },
      b: { provides: ['y'], inference: { criteria: 'B done', autoDetectable: false } },
      c: { provides: ['z'] }, // no inference hints
    }), 'e1');

    const prompt = buildInferencePrompt(live, { scope: ['b', 'c'] });
    expect(prompt).not.toContain('### a');
    expect(prompt).toContain('### b');
    expect(prompt).toContain('### c');
  });

  it('includes additional context', () => {
    const live = createLiveGraph(makeConfig({
      task: {
        provides: ['x'],
        inference: { criteria: 'task done', autoDetectable: true },
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live, {
      context: 'Deployment log: all services healthy, HTTP 200 OK',
    });
    expect(prompt).toContain('Deployment log: all services healthy, HTTP 200 OK');
    expect(prompt).toContain('Additional Context');
  });

  it('includes inference hints: keywords and suggestedChecks', () => {
    const live = createLiveGraph(makeConfig({
      deploy: {
        provides: ['deployed'],
        inference: {
          criteria: 'App deployed',
          keywords: ['azure', 'deployment'],
          suggestedChecks: ['health check returns 200'],
          autoDetectable: true,
        },
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('azure, deployment');
    expect(prompt).toContain('health check returns 200');
  });

  it('includes description and requires/provides', () => {
    const live = createLiveGraph(makeConfig({
      task: {
        requires: ['input-a', 'input-b'],
        provides: ['output-x'],
        description: 'Process input data',
        inference: { autoDetectable: true },
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('Process input data');
    expect(prompt).toContain('input-a, input-b');
    expect(prompt).toContain('output-x');
  });

  it('supports custom system prompt', () => {
    const live = createLiveGraph(makeConfig({
      task: {
        provides: ['x'],
        inference: { autoDetectable: true },
      },
    }), 'e1');

    const prompt = buildInferencePrompt(live, {
      systemPrompt: 'You are a CI/CD pipeline analyzer.',
    });
    expect(prompt).toContain('You are a CI/CD pipeline analyzer.');
    expect(prompt).not.toContain('workflow completion analyzer');
  });

  it('shows available tokens', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['token-x'], inference: { autoDetectable: true } },
      b: { requires: ['token-x'], provides: ['token-y'], inference: { autoDetectable: true } },
    }), 'e1');

    // Inject some tokens
    live = applyEvent(live, { type: 'inject-tokens', tokens: ['external-signal'], timestamp: ts() });

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('external-signal');
  });
});

// ============================================================================
// inferCompletions
// ============================================================================

describe('inferCompletions', () => {
  it('calls adapter with the built prompt and returns parsed suggestions', async () => {
    const live = createLiveGraph(makeConfig({
      deploy: {
        provides: ['deployed'],
        inference: { criteria: 'App deployed', autoDetectable: true },
      },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'deploy', confidence: 0.92, reasoning: 'Health check passed' },
    ]);

    const result = await inferCompletions(live, adapter);

    expect(adapter.analyze).toHaveBeenCalledOnce();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].taskName).toBe('deploy');
    expect(result.suggestions[0].confidence).toBe(0.92);
    expect(result.suggestions[0].reasoning).toBe('Health check passed');
    expect(result.suggestions[0].detectionMethod).toBe('llm-inferred');
    expect(result.analyzedNodes).toEqual(['deploy']);
    expect(result.promptUsed).toContain('deploy');
  });

  it('returns empty when no analyzable nodes', async () => {
    const live = createLiveGraph(makeConfig({
      noHints: { provides: ['x'] },
    }), 'e1');

    const adapter = mockAdapter('anything');
    const result = await inferCompletions(live, adapter);

    expect(adapter.analyze).not.toHaveBeenCalled();
    expect(result.suggestions).toEqual([]);
    expect(result.analyzedNodes).toEqual([]);
  });

  it('handles markdown-fenced JSON response', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const response = '```json\n[{"taskName": "task", "confidence": 0.85, "reasoning": "Done"}]\n```';
    const adapter = mockAdapter(response);
    const result = await inferCompletions(live, adapter);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].confidence).toBe(0.85);
  });

  it('handles response with preamble text before JSON', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const response = 'Based on my analysis:\n\n[{"taskName": "task", "confidence": 0.7, "reasoning": "Likely done"}]';
    const adapter = mockAdapter(response);
    const result = await inferCompletions(live, adapter);

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].confidence).toBe(0.7);
  });

  it('returns empty for malformed response', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockAdapter('I cannot determine the status of these tasks.');
    const result = await inferCompletions(live, adapter);

    expect(result.suggestions).toEqual([]);
    expect(result.rawResponse).toContain('cannot determine');
  });

  it('filters out references to unknown nodes', async () => {
    const live = createLiveGraph(makeConfig({
      real: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'real', confidence: 0.9, reasoning: 'Done' },
      { taskName: 'fake-node', confidence: 0.8, reasoning: 'Hallucinated' },
    ]);

    const result = await inferCompletions(live, adapter);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].taskName).toBe('real');
  });

  it('clamps confidence to [0, 1]', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'task', confidence: 1.5, reasoning: 'Over-confident' },
    ]);

    const result = await inferCompletions(live, adapter);
    expect(result.suggestions[0].confidence).toBe(1.0);
  });

  it('passes threshold to filtering', async () => {
    const live = createLiveGraph(makeConfig({
      high: { provides: ['x'], inference: { autoDetectable: true } },
      low: { provides: ['y'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'high', confidence: 0.9, reasoning: 'Good' },
      { taskName: 'low', confidence: 0.3, reasoning: 'Weak' },
    ]);

    // inferCompletions returns ALL parsed suggestions (threshold affects parsing min)
    const result = await inferCompletions(live, adapter, { threshold: 0.8 });
    // Both come back (threshold is applied at applyInferences level)
    expect(result.suggestions.length).toBeGreaterThanOrEqual(1);
  });

  it('respects scope option', async () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'], inference: { autoDetectable: true } },
      b: { provides: ['y'] }, // no autoDetectable
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'b', confidence: 0.8, reasoning: 'Scoped in' },
    ]);

    const result = await inferCompletions(live, adapter, { scope: ['b'] });
    expect(result.analyzedNodes).toEqual(['b']);
    expect(result.suggestions).toHaveLength(1);
  });

  it('skips completed tasks even when in scope', async () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    const adapter = mockAdapter('[]');
    const result = await inferCompletions(live, adapter, { scope: ['a'] });
    expect(result.analyzedNodes).toEqual([]);
    expect(adapter.analyze).not.toHaveBeenCalled();
  });
});

// ============================================================================
// applyInferences
// ============================================================================

describe('applyInferences', () => {
  it('applies high-confidence suggestions as task completions', () => {
    const live = createLiveGraph(makeConfig({
      deploy: { provides: ['deployed'], inference: { autoDetectable: true } },
      monitor: { requires: ['deployed'], provides: ['monitored'] },
    }), 'e1');

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'deploy', confidence: 0.95, reasoning: 'Health check OK', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: ['deploy'],
    };

    const updated = applyInferences(live, result, 0.8);
    expect(updated.state.tasks['deploy'].status).toBe('completed');
    expect(updated.state.availableOutputs).toContain('deployed');

    // Monitor should now be eligible
    expect(schedule(updated).eligible).toContain('monitor');
  });

  it('skips suggestions below threshold', () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'task', confidence: 0.4, reasoning: 'Weak evidence', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: ['task'],
    };

    const updated = applyInferences(live, result, 0.5);
    expect(updated.state.tasks['task'].status).toBe('not-started');
  });

  it('skips already-completed tasks', () => {
    let live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    live = applyEvent(live, { type: 'task-started', taskName: 'task', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'task', timestamp: ts() });

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'task', confidence: 1.0, reasoning: 'Already done', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: ['task'],
    };

    const updated = applyInferences(live, result, 0.5);
    // Should be same state — no double-completion
    expect(updated.state.tasks['task'].status).toBe('completed');
  });

  it('applies multiple suggestions', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'], inference: { autoDetectable: true } },
      b: { provides: ['y'], inference: { autoDetectable: true } },
      c: { provides: ['z'], inference: { autoDetectable: true } },
    }), 'e1');

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'a', confidence: 0.9, reasoning: 'Done', detectionMethod: 'llm-inferred' },
        { taskName: 'b', confidence: 0.85, reasoning: 'Done', detectionMethod: 'llm-inferred' },
        { taskName: 'c', confidence: 0.3, reasoning: 'Weak', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: ['a', 'b', 'c'],
    };

    const updated = applyInferences(live, result, 0.8);
    expect(updated.state.tasks['a'].status).toBe('completed');
    expect(updated.state.tasks['b'].status).toBe('completed');
    expect(updated.state.tasks['c'].status).toBe('not-started');
  });

  it('uses default threshold of 0.5', () => {
    const live = createLiveGraph(makeConfig({
      above: { provides: ['x'], inference: { autoDetectable: true } },
      below: { provides: ['y'], inference: { autoDetectable: true } },
    }), 'e1');

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'above', confidence: 0.6, reasoning: 'Moderate', detectionMethod: 'llm-inferred' },
        { taskName: 'below', confidence: 0.4, reasoning: 'Weak', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: ['above', 'below'],
    };

    const updated = applyInferences(live, result);
    expect(updated.state.tasks['above'].status).toBe('completed');
    expect(updated.state.tasks['below'].status).toBe('not-started');
  });

  it('ignores unknown task names', () => {
    const live = createLiveGraph(makeConfig({
      real: { provides: ['x'] },
    }), 'e1');

    const result: InferenceResult = {
      suggestions: [
        { taskName: 'nonexistent', confidence: 1.0, reasoning: 'Ghost', detectionMethod: 'llm-inferred' },
      ],
      promptUsed: '',
      rawResponse: '',
      analyzedNodes: [],
    };

    const updated = applyInferences(live, result, 0.5);
    // Should be unchanged
    expect(updated).toBe(live);
  });
});

// ============================================================================
// inferAndApply
// ============================================================================

describe('inferAndApply', () => {
  it('infers and applies in one step', async () => {
    const live = createLiveGraph(makeConfig({
      deploy: { provides: ['deployed'], inference: { criteria: 'App deployed', autoDetectable: true } },
      monitor: { requires: ['deployed'], provides: ['monitored'] },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'deploy', confidence: 0.95, reasoning: 'Health check OK' },
    ]);

    const result = await inferAndApply(live, adapter, { threshold: 0.8 });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].taskName).toBe('deploy');
    expect(result.skipped).toHaveLength(0);
    expect(result.live.state.tasks['deploy'].status).toBe('completed');
    expect(schedule(result.live).eligible).toContain('monitor');
  });

  it('separates applied from skipped', async () => {
    const live = createLiveGraph(makeConfig({
      high: { provides: ['x'], inference: { autoDetectable: true } },
      low: { provides: ['y'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'high', confidence: 0.9, reasoning: 'Strong' },
      { taskName: 'low', confidence: 0.3, reasoning: 'Weak' },
    ]);

    const result = await inferAndApply(live, adapter, { threshold: 0.8 });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].taskName).toBe('high');
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].taskName).toBe('low');
  });

  it('returns full audit trail', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'task', confidence: 0.88, reasoning: 'Evidence found' },
    ]);

    const result = await inferAndApply(live, adapter);

    expect(result.inference.promptUsed).toContain('task');
    expect(result.inference.rawResponse).toContain('task');
    expect(result.inference.analyzedNodes).toEqual(['task']);
  });

  it('handles empty LLM response gracefully', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockAdapter('[]');
    const result = await inferAndApply(live, adapter);

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.live.state.tasks['task'].status).toBe('not-started');
  });

  it('passes context through to the prompt', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockAdapter('[]');
    const result = await inferAndApply(live, adapter, {
      context: 'Server logs show deployment successful',
    });

    expect(result.inference.promptUsed).toContain('Server logs show deployment successful');
  });
});

// ============================================================================
// Edge cases and integration
// ============================================================================

describe('inference integration', () => {
  it('full pipeline: create → evidence → infer → schedule', async () => {
    let live = createLiveGraph(makeConfig({
      'infra-provisioned': {
        provides: ['infra-ready'],
        inference: {
          criteria: 'Azure infrastructure setup completed',
          keywords: ['azure', 'deployment', 'provisioning'],
          suggestedChecks: ['scan logs for "Deployment Succeeded"'],
          autoDetectable: true,
        },
      },
      'app-deployed': {
        requires: ['infra-ready'],
        provides: ['app-ready'],
        inference: {
          criteria: 'Application code deployed and health check passing',
          suggestedChecks: ['HTTP 200 from /health'],
          autoDetectable: true,
        },
      },
      'monitoring-enabled': {
        requires: ['app-ready'],
        provides: ['monitored'],
        inference: {
          criteria: 'Metrics flowing in Application Insights',
          autoDetectable: true,
        },
      },
    }), 'e1');

    // Step 1: LLM analyzes with deployment log context
    const adapter: InferenceAdapter = {
      analyze: vi.fn().mockResolvedValue(JSON.stringify([
        { taskName: 'infra-provisioned', confidence: 0.95, reasoning: 'Deployment log says Succeeded' },
        { taskName: 'app-deployed', confidence: 0.88, reasoning: 'Health check 200 OK in logs' },
        { taskName: 'monitoring-enabled', confidence: 0.2, reasoning: 'No metrics evidence yet' },
      ])),
    };

    const result = await inferAndApply(live, adapter, {
      threshold: 0.8,
      context: 'Deployment log: "Deployment Succeeded", health check: HTTP 200 OK',
    });

    // Step 2: Check what got applied
    expect(result.applied.map(s => s.taskName)).toEqual(['infra-provisioned', 'app-deployed']);
    expect(result.skipped.map(s => s.taskName)).toEqual(['monitoring-enabled']);

    // Step 3: Graph state reflects the inferences
    live = result.live;
    expect(live.state.tasks['infra-provisioned'].status).toBe('completed');
    expect(live.state.tasks['app-deployed'].status).toBe('completed');
    expect(live.state.tasks['monitoring-enabled'].status).toBe('not-started');

    // Step 4: monitoring-enabled is now eligible (its deps are met)
    expect(schedule(live).eligible).toContain('monitoring-enabled');
  });

  it('handles LLM adapter errors gracefully', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter: InferenceAdapter = {
      analyze: vi.fn().mockRejectedValue(new Error('Rate limited')),
    };

    await expect(inferCompletions(live, adapter)).rejects.toThrow('Rate limited');
  });

  it('works with continuous-event-graph mutations', async () => {
    let live = createLiveGraph(makeConfig({
      fetch: { provides: ['data'], inference: { autoDetectable: true } },
    }), 'e1');

    // Dynamically add a node that is also autoDetectable
    const { addNode } = await import('../../src/continuous-event-graph/index.js');
    live = addNode(live, 'transform', {
      requires: ['data'],
      provides: ['transformed'],
      inference: { criteria: 'Data transformed', autoDetectable: true },
    });

    const prompt = buildInferencePrompt(live);
    expect(prompt).toContain('fetch');
    expect(prompt).toContain('transform');
    expect(prompt).toContain('Data transformed');
  });

  it('handles JSON with extra whitespace and newlines', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const response = `
    [
      {
        "taskName": "task",
        "confidence": 0.85,
        "reasoning": "Evidence supports completion"
      }
    ]
    `;
    const adapter = mockAdapter(response);
    const result = await inferCompletions(live, adapter);

    expect(result.suggestions).toHaveLength(1);
  });

  it('handles response with only invalid entries', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 123 as any, confidence: 0.9, reasoning: 'Bad name type' },
      { taskName: 'task', confidence: 'high' as any, reasoning: 'Bad confidence type' },
    ]);

    const result = await inferCompletions(live, adapter);
    expect(result.suggestions).toEqual([]);
  });

  it('handles empty array response', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockAdapter('[]');
    const result = await inferCompletions(live, adapter);
    expect(result.suggestions).toEqual([]);
  });

  it('negative confidence is clamped to 0', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = mockJsonAdapter([
      { taskName: 'task', confidence: -0.5, reasoning: 'Negative' },
    ]);

    const result = await inferCompletions(live, adapter);
    expect(result.suggestions[0].confidence).toBe(0);
  });
});

// ============================================================================
// createCliAdapter
// ============================================================================

describe('createCliAdapter', () => {
  // Dynamic import since it uses node:child_process
  let createCliAdapter: typeof import('../../src/inference/index.js')['createCliAdapter'];

  beforeAll(async () => {
    const mod = await import('../../src/inference/index.js');
    createCliAdapter = mod.createCliAdapter;
  });

  it('executes a CLI command and returns stdout', async () => {
    // Use `node -e` instead of `echo` — echo is a shell built-in on Windows and
    // cannot be spawned via execFile directly.
    const adapter = createCliAdapter({
      command: 'node',
      args: () => ['-e', 'console.log(\'[{"taskName":"test","confidence":0.9,"reasoning":"echo works"}]\')'],
    });

    const result = await adapter.analyze('anything');
    expect(result).toContain('taskName');
    expect(result).toContain('test');
  });

  it('passes prompt as an argument by default', async () => {
    // Use node to echo the argument back
    const adapter = createCliAdapter({
      command: 'node',
      args: (prompt) => ['-e', `console.log(JSON.stringify({got: process.argv[1]}))`, prompt],
    });

    const result = await adapter.analyze('hello-prompt');
    const parsed = JSON.parse(result.trim());
    expect(parsed.got).toBe('hello-prompt');
  });

  it('supports stdin mode for long prompts', async () => {
    const adapter = createCliAdapter({
      command: 'node',
      args: () => ['-e', 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(d))'],
      stdin: true,
    });

    const result = await adapter.analyze('prompt-via-stdin');
    expect(result.trim()).toBe('prompt-via-stdin');
  });

  it('rejects on command failure', async () => {
    const adapter = createCliAdapter({
      command: 'node',
      args: () => ['-e', 'process.exit(1)'],
    });

    await expect(adapter.analyze('test')).rejects.toThrow('CLI adapter failed');
  });

  it('rejects on command not found', async () => {
    const adapter = createCliAdapter({
      command: 'nonexistent-command-xyz-123',
      args: () => [],
    });

    await expect(adapter.analyze('test')).rejects.toThrow();
  });

  it('works end-to-end with inferCompletions', async () => {
    const live = createLiveGraph(makeConfig({
      task: { provides: ['x'], inference: { autoDetectable: true } },
    }), 'e1');

    const adapter = createCliAdapter({
      command: 'node',
      args: () => ['-e', 'console.log(JSON.stringify([{taskName:"task",confidence:0.92,reasoning:"CLI inferred"}]))'],
    });

    const result = await inferCompletions(live, adapter);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].taskName).toBe('task');
    expect(result.suggestions[0].confidence).toBe(0.92);
  });
});

// ============================================================================
// createHttpAdapter
// ============================================================================

describe('createHttpAdapter', () => {
  let createHttpAdapter: typeof import('../../src/inference/index.js')['createHttpAdapter'];

  beforeAll(async () => {
    const mod = await import('../../src/inference/index.js');
    createHttpAdapter = mod.createHttpAdapter;
  });

  it('constructs an adapter with custom body builder and response extractor', () => {
    const adapter = createHttpAdapter({
      url: 'http://localhost:11434/api/generate',
      buildBody: (prompt) => ({ model: 'llama3', prompt, stream: false }),
      extractResponse: (json) => json.response as string,
    });

    expect(adapter).toBeDefined();
    expect(typeof adapter.analyze).toBe('function');
  });

  it('constructs an adapter with default body and extraction', () => {
    const adapter = createHttpAdapter({
      url: 'http://example.com/api',
    });

    expect(adapter).toBeDefined();
    expect(typeof adapter.analyze).toBe('function');
  });

  it('includes custom headers', () => {
    const adapter = createHttpAdapter({
      url: 'http://example.com/api',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(adapter).toBeDefined();
  });
});
