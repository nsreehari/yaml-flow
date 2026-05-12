/**
 * Variable interpolation for workflow configs.
 *
 * Walks any object/array and replaces `${KEY}` patterns with values from
 * a variables map. Pure function — returns a new object, never mutates.
 *
 * Works on both GraphConfig and StepFlowConfig (or any plain object).
 *
 * @example
 * ```ts
 * const resolved = resolveVariables(config, {
 *   ENTITY_ID: 'ticket-42',
 *   TOOLS_DIR: '/opt/tools',
 * });
 * ```
 */
type Variables = Record<string, string | number | boolean>;
/**
 * Resolve `${KEY}` variable references in a workflow config object.
 *
 * Pure function: config in → new config out. Works on any shape
 * (GraphConfig, StepFlowConfig, or arbitrary objects).
 *
 * @param config  - The config object to interpolate
 * @param variables - Key-value pairs to substitute
 * @returns A new config with all `${KEY}` patterns replaced
 */
declare function resolveVariables<T extends Record<string, unknown>>(config: T, variables: Variables): T;

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
type ConfigTemplates = Record<string, Record<string, unknown>>;
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
declare function resolveConfigTemplates<T extends Record<string, unknown>>(config: T): T;

export { type ConfigTemplates, type Variables, resolveConfigTemplates, resolveVariables };
