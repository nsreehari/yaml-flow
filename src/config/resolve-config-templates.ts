/**
 * Config template resolution for workflow configs.
 *
 * In large graphs, many tasks share the same base config (cmd, timeout, cwd, headers, etc.).
 * Instead of duplicating, tasks reference a named template via `config-template`.
 * This function deep-merges the template into each task's config, then removes the reference.
 *
 * Pure function — returns a new config, never mutates.
 *
 * @example
 * ```ts
 * const config = {
 *   configTemplates: {
 *     PYTHON_TOOL: { cmd: 'python', timeout: 30000, cwd: '/workdata' }
 *   },
 *   tasks: {
 *     analyze: {
 *       provides: ['analysis'],
 *       config: { 'config-template': 'PYTHON_TOOL', 'cmd-args': 'analyze.py' }
 *     }
 *   }
 * };
 * const resolved = resolveConfigTemplates(config);
 * // analyze.config → { cmd: 'python', timeout: 30000, cwd: '/workdata', 'cmd-args': 'analyze.py' }
 * ```
 */

/** Shape of a config-templates block */
export type ConfigTemplates = Record<string, Record<string, unknown>>;

/**
 * Deep-merge template into task config.
 * Task-level values override template values.
 * Nested objects are merged one level deep (like SwarmX's pattern).
 */
function mergeConfigs(
  template: Record<string, unknown>,
  taskConfig: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...template };

  for (const [key, value] of Object.entries(taskConfig)) {
    if (key === 'config-template') continue; // strip the reference

    // One-level deep merge for nested objects (both sides must be plain objects)
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] !== null &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = {
        ...(merged[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

/**
 * Resolve `config-template` references in task configs against a `configTemplates` map.
 *
 * Accepts any config object that may contain:
 *   - `configTemplates` (camelCase) or `config-templates` (kebab-case) at the top level
 *   - `tasks` (event-graph) or `steps` (step-machine) containing task/step objects
 *   - Each task/step may have a `config` sub-object with a `config-template` key
 *
 * Returns a new config with templates merged and references removed.
 * The `configTemplates` / `config-templates` key is also removed from the output.
 */
export function resolveConfigTemplates<T extends Record<string, unknown>>(config: T): T {
  // Find templates — support both naming conventions
  const templates: ConfigTemplates =
    (config['configTemplates'] as ConfigTemplates) ??
    (config['config-templates'] as ConfigTemplates) ??
    {};

  // Find the tasks/steps container
  const tasksKey = 'tasks' in config ? 'tasks' : 'steps' in config ? 'steps' : null;
  if (!tasksKey) return config; // nothing to resolve

  const tasks = config[tasksKey] as Record<string, Record<string, unknown>> | undefined;
  if (!tasks || typeof tasks !== 'object') return config;

  const resolvedTasks: Record<string, Record<string, unknown>> = {};

  for (const [name, task] of Object.entries(tasks)) {
    const taskConfig = task['config'] as Record<string, unknown> | undefined;
    const templateName = taskConfig?.['config-template'] as string | undefined;

    if (!templateName || !taskConfig) {
      resolvedTasks[name] = task;
      continue;
    }

    const template = templates[templateName];
    if (!template) {
      // Template not found — leave as-is but strip the reference
      const { 'config-template': _, ...rest } = taskConfig;
      resolvedTasks[name] = { ...task, config: rest };
      continue;
    }

    resolvedTasks[name] = {
      ...task,
      config: mergeConfigs(template, taskConfig),
    };
  }

  // Build result — remove the templates key from output
  const result = { ...config, [tasksKey]: resolvedTasks };
  delete result['configTemplates'];
  delete result['config-templates'];
  return result as T;
}
