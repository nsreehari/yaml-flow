/**
 * storage-interface.ts
 *
 * Three minimal storage primitives that together cover all persistence needs
 * of the board-live-cards system. Any backend (Node fs, CosmosDB, Azure Blob,
 * browser localStorage, in-memory test double) implements these three interfaces.
 *
 * The pure-logic stores in board-live-cards-all-stores.ts depend only on these
 * interfaces — never on Node built-ins.
 *
 *  Blob    — raw string content at a logical, backend-neutral key
 *  Journal — append-only log with cursor-based reads
 *  KV      — key-value store with list/delete
 *
 * Mapping to existing storage adapters:
 *
 *   CardStorageAdapter
 *     inventory (cardId → { blobRef, checksum, fileMetadata? })  → KV
 *     card JSON files                                             → Blob
 *     source output files                                         → Blob
 *
 *   JournalStorageAdapter     → Journal (board-journal.jsonl)
 *
 *   ExecutionRequestStorageAdapter → KV (keyed by journalId)
 *
 *   StateSnapshotStorageAdapter
 *     board-graph.json (packed single JSON, written atomically)   → Blob
 *     per-card sidecars (cards/<id>/runtime, fetched-sources-manifest) → KV
 */

// ============================================================================
// Blob — raw content at an opaque key
//
// The key is backend-specific (file path, blob name, storage key).
// Content is always a string — callers own JSON serialisation.
// ============================================================================

export interface BlobStorage {
  /** Returns raw content string, or null if the blob does not exist. */
  read(key: string): string | null;

  /** Write content at key. Implementations should be atomic (write-rename). */
  write(key: string, content: string): void;

  /** Returns true if a blob exists at key. */
  exists(key: string): boolean;

  /** Delete the blob at key. No-op if it does not exist. */
  remove(key: string): void;
}

// ============================================================================
// KindValueRef — backend-neutral typed reference
//
// A ref describes WHERE content lives without carrying the bytes.
// Serialized on the CLI wire as: ::kind::value
//   kind = 'fs-path': value is an absolute file path
//   kind = 'inline':  value is the content string itself
//   kind = 'kv':      value is a KVStorage key
// Other kinds can be added by new backends without changing pure-logic code.
// ============================================================================

export interface KindValueRef {
  readonly kind: string;
  readonly value: string;
}

/** Serialize a KindValueRef to the wire format: ::kind::value */
export function serializeRef(ref: KindValueRef): string {
  return `::${ref.kind}::${ref.value}`;
}

/** Parse a wire-format ref string (::kind::value) into a KindValueRef. */
export function parseRef(s: string): KindValueRef {
  if (!s.startsWith('::')) throw new Error(`Invalid ref format (expected ::kind::value): ${s}`);
  const inner = s.slice(2);
  const idx = inner.indexOf('::');
  if (idx === -1) throw new Error(`Invalid ref format (expected ::kind::value): ${s}`);
  return { kind: inner.slice(0, idx), value: inner.slice(idx + 2) };
}

// ============================================================================
// Journal — append-only log, cursor-based reads
//
// Each entry has a string id (UUID or monotonic token) and an opaque payload.
// Cursors are entry ids — readAfter returns entries strictly after that id.
// A null/empty cursor means "read from the beginning".
// ============================================================================

export interface JournalEntry {
  id: string;
  payload: unknown;
}

export interface JournalReadResult {
  entries: JournalEntry[];
  /** The id of the last entry returned, suitable for use as the next cursor. */
  newCursor: string | null;
}

export interface JournalStorage {
  /** Append an entry. The storage layer assigns the id. */
  append(payload: unknown): JournalEntry;

  /** Read ALL entries (for index rebuilds, full replay). */
  readAll(): JournalEntry[];

  /**
   * Read entries appended after the given cursor id.
   * If cursor is null/empty, returns all entries from the beginning.
   */
  readAfter(cursor: string | null): JournalReadResult;
}

// ============================================================================
// KV — key-value store with list and delete
//
// Values are opaque unknown — callers own serialisation.
// Keys are scoped by the adapter factory (e.g. a boardDir prefix is closed
// over in the adapter, not passed per-call).
// ============================================================================

export interface KVStorage {
  /** Returns the stored value, or null if the key does not exist. */
  read(key: string): unknown | null;

  /** Write value at key. Overwrites any existing value. */
  write(key: string, value: unknown): void;

  /** Delete the key. No-op if it does not exist. */
  delete(key: string): void;

  /**
   * List all keys, optionally filtered to those starting with prefix.
   * Order is implementation-defined.
   */
  listKeys(prefix?: string): string[];
}

// ============================================================================
// StorageProvider — aggregate of all three primitives
//
// Adapter factories receive a StorageProvider and close over any scope (e.g.
// boardDir) themselves. This is the single injection point for swapping
// backends (Node fs → CosmosDB, browser localStorage, test doubles, etc.).
// ============================================================================

export interface StorageProvider {
  blob: BlobStorage;
  journal: JournalStorage;
  kv: KVStorage;
}

// ============================================================================
// AtomicRelayLock — non-blocking try-acquire lock with relay-on-busy semantics
//
// This interface serves TWO tightly coupled purposes which are intentionally
// unified into a single primitive:
//
//   1. ATOMICITY — ensures that a read-mutate-save cycle is executed by at
//      most one actor at a time, preventing concurrent actors from racing on
//      stale state and writing conflicting snapshots.
//
//   2. RELAY SIGNAL — when tryAcquire() returns null, the caller knows the
//      cycle is already in progress. Because the holder always reads fresh
//      state upon entry, it will pick up every change appended by the skipping
//      caller before the lock was attempted. The caller can therefore safely
//      exit — its work will be completed by the holder. This is the
//      "relay baton" pattern: the lock being held IS the in-progress signal.
//
// These two purposes are not an accidental overload — they are the same
// invariant expressed at different scopes. Any backend implementation
// (FS lockfile, Cosmos document lease, Azure entity lock, in-memory flag)
// that satisfies "at most one holder at a time" automatically satisfies both.
//
// Contract:
//   - tryAcquire() is non-blocking. It never waits.
//   - Returns a release function on success, or null if already held.
//   - The release function must be called exactly once (use try/finally).
//   - Behaviour after calling release() more than once is undefined.
// ============================================================================

export interface AtomicRelayLock {
  /**
   * Attempt to acquire the lock without blocking.
   * Returns a `release` function if successful, or `null` if the lock is
   * already held by another actor (relay: that actor will complete the work).
   */
  tryAcquire(): (() => void) | null;
}

/**
 * Execute `work` under an `AtomicRelayLock`.
 *
 * - If the lock is busy, returns false immediately (relay: the holder will
 *   complete the work on behalf of this caller).
 * - If acquired, runs `work` exclusively, releases the lock, then calls
 *   `continuation` if provided — allowing the caller to schedule the next
 *   cycle (e.g. spawn a detached process) after the lock is free.
 * - Returns true if work ran.
 */
export async function withRelayLock(
  lock: AtomicRelayLock,
  work: () => Promise<void>,
  continuation?: () => void,
): Promise<boolean> {
  const release = lock.tryAcquire();
  if (!release) return false; // relay: holder is already doing the work
  try {
    await work();
  } finally {
    release(); // release before continuation so it can immediately re-acquire
  }
  continuation?.();
  return true;
}
