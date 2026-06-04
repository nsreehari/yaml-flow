import type { ExecutionRef } from './execution-interface.js';
import { serializeRef } from './storage-interface.js';

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertBoardSelfRef(
  selfRef: ExecutionRef | null | undefined,
  owner: string,
): asserts selfRef is ExecutionRef {
  if (!selfRef || typeof selfRef !== 'object') {
    throw new Error(`${owner}: adapter.selfRef is required`);
  }
  if (!hasNonEmptyString(selfRef.howToRun)) {
    throw new Error(`${owner}: adapter.selfRef.howToRun is required`);
  }
  if (!hasNonEmptyString(selfRef.whatToRun)) {
    throw new Error(`${owner}: adapter.selfRef.whatToRun is required`);
  }
}

export function createYamlFlowCliBoardSelfRef(notifyChannel?: string): ExecutionRef {
  return {
    meta: 'board-live-cards',
    howToRun: 'built-in',
    whatToRun: serializeRef({ kind: 'built-in', value: 'board-live-cards' }),
    ...(notifyChannel ? { extra: { notifyChannel } } : {}),
  };
}