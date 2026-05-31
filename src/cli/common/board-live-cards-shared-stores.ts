import type { KindValueRef } from './storage-interface.js';

export type Awaitable<T> = T | Promise<T>;

export interface SyncKVStoreOps {
  read(key: string): unknown | null;
  write(key: string, value: unknown): void;
  delete(key: string): void;
  listKeys(prefix?: string): string[];
}

export interface AsyncKVStoreOps {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

export interface SyncBlobStoreOps {
  read(key: string): string | null;
  write(key: string, content: string): void;
  exists(key: string): boolean;
  remove(key: string): void;
  listKeys(prefix?: string): string[];
}

export interface AsyncBlobStoreOps {
  read(key: string): Promise<string | null>;
  write(key: string, content: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

function isPromiseLike<T>(value: Awaitable<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as Promise<T>).then === 'function';
}

function chain<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return isPromiseLike(value) ? value.then(next) : next(value);
}

function runSequentially<T>(items: T[], step: (item: T) => Awaitable<void>): Awaitable<void> {
  let pending: Promise<void> | null = null;
  for (const item of items) {
    if (pending) {
      pending = pending.then(() => step(item)).then(() => undefined);
      continue;
    }
    const result = step(item);
    if (isPromiseLike(result)) pending = Promise.resolve(result).then(() => undefined);
  }
  return pending ?? undefined;
}

function readStoredSourceData(raw: string | null): unknown {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function normalizeOutputRecordKey(key: string, pattern: RegExp): string | null {
  const match = key.match(pattern);
  return match ? match[1] : null;
}

function readMappedRecord(
  keys: string[],
  readValue: (key: string) => Awaitable<unknown | null>,
  toResultKey: (key: string) => string | null,
): Awaitable<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const result = runSequentially(keys, (key) => {
    const resultKey = toResultKey(key);
    if (!resultKey) return;
    return chain(readValue(key), (value) => {
      out[resultKey] = value;
    });
  });
  return isPromiseLike(result) ? result.then(() => out) : out;
}

export function createFetchedSourcesStoreFromBacking(
  blob: SyncBlobStoreOps,
  resolveRef: (ref: KindValueRef) => string,
): {
  readSourceData(cardId: string, outputFile: string): unknown;
  ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string): void;
  commitSourceData(cardId: string, outputFile: string, deliveryToken: string): boolean;
  hasSource(cardId: string, outputFile: string): boolean;
  listSources(cardId: string): string[];
};
export function createFetchedSourcesStoreFromBacking(
  blob: AsyncBlobStoreOps,
  resolveRef: (ref: KindValueRef) => Promise<string>,
): {
  readSourceData(cardId: string, outputFile: string): Promise<unknown>;
  ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string): Promise<void>;
  commitSourceData(cardId: string, outputFile: string, deliveryToken: string): Promise<boolean>;
  hasSource(cardId: string, outputFile: string): Promise<boolean>;
  listSources(cardId: string): Promise<string[]>;
};
export function createFetchedSourcesStoreFromBacking(
  blob: SyncBlobStoreOps | AsyncBlobStoreOps,
  resolveRef: (ref: KindValueRef) => Awaitable<string>,
) {
  return {
    readSourceData(cardId: string, outputFile: string) {
      return chain(blob.read(`${cardId}/${outputFile}`), readStoredSourceData);
    },
    ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string) {
      return chain(resolveRef(ref), (content) => blob.write(`${cardId}/.staged/${deliveryToken}/${outputFile}`, content));
    },
    commitSourceData(cardId: string, outputFile: string, deliveryToken: string) {
      const stagedKey = `${cardId}/.staged/${deliveryToken}/${outputFile}`;
      return chain(blob.read(stagedKey), (content) => {
        if (content == null) return false;
        return chain(blob.write(`${cardId}/${outputFile}`, content), () => chain(blob.remove(stagedKey), () => true));
      });
    },
    hasSource(cardId: string, outputFile: string) {
      return blob.exists(`${cardId}/${outputFile}`);
    },
    listSources(cardId: string) {
      return chain(blob.listKeys(`${cardId}/`), (keys) => (
        keys
          .filter((key) => !key.includes('/.staged/'))
          .map((key) => key.slice(`${cardId}/`.length))
      ));
    },
  };
}

