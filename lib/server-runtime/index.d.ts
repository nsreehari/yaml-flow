import { M as MultiBoardRuntimeOptions, a as MultiBoardRuntime, S as SingleBoardRuntimeOptions, b as SingleBoardRuntime } from '../types-CmcC19X0.js';
export { B as BoardContextConfig, D as DescribeEnvelope, I as InvocationAdapter, N as NotificationTransport, R as RuntimeLogger, c as RuntimeRequest, d as RuntimeResponse } from '../types-CmcC19X0.js';
export { j as BlobStorage, k as BoardChangeNotification, d as BoardLiveCardsPublic, a as BoardPlatformAdapter, C as CommandInput, e as CommandResult, l as KVStorage, K as KindValueRef } from '../board-live-cards-public-Cf__4Q0f.js';
export { ExecutionRef } from '../execution-refs.js';
import '../types-BBhqYGhE.js';

/**
 * server-runtime/index.ts
 *
 * Platform-free board server runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER DIAGRAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   HOST (demo-server / Azure Fn / Firebase Fn)
 *     ↓ constructs adapters, calls createSingleBoardServerRuntime(options)
 *   THIS FILE — routes, contexts, chat/file orchestration
 *     ↓ delegates to
 *   board-live-cards-public.ts — graph, journal, dispatch (already platform-free)
 *
 * No node:fs, node:net, node:child_process, node:os imports.
 * All platform access flows through injected adapters.
 * ─────────────────────────────────────────────────────────────────────────────
 */

declare function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime;
declare function createMultiBoardServerRuntime(options: MultiBoardRuntimeOptions): MultiBoardRuntime;

export { MultiBoardRuntime, MultiBoardRuntimeOptions, SingleBoardRuntime, SingleBoardRuntimeOptions, createMultiBoardServerRuntime, createSingleBoardServerRuntime };
