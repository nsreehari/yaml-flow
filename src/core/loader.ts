/**
 * yaml-flow - Flow Loader
 * 
 * Utilities for loading and validating flow configurations.
 */

import type { FlowConfig } from './types.js';

/**
 * Parse YAML string to FlowConfig
 * Requires 'yaml' package to be installed
 */
export async function parseYaml(yamlString: string): Promise<FlowConfig> {
  const yaml = await import('yaml');
  return yaml.parse(yamlString) as FlowConfig;
}

/**
 * Load flow from a URL (browser-friendly)
 */
export async function loadFlowFromUrl(url: string): Promise<FlowConfig> {
  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Failed to load flow from ${url}: ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (contentType.includes('json') || url.endsWith('.json')) {
    return JSON.parse(text) as FlowConfig;
  }

  // Assume YAML
  return parseYaml(text);
}

/**
 * Load flow from file path (Node.js only)
 */
export async function loadFlowFromFile(filePath: string): Promise<FlowConfig> {
  const fs = await import('fs/promises');
  const text = await fs.readFile(filePath, 'utf-8');

  if (filePath.endsWith('.json')) {
    return JSON.parse(text) as FlowConfig;
  }

  // Assume YAML
  return parseYaml(text);
}

/**
 * Validate a flow configuration
 * Returns array of validation errors (empty if valid)
 */
export function validateFlowConfig(flow: unknown): string[] {
  const errors: string[] = [];

  if (!flow || typeof flow !== 'object') {
    return ['Flow must be an object'];
  }

  const f = flow as Record<string, unknown>;

  // Check settings
  if (!f.settings || typeof f.settings !== 'object') {
    errors.push('Flow must have a "settings" object');
  } else {
    const settings = f.settings as Record<string, unknown>;
    if (typeof settings.start_step !== 'string') {
      errors.push('settings.start_step must be a string');
    }
    if (settings.max_total_steps !== undefined && typeof settings.max_total_steps !== 'number') {
      errors.push('settings.max_total_steps must be a number');
    }
    if (settings.timeout_ms !== undefined && typeof settings.timeout_ms !== 'number') {
      errors.push('settings.timeout_ms must be a number');
    }
  }

  // Check steps
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
    }
  }

  // Check terminal_states
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

/**
 * Load and validate flow, throwing if invalid
 */
export async function loadFlow(source: string | FlowConfig): Promise<FlowConfig> {
  let flow: FlowConfig;

  if (typeof source === 'string') {
    // Check if it's a URL or file path
    if (source.startsWith('http://') || source.startsWith('https://')) {
      flow = await loadFlowFromUrl(source);
    } else if (source.includes('{')) {
      // Looks like JSON string
      flow = JSON.parse(source);
    } else {
      // Assume file path (Node.js)
      flow = await loadFlowFromFile(source);
    }
  } else {
    flow = source;
  }

  const errors = validateFlowConfig(flow);
  if (errors.length > 0) {
    throw new Error(`Invalid flow configuration:\n- ${errors.join('\n- ')}`);
  }

  return flow;
}
