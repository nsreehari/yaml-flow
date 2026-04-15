/**
 * Inference Example: GitHub Copilot CLI
 *
 * Uses createCliAdapter to pipe prompts directly to `copilot --allow-all`
 * via stdin and capture the LLM response from stdout.
 *
 * Prerequisites:
 *   - GitHub Copilot CLI installed (comes with VS Code / GitHub Copilot extension)
 *   - `copilot` available on PATH
 *
 * Run with: npx tsx examples/inference/copilot-cli.ts
 */

import { createLiveGraph, schedule } from '../../src/continuous-event-graph/index.js';
import {
  buildInferencePrompt,
  inferCompletions,
  applyInferences,
  createCliAdapter,
} from '../../src/inference/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Create a Copilot adapter — just 4 lines
// ============================================================================

const copilotAdapter = createCliAdapter({
  command: 'copilot',
  args: () => ['--allow-all'],
  stdin: true,           // pipe prompt via stdin (handles long prompts)
  timeout: 120_000,      // copilot can be slow on first call
});

// ============================================================================
// 2. Define a deployment pipeline with inference hints
// ============================================================================

const config: GraphConfig = {
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
// 3. Run the pipeline
// ============================================================================

async function main() {
  const live = createLiveGraph(config);

  // Show the generated prompt
  const prompt = buildInferencePrompt(live, {
    context: [
      'Current state of PR #42:',
      '- Code review: 3 approvals from team leads, 0 open comments',
      '- CI pipeline: 120/120 tests pass, code coverage 87%',
      '- Security scan: 0 critical, 0 high vulnerabilities',
    ].join('\n'),
  });

  console.log('=== Prompt ===');
  console.log(prompt.slice(0, 500) + '...');
  console.log(`(${prompt.length} chars total)\n`);

  // Ask Copilot to infer which tasks are complete
  console.log('Calling copilot CLI...');
  const result = await inferCompletions(live, copilotAdapter, {
    context: [
      'Current state of PR #42:',
      '- Code review: 3 approvals from team leads, 0 open comments',
      '- CI pipeline: 120/120 tests pass, code coverage 87%',
      '- Security scan: 0 critical, 0 high vulnerabilities',
    ].join('\n'),
  });

  console.log('=== Inference Results ===');
  for (const s of result.suggestions) {
    console.log(`  ${s.taskName}: ${(s.confidence * 100).toFixed(0)}% — ${s.reasoning}`);
  }

  // Apply suggestions above 70% confidence
  const updated = applyInferences(live, result, 0.7);

  const applied = result.suggestions.filter(s => s.confidence >= 0.7);
  const skipped = result.suggestions.filter(s => s.confidence < 0.7);

  console.log('\n=== After Applying (threshold 70%) ===');
  console.log('Applied:', applied.map(s => s.taskName).join(', ') || '(none)');
  console.log('Skipped:', skipped.map(s => s.taskName).join(', ') || '(none)');

  for (const [name, state] of Object.entries(updated.state.tasks)) {
    console.log(`  ${name}: ${state.status}`);
  }

  const next = schedule(updated);
  console.log('\nNewly eligible:', next.eligible.join(', ') || '(none)');
}

main().catch(console.error);
