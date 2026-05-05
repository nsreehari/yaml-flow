/**
 * board-live-cards-browser-adapter.ts
 *
 * Browser implementation of BoardPlatformAdapter.
 * Uses localStorage for all persistence.
 *
 * Constraints vs Node/FS adapter:
 *   - lock: in-memory no-op (browser is single-threaded; no cross-tab locking)
 *   - dispatchExecution: supports 'http:post' and 'http:get' only
 *   - requestProcessAccumulated: not applicable (caller drives via polling / setInterval)
 *   - selfRef: 'built-in' kind — no spawnable CLI available
 */

import type { KindValueRef, AtomicRelayLock } from '../common/storage-interface.js';
import { serializeRef, parseRef } from '../common/storage-interface.js';
import type { BoardPlatformAdapter } from '../common/board-live-cards-public.js';
import {
  createLocalStorageBlobStorage,
  createLocalStorageKvStorage,
  createLocalStorageJournalStorageAdapter,
  computeStableJsonHashBrowser,
} from './storage-localstorage-adapters.js';

// ============================================================================
// In-memory no-op AtomicRelayLock
// Browser is single-threaded; no concurrent actors within one tab.
// ============================================================================

function createInMemoryRelayLock(): AtomicRelayLock {
  let held = false;
  return {
    tryAcquire(): (() => void) | null {
      if (held) return null;
      held = true;
      return () => { held = false; };
    },
  };
}

// ============================================================================
// createBrowserBoardPlatformAdapter
//
// namespace — logical name for this board instance (e.g. 'my-board').
//   Used as the localStorage key prefix so multiple boards can coexist.
// opts.callbackBaseUrl — if set, used as selfRef.whatToRun for http callbacks.
//   e.g. 'https://my-app.example.com/api/board'
// ============================================================================

export function createBrowserBoardPlatformAdapter(
  namespace: string,
  opts?: {
    callbackBaseUrl?: string;
    onWarn?: (msg: string) => void;
  },
): BoardPlatformAdapter {
  const selfRef = opts?.callbackBaseUrl
    ? {
        meta: 'board-live-cards',
        howToRun: 'http:post' as const,
        whatToRun: opts.callbackBaseUrl,
      }
    : {
        meta: 'board-live-cards',
        howToRun: 'built-in' as const,
        whatToRun: '::built-in::board-live-cards-browser',
      };

  const lock = createInMemoryRelayLock();

  return {
    kvStorage: (ns: string) =>
      createLocalStorageKvStorage(`${namespace}:${ns}`),

    blobStorage: (ns: string) =>
      createLocalStorageBlobStorage(ns ? `${namespace}:${ns}` : namespace),

    journalAdapter: () =>
      createLocalStorageJournalStorageAdapter(`${namespace}:journal`),

    lock,

    selfRef,

    async dispatchExecution(ref, args): Promise<{ dispatched: boolean; error?: string }> {
      if (ref.howToRun === 'http:post') {
        try {
          const url = ref.whatToRun.startsWith('::')
            ? parseRef(ref.whatToRun).value
            : ref.whatToRun;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
          });
          if (!resp.ok) {
            return { dispatched: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
          }
          return { dispatched: true };
        } catch (e) {
          return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      if (ref.howToRun === 'http:get') {
        try {
          const baseUrl = ref.whatToRun.startsWith('::')
            ? parseRef(ref.whatToRun).value
            : ref.whatToRun;
          const params = new URLSearchParams(
            Object.entries(args as Record<string, unknown>)
              .filter(([, v]) => v !== undefined && v !== null)
              .map(([k, v]) => [k, String(v)]),
          );
          const url = `${baseUrl}?${params.toString()}`;
          const resp = await fetch(url);
          if (!resp.ok) {
            return { dispatched: false, error: `HTTP ${resp.status}: ${resp.statusText}` };
          }
          return { dispatched: true };
        } catch (e) {
          return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
        }
      }

      return {
        dispatched: false,
        error: `Browser adapter: only http:post and http:get dispatch are supported (got: ${ref.howToRun})`,
      };
    },

    resolveBlob(ref: KindValueRef): string {
      // In the browser, blobs are stored in localStorage under the board namespace.
      // The ref value is treated as a logical localStorage key.
      const storage = createLocalStorageBlobStorage(namespace);
      const content = storage.read(ref.value);
      if (content === null) {
        throw new Error(`resolveBlob: blob not found: ${serializeRef(ref)}`);
      }
      return content;
    },

    hashFn: computeStableJsonHashBrowser,

    genId: (): string => globalThis.crypto.randomUUID().replace(/-/g, ''),

    kvStorageForRef: (ref: string) => createLocalStorageKvStorage(parseRef(ref).value),

    // requestProcessAccumulated is intentionally absent — the browser caller
    // drives drain cycles via polling or setInterval.

    onWarn: opts?.onWarn,
  };
}
