/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** On Windows, fs.renameSync fails with EPERM when dest is held open. Retry with back-off. */
function renameSync(src: string, dest: string): void {
  if (process.platform !== 'win32') { fs.renameSync(src, dest); return; }
  const delays = [10, 20, 40, 80, 160];
  for (let i = 0; i <= delays.length; i++) {
    try { fs.renameSync(src, dest); return; } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < delays.length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]);
        continue;
      }
      throw err;
    }
  }
}
import {
  parseCommandSpec,
  makeBoardTempFilePath,
  buildBoardCliInvocation,
  runDetached,
} from './process-runner.js';
import { withRelayLock, serializeRef } from './storage-interface.js';
import fg from 'fast-glob';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph, LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import type { ReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import type { GraphConfig, TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { Journal } from '../continuous-event-graph/journal.js';
import { validateLiveCardDefinition } from '../card-compute/schema-validator.js';
import { createBoardCommandHandlers } from './board-live-cards-cli-board-commands.js';
import { createCallbackCommandHandlers } from './board-live-cards-cli-callbacks.js';
import { createNonCoreCommandHandlers } from './board-live-cards-cli-noncore.js';
import { createCardCommandHandlers } from './board-live-cards-cli-card-commands.js';
import { createCompatCommandHandlers } from './board-live-cards-cli-compat.js';
import type { CardUpsertIndexEntry } from './board-live-cards-all-stores.js';
import { createExecutionCommandHandlers } from './board-live-cards-cli-execution-commands.js';
import { createCardHandlerFn } from './board-live-cards-lib-card-handler.js';
import { buildBoardStatusObject } from './board-live-cards-lib-board-status.js';
import {
  createFsOutputStore,
  computeStableJsonHash,
  createFsKvStorage,
  createFsBlobStorage,
  createFsAtomicRelayLock,
} from './storage-fs-adapters.js';
import { createNodeInvocationAdapter, createNodeCommandExecutor } from './process-runner.js';
import {
  createCardStore, createJournalStore, createExecutionRequestStore,
  createStateSnapshotStore, createBoardConfigStore, createFetchedSourcesStore, createCardRuntimeStore,
  BOARD_GRAPH_KEY, BOARD_LAST_JOURNAL_PROCESSED_ID_KEY, SNAPSHOT_SCHEMA_VERSION_V1,
  type StateSnapshotStorageAdapter, type StateSnapshotReadView,
  type BoardConfigStore,
} from './board-live-cards-all-stores.js';
// Re-export domain types and functions for backward compatibility
import { nextEntryAfterFetchDelivery } from './board-live-cards-lib-types.js';
import type { InvocationAdapter } from './process-interface.js';
export type { SourceRuntimeEntry, InferenceRuntimeEntry, FetchRuntimeEntry, SourceTokenPayload, CommandResponse } from './board-live-cards-lib-types.js';
export { isSourceInFlight, decideSourceAction, nextEntryAfterFetchDelivery, nextEntryAfterFetchFailure, Resp } from './board-live-cards-lib-types.js';

const BOARD_FILE = 'board-graph.json';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function createFsCardStorageAdapter(boardDir: string) {
  const indexPath = path.join(boardDir, '.card-index.json');
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);

  // Build a CardIndex from the append-only card-inventory.jsonl (legacy)
  // and the new card-upsert KV store (new path). KV entries take precedence.
  // The card file path IS the key — adapter.readCard(key) reads the file at that path.
  function buildIndexFromInventory(): import('./board-live-cards-all-stores.js').CardIndex {
    const result: import('./board-live-cards-all-stores.js').CardIndex = {};
    // Legacy: read from cards-inventory.jsonl
    if (fs.existsSync(inventoryPath)) {
      const lines = fs.readFileSync(inventoryPath, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { cardId: string; cardFilePath: string; addedAt: string };
          const absPath = path.resolve(entry.cardFilePath);
          result[entry.cardId] = { key: absPath, checksum: '', updatedAt: entry.addedAt };
        } catch { /* skip malformed lines */ }
      }
    }
    // New path: read from .card-upsert-kv — overrides legacy entries
    const upsertKv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
    for (const cardId of upsertKv.listKeys()) {
      const entry = upsertKv.read(cardId) as CardUpsertIndexEntry | null;
      if (entry?.blobRef) {
        result[cardId] = { key: entry.blobRef, checksum: entry.taskConfigHash, updatedAt: entry.updatedAt };
      }
    }
    return result;
  }

  return {
    readIndex() {
      // Prefer explicit .card-index.json if written by writeCard; fall back to inventory.
      if (fs.existsSync(indexPath)) {
        try { return JSON.parse(fs.readFileSync(indexPath, 'utf-8')); } catch { /* fall through */ }
      }
      return buildIndexFromInventory();
    },
    writeIndex(index: unknown) {
      const tmp = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
      renameSync(tmp, indexPath);
    },
    readCard(key: string) {
      if (!fs.existsSync(key)) return null;
      try { return JSON.parse(fs.readFileSync(key, 'utf-8')); } catch { return null; }
    },
    writeCard(key: string, card: unknown): string {
      const json = stableJson(card);
      const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(JSON.parse(json), null, 2), 'utf-8');
      renameSync(tmp, key);
      return createHash('sha256').update(json).digest('hex');
    },
    cardExists(key: string) { return fs.existsSync(key); },
    defaultCardKey(cardId: string) { return path.join(boardDir, `${cardId}.json`); },
  };
}

