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
 *   ExecutionRequestStore → KV (keyed by journalId, via createFsKvStorage)
 *
 *   StateSnapshotStorageAdapter
 *     board-graph.json (packed single JSON, written atomically)   → Blob
 *     per-card sidecars (cards/<id>/runtime, fetched-sources-manifest) → KV
 */

// ============================================================================
// Blob — raw content at an opaque key
//
// The key is backend-specific (file path, blob name, storage key).
// Text helpers are always available. Binary helpers are optional so existing
// backends can adopt incrementally.
// ============================================================================

export interface BlobStat {
  key: string;
  size: number;
  updatedAt?: string;
  contentType?: string;
}

export interface BlobStorage {
  /** Returns raw content string, or null if the blob does not exist. */
  read(key: string): string | null;

  /** Write content at key. Implementations should be atomic (write-rename). */
  write(key: string, content: string): void;

  /** Returns true if a blob exists at key. */
  exists(key: string): boolean;

  /** Delete the blob at key. No-op if it does not exist. */
  remove(key: string): void;

  /** Optional binary read for file-like artifacts. */
  readBytes?(key: string): Uint8Array | null;

  /** Optional binary write for file-like artifacts. */
  writeBytes?(key: string, content: Uint8Array): void;

  /** List all keys that start with the given prefix. */
  listKeys(prefix?: string): string[];

  /** Optional metadata lookup. */
  stat?(key: string): BlobStat | null;
}

// ============================================================================
// KindValueRef — backend-neutral typed reference
//
// A ref describes WHERE content lives without carrying the bytes.
// Serialized on the CLI wire as: b64:<base64url({"kind":"...","value":"..."})>
//   kind = 'fs-path': value is an absolute file path
// Additional kinds (e.g. 'cosmos') are added in board-worker-adapter.ts as new backends are supported.
// ============================================================================

export interface KindValueRef {
  readonly kind: string;
  readonly value: string;
}

const REF_PREFIX = 'b64:';

function toBase64Url(raw: string): string {
  const utf8 = new TextEncoder().encode(raw);
  const buf = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(enc: string): string } } }).Buffer;
  let base64: string;
  if (buf) {
    base64 = buf.from(utf8).toString('base64');
  } else if (typeof btoa === 'function') {
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    base64 = btoa(binary);
  } else {
    throw new Error('No base64 encoder available in this runtime');
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (input.length % 4)) % 4);
  const buf = (globalThis as { Buffer?: { from(data: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(base64, 'base64').toString('utf8');
  if (typeof atob === 'function') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  throw new Error('No base64 decoder available in this runtime');
}

/** Serialize a KindValueRef to the wire format: b64:<base64url(json)> */
export function serializeRef(ref: KindValueRef): string {
  return `${REF_PREFIX}${toBase64Url(JSON.stringify(ref))}`;
}

/** Parse a wire-format ref string (b64:<base64url(json)>) into a KindValueRef. */
export function parseRef(s: string): KindValueRef {
  if (!s.startsWith(REF_PREFIX)) throw new Error(`Invalid ref format (expected ${REF_PREFIX}<base64url(json)>): ${s}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(s.slice(REF_PREFIX.length)));
  } catch {
    throw new Error(`Invalid ref format (malformed base64url/json): ${s}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid ref format (expected object payload): ${s}`);
  }
  const candidate = parsed as { kind?: unknown; value?: unknown };
  if (typeof candidate.kind !== 'string' || typeof candidate.value !== 'string') {
    throw new Error(`Invalid ref format (payload must contain string kind/value): ${s}`);
  }
  return { kind: candidate.kind, value: candidate.value };
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

  /** Truncate all entries. Optional — not all backends support it. */
  clear?(): void;
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
// JSONStorage — KV store with JSON-aware merge operations
//
// Backed by KVStorage under the hood. Adds deepMerge and shallowMerge so
// callers never need to read-modify-write manually for partial updates.
// ============================================================================

export interface JSONStorage {
  /** Returns the stored JSON value, or null if the key does not exist. */
  read(key: string): unknown | null;

  /**
   * Read a nested value inside the stored object using a dot-notation path.
   * e.g. get('myKey', 'a.b.c') returns the value at { a: { b: { c: ... } } }.
   * Returns null if the key does not exist or the path cannot be traversed.
   */
  get(key: string, jsonPath: string): unknown | null;

  /** Write value at key. Overwrites any existing value. */
  write(key: string, value: unknown): void;

  /** Delete the key. No-op if it does not exist. */
  delete(key: string): void;

  /** List all keys, optionally filtered by prefix. */
  listKeys(prefix?: string): string[];

  /**
   * Shallow-merge patch into the existing object at key.
   * Equivalent to: write(key, { ...read(key), ...patch })
   * Creates the key if it does not exist.
   */
  shallowMerge(key: string, patch: Record<string, unknown>): void;

  /**
   * Deep-merge patch into the existing object at key.
   * Recursively merges nested plain objects; arrays and primitives are replaced.
   * Creates the key if it does not exist.
   */
  deepMerge(key: string, patch: Record<string, unknown>): void;

  /**
   * Set a nested value inside the stored object using a dot-notation path.
   * e.g. patch('myKey', 'a.b.c', 42) sets { a: { b: { c: 42 } } } into the stored object.
   * Intermediate objects are created if absent. Arrays are not traversed — use integer
   * segments to index into them (e.g. 'items.0.name').
   * Creates the top-level key if it does not exist.
   */
  patch(key: string, jsonPath: string, value: unknown): void;
}

// ============================================================================
// ScratchStorage — backend-neutral ephemeral blob store with self-managed
// retention. Used by the public layer for child-process I/O handoff (probes,
// dispatchExecution) and any other "stash bytes briefly, key them, clean up
// later" need.
//
// Key shape is backend-defined and opaque to callers:
//   - FS backend: key === absolute file path under the scratch root
//   - Other backends: opaque string usable only with this store's methods
//
// Sweep policy is owned by the store itself (not the caller). Implementations
// SHOULD run a best-effort sweep after each write/create when the configured
// sweepIntervalMs has elapsed since the last sweep. Sweep deletes entries
// older than maxAgeMs and is bounded in wall-time.
//
// Reserved config keys (used by sweep machinery):
//   'retention.maxAgeMs'        — default 86_400_000 (24h)
//   'retention.sweepIntervalMs' — default 43_200_000 (12h)
//   'retention.lastSweepAt'     — epoch-ms of last sweep (managed internally)
//
// keyRef(key) returns a transport-resolvable KindValueRef for handing the
// underlying location to a spawned child process or remote worker. On FS this
// is { kind: 'fs-path', value: <absolute path> }. Non-FS backends should
// return whatever the consumer (e.g. task-executor) understands.
// ============================================================================

export interface ScratchStorage extends BlobStorage {
  /**
   * Allocate a new unique key. Does NOT create any underlying object — caller
   * must write to it (e.g. via a spawned child) before it has content.
   * prefix and suffix are sanitized; both are optional.
   */
  getUniqueKey(prefix?: string, suffix?: string): string;

  /**
   * Allocate a new unique key AND write data at it atomically. Returns the
   * new key. Counts as a write for sweep-trigger purposes.
   */
  create(data: string, prefix?: string, suffix?: string): string;

  /** Resolve a key to a transport-neutral ref (e.g. for child-process handoff). */
  keyRef(key: string): KindValueRef;

  /** Backend-agnostic config bag (used for retention policy and similar knobs). */
  config: {
    get(k: string): unknown;
    set(k: string, v: unknown): void;
  };
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
