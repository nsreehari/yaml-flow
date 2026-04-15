import { describe, it, expect } from 'vitest';
import { validateGraph } from '../../src/event-graph/validate.js';
import type { GraphConfig } from '../../src/event-graph/types.js';

// ============================================================================
// Helper
// ============================================================================

function issuesByCode(result: ReturnType<typeof validateGraph>, code: string) {
  return result.issues.filter((i) => i.code === code);
}

// ============================================================================
// Valid graphs
// ============================================================================

describe('validateGraph — valid graphs', () => {
  it('passes a simple linear graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
        c: { requires: ['y'], provides: ['z'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes a diamond graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        start: { provides: ['ready'] },
        left: { requires: ['ready'], provides: ['left-done'] },
        right: { requires: ['ready'], provides: ['right-done'] },
        join: { requires: ['left-done', 'right-done'], provides: ['final'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('passes a goal-reached graph with reachable goals', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['answer'] },
      tasks: {
        search: { provides: ['data'] },
        synthesize: { requires: ['data'], provides: ['answer'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
  });

  it('passes a single-task graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { only: { provides: ['done'] } },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('passes a graph with conditional on provides', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        classify: { provides: ['classified'], on: { photo: ['is-photo'], doc: ['is-doc'] } },
        process_photo: { requires: ['is-photo'], provides: ['processed'] },
        process_doc: { requires: ['is-doc'], provides: ['processed'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    // process_photo and process_doc both provide 'processed' — should be a warning
    expect(issuesByCode(result, 'PROVIDE_CONFLICT').length).toBe(1);
  });
});

// ============================================================================
// DANGLING_REQUIRES
// ============================================================================

describe('validateGraph — DANGLING_REQUIRES', () => {
  it('detects requires with no producer', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x', 'missing-token'], provides: ['y'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    const issues = issuesByCode(result, 'DANGLING_REQUIRES');
    expect(issues).toHaveLength(1);
    expect(issues[0].tokens).toEqual(['missing-token']);
    expect(issues[0].tasks).toEqual(['b']);
  });

  it('detects multiple dangling requires', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { requires: ['ghost-1'], provides: ['x'] },
        b: { requires: ['ghost-2'], provides: ['y'] },
      },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'DANGLING_REQUIRES');
    expect(issues).toHaveLength(2);
  });
});

// ============================================================================
// CIRCULAR_DEPENDENCY
// ============================================================================

describe('validateGraph — CIRCULAR_DEPENDENCY', () => {
  it('detects a simple cycle', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { requires: ['y'], provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    const issues = issuesByCode(result, 'CIRCULAR_DEPENDENCY');
    expect(issues.length).toBeGreaterThanOrEqual(1);
    // The cycle should mention both tasks
    const allTasks = issues.flatMap((i) => i.tasks || []);
    expect(allTasks).toContain('a');
    expect(allTasks).toContain('b');
  });

  it('detects a 3-task cycle', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { requires: ['z'], provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
        c: { requires: ['y'], provides: ['z'] },
      },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'CIRCULAR_DEPENDENCY');
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('allows a linear graph (no cycle)', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
        c: { requires: ['y'], provides: ['z'] },
      },
    };
    const result = validateGraph(graph);
    expect(issuesByCode(result, 'CIRCULAR_DEPENDENCY')).toHaveLength(0);
  });
});

// ============================================================================
// SELF_DEPENDENCY
// ============================================================================

describe('validateGraph — SELF_DEPENDENCY', () => {
  it('detects a task that requires its own provides', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        loop: { requires: ['x'], provides: ['x', 'done'] },
      },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'SELF_DEPENDENCY');
    expect(issues).toHaveLength(1);
    expect(issues[0].tokens).toEqual(['x']);
  });
});

// ============================================================================
// PROVIDE_CONFLICT
// ============================================================================

describe('validateGraph — PROVIDE_CONFLICT', () => {
  it('warns when multiple tasks provide the same token', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        provider_a: { provides: ['output'] },
        provider_b: { provides: ['output'] },
        consumer: { requires: ['output'], provides: ['done'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true); // warning, not error
    const issues = issuesByCode(result, 'PROVIDE_CONFLICT');
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].tasks).toEqual(['provider_a', 'provider_b']);
  });
});

// ============================================================================
// UNREACHABLE_GOAL
// ============================================================================

