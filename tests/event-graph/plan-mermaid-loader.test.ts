import { describe, it, expect } from 'vitest';
import { planExecution } from '../../src/event-graph/plan.js';
import { graphToMermaid, flowToMermaid } from '../../src/event-graph/mermaid.js';
import { validateGraphConfig, exportGraphConfig } from '../../src/event-graph/loader.js';
import type { GraphConfig } from '../../src/event-graph/types.js';
import type { StepFlowConfig } from '../../src/step-machine/types.js';

// ============================================================================
// planExecution
// ============================================================================

describe('planExecution', () => {
  it('computes phases for a linear graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
        c: { requires: ['y'], provides: ['z'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([['a'], ['b'], ['c']]);
    expect(plan.depth).toBe(3);
    expect(plan.maxParallelism).toBe(1);
    expect(plan.entryPoints).toEqual(['a']);
    expect(plan.leafTasks).toEqual(['c']);
  });

  it('detects parallel tasks (fan-out)', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        start: { provides: ['ready'] },
        branch_a: { requires: ['ready'], provides: ['result-a'] },
        branch_b: { requires: ['ready'], provides: ['result-b'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([['start'], ['branch_a', 'branch_b']]);
    expect(plan.maxParallelism).toBe(2);
  });

  it('detects fan-in', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        fetch_a: { provides: ['data-a'] },
        fetch_b: { provides: ['data-b'] },
        merge: { requires: ['data-a', 'data-b'], provides: ['merged'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([['fetch_a', 'fetch_b'], ['merge']]);
    expect(plan.entryPoints).toEqual(['fetch_a', 'fetch_b']);
    expect(plan.leafTasks).toEqual(['merge']);
  });

  it('detects diamond pattern', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        start: { provides: ['ready'] },
        left: { requires: ['ready'], provides: ['left-done'] },
        right: { requires: ['ready'], provides: ['right-done'] },
        join: { requires: ['left-done', 'right-done'], provides: ['final'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([['start'], ['left', 'right'], ['join']]);
    expect(plan.depth).toBe(3);
    expect(plan.maxParallelism).toBe(2);
  });

  it('detects conflicts (multiple tasks providing same token)', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        provider_a: { provides: ['output'] },
        provider_b: { provides: ['output'] },
        consumer: { requires: ['output'], provides: ['done'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.conflicts).toEqual({ output: ['provider_a', 'provider_b'] });
  });

  it('detects unreachable tokens and blocked tasks', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x', 'missing-token'], provides: ['y'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.unreachableTokens).toEqual(['missing-token']);
    expect(plan.blockedTasks).toEqual(['b']);
  });

  it('handles empty graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {},
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([]);
    expect(plan.depth).toBe(0);
    expect(plan.maxParallelism).toBe(0);
  });

  it('handles complex super-agent style graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        prep: { provides: ['workdata-prepared'] },
        copy: { requires: ['workdata-prepared'], provides: ['input-files-copied'] },
        evidence: { requires: ['input-files-copied'], provides: ['evidence-complete'] },
        synthesis: { requires: ['evidence-complete'], provides: ['grades-complete'] },
        analyze: { requires: ['grades-complete'], provides: ['mismatches-analyzed'] },
        health: { requires: ['mismatches-analyzed'], provides: ['health-complete'] },
        report: { requires: ['mismatches-analyzed'], provides: ['report-complete'] },
        archive: { requires: ['health-complete', 'report-complete'], provides: ['done'] },
      },
    };
    const plan = planExecution(graph);
    expect(plan.phases).toEqual([
      ['prep'],
      ['copy'],
      ['evidence'],
      ['synthesis'],
      ['analyze'],
      ['health', 'report'],
      ['archive'],
    ]);
    expect(plan.depth).toBe(7);
    expect(plan.maxParallelism).toBe(2);
    expect(plan.entryPoints).toEqual(['prep']);
    expect(plan.leafTasks).toEqual(['archive']);
  });

  it('includes on conditional provides in producer map', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        classify: {
          provides: ['classified'],
          on: { photo: ['is-photo'], document: ['is-document'] },
        },
        process_photo: { requires: ['is-photo'], provides: ['processed'] },
        process_doc: { requires: ['is-document'], provides: ['processed'] },
      },
    };
    const plan = planExecution(graph);
    // Both process tasks depend on classify via conditional tokens
    expect(plan.dependencies['process_photo']).toContain('classify');
    expect(plan.dependencies['process_doc']).toContain('classify');
  });
});

// ============================================================================
// graphToMermaid
// ============================================================================

describe('graphToMermaid', () => {
  it('generates a basic dependency graph', () => {
    const graph: GraphConfig = {
      id: 'test-graph',
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        build: { provides: ['artifact'] },
        test: { requires: ['artifact'], provides: ['tested'] },
        deploy: { requires: ['tested'], provides: ['deployed'] },
      },
    };
    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('%% test-graph');
    expect(mermaid).toContain('build([build])'); // entry point shape
    expect(mermaid).toContain('deploy[[deploy]]'); // leaf shape
    expect(mermaid).toContain('build -->|artifact| test');
    expect(mermaid).toContain('test -->|tested| deploy');
  });

  it('shows parallel lanes', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        start: { provides: ['ready'] },
        a: { requires: ['ready'], provides: ['a-done'] },
        b: { requires: ['ready'], provides: ['b-done'] },
        join: { requires: ['a-done', 'b-done'], provides: ['final'] },
      },
    };
    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('start -->|ready| a');
    expect(mermaid).toContain('start -->|ready| b');
    expect(mermaid).toContain('a -->|a-done| join');
    expect(mermaid).toContain('b -->|b-done| join');
  });

  it('hides tokens when showTokens is false', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
      },
    };
    const mermaid = graphToMermaid(graph, { showTokens: false });
    expect(mermaid).toContain('a --> b');
    expect(mermaid).not.toContain('|x|');
  });

  it('supports LR direction', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: { provides: ['x'] } },
    };
    const mermaid = graphToMermaid(graph, { direction: 'LR' });
    expect(mermaid).toContain('graph LR');
  });

  it('marks unreachable requires with warning', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        wait: { requires: ['external-event'], provides: ['done'] },
      },
    };
    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('warn_external_event');
    expect(mermaid).toContain('missing');
  });

  it('handles empty graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {},
    };
    const mermaid = graphToMermaid(graph);
    expect(mermaid).toContain('No tasks defined');
  });
});

