/**
 * Inference Example: Pluggable LLM Adapters
 *
 * Shows how to create adapters for different LLM providers.
 * Each adapter implements InferenceAdapter.analyze(prompt) → string.
 *
 * Run with: npx tsx examples/inference/pluggable-adapters.ts
 */

import {
  createLiveGraph,
  schedule,
} from '../../src/continuous-event-graph/index.js';
import {
  inferCompletions,
  applyInferences,
  buildInferencePrompt,
  createCliAdapter,
  createHttpAdapter,
} from '../../src/inference/index.js';
import type { InferenceAdapter } from '../../src/inference/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Adapter Examples (uncomment the one for your LLM provider)
// ============================================================================

/**
 * OpenAI Adapter
 * npm install openai
 */
function createOpenAIAdapter(apiKey: string, model = 'gpt-4o'): InferenceAdapter {
  return {
    analyze: async (prompt: string) => {
      // import OpenAI from 'openai';
      // const client = new OpenAI({ apiKey });
      // const response = await client.chat.completions.create({
      //   model,
      //   messages: [{ role: 'user', content: prompt }],
      //   temperature: 0.1,  // low temperature for deterministic analysis
      // });
      // return response.choices[0].message.content ?? '[]';

      // Mock for demo
      return '[]';
    },
  };
}

/**
 * Azure OpenAI Adapter
 * npm install openai
 */
function createAzureOpenAIAdapter(
  endpoint: string,
  apiKey: string,
  deployment: string,
): InferenceAdapter {
  return {
    analyze: async (prompt: string) => {
      // import OpenAI from 'openai';
      // const client = new OpenAI({
      //   apiKey,
      //   baseURL: `${endpoint}/openai/deployments/${deployment}`,
      //   defaultQuery: { 'api-version': '2024-02-15-preview' },
      //   defaultHeaders: { 'api-key': apiKey },
      // });
      // const response = await client.chat.completions.create({
      //   model: deployment,
      //   messages: [{ role: 'user', content: prompt }],
      //   temperature: 0.1,
      // });
      // return response.choices[0].message.content ?? '[]';

      return '[]';
    },
  };
}

/**
 * Anthropic (Claude) Adapter
 * npm install @anthropic-ai/sdk
 */
function createAnthropicAdapter(apiKey: string, model = 'claude-sonnet-4-20250514'): InferenceAdapter {
  return {
    analyze: async (prompt: string) => {
      // import Anthropic from '@anthropic-ai/sdk';
      // const client = new Anthropic({ apiKey });
      // const response = await client.messages.create({
      //   model,
      //   max_tokens: 1024,
      //   messages: [{ role: 'user', content: prompt }],
      // });
      // return response.content[0].type === 'text' ? response.content[0].text : '[]';

      return '[]';
    },
  };
}

/**
 * Local/Custom Adapter — call any HTTP endpoint
 */
function createCustomAdapter(url: string, headers: Record<string, string> = {}): InferenceAdapter {
  return {
    analyze: async (prompt: string) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ prompt }),
      });
      const data = await response.json() as { response?: string };
      return data.response ?? '[]';
    },
  };
}

// ============================================================================
// 1b. Built-in Adapter Factories (no boilerplate needed)
// ============================================================================

/**
 * Ollama via CLI — runs models locally
 * Install: https://ollama.com
 */
const ollamaCliAdapter = createCliAdapter({
  command: 'ollama',
  args: (prompt) => ['run', 'llama3', prompt],
});

/**
 * Ollama via HTTP — same model, HTTP interface
 * Start with: ollama serve
 */
const ollamaHttpAdapter = createHttpAdapter({
  url: 'http://localhost:11434/api/generate',
  buildBody: (prompt) => ({ model: 'llama3', prompt, stream: false }),
  extractResponse: (json) => json.response as string,
});

/**
 * llm CLI — Simon Willison's LLM tool
 * Install: pip install llm
 */
