/**
 * fs-board-adapter.ts
 *
 * Wires Node.js / FS platform adapters into BoardPlatformAdapter and
 * BoardNonCorePlatformAdapter, and provides FS-specific board utility functions.
 *
 * Everything in the board-live-cards system that is platform-free lives in
 * src/cli/common/. All FS / Node.js / process concerns live here.
 *
 * Re-exports the full public API so consumers only need to import from this file.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { InvocationAdapter, DescribeEnvelope } from '../../server-runtime/types.js';
import {
  resolveBoardCliCallbackTarget,
  resolveModuleDir,
  genUUID,
  getHash,
  joinPath,
  isAbsolutePath,
  publishJsonEventsToNamedPipe,
} from './process-runner.js';
import {
  createBoardWorkerQueueLane,
  createQueueStorageLane,
  drainQueueLaneToIdle,
} from './queue-runners.js';
import {
  invokeExecutionRef,
  resolveWhatToRunValue,
} from './execution-adapter.js';
import { createNonCoreExecutorDispatcher } from './non-core-executor-dispatcher.js';
import { serializeRef, parseRef } from '../common/storage-interface.js';
import type { KindValueRef } from '../common/storage-interface.js';
import type { BoardCallbackTransport } from '../common/board-callback-transport.js';
import {
  createLocalNodeBoardCallbackTransport,
} from '../common/board-callback-transport.js';
import { createBoardWorkerStore } from '../common/board-worker-store.js';
import type { BoardWorkerStore } from '../common/board-worker-store.js';
import {
  createFsKvStorage,
  createFsBlobStorage,
  createFsAbsolutePathBlobStorage,
  createFsAtomicRelayLock,
  createFsJournalStorageAdapter,
  createFsJournalStorage,
  createFsQueueStorage,
  createFsScratchStorage,
  createFsArchiveFactory,
  computeStableJsonHash,
} from './storage-fs-adapters.js';
import { validateLiveCardDefinition } from '../../card-compute/schema-validator.js';
import {
  createBoardLiveCardsPublic,
} from '../common/board-live-cards-public.js';
import type { BoardPlatformAdapter, BoardNonCorePlatformAdapter } from '../common/board-live-cards-public.js';
import { createChatStorage } from '../common/chat-storage-lib.js';
import type { ChatStorage } from '../common/chat-storage-lib.js';

// ============================================================================
// Re-export public API — consumers only need to import from this file
// ============================================================================

export { createBoardLiveCardsPublic, createBoardLiveCardsNonCorePublic } from '../common/board-live-cards-public.js';
export { createBoardLiveCardsMcp } from '../common/board-live-cards-mcp.js';
export type {
  BoardPlatformAdapter,
  BoardNonCorePlatformAdapter,
  CommandInput,
  CommandResult,
  BoardLiveCardsPublic,
  BoardLiveCardsNonCorePublic,
} from '../common/board-live-cards-public.js';
export type {
  BoardLiveCardsMcp,
  BoardLiveCardsMcpDeps,
  BoardLiveCardsMcpDiscoverSourceKindsResult,
  BoardLiveCardsMcpBoardStatusResult,
  BoardLiveCardsMcpInspectCardDefinitionAndRuntimeResult,
  BoardLiveCardsMcpInspectChatMessagesResult,
  BoardLiveCardsMcpFileDownloadDescriptor,
  BoardLiveCardsMcpManageUpsertCardResult,
} from '../common/board-live-cards-mcp.js';
export { BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1, EMPTY_CONFIG } from '../common/board-live-cards-public.js';
export {
  parseRef,
  serializeRef,
} from '../common/storage-interface.js';
export type { KindValueRef } from '../common/storage-interface.js';
export {
  executionRefFromScriptPath,
  serializeExecutionRef,
  parseExecutionRef,
} from '../common/execution-interface.js';
export type { ExecutionRef } from '../common/execution-interface.js';
export { createCardStorePublic } from '../common/card-store-lib-public.js';
export { createQueueStoragePublic } from '../common/queue-storage-public.js';
export { createArtifactsStorePublic } from '../common/artifacts-store-lib-public.js';
export { createCardStore } from '../common/board-live-cards-lib.js';
export { createBoardWorkerStore } from '../common/board-worker-store.js';
export { createArtifactsStore, createFileArtifactsStore, createCardFileMetadataStore } from '../common/artifacts-store-lib.js';
import { createArtifactsStore } from '../common/artifacts-store-lib.js';
export { createChatStorage, createInMemoryChatStorage } from '../common/chat-storage-lib.js';
export type { ChatStorage, ChatRecord, ChatConfig } from '../common/chat-storage-lib.js';
export type {
  BoardWorkerDeadLetterRequest,
  BoardWorkerLeasedRequest,
  BoardWorkerQueuedRequest,
  BoardWorkerRequest,
  BoardWorkerStore,
} from '../common/board-worker-store.js';
export type { QueueStoragePublic } from '../common/queue-storage-public.js';
export type { LiveCard } from '../common/board-live-cards-lib.js';
export type { InvocationAdapter, DescribeEnvelope } from '../../server-runtime/types.js';
type BoardProcessAccumulatorInternal = ReturnType<typeof createBoardLiveCardsPublic> & {
  processAccumulatedEvents(input: {}): Promise<{ status: string; error?: string }>;
};
export {
  buildLocalBaseSpec,
  createExecutionRefInvoker,
  evaluateArgsMassaging,
  invokeExecutionRef,
  invokeExecutionRefSync,
  invokeRefSync,
  registerInProcessExecutionHandler,
  resolveWhatToRunValue,
  resolveYamlFlowCliPath,
  unregisterInProcessExecutionHandler,
} from './execution-adapter.js';
export { createHostedAsyncBoardNonCorePublic } from '../cloud/hosted-async-board-non-core.js';
export { createNonCoreExecutorDispatcher } from './non-core-executor-dispatcher.js';
export {
  createHttpBoardCallbackTransport,
  createInProcessBoardCallbackTransport,
  createLocalNodeBoardCallbackTransport,
} from '../common/board-callback-transport.js';
export type {
  CreateExecutionRefInvokerOptions,
  ExecutionRefInvoker,
  InProcessExecutionHandler,
  InvokeExecutionRefOptions,
  InvokeRefResult,
  SyncTransportInvoker,
  TransportInvoker,
} from './execution-adapter.js';
export { createFsQueueStorage, createFsBlobStorage } from './storage-fs-adapters.js';
export {
  createBoardWorkerQueueLane,
  createQueueStorageLane,
  drainQueueLaneToIdle,
  startQueueLaneRunner,
  startQueueLaneRunners,
} from './queue-runners.js';
export { createQueueLaneRegistry } from '../common/queue-lane-registry.js';
export type {
  QueueLaneDescriptor,
  QueueLaneLease,
  QueueLaneRegistry,
} from '../common/queue-lane-registry.js';

// ============================================================================
// createNodeSpawnInvocationAdapter
// ============================================================================

/**
 * Creates a Node host InvocationAdapter backed by `spawn`/`spawnSync`.
 *
 * Supports howToRun: 'local-node'
 *   → the Node host adapter spawns the script as a detached child process.
 *
 * Pass to createSingleBoardServerRuntime / createMultiBoardServerRuntime as
 * the `invocationAdapter` option. This is the reference Node host implementation;
 * replace with your own for Azure Functions, Lambda, etc.
 */
