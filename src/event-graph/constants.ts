/**
 * Event Graph — Constants
 */

import type { CompletionStrategy, ConflictStrategy, ExecutionMode, ExecutionStatus, TaskStatus } from './types.js';

export const TASK_STATUS: Record<string, TaskStatus> = {
  NOT_STARTED: 'not-started',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INACTIVATED: 'inactivated',
} as const;

export const EXECUTION_STATUS: Record<string, ExecutionStatus> = {
  CREATED: 'created',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export const COMPLETION_STRATEGIES: Record<string, CompletionStrategy> = {
  ALL_TASKS_DONE: 'all-tasks-done',
  ALL_OUTPUTS_DONE: 'all-outputs-done',
  ONLY_RESOLVED: 'only-resolved',
  GOAL_REACHED: 'goal-reached',
  MANUAL: 'manual',
} as const;

export const EXECUTION_MODES: Record<string, ExecutionMode> = {
  DEPENDENCY_MODE: 'dependency-mode',
  ELIGIBILITY_MODE: 'eligibility-mode',
} as const;

export const CONFLICT_STRATEGIES: Record<string, ConflictStrategy> = {
  ALPHABETICAL: 'alphabetical',
  PRIORITY_FIRST: 'priority-first',
  DURATION_FIRST: 'duration-first',
  COST_OPTIMIZED: 'cost-optimized',
  RESOURCE_AWARE: 'resource-aware',
  RANDOM_SELECT: 'random-select',
  USER_CHOICE: 'user-choice',
  PARALLEL_ALL: 'parallel-all',
  SKIP_CONFLICTS: 'skip-conflicts',
  ROUND_ROBIN: 'round-robin',
} as const;

export const DEFAULTS = {
  EXECUTION_MODE: 'eligibility-mode' as ExecutionMode,
  CONFLICT_STRATEGY: 'alphabetical' as ConflictStrategy,
  COMPLETION_STRATEGY: 'all-outputs-done' as CompletionStrategy,
  MAX_ITERATIONS: 1000,
} as const;
