/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

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
  genUUID,
  getHash,
  resolveModuleDir,
} from './process-runner.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import { blobStorageForRef } from './public-storage-adapter.js';
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
import { createCallbackCommandHandlers, injectTaskProgress } from './board-live-cards-cli-callbacks.js';
import { createCardCommandHandlers } from './board-live-cards-cli-card-commands.js';
import { createCompatCommandHandlers } from './board-live-cards-cli-compat.js';
import type { CardUpsertIndexEntry } from './board-live-cards-all-stores.js';
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
  type BoardConfigStore, type CardStore,
} from './board-live-cards-all-stores.js';
// Re-export domain types and functions for backward compatibility
import { nextEntryAfterFetchDelivery, Resp, type CommandResponse } from './board-live-cards-lib-types.js';
import type { InvocationAdapter, CommandExecutor } from './process-interface.js';
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
      const tmp = `${indexPath}.${process.pid}.${genUUID()}.tmp`;
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
      const tmp = `${key}.${process.pid}.${genUUID()}.tmp`;
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(JSON.parse(json), null, 2), 'utf-8');
      renameSync(tmp, key);
      return getHash(json);
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
    generateId() { return genUUID(); },
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
        return { dispatched: true, invocationId: genUUID() };
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
    return getHash(stableStringify(values));
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
    const entry: JournalEntry = { id: genUUID(), event };
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
    commitId: genUUID(),
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
    commitId: genUUID(),
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
  const tmpPath = `${filePath}.${process.pid}.${genUUID()}.tmp`;
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
    const executionRequestStore = createExecutionRequestStore(createFsKvStorage(path.join(boardDir, '.execution-requests')), onDispatchFailed);
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

const __dirname = resolveModuleDir(import.meta.url);

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

// ============================================================================
// Non-core command handlers (inlined from board-live-cards-cli-noncore.ts)
// ============================================================================

interface ValidateResultLike {
  errors: string[];
}

interface NonCoreCommandDeps {
  getConfigStore: (boardDir: string) => BoardConfigStore;
  getCardStore: (boardDir: string) => CardStore;
  executor: CommandExecutor;
  makeTempFilePath: (boardDir: string, label: string, ext?: string) => string;
  validateLiveCardDefinition: (card: Record<string, unknown>) => ValidateResultLike;
  readStdin: () => string;
}

interface NonCoreCommandHandlers {
  cmdHelp: () => void;
  cmdRunSourceFetch: (args: string[]) => void;
  cmdProbeSource: (args: string[]) => Promise<void>;
  cmdDescribeTaskExecutorCapabilities: (args: string[]) => void;
  cmdValidateCard: (args: string[]) => void;
  /** Direct validate — used by compat layer to avoid stdin coupling. */
  validateCards: (cards: Record<string, unknown>[], boardDir: string | undefined) => CommandResponse<{ cardId: string; errors: string[] }>[];
}