const llmCliAdapter = createCliAdapter({
  command: 'llm',
  args: () => ['--no-stream'],
  stdin: true, // pipe prompt via stdin (better for long prompts)
});

/**
 * GitHub Copilot CLI — use gh copilot for inference
 * Install: gh extension install github/gh-copilot
 */
const ghCopilotAdapter = createCliAdapter({
  command: 'gh',
  args: (prompt) => ['copilot', 'suggest', '-t', 'shell', prompt],
  timeout: 30_000,
});

/**
 * Custom script adapter — run your own wrapper script
 * The script receives the prompt as argument (or stdin) and prints JSON to stdout
 */
const customScriptAdapter = createCliAdapter({
  command: 'python',
  args: (prompt) => ['scripts/infer.py', '--json', prompt],
  cwd: '/path/to/project',
  env: { MODEL: 'gpt-4o', TEMPERATURE: '0.1' },
  timeout: 60_000,
});

// ============================================================================
// 2. Demo: Use the prompt builder standalone
// ============================================================================

const config: GraphConfig = {
  settings: { completion: 'all-tasks' },
  tasks: {
    'code-reviewed': {
      provides: ['review-done'],
      description: 'Code review completed by team lead',
      inference: {
        criteria: 'PR approved with at least 2 approvals and no open comments',
        keywords: ['pull-request', 'code-review', 'approval'],
        suggestedChecks: ['check PR status for "approved"', 'verify no open comments'],
        autoDetectable: true,
      },
    },
    'tests-passed': {
      requires: ['review-done'],
      provides: ['tests-green'],
      description: 'CI pipeline tests all passing',
      inference: {
        criteria: 'All CI checks green, code coverage above 80%',
        keywords: ['ci', 'tests', 'coverage', 'pipeline'],
        suggestedChecks: ['check CI status', 'verify coverage report'],
        autoDetectable: true,
      },
    },
    'deployed-staging': {
      requires: ['tests-green'],
      provides: ['staging-live'],
      description: 'Deployed to staging environment',
      inference: {
        criteria: 'Staging URL returns HTTP 200 with correct version',
        keywords: ['staging', 'deployment', 'version'],
        autoDetectable: true,
      },
    },
  },
};

async function main() {
  const live = createLiveGraph(config);

  // Just build the prompt — useful for debugging or using with your own LLM code
  const prompt = buildInferencePrompt(live, {
    context: 'PR #142: 3 approvals, 0 open comments. CI: all 47 tests pass, coverage 84%.',
  });

  console.log('=== Generated LLM Prompt ===');
  console.log(prompt);
  console.log('\n=== End Prompt ===');
  console.log(`\nPrompt length: ${prompt.length} characters`);
  console.log('This prompt can be sent to any LLM provider.');

  // Demo: use a mock adapter to show the full flow
  const mockAdapter: InferenceAdapter = {
    analyze: async () => JSON.stringify([
      { taskName: 'code-reviewed', confidence: 0.97, reasoning: '3 approvals, 0 open comments — PR is clearly approved.' },
      { taskName: 'tests-passed', confidence: 0.92, reasoning: '47/47 tests pass, coverage 84% exceeds 80% threshold.' },
    ]),
  };

  const result = await inferCompletions(live, mockAdapter, {
    context: 'PR #142: 3 approvals, 0 open comments. CI: all 47 tests pass, coverage 84%.',
  });

  console.log('\n=== Inference Results ===');
  for (const s of result.suggestions) {
    console.log(`  ${s.taskName}: ${(s.confidence * 100).toFixed(0)}% — ${s.reasoning}`);
  }

  // Apply above threshold
  const updated = applyInferences(live, result, 0.9);
  console.log('\n=== After Applying (threshold 90%) ===');
  for (const [name, state] of Object.entries(updated.state.tasks)) {
    console.log(`  ${name}: ${state.status}`);
  }
  console.log('  Eligible:', schedule(updated).eligible);
}

main().catch(console.error);
