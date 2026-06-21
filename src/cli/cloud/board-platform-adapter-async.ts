import type { BoardChangeNotification, RuntimeNotification } from '../common/notification-interface.js';
import type { BoardCallbackTransport } from '../common/board-callback-transport.js';
import type { ExecutionRef } from '../common/execution-interface.js';
import { parseExecutionRef, serializeExecutionRef } from '../common/execution-interface.js';
import { parseRef } from '../common/storage-interface.js';
import type { KindValueRef } from '../common/storage-interface.js';
import type { ChatStorage } from '../common/chat-storage-lib.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncBlobStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncQueueStorage,
  AsyncScratchStorage,
} from './storage-async-interface.js';

export interface AsyncBoardWorkerRequest {
  boardId?: string;
  ref: ExecutionRef;
  args: Record<string, unknown>;
}

export interface AsyncBoardWorkerQueuedRequest {
  messageId: string;
  enqueuedAt: string;
  attempt: number;
  request: AsyncBoardWorkerRequest;
}

export interface AsyncBoardWorkerLeasedRequest extends AsyncBoardWorkerQueuedRequest {
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AsyncBoardWorkerDeadLetterRequest extends AsyncBoardWorkerQueuedRequest {
  reason?: string;
}

export interface AsyncBoardWorkerStore {
  enqueueRequest(request: AsyncBoardWorkerRequest): Promise<string>;
  leaseRequests(opts?: { max?: number; visibilityMs?: number }): Promise<AsyncBoardWorkerLeasedRequest[]>;
  ackRequest(messageId: string, leaseToken: string): Promise<boolean>;
  nackRequest(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): Promise<boolean>;
  peekActive(): Promise<AsyncBoardWorkerQueuedRequest[]>;
  peekDeadLetter(): Promise<AsyncBoardWorkerDeadLetterRequest[]>;
}

export interface AsyncBoardConfigStore {
  readTaskExecutorRef(): Promise<ExecutionRef | undefined>;
  writeTaskExecutorRef(ref: ExecutionRef): Promise<void>;
  readChatHandlerFlow(): Promise<unknown>;
  writeChatHandlerFlow(flow: unknown): Promise<void>;
  readBoardRuntimeStoreRef(): Promise<string | null>;
  writeBoardRuntimeStoreRef(ref: string): Promise<void>;
  readCardStoreRef(): Promise<string | null>;
  writeCardStoreRef(ref: string): Promise<void>;
  readOutputsStoreRef(): Promise<string | null>;
  writeOutputsStoreRef(ref: string): Promise<void>;
  readQueueStoreRef(): Promise<string | null>;
  writeQueueStoreRef(ref: string): Promise<void>;
  readScratchStoreRef(): Promise<string | null>;
  writeScratchStoreRef(ref: string): Promise<void>;
  readChatStoreRef(): Promise<string | null>;
  writeChatStoreRef(ref: string): Promise<void>;
  readArtifactsStoreRef(): Promise<string | null>;
  writeArtifactsStoreRef(ref: string): Promise<void>;
  readFetchedSourcesStoreRef(): Promise<string | null>;
  writeFetchedSourcesStoreRef(ref: string): Promise<void>;
}

export interface AsyncBoardPlatformAdapter {
  kvStorage(namespace: string): AsyncKVStorage;
  kvStorageForRef(ref: string): AsyncKVStorage;
  blobStorage(namespace: string): AsyncBlobStorage;
  blobStorageForRef(ref: string): AsyncBlobStorage;
  chatStorageForRef(ref: string): ChatStorage;
  queueStorageForRef(ref: string, lane: string): AsyncQueueStorage;
  scratchStorage(): AsyncScratchStorage;
  scratchStorageForRef(ref: string): AsyncScratchStorage;
  archiveFactory(): AsyncArchiveFactory;
  archiveFactoryForRef(ref: string): AsyncArchiveFactory;
  journalStorage(): AsyncJournalStorage;
  journalStorageForRef(ref: string): AsyncJournalStorage;
  lock: AsyncAtomicRelayLock;
  callbackTransport?: BoardCallbackTransport;
  dispatchExecution(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }>;
  supportsDirectSourceOutput?(ref: ExecutionRef): boolean;
  resolveBlob(ref: KindValueRef): Promise<string>;
  hashFn(value: unknown): string;
  genId(): string;
  requestProcessAccumulated?(): void | Promise<void>;
  publishBoardChangeNotifications?(notifications: RuntimeNotification[]): void | Promise<void>;
  warn?: (msg: string) => void;
}

export interface HostedFetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface HostedFetchLike {
  (input: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<HostedFetchResponseLike>;
}

export interface HostedAsyncBoardPlatformAdapterOptions {
  boardId?: string;
  kvStorage(namespace: string): AsyncKVStorage;
  kvStorageForRef(ref: string): AsyncKVStorage;
  blobStorage(namespace: string): AsyncBlobStorage;
  blobStorageForRef(ref: string): AsyncBlobStorage;
  chatStorageForRef(ref: string): ChatStorage;
  queueStoreRef?: string;
  queueStorageForRef(ref: string, lane: string): AsyncQueueStorage;
  scratchStorage(): AsyncScratchStorage;
  scratchStorageForRef(ref: string): AsyncScratchStorage;
  archiveFactory(): AsyncArchiveFactory;
  archiveFactoryForRef(ref: string): AsyncArchiveFactory;
  journalStorage(): AsyncJournalStorage;
  journalStorageForRef(ref: string): AsyncJournalStorage;
  lock: AsyncAtomicRelayLock;
  callbackTransport?: BoardCallbackTransport;
  fetch?: HostedFetchLike;
  dispatchExecution?: (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{ dispatched: boolean; error?: string }>;
  supportsDirectSourceOutput?: (ref: ExecutionRef) => boolean;
  resolveBlob?: (ref: KindValueRef) => Promise<string>;
  hashFn: (value: unknown) => string;
  genId: () => string;
  requestProcessAccumulated?: () => void | Promise<void>;
  publishBoardChangeNotifications?: (notifications: BoardChangeNotification[]) => void | Promise<void>;
  onWarn?: (msg: string) => void;
}

function mapQueued(message: { id: string; body: AsyncBoardWorkerRequest; enqueuedAt: string; attempt: number }): AsyncBoardWorkerQueuedRequest {
  return {
    messageId: message.id,
    enqueuedAt: message.enqueuedAt,
    attempt: message.attempt,
    request: message.body,
  };
}

function whatToRunValue(whatToRun: string | KindValueRef): string {
  if (typeof whatToRun === 'string') {
    return whatToRun.startsWith('b64:') ? parseRef(whatToRun).value : whatToRun;
  }
  return whatToRun.value;
}

export function createAsyncBoardWorkerStore(queue: AsyncQueueStorage): AsyncBoardWorkerStore {
  return {
    async enqueueRequest(request: AsyncBoardWorkerRequest): Promise<string> {
      return (await queue.enqueue(request)).id;
    },

    async leaseRequests(opts?: { max?: number; visibilityMs?: number }): Promise<AsyncBoardWorkerLeasedRequest[]> {
      return (await queue.lease<AsyncBoardWorkerRequest>(opts)).map((message) => ({
        ...mapQueued(message),
        leaseToken: message.leaseToken,
        leaseExpiresAt: message.leaseExpiresAt,
      }));
    },

    ackRequest(messageId: string, leaseToken: string): Promise<boolean> {
      return queue.ack(messageId, leaseToken);
    },

    nackRequest(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): Promise<boolean> {
      return queue.nack(messageId, leaseToken, opts);
    },

    async peekActive(): Promise<AsyncBoardWorkerQueuedRequest[]> {
      return (await queue.peekActive<AsyncBoardWorkerRequest>()).map(mapQueued);
    },

    async peekDeadLetter(): Promise<AsyncBoardWorkerDeadLetterRequest[]> {
      return (await queue.peekDeadLetter<AsyncBoardWorkerRequest>()).map((message) => ({
        ...mapQueued(message),
        reason: message.reason,
      }));
    },
  };
}

export function createAsyncBoardConfigStore(kv: AsyncKVStorage): AsyncBoardConfigStore {
  async function readKey(key: string): Promise<string | null> {
    const value = await kv.read(key);
    if (value == null) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  return {
    async readTaskExecutorRef(): Promise<ExecutionRef | undefined> {
      const raw = await readKey('task-executor');
      if (!raw?.trim()) return undefined;
      return parseExecutionRef(raw.trim());
    },
    writeTaskExecutorRef(ref: ExecutionRef): Promise<void> {
      return kv.write('task-executor', serializeExecutionRef(ref));
    },
    readChatHandlerFlow(): Promise<unknown> {
      return kv.read('chat-handler-flow');
    },
    writeChatHandlerFlow(flow: unknown): Promise<void> {
      return kv.write('chat-handler-flow', flow);
    },
    readBoardRuntimeStoreRef(): Promise<string | null> {
      return readKey('board-runtime-store-ref');
    },
    writeBoardRuntimeStoreRef(ref: string): Promise<void> {
      return kv.write('board-runtime-store-ref', ref);
    },
    readCardStoreRef(): Promise<string | null> {
      return readKey('card-store-ref');
    },
    writeCardStoreRef(ref: string): Promise<void> {
      return kv.write('card-store-ref', ref);
    },
    readOutputsStoreRef(): Promise<string | null> {
      return readKey('outputs-store-ref');
    },
    writeOutputsStoreRef(ref: string): Promise<void> {
      return kv.write('outputs-store-ref', ref);
    },
    readQueueStoreRef(): Promise<string | null> {
      return readKey('queue-store-ref');
    },
    writeQueueStoreRef(ref: string): Promise<void> {
      return kv.write('queue-store-ref', ref);
    },
    readScratchStoreRef(): Promise<string | null> {
      return readKey('scratch-store-ref');
    },
    writeScratchStoreRef(ref: string): Promise<void> {
      return kv.write('scratch-store-ref', ref);
    },
    readChatStoreRef(): Promise<string | null> {
      return readKey('chat-store-ref');
    },
    writeChatStoreRef(ref: string): Promise<void> {
      return kv.write('chat-store-ref', ref);
    },
    readArtifactsStoreRef(): Promise<string | null> {
      return readKey('artifacts-store-ref');
    },
    writeArtifactsStoreRef(ref: string): Promise<void> {
      return kv.write('artifacts-store-ref', ref);
    },
    readFetchedSourcesStoreRef(): Promise<string | null> {
      return readKey('fetched-sources-store-ref');
    },
    writeFetchedSourcesStoreRef(ref: string): Promise<void> {
      return kv.write('fetched-sources-store-ref', ref);
    },
  };
}

export function createHostedAsyncBoardPlatformAdapter(
  options: HostedAsyncBoardPlatformAdapterOptions,
): AsyncBoardPlatformAdapter {
  let currentCallbackTransport = options.callbackTransport;

  const resolveBlob = options.resolveBlob ?? (async (ref: KindValueRef): Promise<string> => {
    const content = await options.blobStorage('').read(ref.value);
    if (content == null) throw new Error(`Blob not found for ref ${ref.kind}:${ref.value}`);
    return content;
  });

  async function defaultDispatchExecution(
    ref: ExecutionRef,
    args: Record<string, unknown>,
  ): Promise<{ dispatched: boolean; error?: string }> {
    if (ref.howToRun === 'queue-storage') {
      if (!options.queueStoreRef) {
        return { dispatched: false, error: 'queue-storage dispatch requires queueStoreRef' };
      }
      const store = createAsyncBoardWorkerStore(options.queueStorageForRef(options.queueStoreRef, 'task-executor'));
      await store.enqueueRequest({
        boardId: typeof ref.extra?.boardId === 'string' ? ref.extra.boardId : options.boardId,
        ref,
        args,
      });
      return { dispatched: true };
    }

    if (ref.howToRun === 'http:post') {
      const fetchImpl = options.fetch ?? (globalThis.fetch as HostedFetchLike | undefined);
      if (!fetchImpl) return { dispatched: false, error: 'http:post dispatch requires fetch support' };
      const response = await fetchImpl(whatToRunValue(ref.whatToRun), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, ...(ref.extra ? { extra: ref.extra } : {}) }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        return { dispatched: false, error: `HTTP ${response.status}: ${text}` };
      }
      return { dispatched: true };
    }

    return { dispatched: false, error: `Unsupported hosted async transport \"${ref.howToRun}\"` };
  }

  return {
    kvStorage: options.kvStorage,
    kvStorageForRef: options.kvStorageForRef,
    blobStorage: options.blobStorage,
    blobStorageForRef: options.blobStorageForRef,
    chatStorageForRef: options.chatStorageForRef,
    queueStorageForRef: options.queueStorageForRef,
    scratchStorage: options.scratchStorage,
    scratchStorageForRef: options.scratchStorageForRef,
    archiveFactory: options.archiveFactory,
    archiveFactoryForRef: options.archiveFactoryForRef,
    journalStorage: options.journalStorage,
    journalStorageForRef: options.journalStorageForRef,
    lock: options.lock,
    get callbackTransport() {
      return currentCallbackTransport;
    },
    set callbackTransport(value: BoardCallbackTransport | undefined) {
      currentCallbackTransport = value;
    },
    dispatchExecution: (ref, args) => options.dispatchExecution?.(ref, args) ?? defaultDispatchExecution(ref, args),
    supportsDirectSourceOutput: options.supportsDirectSourceOutput,
    resolveBlob,
    hashFn: options.hashFn,
    genId: options.genId,
    requestProcessAccumulated: options.requestProcessAccumulated,
    publishBoardChangeNotifications: options.publishBoardChangeNotifications,
    warn: options.onWarn,
  };
}