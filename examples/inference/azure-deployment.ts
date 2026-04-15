/**
 * Inference Example: Azure Deployment Pipeline
 *
 * Demonstrates LLM-assisted completion detection for a CI/CD workflow.
 * The graph has 3 checkpoints. After deployment, the LLM analyzes
 * logs and determines what's complete.
 *
 * Run with: npx tsx examples/inference/azure-deployment.ts
 */

import {
  createLiveGraph,
  schedule,
} from '../../src/continuous-event-graph/index.js';
import {
  inferAndApply,
  buildInferencePrompt,
} from '../../src/inference/index.js';
import type { InferenceAdapter } from '../../src/inference/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Define the graph with inference hints
// ============================================================================

const config: GraphConfig = {
  settings: { completion: 'all-tasks' },
  tasks: {
    'infra-provisioned': {
      provides: ['infra-ready'],
      description: 'Azure infrastructure setup',
      inference: {
        criteria: 'All Azure resources provisioned successfully',
        keywords: ['azure', 'resource-group', 'provisioning', 'deployment'],
        suggestedChecks: [
          'scan logs for "Deployment Succeeded"',
          'verify resource group exists',
        ],
        autoDetectable: true,
      },
    },
    'app-deployed': {
      requires: ['infra-ready'],
      provides: ['app-ready'],
      description: 'Application code deployed and running',
      inference: {
        criteria: 'Application health check returns HTTP 200',
        keywords: ['nodejs', 'health-check', 'deploy'],
        suggestedChecks: ['HTTP 200 from /health endpoint'],
        autoDetectable: true,
      },
    },
    'monitoring-enabled': {
      requires: ['app-ready'],
      provides: ['monitored'],
      description: 'Metrics and alerts configured',
      inference: {
        criteria: 'Application Insights receiving metrics and alerts configured',
        keywords: ['monitoring', 'metrics', 'alerts', 'insights'],
        suggestedChecks: ['verify metrics flowing', 'test alert rules'],
        autoDetectable: true,
      },
    },
  },
};

// ============================================================================
// 2. Create a mock LLM adapter (swap with real OpenAI/Azure/Anthropic in prod)
// ============================================================================

const mockDeploymentAdapter: InferenceAdapter = {
  analyze: async (prompt: string) => {
    // In production, this would call your LLM:
    // const response = await openai.chat.completions.create({ model: 'gpt-4o', messages: [...] });
    // return response.choices[0].message.content;

    console.log('\n📝 Prompt sent to LLM (first 200 chars):');
    console.log(prompt.substring(0, 200) + '...\n');

    // Simulated LLM response based on deployment logs
    return JSON.stringify([
      {
        taskName: 'infra-provisioned',
        confidence: 0.95,
        reasoning: 'Deployment log explicitly states "Deployment Succeeded" and lists all provisioned resources including App Service, Storage, and Application Insights.',
      },
      {
        taskName: 'app-deployed',
        confidence: 0.88,
        reasoning: 'Health check endpoint returned HTTP 200 OK. The app appears to be running successfully.',
      },
      {
        taskName: 'monitoring-enabled',
        confidence: 0.15,
        reasoning: 'No evidence of metrics flowing or alerts being configured. The Application Insights resource exists but may not be receiving data yet.',
      },
    ]);
  },
};

// ============================================================================
// 3. Run the inference pipeline
// ============================================================================

async function main() {
  let live = createLiveGraph(config);
  console.log('=== Azure Deployment Pipeline with LLM Inference ===');
  console.log('Initial schedule:', schedule(live).eligible);

  // The deployment logs arrive (this would come from your CI/CD system)
  const deploymentLogs = `
    [2025-11-16T10:30:00Z] Azure CLI: Deployment Succeeded
    [2025-11-16T10:30:01Z] Resource Group: swarmx-rg-001 (eastus)
    [2025-11-16T10:30:02Z] Resources: App Service Plan, Web App, Application Insights, Storage Account
    [2025-11-16T10:31:00Z] App deployed to: https://swarmx-webapp-prod.azurewebsites.net
    [2025-11-16T10:31:05Z] Health check: GET /health → HTTP 200 OK
  `.trim();

  // Ask the LLM to analyze the evidence
  const result = await inferAndApply(live, mockDeploymentAdapter, {
    threshold: 0.8,
    context: deploymentLogs,
  });

  // Report
  console.log('\n=== LLM Analysis Results ===');
  console.log(`Analyzed nodes: ${result.inference.analyzedNodes.join(', ')}`);

  console.log('\n  Applied (above threshold):');
  for (const s of result.applied) {
    console.log(`    ✅ ${s.taskName} (${(s.confidence * 100).toFixed(0)}%): ${s.reasoning}`);
  }

  console.log('\n  Skipped (below threshold):');
  for (const s of result.skipped) {
    console.log(`    ⏭️  ${s.taskName} (${(s.confidence * 100).toFixed(0)}%): ${s.reasoning}`);
  }

  // Updated graph state
  live = result.live;
  console.log('\n=== Updated Graph State ===');
  console.log('infra-provisioned:', live.state.tasks['infra-provisioned'].status);
  console.log('app-deployed:', live.state.tasks['app-deployed'].status);
  console.log('monitoring-enabled:', live.state.tasks['monitoring-enabled'].status);
  console.log('Now eligible:', schedule(live).eligible);
  console.log('Available tokens:', live.state.availableOutputs);
}

main().catch(console.error);
