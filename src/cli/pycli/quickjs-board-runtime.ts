import {
  createBoardLiveCardsPublic,
  type BoardPlatformAdapter,
  type CommandInput,
  type CommandResult,
} from '../common/board-live-cards-public.js';
import { parseRef, serializeRef, type KindValueRef, type AtomicRelayLock } from '../common/storage-interface.js';
import type { ExecutionRef } from '../common/execution-interface.js';
import jsonataSync from '../../card-compute/jsonata-sync.cjs';

declare global {
  // Injected by Python host bridge.
  // eslint-disable-next-line no-var
  var __hostCall: (payload: unknown) => unknown;
  // Used by createRequire shim when card-compute asks for jsonata-sync.cjs.
  // eslint-disable-next-line no-var
  var __jsonataSync: unknown;
  // QuickJS callable surface.
  // eslint-disable-next-line no-var
  var pycliBoardInvoke: (payload: BoardInvokePayload) => CommandResult | string;
}

type BoardInvokePayload = {
  baseRef: string;
  notifyChannel?: string;
  command:
    | 'init'
    | 'status'
    | 'getCardStoreRef'
    | 'getOutputsStoreRef'
    | 'getOutputsDataObject'
    | 'getAllOutputsDataObjects'
    | 'getOutputsComputedValues'
    | 'getAllOutputsComputedValues'
    | 'removeCard'
    | 'retrigger'
    | 'processAccumulatedEvents'
    | 'upsertCard'
    | 'taskFailed'
    | 'taskProgress'
    | 'sourceDataFetched'
    | 'sourceDataFetchFailure';
  input?: CommandInput;
};

function hostCall<T>(payload: unknown): T {
  return globalThis.__hostCall(payload) as T;
}

function makeLock(scope: string): AtomicRelayLock {
  return {
    tryAcquire(): (() => void) | null {
      const token = hostCall<string | null>({ op: 'lock.tryAcquire', scope });
      if (!token) return null;
      return () => {
        hostCall<boolean>({ op: 'lock.release', scope, token });
      };
    },
  };
}

function createHostAdapter(baseRef: KindValueRef, notifyChannel?: string): BoardPlatformAdapter {
  const scope = baseRef.value;

  function makeKv(scopeRoot: string, namespace: string) {
    return {
      read(key: string): unknown | null {
        return hostCall<unknown | null>({ op: 'kv.read', scope: scopeRoot, namespace, key });
      },
      write(key: string, value: unknown): void {
        hostCall<boolean>({ op: 'kv.write', scope: scopeRoot, namespace, key, value });
      },
      delete(key: string): void {
        hostCall<boolean>({ op: 'kv.delete', scope: scopeRoot, namespace, key });
      },
      listKeys(prefix?: string): string[] {
        return hostCall<string[]>({ op: 'kv.list', scope: scopeRoot, namespace, prefix });
      },
    };
  }

  return {
    kvStorage(namespace: string) {
      return makeKv(scope, namespace);
    },

    kvStorageForRef(ref: string) {
      const parsed = parseRef(ref);
      return makeKv(parsed.value, '');
    },

    requestProcessAccumulated() {
      hostCall<boolean>({ op: 'board.requestProcessAccumulated', scope, notifyChannel });
    },

    publishBoardChangeNotifications(notifications) {
      if (!notifyChannel || notifications.length === 0) return;
      hostCall<boolean>({ op: 'board.publishNotifications', scope, notifyChannel, notifications });
    },

    blobStorage(namespace: string) {
      return {
        read(key: string): string | null {
          return hostCall<string | null>({ op: 'blob.read', scope, namespace, key });
        },
        write(key: string, content: string): void {
          hostCall<boolean>({ op: 'blob.write', scope, namespace, key, content });
        },
        exists(key: string): boolean {
          return hostCall<boolean>({ op: 'blob.exists', scope, namespace, key });
        },
        remove(key: string): void {
          hostCall<boolean>({ op: 'blob.remove', scope, namespace, key });
        },
      };
    },

    journalAdapter() {
      return {
        readAllEntries() {
          return hostCall<Array<{ id: string; event: unknown }>>({ op: 'journal.readAllEntries', scope }) as Array<{ id: string; event: unknown }>;
        },
        appendEntry(entry: { id: string; event: unknown }) {
          hostCall<boolean>({ op: 'journal.appendEntry', scope, entry });
        },
        generateId() {
          return hostCall<string>({ op: 'journal.generateId', scope });
        },
      };
    },

    lock: makeLock(scope),

    selfRef: hostCall<ExecutionRef>({ op: 'self.ref', scope }),

    async dispatchExecution(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }> {
      return hostCall<{ dispatched: boolean; error?: string }>({
        op: 'execution.dispatch',
        scope,
        ref,
        args,
      });
    },

    resolveBlob(ref) {
      const content = hostCall<string | null>({
        op: 'blob.resolveRef',
        scope,
        ref,
      });
      if (content === null) {
        throw new Error(`resolveBlob: blob not found: ${serializeRef(ref)}`);
      }
      return content;
    },

    hashFn(value: unknown): string {
      return hostCall<string>({ op: 'hash.computeStableJson', value });
    },

    genId(): string {
      return hostCall<string>({ op: 'id.gen' });
    },

    onWarn(msg: string): void {
      hostCall<boolean>({ op: 'warn', msg });
    },
  };
}

async function invoke(payload: BoardInvokePayload): Promise<CommandResult | string> {
  const baseRef = parseRef(payload.baseRef);
  const board = createBoardLiveCardsPublic(baseRef, createHostAdapter(baseRef, payload.notifyChannel));
  const input = payload.input ?? {};

  switch (payload.command) {
    case 'init':
      return board.init(input);
    case 'status':
      return board.status(input);
    case 'getCardStoreRef':
      return board.getCardStoreRef(input);
    case 'getOutputsStoreRef':
      return board.getOutputsStoreRef(input);
    case 'getOutputsDataObject':
      return board.getOutputsDataObject(input);
    case 'getAllOutputsDataObjects':
      return board.getAllOutputsDataObjects(input);
    case 'getOutputsComputedValues':
      return board.getOutputsComputedValues(input);
    case 'getAllOutputsComputedValues':
      return board.getAllOutputsComputedValues(input);
    case 'removeCard':
      return board.removeCard(input);
    case 'retrigger':
      return board.retrigger(input);
    case 'processAccumulatedEvents':
      return board.processAccumulatedEvents(input);
    case 'upsertCard':
      return board.upsertCard(input);
    case 'taskFailed':
      return board.taskFailed(input);
    case 'taskProgress':
      return board.taskProgress(input);
    case 'sourceDataFetched':
      return board.sourceDataFetched(input);
    case 'sourceDataFetchFailure':
      return board.sourceDataFetchFailure(input);
    default:
      return { status: 'fail', error: `Unsupported command: ${(payload as { command?: string }).command ?? 'unknown'}` };
  }
}

globalThis.__jsonataSync = jsonataSync;
globalThis.pycliBoardInvoke = invoke;
