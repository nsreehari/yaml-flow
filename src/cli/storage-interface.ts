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
