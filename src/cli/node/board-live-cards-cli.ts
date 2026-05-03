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
} from './fs-board-adapter.js';
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
  const baseRef = br ? parseRef(br) : undefined;

  // ── Source callbacks — token has `br` field; no --base-ref needed ────────
  if (cmd === 'source-data-fetched') {
    const token = requireFlag(rest, '--token', 'source-data-fetched --token <token> --ref <sourcefile>');
    const ref   = requireFlag(rest, '--ref',   'source-data-fetched --token <token> --ref <sourcefile>');
    const brStr = decodeBoardRefFromToken(token);
    if (!brStr) throw new Error('source-data-fetched: could not decode board ref from token — is this a valid source token?');
    const br2 = parseRef(brStr);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.sourceDataFetched({ params: { token, ref } }));
    return;
  }

  if (cmd === 'source-data-fetch-failure') {
    const token = requireFlag(rest, '--token', 'source-data-fetch-failure --token <token> [--reason <message>]');
    const brStr = decodeBoardRefFromToken(token);
    if (!brStr) throw new Error('source-data-fetch-failure: could not decode board ref from token — is this a valid source token?');
    const br2 = parseRef(brStr);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    const params: Record<string, string> = { token };
    const reason = optFlag(rest, '--reason');
    if (reason) params['reason'] = reason;
    printResult(board.sourceDataFetchFailure({ params }));
    return;
  }

  // ── validate-tmp-card — card JSON arrives via stdin, optional --base-ref ─────
  if (cmd === 'validate-tmp-card') {
    const tmpRef = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }));
    const body = await readStdinBody();
    printResult(nonCore.validateTmpCard({ body }));
    return;
  }

  // ── probe-tmp-source — source-def + mock-projections arrive via stdin ──────
  if (cmd === 'probe-tmp-source') {
    const outRef  = requireFlag(rest, '--out-ref', 'probe-tmp-source --out-ref <ref>');
    const tmpRef  = baseRef ?? { kind: 'fs-path' as const, value: resolvePath('.') };
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }));
    const body    = await readStdinBody();
    printResult(nonCore.probeTmpSource({ params: { outRef }, body }));
    return;
  }

  // ── All remaining commands require --base-ref ─────────────────────────────
  if (!baseRef) throw new Error(`--base-ref is required for command "${cmd ?? '(none)'}"`);

  const board   = () => createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, __dirname, { onWarn: console.warn }));
  const nonCore = () => createBoardLiveCardsNonCorePublic(baseRef, createFsBoardNonCorePlatformAdapter(baseRef, __dirname, { onWarn: console.warn }));

  switch (cmd) {
    case 'init': {
      const cardStoreRef = requireFlag(rest, '--card-store-ref', 'init --base-ref <ref> --card-store-ref <::kind::value> --outputs-store-ref <::kind::value>');
      const outputsStoreRef = requireFlag(rest, '--outputs-store-ref', 'init --base-ref <ref> --card-store-ref <::kind::value> --outputs-store-ref <::kind::value>');
      const body = await readStdinBody();
      printResult(board().init({ params: { cardStoreRef, outputsStoreRef }, body }));
      return;
    }
    case 'status': {
      printResult(board().status({}));
      return;
    }
    case 'get-card-store-ref': {
      printResult(board().getCardStoreRef({}));
      return;
    }
    case 'get-outputs-store-ref': {
      printResult(board().getOutputsStoreRef({}));
      return;
    }
    case 'remove-card': {
      const id = requireFlag(rest, '--id', 'remove-card --base-ref <ref> --id <card-id>');
      printResult(board().removeCard({ params: { id } }));
      return;
    }
    case 'retrigger': {
      const id = requireFlag(rest, '--id', 'retrigger --base-ref <ref> --id <card-id>');
      printResult(board().retrigger({ params: { id } }));
      return;
    }
    case 'process-accumulated-events': {
      printResult(await board().processAccumulatedEvents({}));
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
      printResult(board().upsertCard({ params }));
      return;
    }
    case 'task-completed': {
      const token  = requireFlag(rest, '--token', 'task-completed --base-ref <ref> --token <token> [--data <json>]');
      const dataRaw = optFlag(rest, '--data');
      const data = dataRaw ? JSON.parse(dataRaw) as Record<string, unknown> : {};
      printResult(board().taskCompleted({ params: { token }, body: { data } }));
      return;
    }
    case 'task-failed': {
      const token = requireFlag(rest, '--token', 'task-failed --base-ref <ref> --token <token> [--error <message>]');
      const params: Record<string, string> = { token };
      const error = optFlag(rest, '--error');
      if (error) params['error'] = error;
      printResult(board().taskFailed({ params }));
      return;
    }
    case 'task-progress': {
      const token  = requireFlag(rest, '--token', 'task-progress --base-ref <ref> --token <token> [--update <json>]');
      const updateRaw = optFlag(rest, '--update');
      const update = updateRaw ? JSON.parse(updateRaw) as Record<string, unknown> : {};
      printResult(board().taskProgress({ params: { token }, body: { update } }));
      return;
    }
    case 'validate-card': {
      const cardId = optFlag(rest, '--card-id');
      const all    = rest.includes('--all');
      if (!cardId && !all) throw new Error('validate-card requires --card-id <id> or --all');
      const params: Record<string, string | number | boolean> = {};
      if (cardId) params['cardId'] = cardId;
      if (all)    params['all']    = true;
      printResult(nonCore().validateCard({ params }));
      return;
    }
    case 'probe-source': {
      const cardId = requireFlag(rest, '--card-id', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --out-ref <ref>');
      const idxRaw = requireFlag(rest, '--source-idx', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --out-ref <ref>');
      const outRef = optFlag(rest, '--out-ref');
      const body   = await readStdinBody();
      const params: Record<string, string | number | boolean> = { cardId, sourceIdx: parseInt(idxRaw, 10) };
      if (outRef) params['outRef'] = outRef;
      printResult(nonCore().probeSource({ params, body }));
      return;
    }
    case 'describe-task-executor-capabilities': {
      printResult(nonCore().describeTaskExecutorCapabilities({}));
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