describe('validateGraph — UNREACHABLE_GOAL', () => {
  it('errors when goal token has no producer', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['answer', 'phantom'] },
      tasks: {
        search: { provides: ['data'] },
        synthesize: { requires: ['data'], provides: ['answer'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    const issues = issuesByCode(result, 'UNREACHABLE_GOAL');
    expect(issues).toHaveLength(1);
    expect(issues[0].tokens).toEqual(['phantom']);
  });

  it('passes when all goal tokens are reachable', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['answer'] },
      tasks: {
        search: { provides: ['data'] },
        synthesize: { requires: ['data'], provides: ['answer'] },
      },
    };
    expect(issuesByCode(validateGraph(graph), 'UNREACHABLE_GOAL')).toHaveLength(0);
  });

  it('counts on-conditional provides as reachable', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['is-photo'] },
      tasks: {
        classify: { provides: ['classified'], on: { photo: ['is-photo'], doc: ['is-doc'] } },
      },
    };
    expect(issuesByCode(validateGraph(graph), 'UNREACHABLE_GOAL')).toHaveLength(0);
  });
});

// ============================================================================
// MISSING_GOAL
// ============================================================================

describe('validateGraph — MISSING_GOAL', () => {
  it('errors when goal-reached has no goal defined', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached' } as any,
      tasks: { a: { provides: ['x'] } },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'MISSING_GOAL');
    expect(issues).toHaveLength(1);
  });
});

// ============================================================================
// DEAD_END_TASK
// ============================================================================

describe('validateGraph — DEAD_END_TASK', () => {
  it('warns about tasks with no provides', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        useful: { provides: ['x'] },
        dead: { requires: ['x'], provides: [] },
      },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'DEAD_END_TASK');
    expect(issues).toHaveLength(1);
    expect(issues[0].tasks).toEqual(['dead']);
    expect(issues[0].severity).toBe('warning');
  });

  it('does not warn for single-task graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: { only: { provides: [] } },
    };
    expect(issuesByCode(validateGraph(graph), 'DEAD_END_TASK')).toHaveLength(0);
  });

  it('does not warn if on_failure produces tokens', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: [], on_failure: ['b-failed'] },
      },
    };
    expect(issuesByCode(validateGraph(graph), 'DEAD_END_TASK')).toHaveLength(0);
  });
});

// ============================================================================
// ISOLATED_TASK
// ============================================================================

describe('validateGraph — ISOLATED_TASK', () => {
  it('reports an isolated entry-point task', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        connected: { provides: ['x'] },
        downstream: { requires: ['x'], provides: ['y'] },
        orphan: { provides: ['nobody-needs-this'] },
      },
    };
    const result = validateGraph(graph);
    const issues = issuesByCode(result, 'ISOLATED_TASK');
    expect(issues).toHaveLength(1);
    expect(issues[0].tasks).toEqual(['orphan']);
    expect(issues[0].severity).toBe('info');
  });

  it('does not report entry points whose provides are used', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {
        source: { provides: ['data'] },
        sink: { requires: ['data'], provides: ['done'] },
      },
    };
    expect(issuesByCode(validateGraph(graph), 'ISOLATED_TASK')).toHaveLength(0);
  });

  it('does not report entry points that produce goal tokens', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['standalone-result'] },
      tasks: {
        connected: { provides: ['x'] },
        sink: { requires: ['x'], provides: ['y'] },
        standalone: { provides: ['standalone-result'] },
      },
    };
    expect(issuesByCode(validateGraph(graph), 'ISOLATED_TASK')).toHaveLength(0);
  });
});

// ============================================================================
// EMPTY_GRAPH
// ============================================================================

describe('validateGraph — EMPTY_GRAPH', () => {
  it('errors on empty graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-complete' },
      tasks: {},
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(false);
    expect(issuesByCode(result, 'EMPTY_GRAPH')).toHaveLength(1);
  });
});

// ============================================================================
// Complex real-world graph (super-agent style)
// ============================================================================

describe('validateGraph — complex graph', () => {
  it('validates a super-agent pipeline graph', () => {
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
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('validates an evidence-gatherer inner graph', () => {
    const graph: GraphConfig = {
      settings: { completion: 'only-dependency-resolved-outputs' as any },
      tasks: {
        'url-connects': { provides: ['connection-evidence'] },
        'webpage-opens': { requires: ['connection-evidence'], provides: ['webpage-evidence'] },
        'redirect-analyzer': { requires: ['connection-evidence'], provides: ['redirect-evidence'] },
        'content-downloads': { requires: ['webpage-evidence'], provides: ['content-evidence'] },
        'security-analyzer': { requires: ['content-evidence'], provides: ['security-evidence'] },
      },
    };
    const result = validateGraph(graph);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
