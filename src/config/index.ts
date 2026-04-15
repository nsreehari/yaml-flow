/**
 * Config utilities — pre-processing transforms for workflow configs.
 *
 * These are pure functions you apply *before* passing config to the engine.
 * They never touch engine state — just config in → config out.
 */

export { resolveVariables } from './resolve-variables.js';
export type { Variables } from './resolve-variables.js';

export { resolveConfigTemplates } from './resolve-config-templates.js';
export type { ConfigTemplates } from './resolve-config-templates.js';
