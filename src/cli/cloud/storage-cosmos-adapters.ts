import type { JournalEntry, JournalReadResult } from '../common/storage-interface.js';
import type { AsyncAtomicRelayLock, AsyncJournalStorage, AsyncKVStorage } from './storage-async-interface.js';

type CosmosStatusResult<T> = { resource?: T; statusCode?: number };
type CosmosAccessCondition = { type: 'IfMatch'; condition: string };

export interface CosmosSqlQuerySpec {
  query: string;
  parameters?: Array<{ name: string; value: unknown }>;
}

export interface CosmosQueryIteratorLike<T> {
  fetchAll(): Promise<{ resources: T[] }>;
}

export interface CosmosItemLike<T> {
  read(): Promise<CosmosStatusResult<T>>;
  replace(body: T, options?: { accessCondition?: CosmosAccessCondition }): Promise<CosmosStatusResult<T>>;
  delete(): Promise<{ statusCode?: number }>;
}

export interface CosmosContainerLike {
  item<T = unknown>(id: string, partitionKey?: unknown): CosmosItemLike<T>;
  items: {
    upsert<T>(body: T): Promise<CosmosStatusResult<T>>;
    create<T>(body: T): Promise<CosmosStatusResult<T>>;
    query<T>(query: CosmosSqlQuerySpec): CosmosQueryIteratorLike<T>;
  };
}

type PartitionResolver = string | ((key: string) => string);

interface CosmosBaseDocument {
  id: string;
  pk: string;
  kind: string;
  _etag?: string;
}

interface CosmosKvDocument extends CosmosBaseDocument {
  kind: 'kv';
  value: unknown;
}

interface CosmosJournalDocument extends CosmosBaseDocument {
  kind: 'journal';
  streamKey: string;
  createdAt: string;
  payload: unknown;
}

interface CosmosLockDocument extends CosmosBaseDocument {
  kind: 'lock';
  held: boolean;
  holderId: string;
  expiresAt: string | null;
  updatedAt: string;
}

export interface CosmosKvStorageOptions {
  partitionKey?: PartitionResolver;
}

export interface CosmosJournalStorageOptions {
  partitionKey?: PartitionResolver;
  now?: () => Date;
  idFactory?: () => string;
}

export interface CosmosAtomicRelayLockOptions {
  partitionKey?: string;
  holderId?: string;
  ttlMs?: number;
  now?: () => Date;
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybe = error as { statusCode?: unknown; code?: unknown };
  if (typeof maybe.statusCode === 'number') return maybe.statusCode;
  if (typeof maybe.code === 'number') return maybe.code;
  return undefined;
}

function isStatus(error: unknown, expected: number): boolean {
  return getStatusCode(error) === expected;
}

function resolvePartitionKey(key: string, resolver: PartitionResolver | undefined, fallback: string): string {
  if (!resolver) return fallback;
  return typeof resolver === 'function' ? resolver(key) : resolver;
}

