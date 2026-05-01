import type { GraphEvent } from '../event-graph/types.js';
import type { FetchedSourcesStore } from './board-live-cards-all-stores.js';
import { parseRef } from './storage-interface.js';

/**
 * Append a task-progress event to the board journal and schedule a drain pass.
 *
 * This is the single place that knows the shape of a task-progress journal entry.
 * All callback commands (source-data-fetched, source-data-fetch-failure,
 * task-progress, inference-done) go through this helper instead of hand-crafting
 * the event inline.
 */
export function injectTaskProgress(
  boardDir: string,
  taskName: string,
  update: Record<string, unknown>,
  deps: {
    appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
    processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
  },
): void {
  deps.appendEventToJournal(boardDir, {
    type: 'task-progress',
    taskName,
    update,
    timestamp: new Date().toISOString(),
  });
  void deps.processAccumulatedEventsInfinitePass(boardDir);
}

interface CallbackTokenPayload {
  taskName: string;
}

interface SourceTokenPayloadLike {
  cbk: string;
  rg: string;
  cid: string;
  b: string;
  d: string;
  cs?: string;
}

interface CallbackCommandDeps {
  decodeCallbackToken: (token: string) => CallbackTokenPayload | null;
  decodeSourceToken: (token: string) => SourceTokenPayloadLike | null;
  getFetchedSourcesStore: (boardDir: string) => FetchedSourcesStore;
  generateId: () => string;
  writeRuntimeDataObjects: (boardDir: string, data: Record<string, unknown>) => void;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsForced: (boardDir: string) => Promise<void>;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface CallbackCommandHandlers {
  cmdTaskCompleted: (args: string[]) => void;
  cmdTaskFailed: (args: string[]) => void;
  cmdTaskProgress: (args: string[]) => void;
  cmdSourceDataFetched: (args: string[]) => void;
  cmdSourceDataFetchFailure: (args: string[]) => void;
}

export function createCallbackCommandHandlers(deps: CallbackCommandDeps): CallbackCommandHandlers {
  function cmdTaskCompleted(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const tokenIdx = args.indexOf('--token');
    const dataIdx = args.indexOf('--data');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    if (!dir || !token) {
      console.error('Usage: board-live-cards task-completed --rg <dir> --token <token> [--data <json>]');
      process.exit(1);
    }

    const decoded = deps.decodeCallbackToken(token);
    if (!decoded) {
      console.error('Invalid callback token');
      process.exit(1);
    }

    const data: Record<string, unknown> = dataIdx !== -1
      ? JSON.parse(args[dataIdx + 1])
      : {};

    deps.writeRuntimeDataObjects(dir, data);

    deps.appendEventToJournal(dir, {
      type: 'task-completed',
      taskName: decoded.taskName,
      data,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsForced(dir);
    console.log('Task completed.');
  }

  function cmdTaskFailed(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const tokenIdx = args.indexOf('--token');
    const errorIdx = args.indexOf('--error');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const errorMsg = errorIdx !== -1 ? args[errorIdx + 1] : 'unknown error';
    if (!dir || !token) {
      console.error('Usage: board-live-cards task-failed --rg <dir> --token <token> [--error <message>]');
      process.exit(1);
    }

    const decoded = deps.decodeCallbackToken(token);
    if (!decoded) {
      console.error('Invalid callback token');
      process.exit(1);
    }

    deps.appendEventToJournal(dir, {
      type: 'task-failed',
      taskName: decoded.taskName,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsForced(dir);
    console.log('Task failed.');
  }

  function cmdSourceDataFetched(args: string[]): void {
    const refIdx = args.indexOf('--ref');
    const tokenIdx = args.indexOf('--token');
    const refRaw = refIdx !== -1 ? args[refIdx + 1] : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    if (!refRaw || !token) {
      console.error('Usage: board-live-cards source-data-fetched --ref ::kind::value --token <sourceToken>');
      process.exit(1);
    }

    const ref = parseRef(refRaw);

    const payload = deps.decodeSourceToken(token);
    if (!payload) {
      console.error('Invalid source token');
      process.exit(1);
    }

    const { cbk, rg, cid, b, d, cs } = payload;

    const deliveryToken = deps.generateId();
    deps.getFetchedSourcesStore(rg).ingestSourceDataStaged(cid, d, ref, deliveryToken);
    console.log(`[source-data-fetched] ${cid}.${b} -> ${cid}/${d}`);

    const fetchedAt = new Date().toISOString();
    const cbkDecoded = deps.decodeCallbackToken(cbk);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in source token');
      process.exit(1);
    }

    injectTaskProgress(rg, cbkDecoded.taskName, { bindTo: b, outputFile: d, fetchedAt, deliveryToken, sourceChecksum: cs }, deps);
  }

  function cmdSourceDataFetchFailure(args: string[]): void {
    const tokenIdx = args.indexOf('--token');
    const reasonIdx = args.indexOf('--reason');
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : 'unknown';
    if (!token) {
      console.error('Usage: board-live-cards source-data-fetch-failure --token <sourceToken> [--reason <msg>]');
      process.exit(1);
    }

    const payload = deps.decodeSourceToken(token);
    if (!payload) {
      console.error('Invalid source token');
      process.exit(1);
    }

    const { cbk, rg, cid, b, d, cs } = payload;
    console.log(`[source-data-fetch-failure] ${cid}.${b}: ${reason}`);

    const cbkDecoded = deps.decodeCallbackToken(cbk);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in source token');
      process.exit(1);
    }

    injectTaskProgress(rg, cbkDecoded.taskName, { bindTo: b, outputFile: d, failure: true, reason, sourceChecksum: cs }, deps);
  }

  function cmdTaskProgress(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const tokenIdx = args.indexOf('--token');
    const updateIdx = args.indexOf('--update');

    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const updateJson = updateIdx !== -1 ? args[updateIdx + 1] : '{}';

    if (!dir || !token) {
      console.error('Usage: board-live-cards task-progress --rg <dir> --token <token> [--update <json>]');
      process.exit(1);
    }

    const decoded = deps.decodeCallbackToken(token);
    if (!decoded) {
      console.error('Invalid callback token');
      process.exit(1);
    }

    const update = updateJson ? JSON.parse(updateJson) : {};

    injectTaskProgress(dir, decoded.taskName, update, deps);
  }

  return {
    cmdTaskCompleted,
    cmdTaskFailed,
    cmdTaskProgress,
    cmdSourceDataFetched,
    cmdSourceDataFetchFailure,
  };
}
