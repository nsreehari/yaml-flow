import type { GraphEvent } from '../event-graph/types.js';
import type { FetchedSourcesStore } from './board-live-cards-all-stores.js';
import { parseRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';

/**
 * Append a task-progress event to the board journal and schedule a drain pass.
 *
 * This is the single place that knows the shape of a task-progress journal entry.
 * All callback commands (source-data-fetched, source-data-fetch-failure,
 * task-progress, inference-done) go through this helper instead of hand-crafting
 * the event inline.
 */
export function injectTaskProgress(
  baseRef: KindValueRef,
  taskName: string,
  update: Record<string, unknown>,
  deps: {
    appendEventToJournal: (baseRef: KindValueRef, event: GraphEvent) => void;
    processAccumulatedEventsInfinitePass: (baseRef: KindValueRef) => Promise<boolean>;
  },
): void {
  deps.appendEventToJournal(baseRef, {
    type: 'task-progress',
    taskName,
    update,
    timestamp: new Date().toISOString(),
  });
  void deps.processAccumulatedEventsInfinitePass(baseRef);
}

interface CallbackTokenPayload {
  taskName: string;
}

interface SourceTokenPayloadLike {
  cbk: string;
  rg: string;
  br: string;
  cid: string;
  b: string;
  d: string;
  cs?: string;
}

interface CallbackCommandDeps {
  decodeCallbackToken: (token: string) => CallbackTokenPayload | null;
  decodeSourceToken: (token: string) => SourceTokenPayloadLike | null;
  getFetchedSourcesStore: (baseRef: KindValueRef) => FetchedSourcesStore;
  generateId: () => string;
  writeRuntimeDataObjects: (baseRef: KindValueRef, data: Record<string, unknown>) => void;
  appendEventToJournal: (baseRef: KindValueRef, event: GraphEvent) => void;
  processAccumulatedEventsForced: (baseRef: KindValueRef) => Promise<void>;
  processAccumulatedEventsInfinitePass: (baseRef: KindValueRef) => Promise<boolean>;
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
    const brIdx = args.indexOf('--base-ref');
    const tokenIdx = args.indexOf('--token');
    const dataIdx = args.indexOf('--data');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const baseRef = baseRefRaw ? parseRef(baseRefRaw) : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    if (!baseRef || !token) {
      console.error('Usage: board-live-cards task-completed --base-ref <::kind::value> --token <token> [--data <json>]');
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

    deps.writeRuntimeDataObjects(baseRef, data);

    deps.appendEventToJournal(baseRef, {
      type: 'task-completed',
      taskName: decoded.taskName,
      data,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsForced(baseRef);
    console.log('Task completed.');
  }

  function cmdTaskFailed(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const tokenIdx = args.indexOf('--token');
    const errorIdx = args.indexOf('--error');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const baseRef = baseRefRaw ? parseRef(baseRefRaw) : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const errorMsg = errorIdx !== -1 ? args[errorIdx + 1] : 'unknown error';
    if (!baseRef || !token) {
      console.error('Usage: board-live-cards task-failed --base-ref <::kind::value> --token <token> [--error <message>]');
      process.exit(1);
    }

    const decoded = deps.decodeCallbackToken(token);
    if (!decoded) {
      console.error('Invalid callback token');
      process.exit(1);
    }

    deps.appendEventToJournal(baseRef, {
      type: 'task-failed',
      taskName: decoded.taskName,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });

    void deps.processAccumulatedEventsForced(baseRef);
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

    const { cbk, cid, b, d, cs } = payload;
    const boardRef = parseRef(payload.br);

    const deliveryToken = deps.generateId();
    deps.getFetchedSourcesStore(boardRef).ingestSourceDataStaged(cid, d, ref, deliveryToken);
    console.log(`[source-data-fetched] ${cid}.${b} -> ${cid}/${d}`);

    const fetchedAt = new Date().toISOString();
    const cbkDecoded = deps.decodeCallbackToken(cbk);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in source token');
      process.exit(1);
    }

    injectTaskProgress(boardRef, cbkDecoded.taskName, { bindTo: b, outputFile: d, fetchedAt, deliveryToken, sourceChecksum: cs }, deps);
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

    const { cbk, cid, b, d, cs } = payload;
    const boardRef = parseRef(payload.br);
    console.log(`[source-data-fetch-failure] ${cid}.${b}: ${reason}`);

    const cbkDecoded = deps.decodeCallbackToken(cbk);
    if (!cbkDecoded) {
      console.error('Invalid callback token embedded in source token');
      process.exit(1);
    }

    injectTaskProgress(boardRef, cbkDecoded.taskName, { bindTo: b, outputFile: d, failure: true, reason, sourceChecksum: cs }, deps);
  }

  function cmdTaskProgress(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const tokenIdx = args.indexOf('--token');
    const updateIdx = args.indexOf('--update');

    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const baseRef = baseRefRaw ? parseRef(baseRefRaw) : undefined;
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
    const updateJson = updateIdx !== -1 ? args[updateIdx + 1] : '{}';

    if (!baseRef || !token) {
      console.error('Usage: board-live-cards task-progress --base-ref <::kind::value> --token <token> [--update <json>]');
      process.exit(1);
    }

    const decoded = deps.decodeCallbackToken(token);
    if (!decoded) {
      console.error('Invalid callback token');
      process.exit(1);
    }

    const update = updateJson ? JSON.parse(updateJson) : {};

    injectTaskProgress(baseRef, decoded.taskName, update, deps);
  }

  return {
    cmdTaskCompleted,
    cmdTaskFailed,
    cmdTaskProgress,
    cmdSourceDataFetched,
    cmdSourceDataFetchFailure,
  };
}