function createNonCoreCommandHandlers(deps: NonCoreCommandDeps): NonCoreCommandHandlers {
  function cmdRunSourceFetch(args: string[]): void {
    const inIdx  = args.indexOf('--in-ref');
    const outIdx = args.indexOf('--out-ref');
    const errIdx = args.indexOf('--err-ref');

    const inFile  = inIdx  !== -1 ? args[inIdx + 1]  : undefined;
    const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;
    const errFile = errIdx !== -1 ? args[errIdx + 1] : undefined;

    if (!inFile || !outFile) {
      console.error('Usage: board-live-cards run-source-fetch --in-ref <::kind::value> --out-ref <::kind::value> [--err-ref <::kind::value>]');
      process.exit(1);
    }

    // Parse refs
    let inRef: ReturnType<typeof parseRef>;
    let outRef: ReturnType<typeof parseRef>;
    let errRef: ReturnType<typeof parseRef> | undefined;
    try {
      inRef = parseRef(inFile);
      outRef = parseRef(outFile);
      if (errFile) errRef = parseRef(errFile);
    } catch (e) {
      console.error(`[run-source-fetch] invalid ref: ${(e as Error).message}`);
      process.exit(1);
    }

    const inStorage = blobStorageForRef(inRef);
    const outStorage = blobStorageForRef(outRef);
    const errStorage = errRef ? blobStorageForRef(errRef) : undefined;

    function writeErr(msg: string): void {
      if (errStorage && errRef) errStorage.write(errRef.value, msg);
    }

    // Read and parse source definition
    const rawIn = inStorage.read(inRef.value);
    if (rawIn === null) {
      const msg = `Input not found: ${inFile}`;
      writeErr(msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }
    let source: any;
    try {
      source = JSON.parse(rawIn);
    } catch (err) {
      const msg = `Failed to parse input: ${(err as Error).message}`;
      writeErr(msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }

    // Source must have a cli field
    if (!source.cli) {
      const msg = 'Source definition missing cli field (board-live-cards built-in executor only understands source.cli)';
      writeErr(msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }

    // Execute the source cli command
    console.log(`[run-source-fetch] executing: ${source.cli}`);
    const timeout = source.timeout ?? 120_000;
    const sourceCwd = typeof source.cwd === 'string' ? source.cwd : process.cwd();
    const sourceBoardDir = typeof source.boardDir === 'string' ? source.boardDir : undefined;

    const cmdParts = deps.executor.splitCommand(source.cli);
    if (cmdParts.length === 0) {
      const msg = 'Source cli command is empty';
      writeErr(msg);
      console.error(`[run-source-fetch] ${msg}`);
      process.exit(1);
    }
    const rawCmd = cmdParts[0];
    const { cmd, args: cliArgs } = deps.executor.resolveInvocation(rawCmd, cmdParts.slice(1));

    let stdout: string;
    try {
      stdout = deps.executor.executeSync(cmd, cliArgs, {
        shell: false,
        encoding: 'utf-8',
        timeout,
        cwd: sourceCwd,
        env: {
          ...process.env,
          ...(sourceBoardDir ? { BOARD_DIR: sourceBoardDir } : {}),
        },
      }) as string;
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      console.error(`[run-source-fetch] cli failed: ${msg}`);
      writeErr(msg);
      process.exit(1);
    }

    // Write result to --out
    const result = stdout!.trim();
    try {
      outStorage.write(outRef.value, result);
      console.log(`[run-source-fetch] result written to ${outFile}`);
    } catch (err) {
      const msg = `Failed to write output: ${(err as Error).message}`;
      console.error(`[run-source-fetch] ${msg}`);
      writeErr(msg);
      process.exit(1);
    }
  }

  async function cmdProbeSource(args: string[]): Promise<void> {
    const cardIdx = args.indexOf('--card');
    const sourceIdxArg = args.indexOf('--source-idx');
    const sourceBindArg = args.indexOf('--source-bind');
    const mockProjectionsIdx = args.indexOf('--mock-projections');
    const rgIdx = args.indexOf('--rg');
    const outIdx = args.indexOf('--out');

    const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const sourceIdxVal = sourceIdxArg !== -1 ? parseInt(args[sourceIdxArg + 1], 10) : 0;
    const sourceBindVal = sourceBindArg !== -1 ? args[sourceBindArg + 1] : undefined;
    const mockProjectionsRaw = mockProjectionsIdx !== -1 ? args[mockProjectionsIdx + 1] : undefined;
    const boardDirArg = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;

    if (!cardFilePath) {
      console.error('Usage: board-live-cards probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>] [--mock-projections <json>] [--rg <boardDir>] [--out <result.json>]');
      process.exit(1);
    }

    // Read card
    let card: any;
    try {
      card = JSON.parse(fs.readFileSync(path.resolve(cardFilePath), 'utf-8'));
    } catch (e) {
      console.error(`[probe-source] Cannot read card: ${(e as Error).message}`);
      process.exit(1);
    }

    const source_defs: any[] = card.source_defs ?? [];
    if (source_defs.length === 0) {
      console.error(`[probe-source] Card "${card.id}" has no source_defs`);
      process.exit(1);
    }

    // Select source by index or bindTo name
    let sourceIdx: number;
    if (sourceBindVal) {
      sourceIdx = source_defs.findIndex((s: any) => s.bindTo === sourceBindVal);
      if (sourceIdx === -1) {
        console.error(`[probe-source] No source with bindTo="${sourceBindVal}" in card "${card.id}"`);
        process.exit(1);
      }
    } else {
      sourceIdx = sourceIdxVal;
      if (isNaN(sourceIdx) || sourceIdx < 0 || sourceIdx >= source_defs.length) {
        console.error(`[probe-source] --source-idx ${sourceIdxVal} out of range (card has ${source_defs.length} source(s))`);
        process.exit(1);
      }
    }

    const sourceDef = source_defs[sourceIdx];
    const cardDir = path.resolve(path.dirname(cardFilePath));
    const boardDir = boardDirArg ? path.resolve(boardDirArg) : cardDir;

    // Parse --mock-projections (JSON string or @file.json) — pre-resolved _projections values for testing
    let mockProjections: Record<string, unknown> = {};
    if (mockProjectionsRaw) {
      const raw = mockProjectionsRaw.startsWith('@')
        ? fs.readFileSync(path.resolve(mockProjectionsRaw.slice(1)), 'utf-8')
        : mockProjectionsRaw;
      try {
        mockProjections = JSON.parse(raw);
      } catch (e) {
        console.error(`[probe-source] --mock-projections is not valid JSON: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Detect registered task-executor
    const teConfig = deps.getConfigStore(boardDir).readTaskExecutorConfig();
    const taskExecutorCmd = teConfig?.command;
    const taskExecutorBaseArgs = teConfig?.args ?? [];
    const taskExecutorExtraB64 = teConfig?.extra
      ? Buffer.from(JSON.stringify(teConfig.extra)).toString('base64')
      : undefined;

    // Build --in payload — mirrors exactly what run-sourcedefs-internal passes to the executor
    const inPayload: Record<string, unknown> = {
      ...sourceDef,
      cwd: typeof sourceDef.cwd === 'string' && sourceDef.cwd ? sourceDef.cwd : cardDir,
      boardDir: typeof sourceDef.boardDir === 'string' && sourceDef.boardDir ? sourceDef.boardDir : boardDir,
      _projections: mockProjections,
    };

    // Derive sourceKind from executor's describe-capabilities rather than hardcoding.
    // Call describe-capabilities, get sourceKinds keys, find which one appears in sourceDef.
    // Falls back to 'unknown' if executor is unavailable or call fails.
    let sourceKind = 'unknown';
    if (taskExecutorCmd) {
      try {
        const capRaw = deps.executor.executeSync(taskExecutorCmd, [...taskExecutorBaseArgs, 'describe-capabilities'], {
          timeout: 8_000, encoding: 'utf-8',
        });
        const caps = JSON.parse(String(capRaw));
        const knownKinds: string[] = caps?.sourceKinds ? Object.keys(caps.sourceKinds) : [];
        const defKeys = new Set(Object.keys(sourceDef));
        sourceKind = knownKinds.find(k => defKeys.has(k)) ?? 'unknown';
      } catch {
        // describe-capabilities failed — fall back to 'unknown'; probe execution still proceeds
      }
    }

    console.log(`[probe-source] card:        ${card.id}`);
    console.log(`[probe-source] source[${sourceIdx}]:  bindTo="${sourceDef.bindTo}" kind=${sourceKind}`);
    console.log(`[probe-source] _projections:       ${JSON.stringify(mockProjections)}`);
    console.log(`[probe-source] executor:    ${taskExecutorCmd ?? 'built-in (source.cli only)'}`);
    console.log('[probe-source] running fetch...');

    const inFile = deps.makeTempFilePath(boardDir, `probe-in-${sourceDef.bindTo}`);
    const tmpOut = deps.makeTempFilePath(boardDir, `probe-out-${sourceDef.bindTo}`);
    const errFile = deps.makeTempFilePath(boardDir, `probe-err-${sourceDef.bindTo}`, '.txt');

    fs.writeFileSync(inFile, JSON.stringify(inPayload, null, 2), 'utf-8');

    const inRef  = serializeRef({ kind: 'fs-path', value: inFile });
    const outRef = serializeRef({ kind: 'fs-path', value: tmpOut });
    const errRef = serializeRef({ kind: 'fs-path', value: errFile });

    let passed = false;
    let errorMsg: string | undefined;
    let resultRaw: string | undefined;

    try {
      if (taskExecutorCmd) {
        const executorArgs = [...taskExecutorBaseArgs, 'run-source-fetch',
          '--in-ref', inRef, '--out-ref', outRef, '--err-ref', errRef,
        ];
        if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
        deps.executor.executeSync(taskExecutorCmd, executorArgs, {
          timeout: (sourceDef.timeout as number) ?? 30_000,
        });
      } else {
        // Built-in path: only source.cli is supported
        if (!inPayload.cli) {
          throw new Error('No task-executor registered and source has no cli field — cannot probe with built-in executor');
        }
        const cmdParts = deps.executor.splitCommand(inPayload.cli as string);
        const rawCmd = cmdParts[0];
        const { cmd, args: cliArgs } = deps.executor.resolveInvocation(rawCmd, cmdParts.slice(1));
        const stdout = deps.executor.executeSync(cmd, cliArgs, {
          shell: false,
          encoding: 'utf-8',
          timeout: (sourceDef.timeout as number) ?? 30_000,
          cwd: inPayload.cwd as string,
        });
        fs.writeFileSync(tmpOut, String(stdout).trim(), 'utf-8');
      }

      passed = fs.existsSync(tmpOut);
      if (passed) {
        resultRaw = fs.readFileSync(tmpOut, 'utf-8');
      } else {
        errorMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
      }
    } catch (e) {
      errorMsg = (e as Error).message ?? String(e);
      if (!errorMsg && fs.existsSync(errFile)) {
        errorMsg = fs.readFileSync(errFile, 'utf-8').trim();
      }
    }

    // Cleanup temp inputs
    for (const f of [inFile, errFile]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }

    // Report
    if (passed && resultRaw !== undefined) {
      const resultSize = resultRaw.length;
      const sample = resultRaw.slice(0, 300);
      console.log('[probe-source] STATUS:      PROBE_PASS');
      console.log(`[probe-source] result size: ${resultSize} bytes`);
      console.log(`[probe-source] sample:      ${sample}${resultSize > 300 ? '...' : ''}`);
      if (outFile) {
        fs.writeFileSync(path.resolve(outFile), resultRaw);
        console.log(`[probe-source] result written to: ${outFile}`);
      } else {
        try { fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
      }
    } else {
      console.log('[probe-source] STATUS:      PROBE_FAIL');
      if (errorMsg) console.log(`[probe-source] error:       ${errorMsg}`);
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
    }

    // Machine-readable summary line — agents parse this
    const summary = {
      status: passed ? 'PROBE_PASS' : 'PROBE_FAIL',
      cardId: card.id as string,
      sourceIdx,
      bindTo: sourceDef.bindTo as string,
      sourceKind,
      mockProjectionsKeys: Object.keys(mockProjections),
      resultSizeBytes: resultRaw !== undefined ? resultRaw.length : 0,
      error: errorMsg ?? undefined,
    };
    console.log(`[probe-source:result] ${JSON.stringify(summary)}`);

    process.exit(passed ? 0 : 1);
  }

  function cmdDescribeTaskExecutorCapabilities(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const boardDir = rgIdx !== -1 ? path.resolve(args[rgIdx + 1]) : undefined;
    if (!boardDir) {
      console.error('Usage: board-live-cards describe-task-executor-capabilities --rg <dir>');
      process.exit(1);
    }

    const teConfig = deps.getConfigStore(boardDir).readTaskExecutorConfig();
    if (!teConfig) {
      console.error(`[describe-task-executor-capabilities] No .task-executor registered in ${boardDir}`);
      process.exit(1);
    }

    try {
      const stdout = deps.executor.executeSync(teConfig.command, [...(teConfig.args ?? []), 'describe-capabilities'], {
        timeout: 10_000,
        encoding: 'utf-8',
      });
      // Pass through the executor's JSON output directly
      process.stdout.write(String(stdout));
      if (!String(stdout).endsWith('\n')) process.stdout.write('\n');
    } catch (e) {
      console.error(`[describe-task-executor-capabilities] Executor failed: ${(e as Error).message ?? e}`);
      process.exit(1);
    }
  }

  function cmdHelp(): void {
    console.log(`
board-live-cards-cli — LiveCards board CLI

USAGE
  board-live-cards-cli <command> [options]

BOARD MANAGEMENT
  init <dir> [--task-executor <script>] [--chat-handler <script>] [--inference-adapter <script>] [--runtime-out <dir>]
    Create a new board in <dir>.
    If --task-executor is given, writes <dir>/.task-executor with the script path.
    If --chat-handler is given, writes <dir>/.chat-handler with the script path.
    If --inference-adapter is given, writes <dir>/.inference-adapter with the script path.
    Writes <dir>/.runtime-out (default: <dir>/runtime-out).
    Published runtime files:
      <runtime-out>/board-livegraph-status.json
      <runtime-out>/cards/<card-id>.computed.json
    Re-running init on an existing board is safe; handler registrations are updated.

  status --rg <dir> [--json]
    Read and print the published status snapshot from <runtime-out>/board-livegraph-status.json.
    --json emits the stable machine-readable status object.

CARD MANAGEMENT
  upsert-card --rg <dir> (--card <card.json> | --card-glob <glob>) [--card-id <card-id>] [--restart]
    Insert or update one or many cards.
    Enforces strict one-to-one mapping between card id and file path:
      - same id + same file path: update
      - new id + new file path: insert
      - id remap or file remap: rejected
    If --card-id is provided, it must match the id inside the file.
    --card-id is valid only with --card (single file), not with --card-glob.
    --restart clears the task so it re-triggers from scratch.

  validate-card (--card <card.json> | --card-glob <glob>) [--rg <boardDir>]
    Validate one or many card JSON files without adding them to a board.
    Checks JSON Schema structure, runtime expression syntax, and provides.ref namespaces.
    When --rg is provided, also invokes the board's task executor validate-source-def
    subcommand to structurally validate each source definition against supported kinds.
    Exits with code 1 if any card fails validation.

  remove-card --rg <dir> --id <card-id>
    Remove a card and its task from the board.

  retrigger --rg <dir> --task <task-name>
    Mark a task not-started and drain to re-trigger it.

TASK CALLBACKS  (called by task executor scripts)
  task-completed --token <callbackToken> [--data <json>]
    Signal successful task completion with optional JSON result data.

  task-failed --token <callbackToken> [--error <message>]
    Signal task failure with an optional error message.

  task-progress --rg <dir> --token <callbackToken> [--update <json>]
    Signal task progress with optional update payload (for waiting on more evidence, etc.).

SOURCE CALLBACKS  (called internally by run-sourcedefs-internal)
  source-data-fetched --tmp <file> --token <sourceToken>
    Atomically rename <file> into the outputFile destination and record delivery
    via journal events. Appends a task-progress event to re-invoke the card handler.

  source-data-fetch-failure --token <sourceToken> [--reason <message>]
    Record a source fetch failure via journal events and append a task-progress event.

INTERNAL COMMANDS
  process-accumulated-events --rg <dir>
    Executes forced drain for this board.
    This command is also used as the background relay worker.
    By default it schedules a detached worker and returns quickly.
    Internal workers run with --inline-loop to perform the settle loop.

    Eventual-progress guarantee is relay-based (not per-call blocking guarantee):
    1) at least one runner continues processing,
    2) no crash/forced exit in relay window,
    3) lock stays healthy,
    4) event production eventually quiesces.

  run-sourcedefs-internal --card <card.json> --token <callbackToken> --rg <dir>
    Execute all source[] entries for a card, then report delivery or failure.
    (Internal command — invoked by the card-handler. Not intended for direct use.)

    If <dir>/.task-executor exists, invokes it with run-source-fetch subcommand:
      <executor> run-source-fetch --in <source_json> --out <outfile> --err <errfile>

    If no .task-executor is registered, uses board-live-cards built-in run-source-fetch.

  run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
    Execute a source definition. Board-live-cards reads source.cli and executes it.
    Writes result to --out. Presence of --out after exit indicates success.

  describe-task-executor-capabilities --rg <dir>
    Invoke the registered task-executor's describe-capabilities subcommand and
    print its capabilities JSON to stdout.  Requires a .task-executor file in <dir>.

  probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>]
               [--mock-projections <json>] [--rg <boardDir>] [--out <result.json>]
    Validate that a card source can be fetched successfully.
    Reads the card file, extracts the chosen source (default: index 0), builds the
    run-source-fetch --in payload with the supplied _projections data, invokes the
    registered task-executor (or built-in executor for source.cli), and reports pass/fail.
    --mock-projections:     JSON string (or @file.json) providing pre-resolved _projections values
                     the source needs.  Craft the minimal payload that exercises the
                     source — e.g. '{"holdings":[{"ticker":"AAPL","quantity":10}]}'.
                     If omitted, _projections is passed as empty ({}).
    --source-idx:    0-based index into card.source_defs[]. Default: 0.
    --source-bind:   Select source by its bindTo name instead of index.
    --rg:            Board directory used to find .task-executor. Defaults to the
                     directory containing the card file.
    --out:           Optional path to write the raw fetch result JSON.
    Prints a structured report ending with a [probe-source:result] JSON line.
    Exits 0 on PROBE_PASS, 1 on PROBE_FAIL.

  run-inference-internal --in <input.json> --token <inferenceToken>
    Execute inference via registered .inference-adapter and forward result to inference-done.
    inferenceToken encodes boardDir (rg), cardId (cid), callbackToken (cbk), checksum (cs).
    (Internal command — invoked by the card-handler when custom completion rule is used.)

  inference-done --tmp <result.json> --token <inferenceToken>
    Persist llm_task_completion_inference on the card and append a task-progress event.
    Reads boardDir/callbackToken/checksum from decoded inferenceToken; deletes --tmp file after reading.
    (Internal command — invoked by run-inference-internal.)

RUN-SOURCE-FETCH PROTOCOL
  External task-executors implement:
    <executor> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]

  INPUT:   --in file contains the full source_defs[x] definition object
  OUTPUT:  --out file is written with the result to signal success.
           --err file may be written to explain failure.

  Exit code and --out presence determine success:
    Exit 0 + --out file present → source delivery recorded, card re-evaluated.
    Exit non-zero OR --out absent → source-data-fetch-failure recorded.

BOARD-LIVE-CARDS BUILT-IN EXECUTOR
  Understands source.cli field only:
    "source_defs": [{ "cli": "node ../fetch-prices.js", "bindTo": "prices", "outputFile": "prices.json" }]

  The source.cli command is executed with:
    - Direct command invocation (no shell; quote-aware argument parsing)
    - Stdout is captured and delivered to the card as-is
    - Timeout from source.timeout (default 120s)

  The source.cli command must:
    - Execute successfully (exit 0)
    - Write output to stdout
    - Complete within the timeout

  The output format is the concern of the card's compute function to interpret.

  External task-executors can interpret source definitions however they want.

EXAMPLES
  board-live-cards-cli init ./my-board
  board-live-cards-cli init ./my-board --task-executor ./executors/my-runner.py
  board-live-cards-cli upsert-card --rg ./my-board --card cards/prices.json
  board-live-cards-cli status --rg ./my-board
  board-live-cards-cli retrigger --rg ./my-board --task price-fetch
  board-live-cards-cli probe-source --card cards/card-market-prices.json --source-idx 0 --rg ./my-board --mock-projections '{"holdings":[{"ticker":"AAPL","quantity":10}]}'
`.trimStart());
  }

  function validateCardObjects(
    cards: Record<string, unknown>[],
    boardDir: string | undefined,
  ): CommandResponse<{ cardId: string; errors: string[] }>[] {
    const teConfig = boardDir ? deps.getConfigStore(boardDir).readTaskExecutorConfig() : undefined;

    return cards.map((card) => {
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const schemaErrors = deps.validateLiveCardDefinition(card).errors;
      const sourceErrors: string[] = [];

      if (teConfig && Array.isArray(card.source_defs)) {
        for (const src of card.source_defs as Array<Record<string, unknown>>) {
          const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
          const tmpFile = deps.makeTempFilePath(boardDir!, `validate-src-${bindTo}`);
          try {
            fs.writeFileSync(tmpFile, JSON.stringify(src), 'utf-8');
            let stdout: string;
            try {
              stdout = deps.executor.executeSync(
                teConfig.command,
                [...(teConfig.args ?? []), 'validate-source-def', '--in', tmpFile],
                { timeout: 10_000 },
              );
            } catch (execErr: any) {
              stdout = typeof execErr?.stdout === 'string' ? execErr.stdout
                : Buffer.isBuffer(execErr?.stdout) ? execErr.stdout.toString('utf-8')
                : '';
              if (!stdout.trim()) {
                sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${execErr instanceof Error ? execErr.message : String(execErr)}`);
                continue;
              }
            }
            const parsed = JSON.parse(stdout.trim());
            if (!parsed.ok && Array.isArray(parsed.errors)) {
              for (const error of parsed.errors) {
                sourceErrors.push(`source "${bindTo}": ${error}`);
              }
            }
          } catch (err) {
            sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }
      }

      const allErrors = [...schemaErrors, ...sourceErrors];
      if (allErrors.length === 0) {
        return Resp.success({ cardId, errors: [] as string[] });
      }
      return Resp.error(allErrors.join('; '), { cardId, errors: allErrors }) as CommandResponse<{ cardId: string; errors: string[] }>;
    });
  }

  function cmdValidateCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdIdx = args.indexOf('--card-id');
    const stdioMode = args.includes('--cards-stdio');
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;

    if (stdioMode) {
      // --cards-stdio: read JSON array of card objects from stdin, write results to stdout
      let cards: Record<string, unknown>[];
      try {
        const raw = deps.readStdin();
        cards = JSON.parse(raw) as Record<string, unknown>[];
        if (!Array.isArray(cards)) throw new Error('stdin must be a JSON array');
      } catch (err) {
        const resp = Resp.error(`Failed to parse stdin: ${err instanceof Error ? err.message : String(err)}`);
        console.log(JSON.stringify([resp]));
        return;
      }
      const results = validateCardObjects(cards, boardDir);
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (cardIdIdx !== -1) {
      // --card-id: read from CardStore
      const cardId = args[cardIdIdx + 1];
      if (!cardId || !boardDir) {
        throw new Error('Usage: board-live-cards validate-card --rg <boardDir> --card-id <id>');
      }
      const card = deps.getCardStore(boardDir).readCard(cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found in board at ${boardDir}`);
      }
      const [result] = validateCardObjects([card as Record<string, unknown>], boardDir);
      if (result.status === 'error') {
        for (const err of result.data.errors) console.error(`  ${err}`);
        throw new Error(`Card "${cardId}" failed validation.`);
      }
      console.log(`OK    ${cardId}`);
      return;
    }

    throw new Error('Usage: board-live-cards validate-card (--card-id <id> --rg <boardDir>) | (--cards-stdio [--rg <boardDir>])');
  }

  return {
    cmdHelp,
    cmdRunSourceFetch,
    cmdProbeSource,
    cmdDescribeTaskExecutorCapabilities,
    cmdValidateCard,
    validateCards: validateCardObjects,
  };
}

// ============================================================================
// Execution command handlers (inlined from board-live-cards-cli-execution-commands.ts)
// ============================================================================

// Local type aliases (mirrors non-exported types in main CLI module)
interface SourceTokenPayloadLike {
  cbk: string;
  rg: string;
  cid: string;
  b: string;
  d: string;
  cs?: string;
}

interface FetchRuntimeEntryLike {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  queueRequestedAt?: string;
}

interface CardRuntimeStateLike {
  _sources: Record<string, FetchRuntimeEntryLike>;
  _inferenceEntry?: FetchRuntimeEntryLike;
}

interface ExecutionCommandDeps {
  getConfigStore: (boardDir: string) => BoardConfigStore;
  makeTempFilePath: (boardDir: string, label: string, ext?: string) => string;
  executor: CommandExecutor;
  encodeSourceToken: (payload: SourceTokenPayloadLike) => string;
  decodeSourceToken: (token: string) => SourceTokenPayloadLike | null;
  decodeCallbackToken: (token: string) => { taskName: string } | null;
  getCliInvocation: (command: string, args: string[]) => { cmd: string; args: string[] };
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
  processAccumulatedEventsForced: (boardDir: string) => Promise<void>;
  lookupCardPath: (boardDir: string, cardId: string) => string | null;
  nextEntryAfterFetchDelivery: <T extends FetchRuntimeEntryLike>(entry: T, fetchedAt: string) => T;
}

interface ExecutionCommandHandlers {
  cmdRunSources: (args: string[]) => void;
  cmdRunInference: (args: string[]) => void;
  cmdInferenceDone: (args: string[]) => void;
  cmdTryDrain: (args: string[]) => Promise<void>;
}

function createExecutionCommandHandlers(deps: ExecutionCommandDeps): ExecutionCommandHandlers {
  // Local helpers used only by cmdRunSources
  function invokeSourceDataFetched(sourceToken: string, tmpFile: string, callback: (err: Error | null) => void): void {
    const { cmd, args } = deps.getCliInvocation('source-data-fetched', ['--ref', serializeRef({ kind: 'fs-path', value: tmpFile }), '--token', sourceToken]);
    deps.executor.executeAsync(cmd, args, (err, stdout, stderr) => {
      if (err) console.error(`[source-data-fetched] call failed:`, err.message);
      if (stdout) console.log(stdout.trim());
      if (stderr) console.error(stderr.trim());
      callback(err);
    });
  }

  function invokeSourceDataFetchFailure(sourceToken: string, reason: string, callback: (err: Error | null) => void): void {
    const { cmd, args } = deps.getCliInvocation('source-data-fetch-failure', ['--token', sourceToken, '--reason', reason]);
    deps.executor.executeAsync(cmd, args, (err) => callback(err));
  }

  function cmdRunSources(args: string[]): void {
    const cardIdx = args.indexOf('--card');
    const tokenIdx = args.indexOf('--token');
    const rgIdx = args.indexOf('--rg');
    const sourceChecksumsIdx = args.indexOf('--source-checksums');
    const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const callbackToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const sourceChecksumsJson = sourceChecksumsIdx !== -1 ? args[sourceChecksumsIdx + 1] : undefined;
    const sourceChecksums = sourceChecksumsJson ? JSON.parse(sourceChecksumsJson) as Record<string, string> : undefined;
    if (!cardFilePath || !callbackToken || !boardDir) {
      console.error('Usage: board-live-cards run-sourcedefs-internal --card <path> --token <token> --rg <dir> [--source-checksums <json>]');
      process.exit(1);
    }

    const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));
    if (path.basename(cardFilePath).startsWith('card-enriched-')) {
      try { fs.unlinkSync(cardFilePath); } catch { /* best-effort */ }
    }
    console.log(`[run-sourcedefs-internal] Processing card "${card.id as string}"`);

    type SourceDef = {
      cli?: string;
      bindTo: string;
      outputFile?: string;
      optionalForCompletionGating?: boolean;
      timeout?: number;
      cwd?: string;
      boardDir?: string;
    };

    function runSource(src: SourceDef): void {
      const sourceChecksumForInvoke = src.outputFile ? sourceChecksums?.[src.outputFile] : undefined;
      const sourceToken = deps.encodeSourceToken({
        cbk: callbackToken!,
        rg: boardDir!,
        cid: card.id as string,
        b: src.bindTo,
        d: src.outputFile ?? '',
        cs: sourceChecksumForInvoke,
      });

      function reportFailure(reason: string): void {
        invokeSourceDataFetchFailure(sourceToken, reason, (err) => {
          if (err) console.error(`[run-sourcedefs-internal] source-data-fetch-failure call failed:`, err.message);
        });
      }

      function reportFetched(outFile: string): void {
        invokeSourceDataFetched(sourceToken, outFile, () => {
          // logging already done in helper
        });
      }

      // Execute source.cli directly in this process.
      if (!src.outputFile) {
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
        reportFailure('no outputFile configured');
        return;
      }
      const outFile = deps.makeTempFilePath(boardDir!, `source-out-${src.bindTo}`);
      if (!src.cli) {
        const errMsg = 'source.cli is required for built-in source execution';
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
        reportFailure(errMsg);
        return;
      }

      const timeout = src.timeout ?? 120_000;
      const sourceCwd = typeof src.cwd === 'string' ? src.cwd : path.dirname(cardFilePath || '');
      const sourceBoardDir = typeof src.boardDir === 'string' ? src.boardDir : boardDir;
      const cmdParts = deps.executor.splitCommand(src.cli);
      if (cmdParts.length === 0) {
        const errMsg = 'source.cli command is empty';
        console.warn(`[run-sourcedefs-internal] source "${src.bindTo}": ${errMsg}`);
        reportFailure(errMsg);
        return;
      }

      const rawCmd = cmdParts[0];
      const { cmd, args: cliArgs } = deps.executor.resolveInvocation(rawCmd, cmdParts.slice(1));

      let stdout: string;
      try {
        stdout = deps.executor.executeSync(cmd, cliArgs, {
          shell: false,
          encoding: 'utf-8',
          timeout,
          cwd: sourceCwd,
          env: {
            ...process.env,
            ...(sourceBoardDir ? { BOARD_DIR: sourceBoardDir } : {}),
          },
        });
      } catch (err: unknown) {
        const reason = (err as Error).message ?? String(err);
        console.error(`[run-sourcedefs-internal] source fetch failed for source "${src.bindTo}":`, reason);
        reportFailure(reason);
        return;
      }

      fs.writeFileSync(outFile, stdout.trim(), 'utf-8');
      reportFetched(outFile);
    }

    const source_defs = (card.source_defs ?? []) as SourceDef[];
    for (const src of source_defs) {
      runSource(src);
    }
  }

  function cmdRunInference(args: string[]): void {
    const inIdx = args.indexOf('--in-ref');
    const tokenIdx = args.indexOf('--token');
    const inRaw = inIdx !== -1 ? args[inIdx + 1] : undefined;
    const inferenceToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;

    if (!inRaw || !inferenceToken) {
      console.error('Usage: board-live-cards run-inference-internal --in-ref <::kind::value> --token <inference-token>');
      process.exit(1);
    }

    let inRef: ReturnType<typeof parseRef>;
    try { inRef = parseRef(inRaw); } catch (e) {
      console.error(`[run-inference-internal] invalid --in ref: ${(e as Error).message}`);
      process.exit(1);
    }

    // Decode inference token (encoded via encodeSourceToken: cbk, rg, cid, b='', d='', cs)
    const decodedToken = deps.decodeSourceToken(inferenceToken);
    if (!decodedToken) {
      console.error('Invalid inference token');
      process.exit(1);
    }
    const callbackToken = decodedToken.cbk;
    const boardDir = decodedToken.rg;

    const cbkDecoded = deps.decodeCallbackToken(callbackToken);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in inference token');
      process.exit(1);
    }

    function spawnInferenceDone(tmpFile: string): void {
      const { cmd, args: cliArgs } = deps.getCliInvocation('inference-done', ['--tmp', tmpFile, '--token', inferenceToken!]);
      deps.executor.spawnDetached(cmd, cliArgs);
    }

    function spawnInferenceDoneError(reason: string): void {
      const tmpFile = deps.makeTempFilePath(boardDir, 'inference-err');
      fs.writeFileSync(tmpFile, JSON.stringify({ isTaskCompleted: false, reason }), 'utf-8');
      spawnInferenceDone(tmpFile);
    }

    if (inRef!.kind !== 'fs-path' || !inRef!.value) {
      spawnInferenceDoneError(`inference input ref unsupported kind: ${inRef!.kind}`);
      return;
    }
    const inFile = inRef!.value;

    if (!fs.existsSync(inFile)) {
      spawnInferenceDoneError(`inference input not found: ${inFile}`);
      return;
    }

    const inferenceAdapter = deps.getConfigStore(boardDir).readInferenceAdapter();
    if (!inferenceAdapter) {
      spawnInferenceDoneError(`inference adapter is not configured (.inference-adapter)`);;
      return;
    }

    const outFile = deps.makeTempFilePath(boardDir, 'inference-out');
    const errFile = deps.makeTempFilePath(boardDir, 'inference-err', '.txt');
    const adapterParts = deps.executor.splitCommand(inferenceAdapter);
    if (adapterParts.length === 0) {
      spawnInferenceDoneError('inference adapter command is empty');
      return;
    }

    const adapterRawCmd = adapterParts[0];
    const adapterRawArgs = adapterParts.slice(1);
    const { cmd: adapterCmd, args: adapterArgsPrefix } = deps.executor.resolveInvocation(adapterRawCmd, adapterRawArgs);
    const adapterArgs = [...adapterArgsPrefix, 'run-inference',
      '--in-ref', serializeRef({ kind: 'fs-path', value: inFile }),
      '--out-ref', serializeRef({ kind: 'fs-path', value: outFile }),
      '--err-ref', serializeRef({ kind: 'fs-path', value: errFile }),
    ];

    try {
      deps.executor.executeSync(adapterCmd, adapterArgs, {
        shell: false,
        timeout: 120_000,
        cwd: boardDir,
        env: {
          ...process.env,
          BOARD_DIR: boardDir,
        },
      });
    } catch (err: unknown) {
      const reason = (err as Error).message ?? String(err);
      spawnInferenceDoneError(reason);
      return;
    }

    if (!fs.existsSync(outFile)) {
      const errMsg = fs.existsSync(errFile)
        ? fs.readFileSync(errFile, 'utf-8').trim()
        : 'inference adapter produced no output file';
      spawnInferenceDoneError(errMsg);
      return;
    }

    // Adapter wrote outFile — pass it directly as --tmp; cmdInferenceDone reads and deletes it.
    spawnInferenceDone(outFile);
  }

  function cmdInferenceDone(args: string[]): void {
    const tmpIdx = args.indexOf('--tmp');
    const tokenIdx = args.indexOf('--token');

    const tmpFile = tmpIdx !== -1 ? args[tmpIdx + 1] : undefined;
    const inferenceToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;

    if (!tmpFile || !inferenceToken) {
      console.error('Usage: board-live-cards inference-done --tmp <result.json> --token <inference-token>');
      process.exit(1);
    }

    const decodedToken = deps.decodeSourceToken(inferenceToken);
    if (!decodedToken) {
      console.error('Invalid inference token');
      process.exit(1);
    }

    const { cbk: callbackToken, rg: dir, cs: inputChecksum } = decodedToken;

    const decoded = deps.decodeCallbackToken(callbackToken);
    if (!decoded) {
      console.error('Invalid callback token embedded in inference token');
      process.exit(1);
    }

    const taskName = decoded.taskName;
    const cardPath = deps.lookupCardPath(dir, taskName);
    if (!cardPath) {
      console.error(`Card file for task "${taskName}" not found in inventory`);
      process.exit(1);
    }

    let result: { isTaskCompleted?: boolean; reason?: string; evidence?: string; data?: Record<string, unknown> } = {};
    if (fs.existsSync(tmpFile)) {
      try {
        result = JSON.parse(fs.readFileSync(tmpFile, 'utf-8').trim());
      } catch (err) {
        result = { isTaskCompleted: false, reason: `failed to parse inference result: ${err instanceof Error ? err.message : String(err)}` };
      }
      try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
    } else {
      result = { isTaskCompleted: false, reason: `inference result file not found: ${tmpFile}` };
    }

    const isTaskCompletedFlag = result.isTaskCompleted === true;
    const inferenceCompletedAt = new Date().toISOString();

    const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
    if (!card.card_data) card.card_data = {};
    const cardData = card.card_data as Record<string, unknown>;
    const existingInference = (cardData.llm_task_completion_inference && typeof cardData.llm_task_completion_inference === 'object')
      ? (cardData.llm_task_completion_inference as Record<string, unknown>)
      : {};
    cardData.llm_task_completion_inference = {
      ...existingInference,
      isTaskCompleted: isTaskCompletedFlag,
      reason: typeof result.reason === 'string' ? result.reason : '',
      evidence: typeof result.evidence === 'string' ? result.evidence : '',
      inferenceCompletedAt,
    };
    fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), 'utf-8');

    // Update inference runtime entry to reflect completion
    const runtimePath = path.join(dir, taskName, 'runtime.json');
    let runtime: CardRuntimeStateLike = { _sources: {} };
    if (fs.existsSync(runtimePath)) {
      try {
        runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as CardRuntimeStateLike;
      } catch {}
    }

    const inferenceEntry = runtime._inferenceEntry ?? {};
    runtime._inferenceEntry = deps.nextEntryAfterFetchDelivery(inferenceEntry, inferenceCompletedAt);

    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), 'utf-8');

    injectTaskProgress(dir, taskName, { kind: 'inference-done', isTaskCompleted: isTaskCompletedFlag, inputChecksum }, deps);
  }

  async function cmdTryDrain(args: string[]): Promise<void> {
    const rgIdx = args.indexOf('--rg');
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    if (!boardDir) {
      console.error('Usage: board-live-cards process-accumulated-events --rg <dir>');
      process.exit(1);
    }
    await deps.processAccumulatedEventsForced(boardDir);
  }

  return { cmdRunSources, cmdRunInference, cmdInferenceDone, cmdTryDrain };
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
    generateId: genUUID,
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
