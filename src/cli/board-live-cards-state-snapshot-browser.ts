/**
 * Browser (localStorage) adapter for board-live-cards snapshot store.
 *
 * Persists 5 mutable runtime state keys using browser localStorage.
 * Single-tab safe (localStorage does not support concurrent browser tabs).
 *
 * Configuration state (CardsStore, ControlStore) is NOT persisted here;
 * it is loaded from card-source-kinds.json and config at init time.
 *
 * Version hashing uses non-cryptographic deterministic hash for performance.
 * Stable stringify ensures same hash across runs with identical state.
 */

import {
  applyStateSnapshotCommitEnvelope,
  SNAPSHOT_SCHEMA_VERSION_V1,
  type StateSnapshotCommitEnvelope,
  type StateSnapshotCommitResult,
  type StateSnapshotReadView,
  type StateSnapshotStore,
} from './board-live-cards-state-snapshot-types.js';

interface BrowserSnapshotEnvelope {
  values: Record<string, unknown>;
  version: string | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface BrowserStateSnapshotStoreOptions {
  storage: StorageLike;
  keyPrefix?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hashString(value: string): string {
  // Non-cryptographic deterministic hash for browser snapshots.
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function valuesToVersion(values: Record<string, unknown>): string {
  return hashString(stableStringify(values));
}

function parseStoredEnvelope(raw: string | null): BrowserSnapshotEnvelope {
  if (!raw) return { values: {}, version: null };
  try {
    const parsed = JSON.parse(raw) as BrowserSnapshotEnvelope;
    const values = parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object'
      ? parsed.values
      : {};
    const version = parsed && typeof parsed === 'object' && typeof parsed.version === 'string'
      ? parsed.version
      : valuesToVersion(values as Record<string, unknown>);
    return {
      values: values as Record<string, unknown>,
      version,
    };
  } catch {
    return { values: {}, version: null };
  }
}

export function createBrowserStateSnapshotStore(options: BrowserStateSnapshotStoreOptions): StateSnapshotStore {
  const keyPrefix = options.keyPrefix ?? 'board-live-cards-snapshot';

  function keyForScope(scopeId: string): string {
    return `${keyPrefix}:${scopeId}`;
  }

  async function readSnapshot(scopeId: string): Promise<StateSnapshotReadView> {
    const envelope = parseStoredEnvelope(options.storage.getItem(keyForScope(scopeId)));
    return {
      version: envelope.version,
      values: { ...envelope.values },
    };
  }

  async function commitSnapshot(
    scopeId: string,
    envelope: StateSnapshotCommitEnvelope,
  ): Promise<StateSnapshotCommitResult> {
    if (envelope.schemaVersion !== SNAPSHOT_SCHEMA_VERSION_V1) {
      throw new Error(`Unsupported snapshot schema version: ${envelope.schemaVersion}`);
    }

    const storageKey = keyForScope(scopeId);
    const current = parseStoredEnvelope(options.storage.getItem(storageKey));
    if (current.version !== envelope.expectedVersion) {
      return {
        ok: false,
        reason: 'version-mismatch',
        currentVersion: current.version,
      };
    }

    const nextValues = applyStateSnapshotCommitEnvelope(current.values, {
      deleteKeys: envelope.deleteKeys,
      shallowMerge: envelope.shallowMerge,
    });
    const newVersion = valuesToVersion(nextValues);

    options.storage.setItem(
      storageKey,
      JSON.stringify({ values: nextValues, version: newVersion }),
    );

    return {
      ok: true,
      newVersion,
    };
  }

  return {
    readSnapshot,
    commitSnapshot,
  };
}