function createFsJournalStorageAdapter(boardDir: string) {
  const journalPath = path.join(boardDir, 'board-journal.jsonl');
  return {
    readAllEntries() {
      if (!fs.existsSync(journalPath)) return [];
      const content = fs.readFileSync(journalPath, 'utf-8').trim();
      if (!content) return [];
      return content.split('\n').filter(Boolean).map((l: string) => JSON.parse(l));
    },
    appendEntry(entry: { id: string; event: unknown }) {
      fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
    },
    generateId() { return randomUUID(); },
  };
}

function createFsExecutionRequestStorageAdapter(boardDir: string) {
  const dir = path.join(boardDir, '.execution-requests');
  function entryFilePath(journalId: string): string {
    return path.join(dir, `${journalId}.json`);
  }
  return {
    writeEntries(journalId: string, entries: unknown[]): void {
      const fp = entryFilePath(journalId);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
      renameSync(tmp, fp);
    },
    readEntries(journalId: string) {
      const fp = entryFilePath(journalId);
      if (!fs.existsSync(fp)) return null;
      try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) as import('./board-live-cards-all-stores.js').ExecutionRequestEntry[]; } catch { return null; }
    },
    deleteEntries(journalId: string): void {
      const fp = entryFilePath(journalId);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* best-effort */ }
    },
  };
}
const INVENTORY_FILE = 'cards-inventory.jsonl';
const RUNTIME_OUT_FILE = '.runtime-out';
const DEFAULT_RUNTIME_OUT_DIR = 'runtime-out';
const RUNTIME_STATUS_FILE = 'board-livegraph-status.json';
const RUNTIME_CARDS_DIR = 'cards';
const RUNTIME_DATA_OBJECTS_DIR = 'data-objects';
function createBoardConfig(boardDir: string): BoardConfigStore {
  return createBoardConfigStore(createFsKvStorage(path.join(boardDir, '.config')), parseCommandSpec);
}

