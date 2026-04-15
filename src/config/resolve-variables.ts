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

export type Variables = Record<string, string | number | boolean>;

/**
 * Replace `${KEY}` patterns in a string with values from the variables map.
 * Unmatched variables are left as-is.
 */
function interpolateString(template: string, vars: Variables): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    const value = vars[key.trim()];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Recursively walk a value and interpolate any `${KEY}` patterns found in strings.
 * Returns a new object/array — never mutates the input.
 */
function walkAndInterpolate<T>(value: T, vars: Variables): T {
  if (typeof value === 'string') {
    return interpolateString(value, vars) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walkAndInterpolate(item, vars)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = walkAndInterpolate(v, vars);
    }
    return result as T;
  }
  // numbers, booleans, null, undefined — pass through
  return value;
}

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
export function resolveVariables<T extends Record<string, unknown>>(
  config: T,
  variables: Variables,
): T {
  return walkAndInterpolate(config, variables);
}
