export type Awaitable<T> = T | Promise<T>;

export interface SnapshotReadViewLike {
  version: string | null;
  values: Record<string, unknown>;
}

export interface SnapshotCommitEnvelopeLike {
  schemaVersion: string;
  expectedVersion: string | null;
  deleteKeys: string[];
  shallowMerge: Record<string, unknown>;
}

export interface SnapshotCommitSuccessLike {
  ok: true;
  newVersion: string;
}

export interface SnapshotCommitVersionMismatchLike {
  ok: false;
  reason: 'version-mismatch';
  currentVersion: string | null;
}

export type SnapshotCommitResultLike = SnapshotCommitSuccessLike | SnapshotCommitVersionMismatchLike;

export interface SyncStateSnapshotAdapterLike {
  readValues(scopeId: string): SnapshotReadViewLike;
  writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string;
}

export interface AsyncStateSnapshotAdapterLike {
  readValues(scopeId: string): Promise<SnapshotReadViewLike>;
  writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): Promise<string>;
}

export interface SyncKVLike {
  read(key: string): unknown | null;
  write(key: string, value: unknown): void;
  delete(key: string): void;
  listKeys(prefix?: string): string[];
}

export interface AsyncKVLike {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

export interface JournalEventEntryLike<TEvent> {
  id: string;
  event: TEvent;
}

export interface SyncJournalEntriesAdapter<TEvent> {
  readAllEntries(): JournalEventEntryLike<TEvent>[];
  appendEntry(entry: JournalEventEntryLike<TEvent>): void;
  generateId(): string;
}

export interface AsyncJournalStorageLike<TEvent> {
  append(payload: TEvent): Promise<unknown>;
  readAfter(cursor: string | null): Promise<{ entries: Array<{ payload: unknown }>; newCursor: string | null }>;
}

function isPromiseLike<T>(value: Awaitable<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as Promise<T>).then === 'function';
}

function chain<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return isPromiseLike(value) ? value.then(next) : next(value);
}

export function applyStateSnapshotCommitEnvelope(
  current: Record<string, unknown>,
  envelope: Pick<SnapshotCommitEnvelopeLike, 'deleteKeys' | 'shallowMerge'>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const key of envelope.deleteKeys) delete next[key];
  return { ...next, ...envelope.shallowMerge };
}

export function createStateSnapshotAdapterFromKV(
  kvFactory: (scopeId: string) => SyncKVLike,
  computeHash: (value: unknown) => string,
): SyncStateSnapshotAdapterLike;
export function createStateSnapshotAdapterFromKV(
  kvFactory: (scopeId: string) => AsyncKVLike,
  computeHash: (value: unknown) => string,
): AsyncStateSnapshotAdapterLike;
export function createStateSnapshotAdapterFromKV(
  kvFactory: ((scopeId: string) => SyncKVLike) | ((scopeId: string) => AsyncKVLike),
  computeHash: (value: unknown) => string,
): SyncStateSnapshotAdapterLike | AsyncStateSnapshotAdapterLike {
  const adapter = {
    readValues(scopeId: string): Awaitable<SnapshotReadViewLike> {
      const kv = kvFactory(scopeId);
      return chain(kv.listKeys(), (keys) => {
        const sortedKeys = [...keys].sort();
        if (sortedKeys.length === 0) return { version: null, values: {} };
        const values: Record<string, unknown> = {};
        let pending: Promise<void> | null = null;
        for (const key of sortedKeys) {
          const result = kv.read(key);
          if (isPromiseLike(result)) {
            pending = (pending ?? Promise.resolve()).then(async () => {
              values[key] = await result;
            });
          } else {
            values[key] = result;
          }
        }
        return pending
          ? pending.then(() => ({ version: computeHash(values), values }))
          : { version: computeHash(values), values };
      });
    },
    writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): Awaitable<string> {
      const kv = kvFactory(scopeId);
      let pending: Promise<void> | null = null;
      for (const key of deletedKeys) {
        const result = kv.delete(key);
        if (isPromiseLike(result)) pending = (pending ?? Promise.resolve()).then(() => result).then(() => undefined);
      }
      for (const [key, value] of Object.entries(nextValues)) {
        const result = kv.write(key, value);
        if (isPromiseLike(result)) pending = (pending ?? Promise.resolve()).then(() => result).then(() => undefined);
      }
      return pending ? pending.then(() => computeHash(nextValues)) : computeHash(nextValues);
    },
  };
  return adapter as SyncStateSnapshotAdapterLike | AsyncStateSnapshotAdapterLike;
}

