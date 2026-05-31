import type {
  BlobStat,
  JournalEntry,
  JournalReadResult,
  KindValueRef,
  QueueDeadLetterMessage,
  QueueLeasedMessage,
  QueueMessage,
} from '../common/storage-interface.js';

export interface AsyncBlobStorage {
  read(key: string): Promise<string | null>;
  write(key: string, content: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  readBytes?(key: string): Promise<Uint8Array | null>;
  writeBytes?(key: string, content: Uint8Array): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  stat?(key: string): Promise<BlobStat | null>;
  keyRef?(key: string): Promise<KindValueRef> | KindValueRef;
}

export interface AsyncJournalStorage {
  append(payload: unknown): Promise<JournalEntry>;
  readAll(): Promise<JournalEntry[]>;
  readAfter(cursor: string | null): Promise<JournalReadResult>;
  clear?(): Promise<void>;
}

export interface AsyncQueueStorage {
  enqueue<T>(body: T): Promise<QueueMessage<T>>;
  /** See QueueStorage.enqueueIfAbsent. Optional on adapters that cannot cheaply dedup. */
  enqueueIfAbsent?<T>(body: T, dedupKey: string): Promise<QueueMessage<T> | null>;
  lease<T>(opts?: { max?: number; visibilityMs?: number }): Promise<QueueLeasedMessage<T>[]>;
  ack(messageId: string, leaseToken: string): Promise<boolean>;
  nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): Promise<boolean>;
  peekActive<T>(prefix?: string): Promise<QueueMessage<T>[]>;
  peekDeadLetter<T>(prefix?: string): Promise<QueueDeadLetterMessage<T>[]>;
}

export interface AsyncKVStorage {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
}

export interface AsyncJSONStorage {
  read(key: string): Promise<unknown | null>;
  get(key: string, jsonPath: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  listKeys(prefix?: string): Promise<string[]>;
  shallowMerge(key: string, patch: Record<string, unknown>): Promise<void>;
  deepMerge(key: string, patch: Record<string, unknown>): Promise<void>;
  patch(key: string, jsonPath: string, value: unknown): Promise<void>;
}

export interface AsyncScratchStorage extends AsyncBlobStorage {
  getUniqueKey(prefix?: string, suffix?: string): Promise<string>;
  create(data: string, prefix?: string, suffix?: string): Promise<string>;
  keyRef(key: string): Promise<KindValueRef> | KindValueRef;
  config: {
    get(k: string): Promise<unknown> | unknown;
    set(k: string, v: unknown): Promise<void> | void;
  };
}

export interface AsyncArchiveFactory {
  stream(name: string): AsyncJournalStorage;
  blob(name: string): AsyncBlobStorage;
  listStreams(prefix?: string): Promise<string[]>;
  listBlobs(prefix?: string): Promise<string[]>;
  config: {
    get(k: string): Promise<unknown> | unknown;
    set(k: string, v: unknown): Promise<void> | void;
  };
}

export interface AsyncStorageProvider {
  blob: AsyncBlobStorage;
  journal: AsyncJournalStorage;
  kv: AsyncKVStorage;
}

export interface AsyncAtomicRelayLock {
  tryAcquire(): Promise<(() => Promise<void> | void) | null>;
}

export async function withAsyncRelayLock(
  lock: AsyncAtomicRelayLock,
  work: () => Promise<void>,
  continuation?: () => Promise<void> | void,
): Promise<boolean> {
  const release = await lock.tryAcquire();
  if (!release) return false;
  try {
    await work();
  } finally {
    await release();
  }
  await continuation?.();
  return true;
}