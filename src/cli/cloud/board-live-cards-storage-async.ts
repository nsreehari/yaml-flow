import type {
  AsyncBlobStorage,
  AsyncJSONStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncStorageProvider,
} from './storage-async-interface.js';
import type {
  CardChecksumIndex,
  CardIndex,
  CardUpsertValidation,
  LiveCard,
  StateSnapshotReadView,
} from '../common/board-live-cards-lib.js';
import { applyJsonPath, createJsonStorageFromKV } from '../common/board-live-cards-shared-json.js';
import { createStateSnapshotAdapterFromKV } from '../common/board-live-cards-shared-snapshot-journal.js';

export interface AsyncCardStorageAdapter {
  readIndex(): Promise<CardIndex | null>;
  writeIndex(index: CardIndex): Promise<void>;
  readCard(key: string): Promise<LiveCard | null>;
  writeCard(key: string, card: LiveCard): Promise<string>;
  removeCard(key: string): Promise<void>;
  cardExists(key: string): Promise<boolean>;
  defaultCardKey(cardId: string): string;
}

export interface AsyncCardStore {
  readCard(id: string): Promise<LiveCard | null>;
  readCardKey(id: string): Promise<string | null>;
  readAllCards(): Promise<LiveCard[]>;
  readChecksumIndex(): Promise<CardChecksumIndex>;
  changedSince(snapshotChecksumIndex: CardChecksumIndex): Promise<string[]>;
}

export interface AsyncCardAdminStore extends AsyncCardStore {
  validateUpsert(id: string, cardKey: string): Promise<CardUpsertValidation>;
  writeCard(id: string, card: LiveCard, cardKey?: string): Promise<void>;
  patchCard(id: string, jsonPath: string, value: unknown): Promise<void>;
  removeCard(id: string): Promise<void>;
  readIndex(): Promise<CardIndex>;
}

export interface AsyncStateSnapshotStorageAdapter {
  readValues(scopeId: string): Promise<StateSnapshotReadView>;
  writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): Promise<string>;
}

export function createAsyncJsonStorage(kv: AsyncKVStorage): AsyncJSONStorage {
  return createJsonStorageFromKV(kv) as AsyncJSONStorage;
}

export function createAsyncCardStorageAdapter(
  json: AsyncJSONStorage,
  computeHash: (v: unknown) => string,
): AsyncCardStorageAdapter {
  return {
    async readIndex(): Promise<CardIndex | null> {
      return await json.read('_index') as CardIndex | null;
    },
    writeIndex(index: CardIndex): Promise<void> {
      return json.write('_index', index);
    },
    async readCard(id: string): Promise<LiveCard | null> {
      return await json.read(id) as LiveCard | null;
    },
    async writeCard(id: string, card: LiveCard): Promise<string> {
      await json.write(id, card);
      return computeHash(card);
    },
    removeCard(id: string): Promise<void> {
      return json.delete(id);
    },
    async cardExists(id: string): Promise<boolean> {
      return await json.read(id) !== null;
    },
    defaultCardKey(cardId: string): string {
      return cardId;
    },
  };
}

export function createAsyncCardStore(
  adapter: AsyncCardStorageAdapter,
  onWarn?: (msg: string) => void,
): AsyncCardAdminStore {
  async function loadIndex(): Promise<CardIndex> {
    return await adapter.readIndex() ?? {};
  }

  return {
    async readCard(id: string): Promise<LiveCard | null> {
      const entry = (await loadIndex())[id];
      if (!entry || !await adapter.cardExists(entry.key)) return null;
      return await adapter.readCard(entry.key);
    },

    async readCardKey(id: string): Promise<string | null> {
      return (await loadIndex())[id]?.key ?? null;
    },

    async readAllCards(): Promise<LiveCard[]> {
      const cards: LiveCard[] = [];
      for (const [id, entry] of Object.entries(await loadIndex())) {
        if (!await adapter.cardExists(entry.key)) continue;
        const card = await adapter.readCard(entry.key);
        if (card) cards.push(card);
        else onWarn?.(`[card-store] could not read card "${id}" at key "${entry.key}"`);
      }
      return cards;
    },

    async readChecksumIndex(): Promise<CardChecksumIndex> {
      const result: CardChecksumIndex = {};
      for (const [id, entry] of Object.entries(await loadIndex())) result[id] = entry.checksum;
      return result;
    },

    async changedSince(snapshotChecksumIndex: CardChecksumIndex): Promise<string[]> {
      const localIndex = await loadIndex();
      const changed: string[] = [];
      for (const [id, entry] of Object.entries(localIndex)) {
        if (snapshotChecksumIndex[id] !== entry.checksum) changed.push(id);
      }
      for (const id of Object.keys(snapshotChecksumIndex)) {
        if (!localIndex[id]) changed.push(id);
      }
      return changed;
    },

    async validateUpsert(id: string, cardKey: string): Promise<CardUpsertValidation> {
      const index = await loadIndex();
      const existingById = index[id];
      const existingByKey = Object.entries(index).find(([, entry]) => entry.key === cardKey);
      if (existingById && existingById.key !== cardKey) {
        return { ok: false, error: `Card id "${id}" is already mapped to key "${existingById.key}", cannot remap to "${cardKey}"` };
      }
      if (existingByKey && existingByKey[0] !== id) {
        return { ok: false, error: `Key "${cardKey}" is already mapped to card id "${existingByKey[0]}", cannot remap to "${id}"` };
      }
      return { ok: true };
    },

    async writeCard(id: string, card: LiveCard, cardKey?: string): Promise<void> {
      const index = await loadIndex();
      const resolvedKey = cardKey ?? index[id]?.key ?? adapter.defaultCardKey(id);
      const checksum = await adapter.writeCard(resolvedKey, card);
      index[id] = { key: resolvedKey, checksum, updatedAt: new Date().toISOString() };
      await adapter.writeIndex(index);
    },

    async patchCard(id: string, jsonPath: string, value: unknown): Promise<void> {
      const index = await loadIndex();
      const entry = index[id];
      if (!entry || !await adapter.cardExists(entry.key)) {
        throw new Error(`card "${id}" not found`);
      }
      const current = await adapter.readCard(entry.key);
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`card "${id}" is not patchable`);
      }
      const segments = String(jsonPath || '').split('.').filter(Boolean);
      const next = applyJsonPath(current as Record<string, unknown>, segments, value) as LiveCard;
      const checksum = await adapter.writeCard(entry.key, next);
      index[id] = { key: entry.key, checksum, updatedAt: new Date().toISOString() };
      await adapter.writeIndex(index);
    },

    async removeCard(id: string): Promise<void> {
      const index = await loadIndex();
      const entry = index[id];
      if (!entry) return;
      await adapter.removeCard(entry.key);
      delete index[id];
      await adapter.writeIndex(index);
    },

    readIndex(): Promise<CardIndex> {
      return loadIndex();
    },
  };
}

export function createAsyncStateSnapshotAdapter(
  kvFactory: (scopeId: string) => AsyncKVStorage,
  computeHash: (v: unknown) => string,
): AsyncStateSnapshotStorageAdapter {
  return createStateSnapshotAdapterFromKV(kvFactory, computeHash) as AsyncStateSnapshotStorageAdapter;
}

export function createAsyncStorageProvider(
  blob: AsyncBlobStorage,
  kv: AsyncKVStorage,
  journal: AsyncJournalStorage,
): AsyncStorageProvider {
  return { blob, kv, journal };
}