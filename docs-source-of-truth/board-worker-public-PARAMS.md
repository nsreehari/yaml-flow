# board-worker — Public API Reference

The board-worker surface is the transport-agnostic contract for **queueing executor invocations** and **delivering their results back to the board** via callback tokens. For Node hosts, queue draining is expressed through the generic queue-lane helpers.

Primary pieces:

1. **`BoardWorkerStore`** (`board-worker-store.ts`, platform-free) — durable queue of `BoardWorkerRequest`s on top of any `QueueStorage`.
2. **Task-executor lane helpers** (`queue-runners.ts`, Node) — `createBoardWorkerQueueLane`, `startQueueLaneRunner`, and `startQueueLaneRunners` for host-driven polling/lease/ack/nack execution.
3. **`reportComplete` / `reportFailed`** (`board-worker-adapter.ts`, Node) — callback helpers that task-executors use to deliver results back to the board, in-process or over HTTP.

`board-worker-adapter` is a published worker-facing boundary, not just an internal helper. Its `KindValueRef` / `parseRef` / `serializeRef` helpers intentionally duplicate the common storage wire helpers so executors can depend on `yaml-flow/board-worker-adapter` as a self-contained surface, or vendor the file directly, without importing the broader runtime internals. The wire format must stay aligned with `cli/common/storage-interface.ts`.

Import surface (Node):

```ts
import { createBoardWorkerStore } from 'yaml-flow/board-worker-store';
import {
  createBoardWorkerQueueLane,
  startQueueLaneRunner,
  startQueueLaneRunners,
  type QueueLaneLease,
} from 'yaml-flow/board-live-cards-node';
import {
  reportComplete,
  reportFailed,
  registerInProcessBoardWorkerCallback,
  unregisterInProcessBoardWorkerCallback,
  type BoardWorkerRequest,
  type BoardWorkerLeasedRequest,
  type BoardWorkerDeadLetterRequest,
  type BoardWorkerStore,
  type TaskCallback,
  type ExecutionRef,
} from 'yaml-flow/board-worker-adapter';
```

---

## `BoardWorkerStore` — platform-free queue facade

### Request shapes

```ts
interface BoardWorkerRequest {
  boardId?: string;
  ref: ExecutionRef;                    // executor to invoke
  args: Record<string, unknown>;        // executor input payload
}

interface BoardWorkerQueuedRequest {
  messageId: string;
  enqueuedAt: string;                   // ISO timestamp
  attempt: number;                      // 1-based; incremented on nack
  request: BoardWorkerRequest;
}

interface BoardWorkerLeasedRequest extends BoardWorkerQueuedRequest {
  leaseToken: string;
  leaseExpiresAt: string;               // ISO timestamp
}

interface BoardWorkerDeadLetterRequest extends BoardWorkerQueuedRequest {
  reason?: string;
}
```

### Interface

```ts
interface BoardWorkerStore {
  enqueueRequest(request: BoardWorkerRequest): string;     // returns messageId

  leaseRequests(opts?: {
    max?: number;            // max messages to lease in one call
    visibilityMs?: number;   // lease duration before message becomes visible again
  }): BoardWorkerLeasedRequest[];

  ackRequest(messageId: string, leaseToken: string): boolean;

  nackRequest(messageId: string, leaseToken: string, opts?: {
    dead?: boolean;          // route to dead-letter on this nack
    reason?: string;
  }): boolean;

  peekActive(): BoardWorkerQueuedRequest[];
  peekDeadLetter(): BoardWorkerDeadLetterRequest[];
}
```

### Factory

```ts
function createBoardWorkerStore(queue: QueueStorage): BoardWorkerStore
```

`QueueStorage` (from `storage-interface.ts`) is the only dependency — any
backend can be plugged in (in-memory, filesystem, Firestore, Azure Queue, …):

```ts
interface QueueStorage {
  enqueue<T>(body: T): QueueMessage<T>;
  lease<T>(opts?: { max?: number; visibilityMs?: number }): QueueLeasedMessage<T>[];
  ack(messageId: string, leaseToken: string): boolean;
  nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): boolean;
  peekActive<T>(prefix?: string): QueueMessage<T>[];
  peekDeadLetter<T>(prefix?: string): QueueDeadLetterMessage<T>[];
}
```

---

## Task-executor lane (Node)

Node hosts should drain `BoardWorkerStore` through the generic lane runner APIs.
The task-executor lane is just a `QueueLaneDescriptor<BoardWorkerRequest>` with
the conventional lane id `task-executor`.