function createBoardInvocationAdapter(cliDir: string): InvocationAdapter {
  const base = createNodeInvocationAdapter(cliDir, encodeSourceToken);
  return {
    requestInference: base.requestInference.bind(base),
    requestProcessAccumulated: base.requestProcessAccumulated.bind(base),
    async requestSourceFetch(
      boardDir: string,
      enrichedCard: Record<string, unknown>,
      callbackToken: string,
    ) {
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return { dispatched: false, invocationId: undefined };
      try {
        const teConfig = createBoardConfig(boardDir).readTaskExecutorConfig();
        if (!teConfig) {
          // No task-executor: delegate to run-sourcedefs-internal (handles source.cli).
          return base.requestSourceFetch(boardDir, enrichedCard, callbackToken);
        }
        // Task-executor registered: dispatch each source_def as a detached process.
        const cardId = (enrichedCard.id as string | undefined) ?? 'unknown';
        const { cmd: _cliCmd, args: _cliArgs } = buildBoardCliInvocation(cliDir, '_', []);
        const boardCliScriptPath = (_cliCmd === process.execPath && _cliArgs[0]?.endsWith('.js'))
          ? _cliArgs[0]
          : (_cliArgs[1] ?? _cliArgs[0]);
        // Re-parse teConfig as a legacy command string to correctly split 'node path.cjs' → [node, path.cjs]
        const rawCmdStr = [teConfig.command, ...(teConfig.args ?? [])].join(' ');
        const parsedExec = parseCommandSpec(rawCmdStr);
        const taskExecutorExtraB64 = teConfig.extra
          ? Buffer.from(JSON.stringify(teConfig.extra)).toString('base64')
          : undefined;
        type SourceDef = { bindTo: string; outputFile?: string; [k: string]: unknown };
        const sourceDefs = (enrichedCard.source_defs ?? []) as SourceDef[];
        for (const src of sourceDefs) {
          if (!src.outputFile) {
            console.warn(`[request-source-fetch] source "${src.bindTo}" has no outputFile — skipping`);
            continue;
          }
          const sourceToken = encodeSourceToken({
            cbk: callbackToken, rg: boardDir, cid: cardId,
            b: src.bindTo, d: src.outputFile, cs: undefined,
          });
          const inFile  = makeBoardTempFilePath(boardDir, `source-in-${src.bindTo}`);
          const outFile = makeBoardTempFilePath(boardDir, `source-out-${src.bindTo}`);
          const errFile = makeBoardTempFilePath(boardDir, `source-err-${src.bindTo}`, '.txt');
          const inEnvelope = {
            source_def: src,
            callback: { token: sourceToken, via: { type: 'node-cli' as const, path: boardCliScriptPath } },
          };
          fs.writeFileSync(inFile, JSON.stringify(inEnvelope, null, 2), 'utf-8');
          const executorArgs = [...(parsedExec.args ?? []), 'run-source-fetch',
            '--in-ref', serializeRef({ kind: 'fs-path', value: inFile }),
            '--out-ref', serializeRef({ kind: 'fs-path', value: outFile }),
            '--err-ref', serializeRef({ kind: 'fs-path', value: errFile }),
          ];
          if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
          console.log(`[request-source-fetch] task-executor: ${parsedExec.command} ${executorArgs.join(' ')}`);
          runDetached({ command: parsedExec.command, args: executorArgs });
        }
        return { dispatched: true, invocationId: randomUUID() };
      } catch (err) {
        return { dispatched: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

/** Envelope stored in board-graph.json — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

/**
 * FS-backed StateSnapshotStorageAdapter.
 *
 * CLEANUP TODO: This adapter has hard-coded knowledge of two board-domain keys
 * (`board/graph` and `board/lastJournalProcessedId` — see BOARD_GRAPH_KEY /
 * BOARD_LAST_JOURNAL_PROCESSED_ID_KEY) that it packs into a single
 * `board-graph.json` file for backward compatibility with boards written before
 * the snapshot-store abstraction existed. All other keys are written as
 * `.state-snapshot/<key>.json` sidecar files.
 *
 * A pure FS storage adapter should not know about domain key names. The
 * correct long-term shape is: every key maps to its own sidecar file under
 * `.state-snapshot/`, and `board-graph.json` is retired or read-only for
 * legacy compat. Once the test suite no longer depends on the packed
 * `board-graph.json` format, remove the special-casing of BOARD_GRAPH_KEY
 * and BOARD_LAST_JOURNAL_PROCESSED_ID_KEY here.
 */
function createFsStateSnapshotStorageAdapter(boardFileName: string): StateSnapshotStorageAdapter {
  const sidecarRootDirName = '.state-snapshot';

  function keyToSidecarPath(scopeDir: string, key: string): string {
    return path.join(scopeDir, sidecarRootDirName, ...key.split('/').filter(Boolean)) + '.json';
  }

  function stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${(value as unknown[]).map(stableStringify).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }

  function valueToVersion(values: Record<string, unknown>): string {
    return createHash('sha256').update(stableStringify(values)).digest('hex');
  }

  function readJson(filePath: string): unknown {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  return {
    readValues(scopeDir: string): StateSnapshotReadView {
      const boardPath = path.join(scopeDir, boardFileName);
      if (!fs.existsSync(boardPath)) return { version: null, values: {} };

      const env = readJson(boardPath) as { graph: unknown; lastDrainedJournalId?: string };
      const values: Record<string, unknown> = {
        [BOARD_GRAPH_KEY]: env.graph,
        [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: env.lastDrainedJournalId ?? '',
      };

      const sidecarRoot = path.join(scopeDir, sidecarRootDirName);
      if (fs.existsSync(sidecarRoot)) {
        const stack: string[] = [sidecarRoot];
        const files: string[] = [];
        while (stack.length > 0) {
          const current = stack.pop()!;
          for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const abs = path.join(current, entry.name);
            if (entry.isDirectory()) { stack.push(abs); continue; }
            if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
            files.push(abs);
          }
        }
        files.sort((a, b) => a.localeCompare(b));
        for (const abs of files) {
          const key = path.relative(sidecarRoot, abs).replace(/\\/g, '/').replace(/\.json$/, '');
          values[key] = readJson(abs);
        }
      }

      return { version: valueToVersion(values), values };
    },

    writeValues(scopeDir: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const graph = nextValues[BOARD_GRAPH_KEY];
      const lastDrainedJournalId = nextValues[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string;
      if (!graph || typeof graph !== 'object') throw new Error(`Snapshot missing required key: ${BOARD_GRAPH_KEY}`);
      writeJsonAtomic(path.join(scopeDir, boardFileName), { graph, lastDrainedJournalId });

      const boardKeys = new Set([BOARD_GRAPH_KEY, BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]);
      // Delete sidecar files for removed keys.
      for (const key of deletedKeys) {
        if (boardKeys.has(key)) continue;
        const p = keyToSidecarPath(scopeDir, key);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      // Write all non-board keys as sidecar blobs.
      for (const [key, value] of Object.entries(nextValues)) {
        if (boardKeys.has(key)) continue;
        writeJsonAtomic(keyToSidecarPath(scopeDir, key), value);
      }

      return valueToVersion(nextValues);
    },
  };
}

const nodeStateSnapshotStore = createStateSnapshotStore(
  createFsStateSnapshotStorageAdapter(BOARD_FILE),
);

function boardEnvelopeToSnapshotEntries(envelope: BoardEnvelope): Record<string, unknown> {
  return {
    [BOARD_GRAPH_KEY]: envelope.graph,
    [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: envelope.lastDrainedJournalId,
  };
}

function snapshotEntriesToBoardEnvelope(entries: Record<string, unknown>): BoardEnvelope {
  const graph = entries[BOARD_GRAPH_KEY] as LiveGraphSnapshot | undefined;
  const lastDrainedJournalId = entries[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string | undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`State snapshot is missing required key: ${BOARD_GRAPH_KEY}`);
  }
  return {
    graph,
    lastDrainedJournalId: typeof lastDrainedJournalId === 'string' ? lastDrainedJournalId : '',
  };
}

// ============================================================================
// Board Journal — append-only JSONL with GUID IDs
// ============================================================================

export interface JournalEntry {
  id: string;
  event: GraphEvent;
}

export class BoardJournal implements Journal {
  private readonly journalPath: string;
  private lastDrainedId: string;

  constructor(journalPath: string, lastDrainedJournalId: string) {
    this.journalPath = journalPath;
    this.lastDrainedId = lastDrainedJournalId;
  }

  append(event: GraphEvent): void {
    const entry: JournalEntry = { id: randomUUID(), event };
    fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  drain(): GraphEvent[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return [];
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));

    // Find the index of the last drained entry; take everything after it
    let startIdx = 0;
    if (this.lastDrainedId) {
      const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
      if (drainedIdx !== -1) startIdx = drainedIdx + 1;
    }

    const undrained = entries.slice(startIdx);
    if (undrained.length > 0) {
      this.lastDrainedId = undrained[undrained.length - 1].id;
    }
    return undrained.map(e => e.event);
  }

  get size(): number {
    if (!fs.existsSync(this.journalPath)) return 0;
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return 0;
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
    if (!this.lastDrainedId) return entries.length;
    const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
    return drainedIdx === -1 ? entries.length : entries.length - drainedIdx - 1;
  }

  get lastDrainedJournalId(): string {
    return this.lastDrainedId;
  }
}

// ============================================================================
// Cards inventory
// ============================================================================

export interface CardInventoryEntry {
  cardId: string;
  cardFilePath: string;
  addedAt: string;
}

export interface CardInventoryIndex {
  byCardId: Map<string, CardInventoryEntry>;
  byCardPath: Map<string, CardInventoryEntry>;
}

export function readCardInventory(boardDir: string): CardInventoryEntry[] {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  if (!fs.existsSync(inventoryPath)) return [];
  const lines = fs.readFileSync(inventoryPath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l) as CardInventoryEntry);
}

export function lookupCardPath(boardDir: string, cardId: string): string | null {
  // Check new KV store first
  const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
  const kvEntry = kv.read(cardId) as CardUpsertIndexEntry | null;
  if (kvEntry?.blobRef) return kvEntry.blobRef;
  // Fall back to legacy inventory
  const entries = readCardInventory(boardDir);
  const entry = entries.find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}

/** Read all entries from the card-upsert KV dedup cache. Keyed by cardId. */
export function readCardUpsertIndex(boardDir: string): Record<string, CardUpsertIndexEntry> {
  const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
  const result: Record<string, CardUpsertIndexEntry> = {};
  for (const cardId of kv.listKeys()) {
    const entry = kv.read(cardId) as CardUpsertIndexEntry | null;
    if (entry) result[cardId] = entry;
  }
  return result;
}

export function appendCardInventory(boardDir: string, entry: CardInventoryEntry): void {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  const normalized: CardInventoryEntry = { ...entry, cardFilePath: path.resolve(entry.cardFilePath) };
  fs.appendFileSync(inventoryPath, JSON.stringify(normalized) + '\n');
}

export function buildCardInventoryIndex(boardDir: string): CardInventoryIndex {
  const byCardId = new Map<string, CardInventoryEntry>();
  const byCardPath = new Map<string, CardInventoryEntry>();

  for (const entry of readCardInventory(boardDir)) {
    const normalizedPath = path.resolve(entry.cardFilePath);
    const normalizedEntry: CardInventoryEntry = {
      ...entry,
      cardFilePath: normalizedPath,
    };

    const existingById = byCardId.get(entry.cardId);
    if (existingById && existingById.cardFilePath !== normalizedPath) {
      throw new Error(
        `Inventory invariant violation: card id "${entry.cardId}" maps to multiple files: ` +
        `"${existingById.cardFilePath}" and "${normalizedPath}"`
      );
    }

    const existingByPath = byCardPath.get(normalizedPath);
    if (existingByPath && existingByPath.cardId !== entry.cardId) {
      throw new Error(
        `Inventory invariant violation: file "${normalizedPath}" maps to multiple ids: ` +
        `"${existingByPath.cardId}" and "${entry.cardId}"`
      );
    }

    byCardId.set(entry.cardId, normalizedEntry);
    byCardPath.set(normalizedPath, normalizedEntry);
  }

  return { byCardId, byCardPath };
}

// ============================================================================
// Library
// ============================================================================

/**
 * Initialize a board directory.
 * - Dir doesn't exist → create it, write empty board-graph.json
 * - Dir exists + valid board-graph.json → no-op, return 'exists'
/**
 * Initialize a new board or verify existing board in the given directory.
 *
 * INIT PHASE:
 * 1. Create empty LiveGraph with EMPTY_CONFIG
 * 2. Snapshot it and commit to snapshot-store (board/graph + board/lastJournalProcessedId keys only)
 * 3. Configuration state (CardsStore, ControlStore) is NOT persisted here.
 *    Card definitions are loaded from card-source-kinds.json files at runtime.
 *    Config files (.task-executor, .inference-adapter) are loaded from disk on demand.
 *
 * Returns 'created' if new board was created, 'exists' if board already existed.
 * Throws if directory exists but is non-empty and has no valid board-graph.json.
 */
export function initBoard(dir: string): 'created' | 'exists' {
  const boardPath = path.join(dir, BOARD_FILE);

  if (fs.existsSync(boardPath)) {
    // Validate it's a real board envelope
    const envelope = loadBoardEnvelope(dir);
    restore(envelope.graph);
    return 'exists';
  }

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`Directory "${dir}" is not empty and has no valid ${BOARD_FILE}`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const live = createLiveGraph(EMPTY_CONFIG);
  const snap = snapshot(live);
  const envelope: BoardEnvelope = { lastDrainedJournalId: '', graph: snap };
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!commitResult.ok) {
    throw new Error(
      `State snapshot init commit failed: expected=${current.version ?? 'null'} current=${commitResult.currentVersion ?? 'null'}`,
    );
  }
  return 'created';
}

/**
 * Load the board envelope (graph + drained cursor) from persistent snapshot store.
 *
 * LOAD PHASE:
 * 1. Read snapshot from disk (5 mutable keys: board/graph, board/lastJournalProcessedId, etc.)
 * 2. Configuration state (CardsStore, ControlStore) is NOT loaded here.
 *    Cards are loaded separately when needed (during upsert-card commands).
 *    Config files are read on demand (.task-executor, .inference-adapter).
 * 3. Restore the graph to verify integrity (no corruption detected during load).
 *
 * Falls back to direct board-graph.json read for compatibility with boards created before snapshot-store wiring.
 */
export function loadBoardEnvelope(dir: string): BoardEnvelope {
  const boardPath = path.join(dir, BOARD_FILE);
  if (!fs.existsSync(boardPath)) {
    throw new Error(`Missing board file: ${boardPath}`);
  }

  const snapshot = nodeStateSnapshotStore.readSnapshot(dir);
  if (snapshot.values[BOARD_GRAPH_KEY]) {
    return snapshotEntriesToBoardEnvelope(snapshot.values);
  }

  // Compatibility fallback for envelopes written before snapshot-store wiring.
  const raw = fs.readFileSync(boardPath, 'utf-8');
  return JSON.parse(raw) as BoardEnvelope;
}

export function loadBoard(dir: string): LiveGraph {
  const envelope = loadBoardEnvelope(dir);
  return restore(envelope.graph);
}

/**
 * Save board state to persistent snapshot store after drain cycle.
 *
 * SAVE PHASE (Drain Cycle):
 * 1. Serialize current ReactiveGraph to snapshot
 * 2. Commit to snapshot-store with optimistic concurrency check (expectedVersion)
 * 3. Snapshot persists only 5 mutable runtime keys:
 *    - board/graph, board/lastJournalProcessedId (in board-graph.json)
 *    - cards/<id>/runtime, cards/<id>/fetched-sources-manifest, outputStore (in .state-snapshot/ sidecars)
 * 4. Configuration state (CardsStore, ControlStore) is NOT persisted here.
 *    Config changes from upsert-card are written directly to card-source-kinds.json.
 *    Control config is persisted separately in .task-executor, .inference-adapter files.
 * 5. Publish status cache as best-effort (cache failures do not fail the commit).
 *
 * Throws if version mismatch detected (concurrent modification from another host/process).
 */
export function saveBoard(dir: string, rg: ReactiveGraph, journalOrCursor: BoardJournal | string): void {
  const newCursor = typeof journalOrCursor === 'string' ? journalOrCursor : journalOrCursor.lastDrainedJournalId;
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = {
    lastDrainedJournalId: newCursor,
    graph: snap,
  };
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!commitResult.ok) {
    throw new Error(
      `State snapshot commit failed: expected=${current.version ?? 'null'} current=${commitResult.currentVersion ?? 'null'}`,
    );
  }
}

function runtimeOutConfigPath(boardDir: string): string {
  return path.join(boardDir, RUNTIME_OUT_FILE);
}

function resolveConfiguredRuntimeOutDir(boardDir: string): string {
  const cfgPath = runtimeOutConfigPath(boardDir);
  if (fs.existsSync(cfgPath)) {
    const configured = fs.readFileSync(cfgPath, 'utf-8').trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(boardDir, configured);
    }
  }

  const defaultDir = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  fs.writeFileSync(cfgPath, defaultDir, 'utf-8');
  return defaultDir;
}

function configureRuntimeOutDir(boardDir: string, runtimeOut?: string): string {
  let resolved: string;
  if (runtimeOut) {
    resolved = path.isAbsolute(runtimeOut) ? runtimeOut : path.resolve(boardDir, runtimeOut);
  } else {
    resolved = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  }

  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(runtimeOutConfigPath(boardDir), resolved, 'utf-8');
  return resolved;
}

function resolveStatusSnapshotPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_STATUS_FILE);
}

function resolveComputedValuesPath(boardDir: string, cardId: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_CARDS_DIR, `${cardId}.computed.json`);
}

function resolveDataObjectsDirPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_DATA_OBJECTS_DIR);
}

function toDataObjectFileName(token: string): string {
  // Keep token recognizable in filenames while avoiding path traversal.
  return token.replace(/[\\/]/g, '__');
}

function writeRuntimeDataObjects(boardDir: string, data: Record<string, unknown>): void {
  for (const [token, payload] of Object.entries(data)) {
    if (!token) continue;
    const fileName = toDataObjectFileName(token);
    if (!fileName) continue;
    const filePath = path.join(resolveDataObjectsDirPath(boardDir), fileName);
    writeJsonAtomic(filePath, payload);
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const content = payload === undefined ? 'null' : JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

// ============================================================================
// Standalone journal append + opportunistic drain
// ============================================================================

/**
 * Decode a callback token → { taskName } or null if malformed.
 * Mirrors the private encodeCallbackToken format in reactive.ts.
 */
function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof payload?.t === 'string') return { taskName: payload.t };
    return null;
  } catch { return null; }
}

// ============================================================================
// Source token — per-source opaque token carrying all delivery metadata
// (SourceTokenPayload interface is re-exported from board-live-cards-lib-types)
// ============================================================================

import type { SourceTokenPayload } from './board-live-cards-lib-types.js';

export function encodeSourceToken(payload: SourceTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSourceToken(token: string): SourceTokenPayload | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' && typeof p?.b === 'string' && typeof p?.d === 'string') {
      return p as SourceTokenPayload;
    }
    return null;
  } catch { return null; }
}