function nowIso(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

function createLexicalId(now: (() => Date) | undefined, idFactory?: () => string): string {
  if (idFactory) return idFactory();
  const ts = String((now?.() ?? new Date()).getTime()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

function toJournalEntry(doc: CosmosJournalDocument): JournalEntry {
  return { id: doc.id, payload: doc.payload };
}

export function createCosmosKvStorage(
  container: CosmosContainerLike,
  options: CosmosKvStorageOptions = {},
): AsyncKVStorage {
  return {
    async read(key: string): Promise<unknown | null> {
      const pk = resolvePartitionKey(key, options.partitionKey, 'kv');
      try {
        const result = await container.item<CosmosKvDocument>(key, pk).read();
        return result.resource?.value ?? null;
      } catch (error) {
        if (isStatus(error, 404)) return null;
        throw error;
      }
    },

    async write(key: string, value: unknown): Promise<void> {
      const pk = resolvePartitionKey(key, options.partitionKey, 'kv');
      await container.items.upsert<CosmosKvDocument>({ id: key, pk, kind: 'kv', value });
    },

    async delete(key: string): Promise<void> {
      const pk = resolvePartitionKey(key, options.partitionKey, 'kv');
      try {
        await container.item<CosmosKvDocument>(key, pk).delete();
      } catch (error) {
        if (!isStatus(error, 404)) throw error;
      }
    },

    async listKeys(prefix = ''): Promise<string[]> {
      const { resources } = await container.items.query<{ id: string }>({
        query: 'SELECT c.id FROM c WHERE c.kind = @kind AND STARTSWITH(c.id, @prefix)',
        parameters: [
          { name: '@kind', value: 'kv' },
          { name: '@prefix', value: prefix },
        ],
      }).fetchAll();
      return resources.map((row) => row.id).sort();
    },
  };
}

export function createCosmosJournalStorage(
  container: CosmosContainerLike,
  streamKey: string,
  options: CosmosJournalStorageOptions = {},
): AsyncJournalStorage {
  const pk = resolvePartitionKey(streamKey, options.partitionKey, `journal:${streamKey}`);

  return {
    async append(payload: unknown): Promise<JournalEntry> {
      const doc: CosmosJournalDocument = {
        id: createLexicalId(options.now, options.idFactory),
        pk,
        kind: 'journal',
        streamKey,
        createdAt: nowIso(options.now),
        payload,
      };
      await container.items.create(doc);
      return toJournalEntry(doc);
    },

    async readAll(): Promise<JournalEntry[]> {
      const { resources } = await container.items.query<CosmosJournalDocument>({
        query: 'SELECT * FROM c WHERE c.kind = @kind AND c.pk = @pk AND c.streamKey = @streamKey ORDER BY c.id',
        parameters: [
          { name: '@kind', value: 'journal' },
          { name: '@pk', value: pk },
          { name: '@streamKey', value: streamKey },
        ],
      }).fetchAll();
      return resources.sort((a, b) => a.id.localeCompare(b.id)).map(toJournalEntry);
    },

    async readAfter(cursor: string | null): Promise<JournalReadResult> {
      const { resources } = await container.items.query<CosmosJournalDocument>({
        query: cursor
          ? 'SELECT * FROM c WHERE c.kind = @kind AND c.pk = @pk AND c.streamKey = @streamKey AND c.id > @cursor ORDER BY c.id'
          : 'SELECT * FROM c WHERE c.kind = @kind AND c.pk = @pk AND c.streamKey = @streamKey ORDER BY c.id',
        parameters: [
          { name: '@kind', value: 'journal' },
          { name: '@pk', value: pk },
          { name: '@streamKey', value: streamKey },
          ...(cursor ? [{ name: '@cursor', value: cursor }] : []),
        ],
      }).fetchAll();
      const ordered = resources.sort((a, b) => a.id.localeCompare(b.id));
      return {
        entries: ordered.map(toJournalEntry),
        newCursor: ordered.length > 0 ? ordered[ordered.length - 1].id : cursor,
      };
    },

    async clear(): Promise<void> {
      const entries = await this.readAll();
      await Promise.all(entries.map((entry) => container.item<CosmosJournalDocument>(entry.id, pk).delete()));
    },
  };
}

export function createCosmosAtomicRelayLock(
  container: CosmosContainerLike,
  lockId: string,
  options: CosmosAtomicRelayLockOptions = {},
): AsyncAtomicRelayLock {
  const pk = options.partitionKey ?? 'lock';
  const holderId = options.holderId ?? `holder-${Math.random().toString(36).slice(2, 10)}`;
  const now = options.now;
  const ttlMs = options.ttlMs ?? 30_000;

  function buildHeld(): CosmosLockDocument {
    const current = now?.() ?? new Date();
    return {
      id: lockId,
      pk,
      kind: 'lock',
      held: true,
      holderId,
      expiresAt: new Date(current.getTime() + ttlMs).toISOString(),
      updatedAt: current.toISOString(),
    };
  }

  function buildReleased(existing?: CosmosLockDocument): CosmosLockDocument {
    return {
      ...(existing ?? { id: lockId, pk, kind: 'lock' as const }),
      kind: 'lock',
      held: false,
      holderId,
      expiresAt: null,
      updatedAt: nowIso(now),
    };
  }

  async function readCurrent(): Promise<CosmosLockDocument | null> {
    try {
      const result = await container.item<CosmosLockDocument>(lockId, pk).read();
      return result.resource ?? null;
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw error;
    }
  }

  function isHeld(doc: CosmosLockDocument | null): boolean {
    if (!doc?.held) return false;
    if (!doc.expiresAt) return true;
    return Date.parse(doc.expiresAt) > (now?.() ?? new Date()).getTime();
  }

  return {
    async tryAcquire(): Promise<(() => Promise<void>) | null> {
      const current = await readCurrent();
      const next = buildHeld();

      if (!current) {
        try {
          await container.items.create(next);
        } catch (error) {
          if (isStatus(error, 409)) return null;
          throw error;
        }
      } else {
        if (isHeld(current)) return null;
        try {
          await container.item<CosmosLockDocument>(lockId, pk).replace(next, current._etag
            ? { accessCondition: { type: 'IfMatch', condition: current._etag } }
            : undefined);
        } catch (error) {
          if (isStatus(error, 412) || isStatus(error, 409)) return null;
          throw error;
        }
      }

      return async () => {
        const latest = await readCurrent();
        if (!latest) return;
        const released = buildReleased(latest);
        try {
          await container.item<CosmosLockDocument>(lockId, pk).replace(released, latest._etag
            ? { accessCondition: { type: 'IfMatch', condition: latest._etag } }
            : undefined);
        } catch {
          // Best-effort release. Callers will retry on the next cycle if needed.
        }
      };
    },
  };
}