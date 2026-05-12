import { I as InvocationAdapter } from './types-CDOsWWes.js';
export { D as DescribeEnvelope } from './types-CDOsWWes.js';
import { K as KindValueRef, B as BoardNonCorePlatformAdapter, a as BoardPlatformAdapter } from './board-live-cards-public-BsO2nOIw.js';
export { b as BOARD_GRAPH_KEY, c as BoardLiveCardsNonCorePublic, d as BoardLiveCardsPublic, C as CommandInput, e as CommandResult, E as EMPTY_CONFIG, L as LiveCard, S as SNAPSHOT_SCHEMA_VERSION_V1, f as createBoardLiveCardsNonCorePublic, g as createBoardLiveCardsPublic, h as createCardStore, p as parseRef, s as serializeRef } from './board-live-cards-public-BsO2nOIw.js';
export { ExecutionRef, executionRefFromScriptPath, parseExecutionRef, serializeExecutionRef } from './execution-refs.js';
export { createCardStorePublic } from './card-store-public.js';
export { c as createArtifactsStore, a as createArtifactsStorePublic, b as createCardFileMetadataStore, d as createChatArtifactsStore, e as createFileArtifactsStore } from './artifacts-store-lib-public-DdTxoCAy.js';
import './types-BBhqYGhE.js';

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
declare function createNodeSpawnInvocationAdapter(): InvocationAdapter;
declare function createFsBoardPlatformAdapter(baseRef: KindValueRef, cliDir: string, opts?: {
    onWarn?: (msg: string) => void;
    suppressSpawn?: boolean;
    notifyChannel?: string;
}): BoardPlatformAdapter;
declare function createFsBoardNonCorePlatformAdapter(baseRef: KindValueRef, cliDir: string, opts?: {
    onWarn?: (msg: string) => void;
}): BoardNonCorePlatformAdapter;
/**
 * Extract the serialized board ref from a source token (which has a `br` field).
 * Returns null for callback tokens (which don't carry a board ref).
 */
declare function decodeBoardRefFromToken(token: string): string | null;

export { BoardNonCorePlatformAdapter, BoardPlatformAdapter, InvocationAdapter, KindValueRef, createFsBoardNonCorePlatformAdapter, createFsBoardPlatformAdapter, createNodeSpawnInvocationAdapter, decodeBoardRefFromToken };