// ============================================================================
// flowToMermaid
// ============================================================================

describe('flowToMermaid', () => {
  it('generates a step-machine flowchart', () => {
    const flow: StepFlowConfig = {
      id: 'support-ticket',
      settings: { start_step: 'classify' },
      steps: {
        classify: {
          transitions: { billing: 'handle', technical: 'handle', unknown: 'escalate' },
        },
        handle: {
          transitions: { resolved: 'done', failed: 'escalate' },
        },
        escalate: {
          transitions: { done: 'done' },
        },
      },
      terminal_states: {
        done: { return_intent: 'resolved' },
      },
    };
    const mermaid = flowToMermaid(flow);
    expect(mermaid).toContain('%% support-ticket');
    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('START(( ))');
    expect(mermaid).toContain('START --> classify');
    expect(mermaid).toContain('classify -->|billing| handle');
    expect(mermaid).toContain('classify -->|technical| handle');
    expect(mermaid).toContain('classify -->|unknown| escalate');
    expect(mermaid).toContain('handle -->|resolved| done');
    expect(mermaid).toContain('done([done: resolved])');
  });

  it('supports custom direction and title', () => {
    const flow: StepFlowConfig = {
      settings: { start_step: 'a' },
      steps: { a: { transitions: { ok: 'end' } } },
      terminal_states: { end: { return_intent: 'done' } },
    };
    const mermaid = flowToMermaid(flow, { direction: 'LR', title: 'My Flow' });
    expect(mermaid).toContain('graph LR');
    expect(mermaid).toContain('%% My Flow');
  });
});

// ============================================================================
// validateGraphConfig
// ============================================================================

describe('validateGraphConfig', () => {
  it('returns empty array for valid config', () => {
    const config = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: { provides: ['x'] } },
    };
    expect(validateGraphConfig(config)).toEqual([]);
  });

  it('catches missing settings', () => {
    const errors = validateGraphConfig({ tasks: { a: { provides: ['x'] } } });
    expect(errors).toContain('Graph config must have a "settings" object');
  });

  it('catches missing completion', () => {
    const errors = validateGraphConfig({ settings: {}, tasks: { a: { provides: ['x'] } } });
    expect(errors).toContain('settings.completion must be a string');
  });

  it('catches goal-reached without goal array', () => {
    const errors = validateGraphConfig({
      settings: { completion: 'goal-reached' },
      tasks: { a: { provides: ['x'] } },
    });
    expect(errors).toContain('settings.goal must be a non-empty array when completion is "goal-reached"');
  });

  it('catches missing tasks', () => {
    const errors = validateGraphConfig({ settings: { completion: 'all-tasks-complete' } });
    expect(errors).toContain('Graph config must have a "tasks" object');
  });

  it('catches empty tasks', () => {
    const errors = validateGraphConfig({ settings: { completion: 'all-tasks-complete' }, tasks: {} });
    expect(errors).toContain('Graph config must have at least one task');
  });

  it('catches task without provides', () => {
    const errors = validateGraphConfig({
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: {} },
    });
    expect(errors).toContain('Task "a" must have a "provides" array');
  });

  it('catches invalid on field', () => {
    const errors = validateGraphConfig({
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: { provides: ['x'], on: { result: 'not-an-array' } } },
    });
    expect(errors.some((e) => e.includes('on.result must be an array'))).toBe(true);
  });

  it('catches non-object arg', () => {
    expect(validateGraphConfig(null)).toEqual(['Graph config must be an object']);
    expect(validateGraphConfig('string')).toEqual(['Graph config must be an object']);
  });
});

// ============================================================================
// exportGraphConfig
// ============================================================================

describe('exportGraphConfig', () => {
  it('exports as JSON', () => {
    const config: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: { provides: ['x'] }, b: { requires: ['x'], provides: ['y'] } },
    };
    const json = exportGraphConfig(config);
    const parsed = JSON.parse(json);
    expect(parsed.settings.completion).toBe('all-tasks-complete');
    expect(parsed.tasks.a.provides).toEqual(['x']);
    expect(parsed.tasks.b.requires).toEqual(['x']);
  });

  it('exports as YAML', () => {
    const config: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { a: { provides: ['x'] }, b: { requires: ['x'], provides: ['y'] } },
    };
    const yaml = exportGraphConfig(config, { format: 'yaml' });
    expect(yaml).toContain('settings:');
    expect(yaml).toContain('completion: all-tasks-complete');
    expect(yaml).toContain('tasks:');
    expect(yaml).toContain('provides: [x]');
    expect(yaml).toContain('requires: [x]');
  });

  it('JSON round-trips', () => {
    const config: GraphConfig = {
      id: 'test',
      settings: { completion: 'goal-reached', goal: ['final'] },
      tasks: {
        fetch: { provides: ['data'], on: { error: ['fetch-failed'] } },
        process: { requires: ['data'], provides: ['final'] },
      },
    };
    const json = exportGraphConfig(config);
    const roundTripped = JSON.parse(json) as GraphConfig;
    expect(roundTripped).toEqual(config);
  });
});