// ============================================================================
// Runtime state — now managed exclusively by RuntimeInternalStore (node-adapters)
// The SourceRuntimeEntry, InferenceRuntimeEntry, FetchRuntimeEntry types and
// domain functions are re-exported from board-live-cards-lib-types.
// ============================================================================

/**
 * Append a raw event to the journal file. No lock, no file read.
 * Safe for hundreds of concurrent callers (appendFileSync is atomic for small writes).
 */
export function appendEventToJournal(boardDir: string, event: GraphEvent): void {
  createJournalStore(createFsJournalStorageAdapter(boardDir)).appendEvent(event);
}

/**
 * Read journal entries after the given ID. Pure file read, no mutation.
 */
export function getUndrainedEntries(boardDir: string, lastDrainedId: string): JournalEntry[] {
  const journalPath = path.join(boardDir, 'board-journal.jsonl');
  if (!fs.existsSync(journalPath)) return [];
  const content = fs.readFileSync(journalPath, 'utf-8').trim();
  if (!content) return [];
  const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

function determineLatestPendingAccumulated(boardDir: string): number {
  const boardPath = path.join(boardDir, BOARD_FILE);
  if (!fs.existsSync(boardPath)) return 0;
  try {
    const envelope = loadBoardEnvelope(boardDir);
    const journalStore = createJournalStore(createFsJournalStorageAdapter(boardDir));
    return journalStore.pendingCount(envelope.lastDrainedJournalId);
  } catch {
    return 0;
  }
}

/**
 * Run one lock-guarded processing pass for this board.
 *
 * GUARANTEE (single-pass only):
 * - At most one process performs this pass at a time (board lock).
 * - If lock is acquired, exactly one drain/apply/save cycle is executed.
 * - If lock is busy, returns false immediately (no waiting).
 *
 * This function does NOT guarantee full settlement; it only advances the baton
 * by one cycle in the relay model.
 */
export async function processAccumulatedEvents(boardDir: string, continuation?: () => void): Promise<boolean> {
  const boardPath = path.join(boardDir, BOARD_FILE);
  const cliDir = __dirname;
  const lock = createFsAtomicRelayLock(boardPath);
  return withRelayLock(lock, async () => {
    const journalStore = createJournalStore(createFsJournalStorageAdapter(boardDir));
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void => {
      appendEventToJournal(boardDir, { type: 'task-completed', taskName, data, timestamp: new Date().toISOString() });
    };
    const taskFailedFn = (taskName: string, error: string): void => {
      appendEventToJournal(boardDir, { type: 'task-failed', taskName, error, timestamp: new Date().toISOString() });
    };
    const onDispatchFailed = (entry: import('./board-live-cards-all-stores.js').ExecutionRequestEntry, error: string): void => {
      const p = entry.payload as Record<string, unknown>;
      const taskName = (p?.enrichedCard as Record<string, unknown> | undefined)?.id as string | undefined
        ?? p?.cardId as string | undefined
        ?? 'unknown';
      taskFailedFn(taskName, error);
    };
    const executionRequestStore = createExecutionRequestStore(createFsExecutionRequestStorageAdapter(boardDir), onDispatchFailed);
    const cardHandlerAdapters = {
      cardStore: createCardStore(createFsCardStorageAdapter(boardDir)),
      cardRuntimeStore: createCardRuntimeStore(createFsKvStorage(path.join(boardDir, '.state-snapshot'))),
      fetchedSourcesStore: createFetchedSourcesStore(createFsBlobStorage(boardDir), resolveSourceDataRef),
      outputStore: createFsOutputStore(resolveComputedValuesPath, resolveDataObjectsDirPath, resolveStatusSnapshotPath),
      executionRequestStore,
    };
    const envelope = loadBoardEnvelope(boardDir);
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore.readEntriesAfterCursor(envelope.lastDrainedJournalId);
    const invocationAdapter = createBoardInvocationAdapter(cliDir);
    const rg = createReactiveGraph(live, { handlers: { 'card-handler': createCardHandlerFn(boardDir, newCursor, cardHandlerAdapters, taskCompletedFn, taskFailedFn) } });
    rg.pushAll(undrained);
    await rg.dispose({ wait: true });
    saveBoard(boardDir, rg, newCursor);
    try {
      cardHandlerAdapters.outputStore.writeStatusSnapshot(boardDir, buildBoardStatusObject(path.resolve(boardDir), restore(rg.snapshot())));
    } catch (err) {
      console.warn(`[board-live-cards] status cache publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind === 'source-fetch') {
        const p = entry.payload as { boardDir: string; enrichedCard: Record<string, unknown>; callbackToken: string };
        invocationAdapter.requestSourceFetch(p.boardDir, p.enrichedCard, p.callbackToken)
          .catch((err: unknown) => taskFailedFn(
            (p.enrichedCard?.id as string | undefined) ?? 'unknown',
            err instanceof Error ? err.message : String(err),
          ));
      } else if (entry.taskKind === 'inference') {
        const p = entry.payload as { boardDir: string; cardId: string; inferencePayload: unknown; callbackToken: string };
        invocationAdapter.requestInference(p.boardDir, p.cardId, p.inferencePayload, p.callbackToken)
          .catch((err: unknown) => taskFailedFn(
            p.cardId ?? 'unknown',
            err instanceof Error ? err.message : String(err),
          ));
      } else {
        console.warn(`[process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
      }
    });
  }, continuation);
}

/**
 * If there are pending events, run one drain pass then dispatch a new process
 * via the adapter to continue — allowing the current process to exit immediately after.
 * If nothing is pending, returns without doing anything.
 */
export async function processAccumulatedEventsInfinitePass(boardDir: string, adapter: InvocationAdapter): Promise<boolean> {
  if (determineLatestPendingAccumulated(boardDir) === 0) return true;
  return processAccumulatedEvents(boardDir, () => { void adapter.requestProcessAccumulated(boardDir); });
}

/**
 * Run one immediate drain pass then schedule infinite-pass continuation.
 */
export async function processAccumulatedEventsForced(boardDir: string, adapter: InvocationAdapter): Promise<void> {
  await processAccumulatedEvents(boardDir);
  await processAccumulatedEventsInfinitePass(boardDir, adapter);
}

// ============================================================================
// Card transform
// ============================================================================

export type BoardLiveCard = LiveCard;

/**
 * Transform a LiveCard into a TaskConfig for the reactive graph.
 *
 * Every card gets handler: 'card-handler'.
 * The handler inspects the card and decides what to do:
 * run compute, invoke source_defs.
 */
export function liveCardToTaskConfig(card: BoardLiveCard): TaskConfig {
  const requires = card.requires;
  const provides = card.provides?.map(p => p.bindTo) ?? [];

  return {
    requires: requires && requires.length > 0 ? requires : undefined,
    provides,
    taskHandlers: ['card-handler'],
    description: card.meta?.title ?? card.id,
  };
}

// ============================================================================
// Reactive graph factory
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generalized CLI invocation: determines how to invoke this script in current environment.
 * Returns { cmd, args } suitable for execFile() or execFileSync().
 */
// ============================================================================
// CLI
// ============================================================================

/**
 * Resolve a KindValueRef to its content string.
 * 'fs-path': read file from disk (FS adapter, stays in cli.ts)
 */
function resolveSourceDataRef(ref: { kind: string; value: string }): string {
  if (ref.kind === 'fs-path') return fs.readFileSync(ref.value, 'utf-8');
  throw new Error(`Unsupported KindValueRef kind: ${ref.kind}`);
}

/**
 * Helper function to add a single card from file.
 * Throws errors instead of calling process.exit() so it can be used in tests.
 */
function resolveCardGlobMatches(cardGlob: string): string[] {
  const patterns = cardGlob
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => p.replace(/\\/g, '/'));
  const matches = fg.sync(patterns, {
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
  });
  // fast-glob returns forward-slash paths; normalise to native so comparisons
  // against inventory entries (which use path.resolve → backslash on Windows) match.
  return [...matches].map(m => path.resolve(m)).sort((a, b) => a.localeCompare(b));
}


