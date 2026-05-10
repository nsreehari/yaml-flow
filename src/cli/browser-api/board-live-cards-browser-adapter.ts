/**
 * board-live-cards-browser-adapter.ts
 *
 * Browser implementation of BoardPlatformAdapter.
 * Uses localStorage for all persistence.
 *
 * Constraints vs Node/FS adapter:
 *   - lock: in-memory no-op (browser is single-threaded; no cross-tab locking)
 *   - dispatchExecution: supports 'in-browser', 'http:post' and 'http:get'
 *   - requestProcessAccumulated: not applicable (caller drives via polling / setInterval)
 *   - selfRef: 'in-browser' kind — routes to registered in-memory handlers
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
// In-memory notification bus (keyed by channel name)
//
// Same role as named-pipe in Node.js: the adapter publishes to a channel,
// and a NotificationTransport subscribes on a matching KindValueRef.
// Kind: "in-memory-bus" — e.g. { kind: 'in-memory-bus', value: 'my-board:notify' }
// ============================================================================

interface InMemoryBus {
  publish(event: unknown): void;
  subscribe(onEvent: (event: unknown) => void): () => void;
}

const _busRegistry = new Map<string, InMemoryBus>();

export function getInMemoryNotificationBus(channel: string): InMemoryBus {
  let bus = _busRegistry.get(channel);
  if (!bus) {
    const listeners = new Set<(event: unknown) => void>();
    bus = {
      publish(event) { for (const fn of listeners) fn(event); },
      subscribe(onEvent) {
        listeners.add(onEvent);
        return () => { listeners.delete(onEvent); };
      },
    };
    _busRegistry.set(channel, bus);
  }
  return bus;
}

/**
 * In-memory NotificationTransport for the browser.
 * Subscribes to the same in-memory bus that the adapter publishes to.
 * Use with notifyRef: { kind: 'in-memory-bus', value: '<channel>' }
 */
export function createInMemoryNotificationTransport(): import('../../server-runtime/types.js').NotificationTransport {
  return {
    async subscribe(ref, onEvent) {
      if (ref.kind !== 'in-memory-bus') {
        console.warn(`[in-memory-transport] unsupported kind: ${ref.kind}`);
        return () => {};
      }
      const bus = getInMemoryNotificationBus(ref.value);
      return bus.subscribe((event) => {
        const e = event as { kind?: string; notifications?: unknown[] };
        if (e && e.kind === 'notification-batch' && Array.isArray(e.notifications)) {
          for (const n of e.notifications) onEvent(n);
          return;
        }
        onEvent(event);
      });
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
// opts.notifyChannel — in-memory notification channel name.
//   The adapter publishes to this channel; pair with notifyRef { kind: 'in-memory-bus', value: channel }.
// ============================================================================

import type { ExecutionRef } from '../common/execution-interface.js';

/**
 * Registry of in-browser execution handlers keyed by whatToRun value.
 * Consumers register handlers that will be invoked when the drain cycle
 * dispatches execution with howToRun === 'in-browser'.
 */
export type InBrowserHandler = (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{ dispatched: boolean; error?: string }>;

export function createBrowserBoardPlatformAdapter(
  namespace: string,
  opts?: {
    callbackBaseUrl?: string;
    notifyChannel?: string;
    onWarn?: (msg: string) => void;
  },
): BoardPlatformAdapter & {
  registerHandler(name: string, handler: InBrowserHandler): void;
  writeMemoryBlob(key: string, data: string): string;
} {
  const selfRef = opts?.callbackBaseUrl
    ? {
        meta: 'board-live-cards',
        howToRun: 'http:post' as const,
        whatToRun: opts.callbackBaseUrl,
      }
    : {
        meta: 'board-live-cards',
        howToRun: 'in-browser' as const,
        whatToRun: serializeRef({ kind: 'in-browser', value: namespace }),
      };

  // In-browser handler registry: maps whatToRun → handler function
  const handlerRegistry = new Map<string, InBrowserHandler>();

  // In-memory blob store: ephemeral key→value map for blob refs (kind: 'in-memory')
  const memoryBlobs = new Map<string, string>();

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
          const url = ref.whatToRun.startsWith('b64:')
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
          const baseUrl = ref.whatToRun.startsWith('b64:')
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

      if (ref.howToRun === 'in-browser') {
        const handler = handlerRegistry.get(ref.whatToRun);
        if (handler) return handler(ref, args);
        return { dispatched: false, error: `No in-browser handler registered for: ${ref.whatToRun}` };
      }

      return {
        dispatched: false,
        error: `Browser adapter: unsupported dispatch kind (got: ${ref.howToRun})`,
      };
    },

    resolveBlob(ref: KindValueRef): string {
      // In-memory blobs: written by task executors, ephemeral (page-lifetime)
      if (ref.kind === 'in-memory') {
        const content = memoryBlobs.get(ref.value);
        if (content === null || content === undefined) {
          throw new Error(`resolveBlob: in-memory blob not found: ${serializeRef(ref)}`);
        }
        return content;
      }
      // localStorage blobs: persistent across page reloads
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

    publishBoardChangeNotifications(notifications) {
      if (!opts?.notifyChannel || notifications.length === 0) return;
      const bus = getInMemoryNotificationBus(opts.notifyChannel);
      bus.publish({ kind: 'notification-batch', notifications });
    },

    // requestProcessAccumulated is intentionally absent — the browser caller
    // drives drain cycles via polling or setInterval.

    onWarn: opts?.onWarn,

    registerHandler(name: string, handler: InBrowserHandler) {
      handlerRegistry.set(name, handler);
    },

    writeMemoryBlob(key: string, data: string): string {
      memoryBlobs.set(key, data);
      return serializeRef({ kind: 'in-memory', value: key });
    },
  };
}
