#!/usr/bin/env node
/**
 * board-live-cards-example-cli.ts
 *
 * Thin arg-parse CLI for the board-live-cards public API.
 *
 * This file contains ONLY:
 *   1. Arg parsing helpers
 *   2. A `cli()` function that maps argv → public-API calls
 *   3. A main-invocation guard
 *
 * All logic lives in board-live-cards-public.ts (platform-free) and
 * fs-board-adapter.ts (Node/FS platform adapters).
 *
 * Imports are limited to ./fs-board-adapter.js and ./process-runner.js —
 * no direct imports from ../common/*.
 */

import {
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  parseRef,
  decodeBoardRefFromToken,
  type KindValueRef,
} from './fs-board-adapter.js';
import { createFsBlobStorage } from './storage-fs-adapters.js';
import { resolveModuleDir, resolvePath } from './process-runner.js';

const __dirname = resolveModuleDir(import.meta.url);

// ============================================================================
// Arg-parse helpers
// ============================================================================

function requireFlag(args: string[], flag: string, usage: string): string {
  const idx = args.indexOf(flag);
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (!val) throw new Error(`Missing ${flag}\nUsage: ${usage}`);
  return val;
}

function optFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function requireBoardRuntimeStoreRef(args: string[], usage: string): string {
  return requireFlag(args, '--board-runtime-store-ref', usage);
}

function requireQueueStoreRef(args: string[], usage: string): string {
  return requireFlag(args, '--queue-store-ref', usage);
}

function readSuccessfulStoreRef(result: { status: string; data?: { storeRef?: string | null } }): string | undefined {
  return result.status === 'success' && typeof result.data?.storeRef === 'string'
    ? result.data.storeRef
    : undefined;
}

function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

async function readStdinBody(): Promise<unknown> {
  if (process.stdin.isTTY) return undefined;
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(parts).toString('utf-8').trim();
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function safeAttachmentCardKey(cardId: string): string {
  return String(cardId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-card';
}

function readAttachmentBytes(
  baseRef: KindValueRef | undefined,
  boardRuntimeStoreRef: string,
  notifyChannel: string | undefined,
  cardId: string,
  fileIdxRaw?: string,
): Uint8Array {
  if (!baseRef) throw new Error('get-attachment-content requires --base-ref <ref>');

  const board = createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, __dirname, {
    onWarn: console.warn,
    notifyChannel,
    boardRuntimeStoreRef,
  }), { boardRuntimeStoreRef });
  const cardStoreRef = readSuccessfulStoreRef(board.getCardStoreRef({}));
  if (!cardStoreRef) throw new Error(`Board at ${baseRef.value} has no card store configured`);

  const artifactsStoreRef = readSuccessfulStoreRef(board.getArtifactsStoreRef({}));
  if (!artifactsStoreRef) {
    throw new Error(`Board at ${baseRef.value} has no artifacts store configured`);
  }

  const adapter = createFsBoardPlatformAdapter(baseRef, __dirname, { onWarn: console.warn, notifyChannel, boardRuntimeStoreRef });
  const card = adapter.kvStorageForRef(cardStoreRef).read(cardId) as { card_data?: unknown } | null;
  if (!card) throw new Error(`Card "${cardId}" not found in board at ${baseRef.value}`);

  const cardData = (card.card_data && typeof card.card_data === 'object' && !Array.isArray(card.card_data))
    ? card.card_data as Record<string, unknown>
    : {};
  const files = Array.isArray(cardData.files) ? cardData.files : [];
  const fileIdx = fileIdxRaw === undefined ? 0 : Number(fileIdxRaw);
  if (!Number.isInteger(fileIdx) || fileIdx < 0) {
    throw new Error('get-attachment-content requires --file-idx to be a non-negative integer');
  }
  if (fileIdx >= files.length) {
    throw new Error(`attachment index ${fileIdx} is out of range for card "${cardId}"`);
  }

  const file = files[fileIdx];
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`attachment index ${fileIdx} for card "${cardId}" is not an object`);
  }
  const storedName = (file as { stored_name?: unknown }).stored_name;
  if (typeof storedName !== 'string' || !storedName) {
    throw new Error(`attachment index ${fileIdx} for card "${cardId}" has no stored_name`);
  }

  const key = `${safeAttachmentCardKey(cardId)}/${storedName}`;
  const readBytes = createFsBlobStorage(parseRef(artifactsStoreRef).value).readBytes;
  if (!readBytes) throw new Error('configured artifacts store does not support byte reads');
  const bytes = readBytes(key);
  if (bytes === null) throw new Error(`attachment content not found for key "${key}"`);
  return bytes;
}

