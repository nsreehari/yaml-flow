/**
 * Integration test: GitHub Copilot CLI with yaml-flow inference
 *
 * Uses createCliAdapter to pipe prompts to `copilot --allow-all` via stdin
 * and capture the LLM response from stdout.
 *
 * Requires: copilot CLI installed (comes with VS Code / GitHub Copilot extension)
 *
 * Usage: npx vitest run tests/inference/copilot-integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { createLiveGraph, schedule } from '../../src/continuous-event-graph/index.js';
import {
  buildInferencePrompt,
  inferCompletions,
  applyInferences,
  createCliAdapter,
} from '../../src/inference/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// Test config: a realistic deployment pipeline
// ============================================================================

const pipelineConfig: GraphConfig = {
  settings: { completion: 'all-tasks' },
  tasks: {
    'code-reviewed': {
      provides: ['review-done'],
      description: 'Code review completed and approved',
      inference: {
        criteria: 'PR has at least 2 approvals and no blocking comments',
        keywords: ['pull-request', 'approval', 'code-review'],
        autoDetectable: true,
      },
    },
    'tests-passed': {
      requires: ['review-done'],
      provides: ['tests-green'],
      description: 'All CI tests passing with adequate coverage',
      inference: {
        criteria: 'CI pipeline green, all tests pass, coverage > 80%',
        keywords: ['ci', 'tests', 'pipeline', 'coverage'],
        autoDetectable: true,
      },
    },
    'security-scan-clean': {
      requires: ['review-done'],
      provides: ['security-ok'],
      description: 'Security scanning reveals no critical issues',
      inference: {
        criteria: 'No critical or high severity vulnerabilities found',
        keywords: ['security', 'scan', 'vulnerability', 'CVE'],
        autoDetectable: true,
      },
    },
    'deployed-staging': {
      requires: ['tests-green', 'security-ok'],
      provides: ['staging-live'],
      description: 'Deployed to staging and health checks passing',
      inference: {
        criteria: 'Staging URL returns HTTP 200 with expected version',
        keywords: ['staging', 'deployment', 'health-check'],
        autoDetectable: true,
      },
    },
  },
};

// ============================================================================
// Copilot adapter — just 4 lines
// ============================================================================

const copilotAdapter = createCliAdapter({
  command: 'copilot',
  args: () => ['--allow-all'],
  stdin: true,
  timeout: 120_000,
});

/** Check if `copilot` binary is reachable (false on CI runners) */
let hasCopilotCli = false;
try { execSync('copilot --version', { stdio: 'ignore' }); hasCopilotCli = true; } catch { /* not installed */ }

// ============================================================================
// Tests
// ============================================================================

describe('copilot CLI integration', () => {
  it('creates an adapter from copilot CLI', () => {
    expect(copilotAdapter).toBeDefined();
    expect(typeof copilotAdapter.analyze).toBe('function');
  });

  it('builds a valid prompt for the pipeline', () => {
    const live = createLiveGraph(pipelineConfig);
    const prompt = buildInferencePrompt(live, {
      context: 'PR #42: 3 approvals, CI green, all 120 tests pass, coverage 87%. Security scan: 0 critical, 0 high.',
    });

    expect(prompt).toContain('code-reviewed');
    expect(prompt).toContain('tests-passed');
    expect(prompt).toContain('security-scan-clean');
    expect(prompt).toContain('PR #42');
    console.log(`Prompt length: ${prompt.length} chars`);
  });

  it.skipIf(!hasCopilotCli)('calls copilot and gets a response', async () => {
    const live = createLiveGraph(pipelineConfig);
    const prompt = buildInferencePrompt(live, {
      context: [
        'PR #42 status:',
        '- 3 approvals from team leads, 0 open comments',
        '- CI: 120/120 tests pass, coverage 87%',
        '- Security scan: 0 critical, 0 high, 2 medium (accepted)',
      ].join('\n'),
    });

    console.log('Sending prompt to copilot CLI...');
    const raw = await copilotAdapter.analyze(prompt);
    console.log('Raw response:', raw.slice(0, 500));

    expect(raw.length).toBeGreaterThan(0);
  }, 120_000);

  it.skipIf(!hasCopilotCli)('runs full inferCompletions → applyInferences pipeline', async () => {
    const live = createLiveGraph(pipelineConfig);

    const result = await inferCompletions(live, copilotAdapter, {
      context: [
        'Current state of PR #42:',
        '- Code review: 3 approvals, 0 blocking comments — APPROVED',
        '- CI pipeline: 120/120 tests pass, code coverage 87%',
        '- Security scan: 0 critical, 0 high vulnerabilities',
      ].join('\n'),
    });

    console.log('\n=== Inference Result ===');
    console.log('Analyzed nodes:', result.analyzedNodes);
    console.log('Suggestions:', result.suggestions.length);
    for (const s of result.suggestions) {
      console.log(`  ${s.taskName}: ${(s.confidence * 100).toFixed(0)}% — ${s.reasoning}`);
    }

    // Should analyze the 4 auto-detectable tasks
    expect(result.analyzedNodes.length).toBeGreaterThan(0);

    // If copilot returns valid JSON, we should get suggestions
    if (result.suggestions.length > 0) {
      const updated = applyInferences(live, result, 0.7);

      const applied = result.suggestions.filter(s => s.confidence >= 0.7);
      const skipped = result.suggestions.filter(s => s.confidence < 0.7);
      console.log('\n=== After applying (threshold 70%) ===');
      console.log('Applied:', applied.map(s => s.taskName));
      console.log('Skipped:', skipped.map(s => s.taskName));

      for (const [name, state] of Object.entries(updated.state.tasks)) {
        console.log(`  ${name}: ${state.status}`);
      }

      const next = schedule(updated);
      console.log('Newly eligible:', next.eligible);
    }
  }, 120_000);
});
