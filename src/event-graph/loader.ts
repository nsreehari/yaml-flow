/**
 * Event Graph — Loader & Exporter
 *
 * Load GraphConfig from YAML/JSON files or strings, and export back.
 * Mirrors the step-machine's loadStepFlow/validateStepFlowConfig pattern.
 */

import type { GraphConfig } from './types.js';

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate a GraphConfig object. Returns an array of error strings.
 * Empty array = valid config.
 */
export function validateGraphConfig(config: unknown): string[] {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return ['Graph config must be an object'];
  }

  const c = config as Record<string, unknown>;

  // Settings
  if (!c.settings || typeof c.settings !== 'object') {
    errors.push('Graph config must have a "settings" object');
  } else {
    const settings = c.settings as Record<string, unknown>;
    if (!settings.completion || typeof settings.completion !== 'string') {
      errors.push('settings.completion must be a string');
    }
    if (settings.completion === 'goal-reached') {
      if (!Array.isArray(settings.goal) || settings.goal.length === 0) {
        errors.push('settings.goal must be a non-empty array when completion is "goal-reached"');
      }
    }
  }

  // Tasks
  if (!c.tasks || typeof c.tasks !== 'object') {
    errors.push('Graph config must have a "tasks" object');
  } else {
    const tasks = c.tasks as Record<string, unknown>;
    if (Object.keys(tasks).length === 0) {
      errors.push('Graph config must have at least one task');
    }
    for (const [name, task] of Object.entries(tasks)) {
      if (!task || typeof task !== 'object') {
        errors.push(`Task "${name}" must be an object`);
        continue;
      }
      const t = task as Record<string, unknown>;
      if (!Array.isArray(t.provides)) {
        errors.push(`Task "${name}" must have a "provides" array`);
      }
      if (t.requires !== undefined && !Array.isArray(t.requires)) {
        errors.push(`Task "${name}".requires must be an array if present`);
      }
      if (t.on !== undefined) {
        if (typeof t.on !== 'object' || Array.isArray(t.on)) {
          errors.push(`Task "${name}".on must be an object mapping result keys to token arrays`);
        } else {
          for (const [key, tokens] of Object.entries(t.on as Record<string, unknown>)) {
            if (!Array.isArray(tokens)) {
              errors.push(`Task "${name}".on.${key} must be an array of tokens`);
            }
          }
        }
      }
    }
  }

  return errors;
}

// ============================================================================
// Parsing
// ============================================================================

async function parseGraphYaml(yamlString: string): Promise<GraphConfig> {
  const yaml = await import('yaml');
  return yaml.parse(yamlString) as GraphConfig;
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load a GraphConfig from a file path, URL, JSON string, or object.
 * Validates the config and throws if invalid.
 *
 * @param source - File path (.yaml/.yml/.json), URL, JSON string, or GraphConfig object
 * @returns Validated GraphConfig
 */
export async function loadGraphConfig(source: string | GraphConfig): Promise<GraphConfig> {
  let config: GraphConfig;

  if (typeof source === 'string') {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to load graph config from ${source}: ${response.statusText}`);
      }
      const text = await response.text();
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json') || source.endsWith('.json')) {
        config = JSON.parse(text) as GraphConfig;
      } else {
        config = await parseGraphYaml(text);
      }
    } else if (source.includes('{')) {
      // Looks like a JSON string
      config = JSON.parse(source) as GraphConfig;
    } else {
      // File path
      const fs = await import('fs/promises');
      const text = await fs.readFile(source, 'utf-8');
      if (source.endsWith('.json')) {
        config = JSON.parse(text) as GraphConfig;
      } else {
        config = await parseGraphYaml(text);
      }
    }
  } else {
    config = source;
  }

  const errors = validateGraphConfig(config);
  if (errors.length > 0) {
    throw new Error(`Invalid graph configuration:\n- ${errors.join('\n- ')}`);
  }

  return config;
}

// ============================================================================
// Exporting
// ============================================================================

export interface ExportOptions {
  /** Output format. Default: 'json' */
  format?: 'json' | 'yaml';
  /** Indentation for JSON (default: 2) or YAML */
  indent?: number;
}

/**
 * Export a GraphConfig to a JSON or YAML string.
 *
 * @param config - The graph configuration to export
 * @param options - Export format options
 * @returns Serialized config string
 */
export function exportGraphConfig(config: GraphConfig, options: ExportOptions = {}): string {
  const { format = 'json', indent = 2 } = options;

  if (format === 'yaml') {
    // Dynamic import isn't available in sync context — use a simple YAML serializer
    return toYaml(config, indent);
  }

  return JSON.stringify(config, null, indent);
}

/**
 * Export a GraphConfig to a file.
 *
 * @param config - The graph configuration to export
 * @param filePath - Output file path (.json or .yaml/.yml)
 * @param options - Export format options (format auto-detected from extension if not specified)
 */
export async function exportGraphConfigToFile(
  config: GraphConfig,
  filePath: string,
  options: ExportOptions = {},
): Promise<void> {
  const format = options.format ??
    (filePath.endsWith('.yaml') || filePath.endsWith('.yml') ? 'yaml' : 'json');

  const content = exportGraphConfig(config, { ...options, format });
  const fs = await import('fs/promises');
  await fs.writeFile(filePath, content, 'utf-8');
}

// ============================================================================
// Simple YAML serializer (avoids requiring the yaml package for export)
// ============================================================================

function toYaml(obj: unknown, indent: number, depth: number = 0): string {
  const pad = ' '.repeat(indent * depth);

  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean') return String(obj);
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    // Quote strings containing special chars
    if (obj.includes(':') || obj.includes('#') || obj.includes('\n') ||
        obj.includes('"') || obj.includes("'") || obj.startsWith(' ') ||
        obj.startsWith('{') || obj.startsWith('[') || obj === '') {
      return JSON.stringify(obj);
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    // Short arrays of simple values: inline
    if (obj.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      return `[${obj.map((v) => (typeof v === 'string' ? toYaml(v, indent, 0) : String(v))).join(', ')}]`;
    }
    return obj
      .map((item) => {
        const val = toYaml(item, indent, depth + 1);
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          // Object item: put first key on same line as dash
          const lines = val.trimStart().split('\n');
          return `${pad}- ${lines[0]}\n${lines.slice(1).map((l) => `${pad}  ${l.trimStart() ? l : ''}`).filter(Boolean).join('\n')}`;
        }
        return `${pad}- ${val}`;
      })
      .join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([key, value]) => {
        if (value === undefined) return '';
        const serialized = toYaml(value, indent, depth + 1);
        if (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0) {
          return `${pad}${key}:\n${serialized}`;
        }
        if (Array.isArray(value) && value.length > 0 &&
            !value.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
          return `${pad}${key}:\n${serialized}`;
        }
        return `${pad}${key}: ${serialized}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  return String(obj);
}
