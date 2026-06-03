import type { ExecutionRef } from './execution-interface.js';
import { assertBoardSelfRef } from './board-self-ref.js';
import { serializeRef } from './storage-interface.js';

export interface BoardTaskCallback {
  token: string;
  via: ExecutionRef;
}

export interface BoardCallbackTransport {
  createCallback(token: string): BoardTaskCallback;
}

export function assertBoardCallbackTransport(
  callbackTransport: BoardCallbackTransport | null | undefined,
  owner: string,
): asserts callbackTransport is BoardCallbackTransport {
  if (!callbackTransport || typeof callbackTransport !== 'object') {
    throw new Error(`${owner}: adapter.callbackTransport is required`);
  }
  if (typeof callbackTransport.createCallback !== 'function') {
    throw new Error(`${owner}: adapter.callbackTransport.createCallback is required`);
  }
}

export function createExecutionRefCallbackTransport(
  getSelfRef: () => ExecutionRef | null | undefined,
  owner = 'callbackTransport',
): BoardCallbackTransport {
  return {
    createCallback(token: string): BoardTaskCallback {
      const selfRef = getSelfRef();
      assertBoardSelfRef(selfRef, owner);
      return { token, via: selfRef };
    },
  };
}

export function createStaticExecutionRefCallbackTransport(selfRef: ExecutionRef): BoardCallbackTransport {
  return createExecutionRefCallbackTransport(() => selfRef, 'createStaticExecutionRefCallbackTransport');
}

export function createHttpBoardCallbackTransport(baseUrl: string): BoardCallbackTransport {
  return createStaticExecutionRefCallbackTransport({
    meta: 'board-live-cards',
    howToRun: 'http:post',
    whatToRun: serializeRef({ kind: 'http-url', value: String(baseUrl || '').trim() }),
  });
}

export function createInProcessBoardCallbackTransport(handlerKey: string): BoardCallbackTransport {
  return createStaticExecutionRefCallbackTransport({
    meta: 'board-live-cards',
    howToRun: 'in-process-loop',
    whatToRun: serializeRef({ kind: 'in-process-loop', value: String(handlerKey || '').trim() }),
  });
}

export function createLocalNodeBoardCallbackTransport(opts?: string | {
  notifyChannel?: string;
  boardRuntimeStoreRef?: string;
  queueStoreRef?: string;
}): BoardCallbackTransport {
  const options = typeof opts === 'string' ? { notifyChannel: opts } : (opts ?? {});
  const extra: Record<string, unknown> = {};
  if (options.notifyChannel) extra.notifyChannel = options.notifyChannel;
  if (options.boardRuntimeStoreRef) extra.boardRuntimeStoreRef = options.boardRuntimeStoreRef;
  if (options.queueStoreRef) extra.queueStoreRef = options.queueStoreRef;
  return createStaticExecutionRefCallbackTransport({
    meta: 'board-live-cards',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'yaml-flow-cli', value: 'board-live-cards-cli.js' }),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  });
}