export function createStateSnapshotStoreFromAdapter(
  adapter: SyncStateSnapshotAdapterLike,
  schemaVersion: string,
): {
  readSnapshot(scopeId: string): SnapshotReadViewLike;
  commitSnapshot(scopeId: string, envelope: SnapshotCommitEnvelopeLike): SnapshotCommitResultLike;
};
export function createStateSnapshotStoreFromAdapter(
  adapter: AsyncStateSnapshotAdapterLike,
  schemaVersion: string,
): {
  readSnapshot(scopeId: string): Promise<SnapshotReadViewLike>;
  commitSnapshot(scopeId: string, envelope: SnapshotCommitEnvelopeLike): Promise<SnapshotCommitResultLike>;
};
export function createStateSnapshotStoreFromAdapter(
  adapter: SyncStateSnapshotAdapterLike | AsyncStateSnapshotAdapterLike,
  schemaVersion: string,
) {
  return {
    readSnapshot(scopeId: string) {
      return adapter.readValues(scopeId);
    },
    commitSnapshot(scopeId: string, envelope: SnapshotCommitEnvelopeLike) {
      if (envelope.schemaVersion !== schemaVersion) {
        throw new Error(`Unsupported snapshot schema version: ${envelope.schemaVersion}`);
      }
      return chain(adapter.readValues(scopeId), (current) => {
        if (current.version !== envelope.expectedVersion) {
          return { ok: false, reason: 'version-mismatch', currentVersion: current.version } satisfies SnapshotCommitVersionMismatchLike;
        }
        const nextValues = applyStateSnapshotCommitEnvelope(current.values, envelope);
        return chain(adapter.writeValues(scopeId, nextValues, envelope.deleteKeys), (newVersion) => ({ ok: true, newVersion } satisfies SnapshotCommitSuccessLike));
      });
    },
  };
}

export function entriesAfterCursor<TEntry extends { id: string }>(entries: TEntry[], cursor: string): TEntry[] {
  if (!cursor) return entries;
  const idx = entries.findIndex((entry) => entry.id === cursor);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

export function createJournalStoreFromEntriesAdapter<TEvent>(adapter: SyncJournalEntriesAdapter<TEvent>) {
  return {
    readEntriesAfterCursor(cursor: string): { events: TEvent[]; newCursor: string } {
      const entries = entriesAfterCursor(adapter.readAllEntries(), cursor);
      if (entries.length === 0) return { events: [], newCursor: cursor };
      return { events: entries.map((entry) => entry.event), newCursor: entries[entries.length - 1].id };
    },
    pendingCount(cursor: string): number {
      return entriesAfterCursor(adapter.readAllEntries(), cursor).length;
    },
    appendEvent(event: TEvent): void {
      adapter.appendEntry({ id: adapter.generateId(), event });
    },
  };
}

export function createAsyncJournalStoreFromStorage<TEvent>(storage: AsyncJournalStorageLike<TEvent>) {
  return {
    appendEvent(event: TEvent): Promise<void> {
      return storage.append(event).then(() => undefined);
    },
    async readEntriesAfterCursor(cursor: string): Promise<{ events: TEvent[]; newCursor: string }> {
      const result = await storage.readAfter(cursor || null);
      return {
        events: result.entries.map((entry) => entry.payload as TEvent),
        newCursor: result.newCursor ?? cursor,
      };
    },
  };
}