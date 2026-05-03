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

import {
  makeBoardTempFilePath,
  buildBoardCliInvocation,
  genUUID,
  getHash,
  joinPath,
  isAbsolutePath,
  requestProcessAccumulatedDetached,
  createNodeCommandExecutor,
} from './process-runner.js';
import { buildLocalBaseSpec, dispatchTaskExecutorDetached } from './execution-adapter.js';
import { serializeRef, parseRef } from '../common/storage-interface.js';
import type { KindValueRef } from '../common/storage-interface.js';
import { blobStorageForRef } from './public-storage-adapter.js';
import {
  createFsKvStorage,
  createFsBlobStorage,
  createFsAbsolutePathBlobStorage,
  createFsAtomicRelayLock,
  createFsJournalStorageAdapter,
  computeStableJsonHash,
} from './storage-fs-adapters.js';
import { validateLiveCardDefinition } from '../../card-compute/schema-validator.js';
import type { BoardPlatformAdapter, BoardNonCorePlatformAdapter } from '../common/board-live-cards-public.js';

// ============================================================================
// Re-export public API — consumers only need to import from this file
// ============================================================================

export { createBoardLiveCardsPublic, createBoardLiveCardsNonCorePublic } from '../common/board-live-cards-public.js';
export type {
  BoardPlatformAdapter,
  BoardNonCorePlatformAdapter,
  CommandInput,
  CommandResult,
  BoardLiveCardsPublic,
  BoardLiveCardsNonCorePublic,
} from '../common/board-live-cards-public.js';
export { BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1, EMPTY_CONFIG } from '../common/board-live-cards-public.js';
export { parseRef, serializeRef } from '../common/storage-interface.js';
export type { KindValueRef } from '../common/storage-interface.js';

// ============================================================================
// Constants
// ============================================================================

const BOARD_LOCK_FILE = '.board.lock';

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
  cliDir: string,
  opts?: { onWarn?: (msg: string) => void },
): BoardPlatformAdapter {
  const dir = baseRef.value;

  // Resolve selfRef once — the board CLI script path that executors call back to.
  const { cmd: _cliCmd, args: _cliArgs } = buildBoardCliInvocation(cliDir, '_', []);
  const boardCliScriptPath =
    (_cliCmd === process.execPath && _cliArgs[0]?.endsWith('.js'))
      ? _cliArgs[0]
      : (_cliArgs[1] ?? _cliArgs[0]);
  const selfRef = {
    meta: 'board-live-cards',
    howToRun: 'local-node' as const,
    whatToRun: serializeRef({ kind: 'fs-path', value: boardCliScriptPath }),
  };

  return {
    kvStorage: (namespace: string) =>
      createFsKvStorage(joinPath(dir, `.${namespace}`)),

    blobStorage: (namespace: string) =>
      namespace ? createFsBlobStorage(joinPath(dir, namespace)) : createFsBlobStorage(dir),

    journalAdapter: () => createFsJournalStorageAdapter(dir),

    lock: createFsAtomicRelayLock(joinPath(dir, BOARD_LOCK_FILE)),

    selfRef,

    async dispatchExecution(ref, args) {
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return { dispatched: false };
      try {
        const label = (args['source_def'] as Record<string, unknown> | undefined)?.['bindTo'] as string | undefined
          ?? genUUID().slice(0, 8);
        const inFile  = makeBoardTempFilePath(dir, `exec-in-${label}`);
        const outFile = makeBoardTempFilePath(dir, `exec-out-${label}`);
        const errFile = makeBoardTempFilePath(dir, `exec-err-${label}`, '.txt');
        const inRef   = serializeRef({ kind: 'fs-path', value: inFile });
        const outRef  = serializeRef({ kind: 'fs-path', value: outFile });
        const errRef  = serializeRef({ kind: 'fs-path', value: errFile });
        blobStorageForRef({ kind: 'fs-path', value: inFile }).write(inFile, JSON.stringify(args, null, 2));
        dispatchTaskExecutorDetached(ref, { subcommand: 'run-source-fetch', inRef, outRef, errRef }, cliDir);
        return { dispatched: true };
      } catch (e) {
        return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
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
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return;
      requestProcessAccumulatedDetached(cliDir, baseRef);
    },

    onWarn: opts?.onWarn,
  };
}

// ============================================================================
// createFsBoardNonCorePlatformAdapter — extends the FS adapter with synchronous
// executor dispatch, schema validation, temp file factory, and absolute blob I/O.
// Required for: validateCard, validateTmpCard, probeSource, probeTmpSource,
//               describeTaskExecutorCapabilities
// ============================================================================

export function createFsBoardNonCorePlatformAdapter(
  baseRef: KindValueRef,
  cliDir: string,
  opts?: { onWarn?: (msg: string) => void },
): BoardNonCorePlatformAdapter {
  const base = createFsBoardPlatformAdapter(baseRef, cliDir, opts);
  const executor = createNodeCommandExecutor();
  return {
    ...base,
    invokeExecutorSync(ref, subcommand, args, execOpts) {
      const { command, baseArgs } = buildLocalBaseSpec(ref, cliDir);
      return executor.executeSync(command, [...baseArgs, subcommand, ...args], {
        timeout: execOpts?.timeout ?? 30_000,
        encoding: 'utf-8',
      });
    },
    validateSchema(card) {
      const result = validateLiveCardDefinition(card);
      return { ok: result.errors.length === 0, errors: result.errors };
    },
    makeTempFilePath(label, ext) {
      return makeBoardTempFilePath(baseRef.value, label, ext);
    },
    absoluteBlob: createFsAbsolutePathBlobStorage(),
  };
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
