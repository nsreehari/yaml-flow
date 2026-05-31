import type { JSONStorage } from './storage-interface.js';
import type { AsyncKVStoreOps, Awaitable, SyncKVStoreOps } from './board-live-cards-shared-stores.js';

interface StructuralAsyncJSONStorage {
  read(key: string): Promise<unknown | null>;
  get(key: string, jsonPath: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  shallowMerge(key: string, patch: Record<string, unknown>): Promise<void>;
  deepMerge(key: string, patch: Record<string, unknown>): Promise<void>;
  patch(key: string, jsonPath: string, value: unknown): Promise<void>;
}

function isPromiseLike<T>(value: Awaitable<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as Promise<T>).then === 'function';
}

function chain<T, U>(value: Awaitable<T>, next: (resolved: T) => Awaitable<U>): Awaitable<U> {
  return isPromiseLike(value) ? value.then(next) : next(value);
}

export function deepMergeObjects(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v)
      && result[k] !== null && typeof result[k] === 'object' && !Array.isArray(result[k])
    ) {
      result[k] = deepMergeObjects(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function applyJsonPath(
  obj: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  if (segments.length === 0) return obj;
  const [head, ...tail] = segments;
  if (tail.length === 0) return { ...obj, [head]: value };
  const nested =
    obj[head] !== null && typeof obj[head] === 'object' && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: applyJsonPath(nested, tail, value) };
}

export function createJsonStorageFromKV(kv: SyncKVStoreOps): JSONStorage;
export function createJsonStorageFromKV(kv: AsyncKVStoreOps): StructuralAsyncJSONStorage;
export function createJsonStorageFromKV(kv: SyncKVStoreOps | AsyncKVStoreOps): JSONStorage | StructuralAsyncJSONStorage {
  const storage = {
    read: (key: string) => kv.read(key),
    get(key: string, jsonPath: string) {
      return chain(kv.read(key), (obj) => {
        if (obj === null) return null;
        let current: unknown = obj;
        for (const segment of jsonPath.split('.').filter(Boolean)) {
          if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
          current = (current as Record<string, unknown>)[segment] ?? null;
        }
        return current ?? null;
      });
    },
    write: (key: string, value: unknown) => kv.write(key, value),
    delete: (key: string) => kv.delete(key),
    listKeys: (prefix?: string) => kv.listKeys(prefix),
    shallowMerge(key: string, patch: Record<string, unknown>) {
      return chain(kv.read(key), (existing) => kv.write(key, { ...((existing as Record<string, unknown> | null) ?? {}), ...patch }));
    },
    deepMerge(key: string, patch: Record<string, unknown>) {
      return chain(kv.read(key), (existing) => kv.write(key, deepMergeObjects(((existing as Record<string, unknown> | null) ?? {}), patch)));
    },
    patch(key: string, jsonPath: string, value: unknown) {
      return chain(kv.read(key), (existing) => {
        const segments = jsonPath.split('.').filter(Boolean);
        return kv.write(key, applyJsonPath(((existing as Record<string, unknown> | null) ?? {}), segments, value));
      });
    },
  };
  return storage as JSONStorage | StructuralAsyncJSONStorage;
}