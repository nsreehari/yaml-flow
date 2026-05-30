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
  requestProcessAccumulatedDetached,
  publishJsonEventsToNamedPipe,
  createNodeCommandExecutor,
} from './process-runner.js';
import {
  buildLocalBaseSpec,
  dispatchTaskExecutorDetached,
  resolveWhatToRunValue,
} from './execution-adapter.js';
import { serializeRef, parseRef } from '../common/storage-interface.js';
import type { KindValueRef } from '../common/storage-interface.js';
import {
  createFsKvStorage,
  createFsBlobStorage,
  createFsAbsolutePathBlobStorage,
  createFsAtomicRelayLock,
  createFsJournalStorageAdapter,
  createFsJournalStorage,
  createFsScratchStorage,
  createFsArchiveFactory,
  computeStableJsonHash,
} from './storage-fs-adapters.js';
import { validateLiveCardDefinition } from '../../card-compute/schema-validator.js';
import type { BoardPlatformAdapter, BoardNonCorePlatformAdapter } from '../common/board-live-cards-public.js';
import { createChatStorage } from '../common/chat-storage-lib.js';
import type { ChatStorage } from '../common/chat-storage-lib.js';
import type { ExecutionRef } from '../common/execution-interface.js';

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
export { createArtifactsStorePublic } from '../common/artifacts-store-lib-public.js';
export { createCardStore } from '../common/board-live-cards-lib.js';
export { createArtifactsStore, createFileArtifactsStore, createCardFileMetadataStore } from '../common/artifacts-store-lib.js';
import { createArtifactsStore } from '../common/artifacts-store-lib.js';
export { createChatStorage, createInMemoryChatStorage } from '../common/chat-storage-lib.js';
export type { ChatStorage, ChatRecord, ChatConfig } from '../common/chat-storage-lib.js';
export type { LiveCard } from '../common/board-live-cards-lib.js';
export type { InvocationAdapter, DescribeEnvelope } from '../../server-runtime/types.js';
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
export type {
  CreateExecutionRefInvokerOptions,
  ExecutionRefInvoker,
  InProcessExecutionHandler,
  InvokeExecutionRefOptions,
  InvokeRefResult,
  SyncTransportInvoker,
  TransportInvoker,
} from './execution-adapter.js';

// ============================================================================
// createNodeSpawnInvocationAdapter
// ============================================================================

/**
 * Creates an InvocationAdapter backed by Node.js `spawn`/`spawnSync`.
 *
 * Supports howToRun: 'local-node'
 *   → spawns the script as a detached Node.js child process (fire-and-forget).
 *
 * Pass to createSingleBoardServerRuntime / createMultiBoardServerRuntime as
 * the `invocationAdapter` option. This is the reference Node.js implementation;
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
  selfRef?: ExecutionRef;
};
type FsBoardNonCoreAdapterOpts = { onWarn?: (msg: string) => void; selfRef?: ExecutionRef };

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
  const resolvedCliDir = resolveDefaultCliDir(cliDir);
  const dir = baseRef.value;

  // Resolve selfRef once for callback-style invocations (node <script> ...).
  // When suppressSpawn is set, skip path resolution because spawning is disabled.
  const callbackTarget = opts?.suppressSpawn ? '' : resolveBoardCliCallbackTarget(resolvedCliDir);
  const selfRef = opts?.selfRef ?? {
    meta: 'board-live-cards',
    howToRun: 'local-node' as const,
    whatToRun: callbackTarget ? serializeRef({ kind: 'yaml-flow-cli', value: 'board-live-cards-cli.js' }) : '',
    ...(opts?.notifyChannel ? { extra: { notifyChannel: opts.notifyChannel } } : {}),
  };

  return {
    kvStorage: (namespace: string) =>
      createFsKvStorage(joinPath(dir, `.${namespace}`)),

    blobStorage: (namespace: string) =>
      namespace ? createFsBlobStorage(joinPath(dir, namespace)) : createFsBlobStorage(dir),

    scratchStorage: () => createFsScratchStorage(joinPath(dir, '.tmp')),
    scratchStorageForRef: (ref: string) => createFsScratchStorage(parseRef(ref).value),

    archiveFactory: () => createFsArchiveFactory(joinPath(dir, 'archive')),
    archiveFactoryForRef: (ref: string) => createFsArchiveFactory(parseRef(ref).value),

    journalAdapter: () => createFsJournalStorageAdapter(dir),

    lock: createFsAtomicRelayLock(joinPath(dir, BOARD_LOCK_FILE)),

    selfRef,

    async dispatchExecution(ref, args) {
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
        dispatchTaskExecutorDetached(ref, { subcommand: 'run-source-fetch', inRef, outRef, errRef }, resolvedCliDir);
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
      if (opts?.suppressSpawn) return;
      requestProcessAccumulatedDetached(resolvedCliDir, baseRef, opts?.notifyChannel);
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
}

// ============================================================================
// createFsBoardNonCorePlatformAdapter — extends the FS adapter with synchronous
// executor dispatch, schema validation, temp file factory, and absolute blob I/O.
// Required for: validateCard, validateCardPreflight, probeSource, probeTmpSource,
//               describeTaskExecutorCapabilities
// ============================================================================

export function createFsBoardNonCorePlatformAdapter(
  baseRef: KindValueRef,
  cliDirOrOpts?: string | FsBoardNonCoreAdapterOpts,
  maybeOpts?: FsBoardNonCoreAdapterOpts,
): BoardNonCorePlatformAdapter {
  const { cliDir, opts } = normalizeFsBoardNonCoreAdapterArgs(cliDirOrOpts, maybeOpts);
  const resolvedCliDir = resolveDefaultCliDir(cliDir);
  const base = createFsBoardPlatformAdapter(baseRef, resolvedCliDir, opts);
  const executor = createNodeCommandExecutor();
  return {
    ...base,
    invokeExecutorSync(ref, subcommand, args, execOpts) {
      const { command, baseArgs } = buildLocalBaseSpec(ref, resolvedCliDir);
      const extraFlag = ref.extra ? ['--extra', Buffer.from(JSON.stringify(ref.extra)).toString('base64')] : [];
      return executor.executeSync(command, [...baseArgs, subcommand, ...args, ...extraFlag], {
        timeout: execOpts?.timeout ?? 30_000,
        encoding: 'utf-8',
        input: execOpts?.input,
      });
    },
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