export function createNodeSpawnInvocationAdapter(): InvocationAdapter {
  return {
    async invoke(ref, args): Promise<{ dispatched: boolean; error?: string }> {
      if (ref.howToRun !== 'local-node') {
        return { dispatched: false, error: `createNodeSpawnInvocationAdapter: unsupported howToRun "${ref.howToRun}"` };
      }
      let scriptPath = '';
      try {
        const w = ref.whatToRun;
        scriptPath = resolveWhatToRunValue(w);
      } catch {
        scriptPath = '';
      }
      if (!scriptPath) {
        return { dispatched: false, error: `createNodeSpawnInvocationAdapter: could not resolve executable path from whatToRun` };
      }
      const finalArgs: Record<string, unknown> = { ...args };
      const extra = Buffer.from(JSON.stringify(finalArgs)).toString('base64');
      try {
        const proc = spawn(process.execPath, [
          scriptPath,
          '--boardId', String(args.boardId ?? ''),
          '--cardId',  String(args.cardId  ?? ''),
          '--extraEncJson', extra,
        ], { stdio: 'ignore', windowsHide: true });
        proc.unref();
        return { dispatched: true };
      } catch (err) {
        return { dispatched: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async describe(ref): Promise<DescribeEnvelope | null> {
      if (ref.howToRun !== 'local-node') return null;
      let scriptPath = '';
      try {
        const w = ref.whatToRun;
        scriptPath = resolveWhatToRunValue(w);
      } catch {
        scriptPath = '';
      }
      if (!scriptPath) return null;
      try {
        const result = spawnSync(process.execPath, [scriptPath, 'describe'], {
          timeout: 5000, encoding: 'utf-8', windowsHide: true,
        });
        if (result.status !== 0) return null;
        return JSON.parse(String(result.stdout).trim()) as DescribeEnvelope;
      } catch { return null; }
    },
  };
}

// ============================================================================
// Constants
// ============================================================================

const BOARD_LOCK_FILE = '.board.lock';

type FsBoardAdapterOpts = {
  onWarn?: (msg: string) => void;
  suppressSpawn?: boolean;
  notifyChannel?: string;
  callbackTransport?: BoardCallbackTransport;
  boardRuntimeStoreRef?: string;
  queueStoreRef?: string;
};
type FsBoardNonCoreAdapterOpts = {
  onWarn?: (msg: string) => void;
  callbackTransport?: BoardCallbackTransport;
  /** Rewrite executor refs before dispatch (e.g. hosted queue-storage → local-node). */
  resolveRef?: (ref: import('../common/execution-interface.js').ExecutionRef) => import('../common/execution-interface.js').ExecutionRef;
};

function _pathAlreadyEndsWith(dir: string, segment: string): boolean {
  if (!dir || !segment) return false;
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 && parts[parts.length - 1] === segment;
}

function normalizeFsBoardAdapterArgs(
  cliDirOrOpts?: string | FsBoardAdapterOpts,
  opts?: FsBoardAdapterOpts,
): { cliDir?: string; opts?: FsBoardAdapterOpts } {
  return typeof cliDirOrOpts === 'string'
    ? { cliDir: cliDirOrOpts, opts }
    : { cliDir: undefined, opts: cliDirOrOpts };
}

function normalizeFsBoardNonCoreAdapterArgs(
  cliDirOrOpts?: string | FsBoardNonCoreAdapterOpts,
  opts?: FsBoardNonCoreAdapterOpts,
): { cliDir?: string; opts?: FsBoardNonCoreAdapterOpts } {
  return typeof cliDirOrOpts === 'string'
    ? { cliDir: cliDirOrOpts, opts }
    : { cliDir: undefined, opts: cliDirOrOpts };
}

function resolveDefaultCliDir(cliDir?: string): string {
  if (cliDir) return cliDir;

  const moduleDir = resolveModuleDir(import.meta.url);
  const candidates = [
    moduleDir,
    joinPath(moduleDir, '..', 'cli', 'node'),
    joinPath(moduleDir, '..', '..', 'cli', 'node'),
  ];

  for (const candidate of candidates) {
    try {
      resolveBoardCliCallbackTarget(candidate);
      return candidate;
    } catch {
      // Keep trying candidates until one resolves to the public CLI callback target.
    }
  }

  throw new Error(
    `createFsBoardPlatformAdapter: could not resolve a public CLI directory from module dir ${moduleDir}`,
  );
}

// ============================================================================
// createFsBoardPlatformAdapter — wires FS adapters into BoardPlatformAdapter
//
// All platform-specific Node/FS concerns are encapsulated here.
// board-live-cards-public.ts depends only on BoardPlatformAdapter, never on
// Node built-ins or FS details.
//
// Usage:
//   const adapter = createFsBoardPlatformAdapter(baseRef, cliDir);
//   const board = createBoardLiveCardsPublic(baseRef, adapter);
// ============================================================================

export function createFsBoardPlatformAdapter(
  baseRef: KindValueRef,
  cliDirOrOpts?: string | FsBoardAdapterOpts,
  maybeOpts?: FsBoardAdapterOpts,
): BoardPlatformAdapter {
  const { cliDir, opts } = normalizeFsBoardAdapterArgs(cliDirOrOpts, maybeOpts);
  const dir = baseRef.value;
  let boardWorkerDrainInFlight: Promise<number | void> | null = null;
  let processAccumulatedBoardCache: BoardProcessAccumulatorInternal | undefined;
  let processAccumulatedDrainInFlight: Promise<number | void> | null = null;
  let resolvedCliDirCache: string | undefined;

  function getResolvedCliDir(): string {
    if (!resolvedCliDirCache) {
      resolvedCliDirCache = resolveDefaultCliDir(cliDir);
    }
    return resolvedCliDirCache;
  }

  function requireInternalQueueStoreRef(owner: string): string {
    const ref = opts?.queueStoreRef;
    if (!ref) {
      throw new Error(`createFsBoardPlatformAdapter: ${owner} requires opts.queueStoreRef`);
    }
    return ref;
  }

  function requireInternalBoardRuntimeStoreRef(owner: string): string {
    const ref = opts?.boardRuntimeStoreRef;
    if (!ref) {
      throw new Error(`createFsBoardPlatformAdapter: ${owner} requires opts.boardRuntimeStoreRef`);
    }
    return ref;
  }

  const callbackTransport = opts?.callbackTransport ?? createLocalNodeBoardCallbackTransport({
    notifyChannel: opts?.notifyChannel,
    boardRuntimeStoreRef: opts?.boardRuntimeStoreRef,
    queueStoreRef: opts?.queueStoreRef,
  });

  let adapter: BoardPlatformAdapter;

  function queueStorageForLane(lane: string) {
    return adapter.queueStorageForRef(requireInternalQueueStoreRef(`internal lane "${lane}"`), lane);
  }

  function boardWorkerStoreForLane(lane: string): BoardWorkerStore {
    return createBoardWorkerStore(queueStorageForLane(lane));
  }

  function scheduleInProcessBoardWorkerDrain(): void {
    if (opts?.suppressSpawn || boardWorkerDrainInFlight) return;
    const lane = createBoardWorkerQueueLane({
      id: 'task-executor',
      workerStore: boardWorkerStoreForLane('task-executor'),
      handleRequest: async (_args, request) => {
        const result = await invokeExecutionRef(request.ref, request.args, {
          cliDir: getResolvedCliDir(),
          cwd: process.cwd(),
          label: 'fsBoardAdapter.boardWorker',
        });
        if (result.result !== 'success') {
          const detail = typeof result.data?.error === 'string' ? result.data.error : result.error;
          throw new Error(detail || result.result);
        }
      },
    });
    boardWorkerDrainInFlight = drainQueueLaneToIdle(lane)
      .catch((error) => {
        void opts?.onWarn?.(`[board-worker] in-process queue drain failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        boardWorkerDrainInFlight = null;
        if (queueStorageForLane('task-executor').peekActive().length > 0) {
          scheduleInProcessBoardWorkerDrain();
        }
      });
  }

  adapter = {
    kvStorage: (namespace: string) =>
      createFsKvStorage(joinPath(dir, `.${namespace}`)),

    blobStorage: (namespace: string) =>
      namespace ? createFsBlobStorage(joinPath(dir, namespace)) : createFsBlobStorage(dir),
    blobStorageForRef: (ref: string) => createFsBlobStorage(parseRef(ref).value),
    chatStorageForRef: (ref: string) => createFsChatStorageForRefRoot(parseRef(ref).value),
    queueStorageForRef: (ref: string, lane: string) => createFsQueueStorage(joinPath(parseRef(ref).value, lane)),

    scratchStorage: () => createFsScratchStorage(joinPath(dir, '.tmp')),
    scratchStorageForRef: (ref: string) => createFsScratchStorage(parseRef(ref).value),

    archiveFactory: () => createFsArchiveFactory(joinPath(dir, 'archive')),
    archiveFactoryForRef: (ref: string) => createFsArchiveFactory(parseRef(ref).value),

    journalAdapter: () => createFsJournalStorageAdapter(dir),
    journalAdapterForRef: (ref: string) => createFsJournalStorageAdapter(parseRef(ref).value),

    lock: createFsAtomicRelayLock(joinPath(dir, BOARD_LOCK_FILE)),

    callbackTransport,

    async dispatchExecution(ref, args) {
      const hasDirectHostedOutput = Boolean((args['output'] as Record<string, unknown> | undefined)?.['ref']);
      if (ref.howToRun === 'queue-storage') {
        try {
          const store = boardWorkerStoreForLane('task-executor');
          const boardId = typeof ref.extra?.boardId === 'string' ? ref.extra.boardId : undefined;
          if (hasDirectHostedOutput) {
            store.enqueueRequest({ boardId, ref, args });
            return { dispatched: true };
          }
          const label = (args['source_def'] as Record<string, unknown> | undefined)?.['bindTo'] as string | undefined
            ?? genUUID().slice(0, 8);
          const scratch = createFsScratchStorage(joinPath(dir, '.tmp'));
          const inFile  = scratch.create(JSON.stringify(args, null, 2), `exec-in-${label}`, '.json');
          const outFile = scratch.getUniqueKey(`exec-out-${label}`, '.json');
          const errFile = scratch.getUniqueKey(`exec-err-${label}`, '.txt');
          const inRef   = serializeRef(scratch.keyRef(inFile));
          const outRef  = serializeRef(scratch.keyRef(outFile));
          const errRef  = serializeRef(scratch.keyRef(errFile));
          store.enqueueRequest({ boardId, ref, args: { subcommand: 'run-source-fetch', inRef, outRef, errRef } });
          return { dispatched: true };
        } catch (e) {
          return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (hasDirectHostedOutput && (ref.howToRun === 'http:post' || ref.howToRun === 'in-process-loop')) {
        try {
          if (ref.howToRun === 'http:post') {
            const url = resolveWhatToRunValue(ref.whatToRun);
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...args, ...(ref.extra ? { extra: ref.extra } : {}) }),
            });
            if (!response.ok) {
              const text = await response.text().catch(() => '');
              return { dispatched: false, error: `HTTP ${response.status}: ${text}` };
            }
            return { dispatched: true };
          }
          const result = await invokeExecutionRef(ref, args, {
            cwd: process.cwd(),
            label: 'dispatchExecution.directHostedWorker',
          });
          if (result.result === 'success') return { dispatched: true };
          const detail = typeof result.data?.error === 'string' ? result.data.error : result.error;
          return { dispatched: false, error: detail || result.result };
        } catch (e) {
          return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
        }
      }
      const needsLocalSpawn = ref.howToRun === 'local-node'
        || ref.howToRun === 'local-process'
        || ref.howToRun === 'local-python'
        || ref.howToRun === 'built-in';
      if (opts?.suppressSpawn && needsLocalSpawn) return { dispatched: false };
      try {
        const label = (args['source_def'] as Record<string, unknown> | undefined)?.['bindTo'] as string | undefined
          ?? genUUID().slice(0, 8);
        const scratch = createFsScratchStorage(joinPath(dir, '.tmp'));
        const inFile  = scratch.create(JSON.stringify(args, null, 2), `exec-in-${label}`, '.json');
        const outFile = scratch.getUniqueKey(`exec-out-${label}`, '.json');
        const errFile = scratch.getUniqueKey(`exec-err-${label}`, '.txt');
        const inRef   = serializeRef(scratch.keyRef(inFile));
        const outRef  = serializeRef(scratch.keyRef(outFile));
        const errRef  = serializeRef(scratch.keyRef(errFile));
        const store = boardWorkerStoreForLane('task-executor');
        const boardId = typeof ref.extra?.boardId === 'string' ? ref.extra.boardId : undefined;
        store.enqueueRequest({ boardId, ref, args: { subcommand: 'run-source-fetch', inRef, outRef, errRef } });
        scheduleInProcessBoardWorkerDrain();
        return { dispatched: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        try {
          const archive = createFsArchiveFactory(joinPath(dir, 'archive'));
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const label = (args['source_def'] as Record<string, unknown> | undefined)?.['bindTo'] as string | undefined ?? 'unknown';
          archive.blob('exec-failures').write(`${stamp}-${label}.json`, JSON.stringify({ error, args, ref, at: new Date().toISOString() }, null, 2));
        } catch { /* best-effort */ }
        return { dispatched: false, error };
      }
    },

    supportsDirectSourceOutput(ref) {
      return ref.howToRun === 'queue-storage'
        || ref.howToRun === 'http:post'
        || ref.howToRun === 'in-process-loop';
    },

    resolveBlob(ref: KindValueRef): string {
      const content = isAbsolutePath(ref.value)
        ? createFsAbsolutePathBlobStorage().read(ref.value)
        : createFsBlobStorage(dir).read(ref.value);
      if (content === null) throw new Error(`resolveBlob: blob not found: ::${ref.kind}::${ref.value}`);
      return content;
    },

    hashFn: computeStableJsonHash,

    genId: () => getHash(`${Date.now()}-${Math.random()}`).slice(0, 32),

    kvStorageForRef: (ref: string) => createFsKvStorage(parseRef(ref).value),

    requestProcessAccumulated() {
      if (opts?.suppressSpawn || processAccumulatedDrainInFlight) return;
      const adapter = this as BoardPlatformAdapter;
      const board = processAccumulatedBoardCache ??= createBoardLiveCardsPublic(baseRef, adapter, {
        boardRuntimeStoreRef: requireInternalBoardRuntimeStoreRef('requestProcessAccumulated'),
      }) as BoardProcessAccumulatorInternal;
      const lane = createQueueStorageLane<{ boardRef?: string }>({
        id: 'process-accumulated',
        queueStorage: queueStorageForLane('process-accumulated'),
        handleMessage: async () => {
          const result = await board.processAccumulatedEvents({});
          if (result.status !== 'success') {
            throw new Error(result.error || `processAccumulatedEvents returned ${result.status}`);
          }
        },
      });
      processAccumulatedDrainInFlight = drainQueueLaneToIdle(lane)
        .catch((error) => {
          void opts?.onWarn?.(`[process-accumulated] in-process queue drain failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          processAccumulatedDrainInFlight = null;
          if (queueStorageForLane('process-accumulated').peekActive().length > 0) {
            adapter.requestProcessAccumulated?.();
          }
        });
    },

    publishBoardChangeNotifications(notifications) {
      if (!opts?.notifyChannel || notifications.length === 0) return;
      const envelopes = notifications.map(notification => ({
        id: genUUID(),
        ts: new Date().toISOString(),
        boardRef: serializeRef(baseRef),
        notification,
      }));
      publishJsonEventsToNamedPipe(
        opts.notifyChannel,
        envelopes,
        opts.onWarn,
      );
    },
    onWarn: opts?.onWarn,
  };

  return adapter;
}

// ============================================================================
// createFsBoardNonCorePlatformAdapter — extends the FS adapter with async
// executor request/response, schema validation, and absolute blob I/O.
// ============================================================================

export function createFsBoardNonCorePlatformAdapter(
  baseRef: KindValueRef,
  cliDirOrOpts?: string | FsBoardNonCoreAdapterOpts,
  maybeOpts?: FsBoardNonCoreAdapterOpts,
): BoardNonCorePlatformAdapter {
  const { cliDir, opts } = normalizeFsBoardNonCoreAdapterArgs(cliDirOrOpts, maybeOpts);
  let resolvedCliDirCache: string | undefined;
  const getResolvedCliDir = (): string => {
    if (!resolvedCliDirCache) {
      resolvedCliDirCache = resolveDefaultCliDir(cliDir);
    }
    return resolvedCliDirCache;
  };
  const base = createFsBoardPlatformAdapter(baseRef, cliDir, opts);
  const dispatcher = createNonCoreExecutorDispatcher({
    resolveCliDir: getResolvedCliDir,
    ...(opts?.resolveRef ? { resolveRef: opts.resolveRef } : {}),
  });
  return {
    ...base,
    invokeExecutor: dispatcher.invokeExecutor,
    validateSchema(card) {
      const result = validateLiveCardDefinition(card);
      return { ok: result.errors.length === 0, errors: result.errors };
    },
    absoluteBlob: createFsAbsolutePathBlobStorage(),
  };
}

// ============================================================================
// createFsBoardChatStorage — convenience factory wiring fs-backed ChatStorage
//
// Wires:
//   - one FsJournalStorage per card at  boardDir/<chatsSubdir>/<safeCardId>.jsonl
//   - one FsKvStorage for processing flags + config at  boardDir/<kvSubdir>/chat/
//
// Both leaf segments are overridable; pass "" to write directly under boardDir.
//
// Usage:
//   const chatStorage = createFsBoardChatStorage(boardDir);
//   // pass to createSingleBoardServerRuntime({ ..., chatStorage })
// ============================================================================

export interface FsBoardChatStorageOptions {
  /** Subdirectory under boardDir for per-card jsonl files. Default: 'chats'. Pass '' to write directly under boardDir. */
  chatsSubdir?: string;
  /** Subdirectory under boardDir for chat KV (processing flags + config). Default: '.kv'. Pass '' to root at boardDir. */
  kvSubdir?: string;
}

export function createFsBoardChatStorage(
  boardDir: string,
  opts: FsBoardChatStorageOptions = {},
): ChatStorage {
  const chatsSubdir = opts.chatsSubdir ?? 'chats';
  const kvSubdir = opts.kvSubdir ?? '.kv';
  const kvParts = kvSubdir ? [kvSubdir, 'chat'] : ['chat'];
  const chatsRoot = chatsSubdir && !_pathAlreadyEndsWith(boardDir, chatsSubdir)
    ? joinPath(boardDir, chatsSubdir)
    : boardDir;
  const kv = createFsKvStorage(joinPath(boardDir, ...kvParts));
  return createChatStorage(
    (cardId: string) => {
      const safeId = String(cardId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${safeId}.jsonl`;
      const journalPath = joinPath(chatsRoot, fileName);
      return createFsJournalStorage(journalPath);
    },
    kv,
  );
}

export function createFsChatStorageForRefRoot(chatStoreDir: string): ChatStorage {
  return createChatStorage(
    (cardId: string) => {
      const safeId = String(cardId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const fileName = `${safeId}.jsonl`;
      return createFsJournalStorage(joinPath(chatStoreDir, 'journal', fileName));
    },
    createFsKvStorage(joinPath(chatStoreDir, 'kv')),
  );
}

// ============================================================================
// createFsBoardFileArtifactsStore — fs-backed file artifacts store
//
// Writes uploads under <baseDir>/<filesSubdir>/<cardId>/<file>. Pass
// filesSubdir: '' to root uploads directly at baseDir/<cardId>/<file>.
//
// Pass the returned store to createSingleBoardServerRuntime via
// BoardContextConfig.filesArtifactsStore.
// ============================================================================

export interface FsBoardFileArtifactsStoreOptions {
  /** Subdirectory under baseDir for file uploads. Default: 'files'. Pass '' to root at baseDir. */
  filesSubdir?: string;
}

export function createFsBoardFileArtifactsStore(
  baseDir: string,
  opts: FsBoardFileArtifactsStoreOptions = {},
) {
  const filesSubdir = opts.filesSubdir ?? 'files';
  const root = filesSubdir && !_pathAlreadyEndsWith(baseDir, filesSubdir) ? joinPath(baseDir, filesSubdir) : baseDir;
  return createArtifactsStore(createFsBlobStorage(root));
}

// ============================================================================
// decodeBoardRefFromToken — extract serialized board ref from a source token
// ============================================================================

/**
 * Extract the serialized board ref from a source token (which has a `br` field).
 * Returns null for callback tokens (which don't carry a board ref).
 */
export function decodeBoardRefFromToken(token: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString()) as Record<string, unknown>;
    return typeof p['br'] === 'string' ? p['br'] : null;
  } catch { return null; }
}
