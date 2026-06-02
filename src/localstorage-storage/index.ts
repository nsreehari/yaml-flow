import {
  parseRef,
  serializeRef,
  type JournalEntry as StorageJournalEntry,
  type KindValueRef,
} from '../cli/common/storage-interface.js';
import type {
  AsyncBoardPlatformAdapter,
} from '../cli/cloud/index.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncBlobStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncQueueStorage,
  AsyncScratchStorage,
} from '../cli/cloud/storage-async-interface.js';
import { createHostedAsyncBoardPlatformAdapter } from '../cli/cloud/index.js';
import {
  computeStableJsonHashBrowser,
  createLocalStorageArchiveFactory,
  createLocalStorageBlobStorage,
  createLocalStorageJournalStorageAdapter,
  createLocalStorageKvStorage,
  createLocalStorageScratchStorage,
} from '../cli/browser-api/storage-localstorage-adapters.js';

export interface LocalStorageBoardRefs {
  baseRef: KindValueRef;
  cardStoreRef: string;
  outputsStoreRef: string;
  scratchStoreRef: string;
  archiveStoreRef: string;
  chatStoreRef: string;
  artifactsStoreRef: string;
}

export interface LocalStorageBoardAdapterOptions {
  refs?: Partial<LocalStorageBoardRefs>;
  requestProcessAccumulated?: () => void | Promise<void>;
  publishBoardChangeNotifications?: (notifications: unknown[]) => void | Promise<void>;
}

function createInMemoryAsyncRelayLock(): AsyncAtomicRelayLock {
  let held = false;
  return {
    async tryAcquire() {
      if (held) return null;
      held = true;
      return () => {
        held = false;
      };
    },
  };
}

function createInMemoryAsyncQueueStorage(): AsyncQueueStorage {
  const queueItems = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    leaseToken?: string;
    leaseExpiresAt?: string;
    reason?: string;
    dedupKey?: string;
  }>();
  const deadQueueItems = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    reason?: string;
    dedupKey?: string;
  }>();

  return {
    async enqueue<T>(body: T) {
      const item = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        body,
        enqueuedAt: new Date().toISOString(),
        attempt: 0,
      };
      queueItems.set(item.id, item);
      return item as { id: string; body: T; enqueuedAt: string; attempt: number };
    },
    async enqueueIfAbsent<T>(body: T, dedupKey: string) {
      for (const existing of queueItems.values()) {
        if (existing.dedupKey === dedupKey) return null;
      }
      const item = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        body,
        enqueuedAt: new Date().toISOString(),
        attempt: 0,
        dedupKey,
      };
      queueItems.set(item.id, item);
      return item as { id: string; body: T; enqueuedAt: string; attempt: number };
    },
    async lease<T>(opts?: { max?: number; visibilityMs?: number }) {
      const max = Math.max(1, Math.floor(opts?.max ?? 1));
      const visibilityMs = Math.max(1, Math.floor(opts?.visibilityMs ?? 60_000));
      const now = Date.now();
      for (const item of queueItems.values()) {
        if (item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= now) {
          delete item.leaseToken;
          delete item.leaseExpiresAt;
        }
      }
      const leased = [];
      for (const item of queueItems.values()) {
        if (leased.length >= max) break;
        if (item.leaseToken) continue;
        item.attempt += 1;
        item.leaseToken = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        item.leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();
        leased.push({
          id: item.id,
          body: item.body,
          enqueuedAt: item.enqueuedAt,
          attempt: item.attempt,
          leaseToken: item.leaseToken,
          leaseExpiresAt: item.leaseExpiresAt,
        });
      }
      return leased as Array<{
        id: string;
        body: T;
        enqueuedAt: string;
        attempt: number;
        leaseToken: string;
        leaseExpiresAt: string;
      }>;
    },
    async ack(messageId, leaseToken) {
      const item = queueItems.get(messageId);
      if (!item || item.leaseToken !== leaseToken) return false;
      queueItems.delete(messageId);
      return true;
    },
    async nack(messageId, leaseToken, opts) {
      const item = queueItems.get(messageId);
      if (!item || item.leaseToken !== leaseToken) return false;
      delete item.leaseToken;
      delete item.leaseExpiresAt;
      if (opts?.dead) {
        queueItems.delete(messageId);
        deadQueueItems.set(messageId, { ...item, reason: opts.reason });
      }
      return true;
    },
    async peekActive<T>(prefix = '') {
      return Array.from(queueItems.values())
        .filter((item) => !item.leaseToken)
        .filter((item) => !prefix || item.id.startsWith(prefix))
        .map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt }));
    },
    async peekDeadLetter<T>(prefix = '') {
      return Array.from(deadQueueItems.values())
        .filter((item) => !prefix || item.id.startsWith(prefix))
        .map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason: item.reason }));
    },
  };
}