```ts
interface CreateBoardWorkerQueueLaneOptions {
  id?: string; // defaults to 'task-executor' in typical host wiring
  workerStore: BoardWorkerStore;

  /** Host-supplied executor. Throw to nack; return normally to ack. */
  handleRequest(
    args: Record<string, unknown>,
    request: BoardWorkerRequest,
  ): Promise<void>;

  pollIntervalMs?: number;   // default consumed by runner: 250
  visibilityMs?: number;     // default consumed by runner: 60_000
  concurrency?: number;      // default consumed by runner: 1
  maxAttempts?: number;      // default consumed by runner: 5

  onError?(error: unknown, lease: QueueLaneLease<BoardWorkerRequest>): void;
}

function createBoardWorkerQueueLane(
  opts: CreateBoardWorkerQueueLaneOptions,
): QueueLaneDescriptor<BoardWorkerRequest>

function startQueueLaneRunner<TMessage>(lane: QueueLaneDescriptor<TMessage>): () => void
function startQueueLaneRunners(registryOrLanes: QueueLaneRegistry | QueueLaneDescriptor[]): () => void
```

Behavior:

- `createBoardWorkerQueueLane(...)` adapts `BoardWorkerStore` lease/ack/nack to the generic queue-lane contract.
- `startQueueLaneRunner(...)` ticks every `pollIntervalMs` (`setInterval`, unref'd if available).
- Each tick leases up to `concurrency` messages and processes them serially.
- Success → `ackRequest`.
- Throw → `nackRequest({ dead: attempt >= maxAttempts, reason })` and invoke `onError`.
- The returned function stops the loop and clears the interval.

---

## Callback bridge — task-executor → board

Task-executors do not call board APIs directly. They receive an opaque
`TaskCallback` (baked into the executor's `inRef` payload by the board) and
invoke `reportComplete` / `reportFailed` when done.

### Types

```ts
type BoardWorkerCallbackOutcome = 'success' | 'failure';

interface ExecutionRef {
  meta?: string;
  howToRun:
    | 'local-node'
    | 'local-python'
    | 'local-process'
    | 'http:post'
    | 'http:get'
    | 'built-in'
    | 'in-process-loop';
  whatToRun: string;                       // b64:<base64url(json)> wire form
  extra?: Record<string, unknown>;
}

interface TaskCallback {
  token: string;                           // opaque — pass back unchanged
  via:   ExecutionRef;                     // delivery target (board CLI / HTTP / in-process)
}
```

### Reporting functions

```ts
function reportComplete(callback: TaskCallback, outRef: KindValueRef): void
function reportFailed(callback: TaskCallback, reason: string): void
```

Both are synchronous (under the hood: `spawnSync` for `local-node`/`local-process`, sync HTTP for `http:post`, registry lookup for `in-process-loop`). Behavior by `via.howToRun`:

| `howToRun` | Delivery |
|---|---|
| `local-node`, `local-process` | Spawns the resolved CLI with subcommand `source-data-fetched --token <token> --ref <outRef>` (success) or `source-data-fetch-failure --token <token> [--reason <reason>]` (failure). Forwards `--notify-channel` from `via.extra.notifyChannel` if set. |
| `http:post` | POSTs JSON to `<via.whatToRun>/<token>/(success\|failure)`. Success body: `{ ref: <serialized outRef> }`. Failure body: `{ reason }`. |
| `in-process-loop` | Looks up `via.whatToRun` (a registry key) in the in-process callback registry and invokes the handler. |
| anything else | Throws — unsupported. |

### In-process callback registry

For embedded scenarios (host + executor in the same Node process), register a
handler keyed by the same string used as `via.whatToRun`:

```ts
interface InProcessBoardWorkerCallbackPayload {
  token: string;
  outcome: 'success' | 'failure';
  ref?:    string;     // present on success
  reason?: string;     // present on failure
}

type InProcessBoardWorkerCallbackResult =
  | void
  | { status?: 'success' | 'fail' | 'error'; error?: string };

type InProcessBoardWorkerCallbackHandler = (
  payload: InProcessBoardWorkerCallbackPayload,
) => InProcessBoardWorkerCallbackResult;

function registerInProcessBoardWorkerCallback(
  key: string,
  handler: InProcessBoardWorkerCallbackHandler,
): void;

function unregisterInProcessBoardWorkerCallback(key: string): void;
```

A non-success `result.status` (`'fail'` / `'error'`) causes `reportComplete` /
`reportFailed` to throw with `result.error` as the message.

---

## Typical wiring

```ts
// 1. Queue store on top of any QueueStorage backend
const workerStore = createBoardWorkerStore(myQueueStorage);

// 2. Host pushes work onto the queue when the board dispatches an execution
workerStore.enqueueRequest({ boardId, ref: executorRef, args: payload });

// 3. A queue runner drains it
const stop = startQueueLaneRunner(createBoardWorkerQueueLane({
  id: 'task-executor',
  workerStore,
  concurrency: 4,
  maxAttempts: 3,
  async handleRequest(args, request) {
    // Host-defined: actually invoke the executor (spawn, HTTP, in-process, …)
    // and ensure it eventually calls reportComplete / reportFailed.
    await dispatch(request.ref, args);
  },
  onError(err, lease) { logger.warn('worker failure', err, lease.id); },
}));

// 4. Task-executor side — after producing output:
reportComplete(callback, outRef);   // or reportFailed(callback, 'reason')

// 5. Teardown
stop();
```