// ============================================================================
// cli() — thin routing layer
// ============================================================================

export async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('board-live-cards — see board-live-cards-cli-PARAMS.md for command reference');
    return;
  }

  // ── Parse baseRef (optional at this point — source-token-based cmds don't need it) ─
  const br = optFlag(rest, '--base-ref');
  const notifyChannel = optFlag(rest, '--notify-channel');
  const baseRef = br ? parseRef(br) : undefined;

  // ── Source callbacks — token has `br` field; no --base-ref needed ────────
  if (cmd === 'source-data-fetched') {
    const usage = 'source-data-fetched --token <token> --ref <sourcefile> --board-runtime-store-ref <b64-ref> --queue-store-ref <b64-ref>';
    const token = requireFlag(rest, '--token', usage);
    const ref = requireFlag(rest, '--ref', usage);
    const boardRuntimeStoreRef = requireBoardRuntimeStoreRef(rest, usage);
    const queueStoreRef = requireQueueStoreRef(rest, usage);
    const brStr = decodeBoardRefFromToken(token);
    if (!brStr) throw new Error('source-data-fetched: could not decode board ref from token — is this a valid source token?');
    const br2 = parseRef(brStr);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, {
      onWarn: console.warn,
      notifyChannel,
      boardRuntimeStoreRef,
      queueStoreRef,
    }), { boardRuntimeStoreRef });
    printResult(board.sourceDataFetched({ params: { token, ref } }));
    return;
  }

  if (cmd === 'source-data-fetch-failure') {
    const usage = 'source-data-fetch-failure --token <token> --board-runtime-store-ref <b64-ref> --queue-store-ref <b64-ref> [--reason <message>]';
    const token = requireFlag(rest, '--token', usage);
    const boardRuntimeStoreRef = requireBoardRuntimeStoreRef(rest, usage);
    const queueStoreRef = requireQueueStoreRef(rest, usage);
    const brStr = decodeBoardRefFromToken(token);
    if (!brStr) throw new Error('source-data-fetch-failure: could not decode board ref from token — is this a valid source token?');
    const br2 = parseRef(brStr);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, {
      onWarn: console.warn,
      notifyChannel,
      boardRuntimeStoreRef,
      queueStoreRef,
    }), { boardRuntimeStoreRef });
    const params: Record<string, string> = { token };
    const reason = optFlag(rest, '--reason');
    if (reason) params['reason'] = reason;
    printResult(board.sourceDataFetchFailure({ params }));
    return;
  }

  // ── validate-card-preflight — card JSON arrives via stdin, optional --base-ref ─────
  if (cmd === 'validate-card-preflight') {
    const tmpRef = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const boardRuntimeStoreRef = baseRef ? requireBoardRuntimeStoreRef(rest, 'validate-card-preflight --base-ref <ref> --board-runtime-store-ref <b64-ref>') : undefined;
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }), boardRuntimeStoreRef ? { boardRuntimeStoreRef } : undefined);
    const body = await readStdinBody();
    printResult(await nonCore.validateCardPreflight({ body }));
    return;
  }

  // ── probe-source-preflight — card JSON + sourceIdx arrive via stdin, no board state needed ────
  if (cmd === 'probe-source-preflight') {
    const idxRaw  = requireFlag(rest, '--source-idx', 'probe-source-preflight --source-idx <n>');
    const outRef  = optFlag(rest, '--out-ref');
    const tmpRef  = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const boardRuntimeStoreRef = baseRef ? requireBoardRuntimeStoreRef(rest, 'probe-source-preflight --base-ref <ref> --board-runtime-store-ref <b64-ref> --source-idx <n>') : undefined;
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }), boardRuntimeStoreRef ? { boardRuntimeStoreRef } : undefined);
    const body    = await readStdinBody();
    const params: Record<string, string | number | boolean> = { sourceIdx: parseInt(idxRaw, 10) };
    if (outRef) params['outRef'] = outRef;
    printResult(await nonCore.probeSourcePreflight({ params, body }));
    return;
  }

  // ── run-source-preflight — card JSON + sourceIdx arrive via stdin, no board state needed ─────
  if (cmd === 'run-source-preflight') {
    const idxRaw  = requireFlag(rest, '--source-idx', 'run-source-preflight --source-idx <n>');
    const outRef  = optFlag(rest, '--out-ref');
    const tmpRef  = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const boardRuntimeStoreRef = baseRef ? requireBoardRuntimeStoreRef(rest, 'run-source-preflight --base-ref <ref> --board-runtime-store-ref <b64-ref> --source-idx <n>') : undefined;
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }), boardRuntimeStoreRef ? { boardRuntimeStoreRef } : undefined);
    const body    = await readStdinBody();
    const params: Record<string, string | number | boolean> = { sourceIdx: parseInt(idxRaw, 10) };
    if (outRef) params['outRef'] = outRef;
    printResult(await nonCore.runSourcePreflight({ params, body }));
    return;
  }

  // ── eval-card-compute — card + mock data arrive via stdin, no board state needed ────
  if (cmd === 'eval-card-compute') {
    const tmpRef = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const boardRuntimeStoreRef = baseRef ? requireBoardRuntimeStoreRef(rest, 'eval-card-compute --base-ref <ref> --board-runtime-store-ref <b64-ref>') : undefined;
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }), boardRuntimeStoreRef ? { boardRuntimeStoreRef } : undefined);
    const body = await readStdinBody();
    printResult(nonCore.evalCardCompute({ body }));
    return;
  }

  // ── simulate-card-cycle — full pipeline simulation with mocks via stdin ────
  if (cmd === 'simulate-card-cycle') {
    const tmpRef = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const boardRuntimeStoreRef = baseRef ? requireBoardRuntimeStoreRef(rest, 'simulate-card-cycle --base-ref <ref> --board-runtime-store-ref <b64-ref>') : undefined;
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }), boardRuntimeStoreRef ? { boardRuntimeStoreRef } : undefined);
    const body = await readStdinBody();
    printResult(await nonCore.simulateCardCycle({ body }));
    return;
  }

  // ── All remaining commands require --base-ref ─────────────────────────────
  if (!baseRef) throw new Error(`--base-ref is required for command "${cmd ?? '(none)'}"`);

  const boardRuntimeStoreRef = requireBoardRuntimeStoreRef(rest, `${cmd ?? '(none)'} --base-ref <ref> --board-runtime-store-ref <b64-ref> ...`);
  const readBoard = () => createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, __dirname, {
    onWarn: console.warn,
    notifyChannel,
    boardRuntimeStoreRef,
  }), { boardRuntimeStoreRef });
  const writeBoard = () => createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, __dirname, {
    onWarn: console.warn,
    notifyChannel,
    boardRuntimeStoreRef,
    queueStoreRef: requireQueueStoreRef(rest, `${cmd ?? '(none)'} --base-ref <ref> --board-runtime-store-ref <b64-ref> --queue-store-ref <b64-ref> ...`),
  }), { boardRuntimeStoreRef });
  const nonCore = () => createBoardLiveCardsNonCorePublic(baseRef, createFsBoardNonCorePlatformAdapter(baseRef, __dirname, { onWarn: console.warn }), { boardRuntimeStoreRef });

  switch (cmd) {
    case 'init': {
      const usage = 'init --base-ref <ref> --board-runtime-store-ref <b64-ref> --queue-store-ref <b64-ref> --card-store-ref <b64-ref> --outputs-store-ref <b64-ref> --fetched-sources-store-ref <b64-ref> --chat-store-ref <b64-ref> --artifacts-store-ref <b64-ref> --scratch-store-ref <b64-ref>';
      const cardStoreRef = requireFlag(rest, '--card-store-ref', usage);
      const outputsStoreRef = requireFlag(rest, '--outputs-store-ref', usage);
      const fetchedSourcesStoreRef = requireFlag(rest, '--fetched-sources-store-ref', usage);
      const chatStoreRef = requireFlag(rest, '--chat-store-ref', usage);
      const scratchStoreRef = requireFlag(rest, '--scratch-store-ref', usage);
      const artifactsStoreRef = requireFlag(rest, '--artifacts-store-ref', usage);
      const queueStoreRef = requireQueueStoreRef(rest, usage);
      const body = await readStdinBody();
      printResult(writeBoard().init({ params: { boardRuntimeStoreRef, queueStoreRef, cardStoreRef, outputsStoreRef, fetchedSourcesStoreRef, chatStoreRef, scratchStoreRef, artifactsStoreRef }, body }));
      return;
    }
    case 'status': {
      printResult(readBoard().status({}));
      return;
    }
    case 'get-card-store-ref': {
      printResult(readBoard().getCardStoreRef({}));
      return;
    }
    case 'get-outputs-store-ref': {
      printResult(readBoard().getOutputsStoreRef({}));
      return;
    }
    case 'get-scratch-store-ref': {
      printResult(readBoard().getScratchStoreRef({}));
      return;
    }
    case 'get-chat-store-ref': {
      printResult(readBoard().getChatStoreRef({}));
      return;
    }
    case 'get-artifacts-store-ref': {
      printResult(readBoard().getArtifactsStoreRef({}));
      return;
    }
    case 'get-fetched-sources-store-ref': {
      printResult(readBoard().getFetchedSourcesStoreRef({}));
      return;
    }
    case 'get-outputs': {
      const type = requireFlag(rest, '--type', 'get-outputs --base-ref <ref> --type <data-object|computed-values> [--key <key>] [--all]');
      const all = rest.includes('--all');
      if (type === 'data-object') {
        if (all) {
          printResult(readBoard().getAllOutputsDataObjects({}));
        } else {
          const key = requireFlag(rest, '--key', 'get-outputs --type data-object --base-ref <ref> --key <datakey>');
          printResult(readBoard().getOutputsDataObject({ params: { key } }));
        }
      } else if (type === 'computed-values') {
        if (all) {
          printResult(readBoard().getAllOutputsComputedValues({}));
        } else {
          const key = requireFlag(rest, '--key', 'get-outputs --type computed-values --base-ref <ref> --key <card-id>');
          printResult(readBoard().getOutputsComputedValues({ params: { key } }));
        }
      } else if (type === 'fetched_sources') {
        if (all) {
          printResult(readBoard().getAllOutputsFetchedSources({}));
        } else {
          const key = requireFlag(rest, '--key', 'get-outputs --type fetched_sources --base-ref <ref> --key <card-id>');
          printResult(readBoard().getOutputsFetchedSources({ params: { key } }));
        }
      } else {
        throw new Error(`get-outputs: unknown --type "${type}", expected data-object | computed-values | fetched_sources`);
      }
      return;
    }
    case 'remove-card': {
      const id = requireFlag(rest, '--id', 'remove-card --base-ref <ref> --id <card-id>');
      printResult(writeBoard().removeCard({ params: { id } }));
      return;
    }
    case 'add-card-files': {
      const cardId = requireFlag(rest, '--card-id', 'add-card-files --base-ref <ref> --card-id <card-id> [--value-json <json>]');
      const valueJson = optFlag(rest, '--value-json');
      const body = valueJson ? JSON.parse(valueJson) as unknown : await readStdinBody();
      printResult(writeBoard().addCardFiles({ params: { cardId }, body }));
      return;
    }
    case 'get-attachment-content': {
      const cardId = requireFlag(rest, '--card-id', 'get-attachment-content --base-ref <ref> --board-runtime-store-ref <b64-ref> --card-id <card-id> [--file-idx <n>]');
      const fileIdx = optFlag(rest, '--file-idx');
      process.stdout.write(Buffer.from(readAttachmentBytes(baseRef, boardRuntimeStoreRef, notifyChannel, cardId, fileIdx)));
      return;
    }
    case 'retrigger': {
      const id = requireFlag(rest, '--id', 'retrigger --base-ref <ref> --id <card-id>');
      printResult(writeBoard().retrigger({ params: { id } }));
      return;
    }
    case 'upsert-card': {
      const cardId  = optFlag(rest, '--card-id');
      const all     = rest.includes('--all');
      const restart = rest.includes('--restart');
      if (!cardId && !all) throw new Error('upsert-card requires --card-id <id> or --all');
      const params: Record<string, string | number | boolean> = {};
      if (cardId)  params['cardId']  = cardId;
      if (all)     params['all']     = true;
      if (restart) params['restart'] = true;
      printResult(writeBoard().upsertCard({ params }));
      return;
    }
    case 'task-failed': {
      const token = requireFlag(rest, '--token', 'task-failed --base-ref <ref> --token <token> [--error <message>]');
      const params: Record<string, string> = { token };
      const error = optFlag(rest, '--error');
      if (error) params['error'] = error;
      printResult(writeBoard().taskFailed({ params }));
      return;
    }
    case 'task-progress': {
      const token  = requireFlag(rest, '--token', 'task-progress --base-ref <ref> --token <token> [--update <json>]');
      const updateRaw = optFlag(rest, '--update');
      const update = updateRaw ? JSON.parse(updateRaw) as Record<string, unknown> : {};
      printResult(writeBoard().taskProgress({ params: { token }, body: { update } }));
      return;
    }
    case 'describe-task-executor-capabilities': {
      printResult(await nonCore().describeTaskExecutorCapabilities({}));
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

// ============================================================================
// Main invocation guard
// ============================================================================

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