function wrapKvStorage(prefix: string): AsyncKVStorage {
  const storage = createLocalStorageKvStorage(prefix);
  return {
    async read(key) {
      return storage.read(key);
    },
    async write(key, value) {
      storage.write(key, value);
    },
    async delete(key) {
      storage.delete(key);
    },
    async listKeys(keyPrefix) {
      return storage.listKeys(keyPrefix);
    },
  };
}

function wrapBlobStorage(prefix: string): AsyncBlobStorage {
  const storage = createLocalStorageBlobStorage(prefix);
  return {
    async read(key) {
      return storage.read(key);
    },
    async write(key, content) {
      storage.write(key, content);
    },
    async exists(key) {
      return storage.exists(key);
    },
    async remove(key) {
      storage.remove(key);
    },
    async readBytes(key) {
      return storage.readBytes?.(key) ?? null;
    },
    async writeBytes(key, content) {
      await storage.writeBytes?.(key, content);
    },
    async listKeys(keyPrefix) {
      return storage.listKeys(keyPrefix);
    },
    async stat(key) {
      return storage.stat?.(key) ?? null;
    },
  };
}

function wrapScratchStorage(prefix: string): AsyncScratchStorage {
  const storage = createLocalStorageScratchStorage(prefix);
  return {
    async read(key) {
      return storage.read(key);
    },
    async write(key, content) {
      storage.write(key, content);
    },
    async exists(key) {
      return storage.exists(key);
    },
    async remove(key) {
      storage.remove(key);
    },
    async readBytes(key) {
      return storage.readBytes?.(key) ?? null;
    },
    async writeBytes(key, content) {
      await storage.writeBytes?.(key, content);
    },
    async listKeys(keyPrefix) {
      return storage.listKeys(keyPrefix);
    },
    async stat(key) {
      return storage.stat?.(key) ?? null;
    },
    async getUniqueKey(keyPrefix, suffix) {
      return storage.getUniqueKey(keyPrefix, suffix);
    },
    async create(data, keyPrefix, suffix) {
      return storage.create(data, keyPrefix, suffix);
    },
    keyRef(key) {
      return storage.keyRef(key);
    },
    config: {
      async get(key) {
        return storage.config.get(key);
      },
      async set(key, value) {
        storage.config.set(key, value);
      },
    },
  };
}

function wrapJournalStorage(prefix: string): AsyncJournalStorage {
  const storage = createLocalStorageJournalStorageAdapter(prefix);

  function toStorageJournalEntry(entry: { id: string; event: unknown }): StorageJournalEntry {
    return {
      id: entry.id,
      payload: entry.event,
    };
  }

  return {
    async append(payload) {
      const entry = {
        id: storage.generateId(),
        event: payload as any,
      };
      storage.appendEntry(entry);
      return toStorageJournalEntry(entry);
    },
    async readAll() {
      return storage.readAllEntries().map(toStorageJournalEntry);
    },
    async readAfter(cursor) {
      const allEntries = storage.readAllEntries().map(toStorageJournalEntry);
      if (!cursor) {
        return {
          entries: allEntries,
          newCursor: allEntries.length > 0 ? allEntries[allEntries.length - 1].id : null,
        };
      }
      const index = allEntries.findIndex((entry) => entry.id === cursor);
      const entries = index === -1 ? allEntries : allEntries.slice(index + 1);
      return {
        entries,
        newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
      };
    },
  };
}

function wrapArchiveFactory(prefix: string): AsyncArchiveFactory {
  const factory = createLocalStorageArchiveFactory(prefix);
  return {
    stream(name) {
      const stream = factory.stream(name);
      return {
        async append(payload) {
          return stream.append(payload);
        },
        async readAll() {
          return stream.readAll();
        },
        async readAfter(cursor) {
          return stream.readAfter(cursor);
        },
        async clear() {
          stream.clear?.();
        },
      };
    },
    blob(name) {
      const blob = factory.blob(name);
      return {
        async read(key) {
          return blob.read(key);
        },
        async write(key, content) {
          blob.write(key, content);
        },
        async exists(key) {
          return blob.exists(key);
        },
        async remove(key) {
          blob.remove(key);
        },
        async readBytes(key) {
          return blob.readBytes?.(key) ?? null;
        },
        async writeBytes(key, content) {
          await blob.writeBytes?.(key, content);
        },
        async listKeys(keyPrefix) {
          return blob.listKeys(keyPrefix);
        },
        async stat(key) {
          return blob.stat?.(key) ?? null;
        },
      };
    },
    async listStreams(keyPrefix) {
      return factory.listStreams(keyPrefix);
    },
    async listBlobs(keyPrefix) {
      return factory.listBlobs(keyPrefix);
    },
    config: {
      async get(key) {
        return factory.config.get(key);
      },
      async set(key, value) {
        factory.config.set(key, value);
      },
    },
  };
}

function localPrefix(namespace: string): string {
  return String(namespace || '').trim();
}

