/**
 * Step Machine — Loader
 *
 * Utilities for loading and validating step-machine flow configurations.
 */

import type { StepFlowConfig } from './types.js';

export async function parseStepFlowYaml(yamlString: string): Promise<StepFlowConfig> {
  const yaml = await import('yaml');
  return yaml.parse(yamlString) as StepFlowConfig;
}

export async function loadStepFlowFromUrl(url: string): Promise<StepFlowConfig> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load flow from ${url}: ${response.statusText}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('json') || url.endsWith('.json')) {
    return JSON.parse(text) as StepFlowConfig;
  }
  return parseStepFlowYaml(text);
}

export async function loadStepFlowFromFile(filePath: string): Promise<StepFlowConfig> {
  const fs = await import('fs/promises');
  const text = await fs.readFile(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return JSON.parse(text) as StepFlowConfig;
  }
  return parseStepFlowYaml(text);
}

export function validateStepFlowConfig(flow: unknown): string[] {
  const errors: string[] = [];
  if (!flow || typeof flow !== 'object') {
    return ['Flow must be an object'];
  }
  const f = flow as Record<string, unknown>;

  if (!f.settings || typeof f.settings !== 'object') {
    errors.push('Flow must have a "settings" object');
  } else {
    const settings = f.settings as Record<string, unknown>;
    if (typeof settings.start_step !== 'string') {
      errors.push('settings.start_step must be a string');
    }
  }

  if (!f.steps || typeof f.steps !== 'object') {
    errors.push('Flow must have a "steps" object');
  } else {
    const steps = f.steps as Record<string, unknown>;
    for (const [stepName, stepConfig] of Object.entries(steps)) {
      if (!stepConfig || typeof stepConfig !== 'object') {
        errors.push(`Step "${stepName}" must be an object`);
        continue;
      }
      const step = stepConfig as Record<string, unknown>;
      if (!step.transitions || typeof step.transitions !== 'object') {
        errors.push(`Step "${stepName}" must have a "transitions" object`);
      }
      if (step.failure_transitions !== undefined && typeof step.failure_transitions !== 'object') {
        errors.push(`Step "${stepName}" failure_transitions must be an object when provided`);
      }
    }
  }

  if (!f.terminal_states || typeof f.terminal_states !== 'object') {
    errors.push('Flow must have a "terminal_states" object');
  } else {
    const terminals = f.terminal_states as Record<string, unknown>;
    for (const [name, config] of Object.entries(terminals)) {
      if (!config || typeof config !== 'object') {
        errors.push(`Terminal state "${name}" must be an object`);
        continue;
      }
      const terminal = config as Record<string, unknown>;
      if (typeof terminal.return_intent !== 'string') {
        errors.push(`Terminal state "${name}" must have a "return_intent" string`);
      }
    }
  }

  return errors;
}

export async function loadStepFlow(source: string | StepFlowConfig): Promise<StepFlowConfig> {
  let flow: StepFlowConfig;
  if (typeof source === 'string') {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      flow = await loadStepFlowFromUrl(source);
    } else if (source.includes('{')) {
      flow = JSON.parse(source);
    } else {
      flow = await loadStepFlowFromFile(source);
    }
  } else {
    flow = source;
  }
  const errors = validateStepFlowConfig(flow);
  if (errors.length > 0) {
    throw new Error(`Invalid step flow configuration:\n- ${errors.join('\n- ')}`);
  }
  return flow;
}
