/**
 * server-runtime/internal-helpers.ts
 *
 * Small, pure helpers shared across the server-runtime slices. No closure
 * state, no I/O. Anything that depends on runtime state belongs in a slice
 * module, not here.
 */

import { parseRef } from '../cli/common/storage-interface.js';
import type { AsyncBoardPlatformAdapter } from '../cli/cloud/board-platform-adapter-async.js';
import type { BoardRuntimePlatformAdapter, ExecutionRef } from './types.js';

export function isAsyncBoardPlatformAdapter(
  adapter: BoardRuntimePlatformAdapter,
): adapter is AsyncBoardPlatformAdapter {
  return typeof (adapter as AsyncBoardPlatformAdapter).journalStorage === 'function';
}

export function executionWhatToRunValue(ref: ExecutionRef): string {
  if (typeof ref.whatToRun === 'string') {
    return ref.whatToRun.startsWith('b64:') ? parseRef(ref.whatToRun).value : ref.whatToRun;
  }
  return ref.whatToRun.value;
}

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}