export function makeLocalStorageRef(path: string): KindValueRef {
  return { kind: 'local-storage', value: localPrefix(path) };
}

export function serializeLocalStorageRef(path: string): string {
  return serializeRef(makeLocalStorageRef(path));
}

export function createLocalStorageBoardRefs(boardId: string): LocalStorageBoardRefs {
  const root = `boards:${boardId}`;
  return {
    baseRef: makeLocalStorageRef(root),
    cardStoreRef: serializeLocalStorageRef(`${root}:cards`),
    outputsStoreRef: serializeLocalStorageRef(`${root}:runtime-out`),
    scratchStoreRef: serializeLocalStorageRef(`${root}:scratch`),
    archiveStoreRef: serializeLocalStorageRef(`${root}:archive`),
    chatStoreRef: serializeLocalStorageRef(`${root}:chat`),
    artifactsStoreRef: serializeLocalStorageRef(`${root}:files`),
  };
}

function requirePrefixFromRef(ref: string, fallback: string): string {
  try {
    const parsed = parseRef(ref);
    if (parsed?.kind === 'local-storage' && parsed.value) return localPrefix(parsed.value);
  } catch {
    // fall through
  }
  return fallback;
}

export function createLocalStorageBoardAdapter(
  boardId: string,
  options: LocalStorageBoardAdapterOptions = {},
): AsyncBoardPlatformAdapter {
  const refs = createLocalStorageBoardRefs(boardId);
  const taskQueueStorage = createInMemoryAsyncQueueStorage();
  const chatQueueStorage = createInMemoryAsyncQueueStorage();
  const processAccumulatedQueueStorage = createInMemoryAsyncQueueStorage();

  return createHostedAsyncBoardPlatformAdapter({
    boardId,
    kvStorage(namespace) {
      return wrapKvStorage(`${refs.baseRef.value}:${namespace || 'root'}`);
    },
    kvStorageForRef(ref) {
      return wrapKvStorage(requirePrefixFromRef(ref, `${refs.baseRef.value}:root`));
    },
    blobStorage(namespace) {
      return wrapBlobStorage(namespace ? `${refs.baseRef.value}:${namespace}` : refs.baseRef.value);
    },
    scratchStorage() {
      return wrapScratchStorage(`${refs.baseRef.value}:scratch`);
    },
    scratchStorageForRef(ref) {
      return wrapScratchStorage(requirePrefixFromRef(ref, `${refs.baseRef.value}:scratch`));
    },
    archiveFactory() {
      return wrapArchiveFactory(`${refs.baseRef.value}:archive`);
    },
    archiveFactoryForRef(ref) {
      return wrapArchiveFactory(requirePrefixFromRef(ref, `${refs.baseRef.value}:archive`));
    },
    journalStorage() {
      return wrapJournalStorage(`${refs.baseRef.value}:journal`);
    },
    queueStorage: taskQueueStorage,
    chatAgentQueueStorage: chatQueueStorage,
    processAccumulatedQueueStorage,
    lock: createInMemoryAsyncRelayLock(),
    resolveBlob: async (ref) => {
      const parsed = ref?.kind === 'local-storage' ? ref : null;
      if (!parsed?.value) throw new Error(`Unsupported localStorage ref: ${serializeRef(ref)}`);
      const storage = createLocalStorageBlobStorage(parsed.value);
      const raw = await Promise.resolve(storage.read(''));
      if (raw === null) throw new Error(`Blob not found: ${serializeRef(ref)}`);
      // If bytes were written via writeBytes, the underlying value is a
      // base64 envelope; decode it back to a UTF-8 string so callers see
      // the original text content rather than the envelope JSON.
      try {
        const parsedEnvelope = JSON.parse(raw) as { __kind?: string; data?: string };
        if (parsedEnvelope?.__kind === 'bytes-b64' && typeof parsedEnvelope.data === 'string') {
          const bytes = await Promise.resolve(storage.readBytes?.(''));
          if (bytes) return new TextDecoder().decode(bytes);
        }
      } catch {
        // Not an envelope; fall through and return raw text.
      }
      return raw;
    },
    hashFn: computeStableJsonHashBrowser,
    genId: () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`).replace(/-/g, ''),
    requestProcessAccumulated: options.requestProcessAccumulated,
    publishBoardChangeNotifications: options.publishBoardChangeNotifications,
    onWarn: (msg) => console.warn(`[localstorage-board-adapter:${boardId}] ${msg}`),
  });
}

export function createLocalStorageBoardRuntimeBundle(
  boardId: string,
  options: LocalStorageBoardAdapterOptions = {},
) {
  const refs = {
    ...createLocalStorageBoardRefs(boardId),
    ...(options.refs ?? {}),
  };
  return {
    refs,
    boardAdapter: createLocalStorageBoardAdapter(boardId, options),
  };
}