export function createExecutionRequestStoreFromBacking<TEntry>(
  kv: SyncKVStoreOps,
  onDispatchFailed: (entry: TEntry, error: string) => void,
): {
  appendEntries(journalId: string, entries: TEntry[]): void;
  dispatchEntriesForJournalId(journalId: string, processorFn: (entry: TEntry) => void): void;
};
export function createExecutionRequestStoreFromBacking<TEntry>(
  kv: AsyncKVStoreOps,
  onDispatchFailed: (entry: TEntry, error: string) => Promise<void>,
): {
  appendEntries(journalId: string, entries: TEntry[]): Promise<void>;
  dispatchEntriesForJournalId(journalId: string, processorFn: (entry: TEntry) => Promise<void>): Promise<void>;
};
export function createExecutionRequestStoreFromBacking<TEntry>(
  kv: SyncKVStoreOps | AsyncKVStoreOps,
  onDispatchFailed: (entry: TEntry, error: string) => Awaitable<void>,
) {
  const handleEntry = (entry: TEntry, processorFn: (entry: TEntry) => Awaitable<void>): Awaitable<void> => {
    try {
      const result = processorFn(entry);
      if (!isPromiseLike(result)) return;
      return result.catch((error) => onDispatchFailed(entry, error instanceof Error ? error.message : String(error)));
    } catch (error) {
      try { return onDispatchFailed(entry, error instanceof Error ? error.message : String(error)); } catch { return; }
    }
  };

  return {
    appendEntries(journalId: string, entries: TEntry[]) {
      if (!journalId || entries.length === 0) return;
      return chain(kv.read(journalId), (existing) => kv.write(journalId, [...((existing as TEntry[] | null) ?? []), ...entries]));
    },
    dispatchEntriesForJournalId(journalId: string, processorFn: (entry: TEntry) => Awaitable<void>) {
      if (!journalId) return;
      return chain(kv.read(journalId), (entries) => {
        const pendingEntries = entries as TEntry[] | null;
        if (!pendingEntries || pendingEntries.length === 0) return;
        return chain(runSequentially(pendingEntries, (entry) => handleEntry(entry, processorFn)), () => kv.delete(journalId));
      });
    },
  };
}

export function createCardRuntimeStoreFromBacking<TState>(
  kv: SyncKVStoreOps,
  keyForId: (id: string) => string,
  defaultState: () => TState,
): {
  readRuntime(cardId: string): TState;
  writeRuntime(cardId: string, state: TState): void;
};
export function createCardRuntimeStoreFromBacking<TState>(
  kv: AsyncKVStoreOps,
  keyForId: (id: string) => string,
  defaultState: () => TState,
): {
  readRuntime(cardId: string): Promise<TState>;
  writeRuntime(cardId: string, state: TState): Promise<void>;
};
export function createCardRuntimeStoreFromBacking<TState>(
  kv: SyncKVStoreOps | AsyncKVStoreOps,
  keyForId: (id: string) => string,
  defaultState: () => TState,
) {
  return {
    readRuntime(cardId: string) {
      return chain(kv.read(keyForId(cardId)), (state) => (state as TState | null) ?? defaultState());
    },
    writeRuntime(cardId: string, state: TState) {
      return kv.write(keyForId(cardId), state);
    },
  };
}

export function createPublishedOutputsStoreFromBacking(
  kv: SyncKVStoreOps,
): {
  writeComputedValues(cardId: string, values: Record<string, unknown>): void;
  readComputedValues(cardId: string): unknown | null;
  readAllComputedValues(): Record<string, unknown>;
  writeDataObjects(data: Record<string, unknown>): void;
  readDataObject(key: string): unknown | null;
  readAllDataObjects(): Record<string, unknown>;
  writeStatusSnapshot(status: unknown): void;
  readStatusSnapshot(): unknown | null;
};
export function createPublishedOutputsStoreFromBacking(
  kv: AsyncKVStoreOps,
): {
  writeComputedValues(cardId: string, values: Record<string, unknown>): Promise<void>;
  readComputedValues(cardId: string): Promise<unknown | null>;
  readAllComputedValues(): Promise<Record<string, unknown>>;
  writeDataObjects(data: Record<string, unknown>): Promise<void>;
  readDataObject(key: string): Promise<unknown | null>;
  readAllDataObjects(): Promise<Record<string, unknown>>;
  writeStatusSnapshot(status: unknown): Promise<void>;
  readStatusSnapshot(): Promise<unknown | null>;
};
export function createPublishedOutputsStoreFromBacking(kv: SyncKVStoreOps | AsyncKVStoreOps) {
  return {
    writeComputedValues(cardId: string, values: Record<string, unknown>) {
      return kv.write(`cards/${cardId}/computed_values`, values);
    },
    readComputedValues(cardId: string) {
      return kv.read(`cards/${cardId}/computed_values`);
    },
    readAllComputedValues() {
      return chain(kv.listKeys('cards/'), (keys) => readMappedRecord(
        keys,
        (key) => kv.read(key),
        (key) => normalizeOutputRecordKey(key, /^cards\/([^/]+)\/computed_values$/),
      ));
    },
    writeDataObjects(data: Record<string, unknown>) {
      return runSequentially(Object.entries(data), ([token, payload]) => {
        if (!token) return;
        return kv.write(`data-objects/${token}`, payload);
      });
    },
    readDataObject(key: string) {
      return kv.read(`data-objects/${key}`);
    },
    readAllDataObjects() {
      return chain(kv.listKeys('data-objects/'), (keys) => readMappedRecord(
        keys,
        (key) => kv.read(key),
        (key) => key.slice('data-objects/'.length),
      ));
    },
    writeStatusSnapshot(status: unknown) {
      return kv.write('status', status);
    },
    readStatusSnapshot() {
      return kv.read('status');
    },
  };
}