export async function cli(argv: string[]): Promise<void> {
  const processAccumulatedAdapter = createBoardInvocationAdapter(__dirname);
  const executor = createNodeCommandExecutor();
  const scheduleInfinitePass = (boardDir: string) => processAccumulatedEventsInfinitePass(boardDir, processAccumulatedAdapter);
  const scheduleForced = (boardDir: string) => processAccumulatedEventsForced(boardDir, processAccumulatedAdapter);
  const boardCommandHandlers = createBoardCommandHandlers({
    initBoard,
    configureRuntimeOutDir,
    loadBoard,
    outputStore: createFsOutputStore(resolveComputedValuesPath, resolveDataObjectsDirPath, resolveStatusSnapshotPath),
    buildBoardStatusObject: (dir: string, live: LiveGraph) => buildBoardStatusObject(path.resolve(dir), live),
    getConfigStore: createBoardConfig,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const callbackCommandHandlers = createCallbackCommandHandlers({
    decodeCallbackToken,
    decodeSourceToken,
    getFetchedSourcesStore: (boardDir: string) => createFetchedSourcesStore(createFsBlobStorage(boardDir), resolveSourceDataRef),
    generateId: randomUUID,
    writeRuntimeDataObjects,
    appendEventToJournal,
    processAccumulatedEventsForced: scheduleForced,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const nonCoreCommandHandlers = createNonCoreCommandHandlers({
    getConfigStore: createBoardConfig,
    getCardStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    executor,
    makeTempFilePath: makeBoardTempFilePath,
    validateLiveCardDefinition,
    readStdin: () => fs.readFileSync('/dev/stdin', 'utf-8'),
  });
  const cardCommandHandlers = createCardCommandHandlers({
    getCardStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    readCardUpsertEntry: (boardDir: string, cardId: string): CardUpsertIndexEntry | null => {
      const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
      return kv.read(cardId) as CardUpsertIndexEntry | null;
    },
    writeCardUpsertEntry: (boardDir: string, cardId: string, entry: CardUpsertIndexEntry): void => {
      const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
      kv.write(cardId, entry);
    },
    liveCardToTaskConfig,
    hashTaskConfig: computeStableJsonHash,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const compatCommandHandlers = createCompatCommandHandlers({
    getCardAdminStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    upsertCardById: cardCommandHandlers.upsertCardById,
    validateCards: nonCoreCommandHandlers.validateCards,
    resolveCardGlobMatches,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
    cmdSourceDataFetched: (args: string[]) => callbackCommandHandlers.cmdSourceDataFetched(args),
  });

  const executionCommandHandlers = createExecutionCommandHandlers({
    getConfigStore: createBoardConfig,
    makeTempFilePath: makeBoardTempFilePath,
    executor,
    encodeSourceToken,
    decodeSourceToken,
    decodeCallbackToken,
    getCliInvocation: buildBoardCliInvocation.bind(null, __dirname),
    appendEventToJournal,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
    processAccumulatedEventsForced: scheduleForced,
    lookupCardPath,
    nextEntryAfterFetchDelivery,
  });

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':            return nonCoreCommandHandlers.cmdHelp();
    case 'init':           return boardCommandHandlers.cmdInit(rest);
    case 'status':         return boardCommandHandlers.cmdStatus(rest);
    case 'upsert-card':    return rest.some((a: string) => a === '--card' || a === '--card-glob')
      ? compatCommandHandlers.compatUpsertCard(rest)
      : cardCommandHandlers.cmdUpsertCard(rest);
    case 'validate-card':  return rest.some((a: string) => a === '--card' || a === '--card-glob')
      ? compatCommandHandlers.compatValidateCard(rest)
      : nonCoreCommandHandlers.cmdValidateCard(rest);
    case 'remove-card':              return boardCommandHandlers.cmdRemoveCard(rest);
    case 'retrigger':                 return boardCommandHandlers.cmdRetrigger(rest);
    case 'task-completed':            return callbackCommandHandlers.cmdTaskCompleted(rest);
    case 'task-failed':               return callbackCommandHandlers.cmdTaskFailed(rest);
    case 'task-progress':             return callbackCommandHandlers.cmdTaskProgress(rest);
    case 'source-data-fetched':       return rest.some((a: string) => a === '--tmp')
      ? compatCommandHandlers.compatSourceDataFetchedTmp(rest)
      : callbackCommandHandlers.cmdSourceDataFetched(rest);
    case 'source-data-fetch-failure': return callbackCommandHandlers.cmdSourceDataFetchFailure(rest);
    case 'run-sourcedefs-internal':      return executionCommandHandlers.cmdRunSources(rest);
    case 'run-inference-internal':    return executionCommandHandlers.cmdRunInference(rest);
    case 'inference-done':            return executionCommandHandlers.cmdInferenceDone(rest);
    case 'run-source-fetch':          return nonCoreCommandHandlers.cmdRunSourceFetch(rest);
    case 'probe-source':               return await nonCoreCommandHandlers.cmdProbeSource(rest);
    case 'describe-task-executor-capabilities': return nonCoreCommandHandlers.cmdDescribeTaskExecutorCapabilities(rest);
    case 'process-accumulated-events': return await executionCommandHandlers.cmdTryDrain(rest);
    default:
      throw new Error(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
