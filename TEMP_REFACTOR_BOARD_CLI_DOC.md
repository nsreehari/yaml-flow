# Board Live Cards CLI — Refactor Design

## Problem Statement

The original `board-live-cards-cli-legacy.ts` (~2900 lines) was split **horizontally** by command group into ~10 files. This was the wrong axis. The split produced command files that still do `fs.readFileSync`, `path.join`, `os.tmpdir()` inline — no actual abstraction boundary was established. The correct split is **vertical** by platform layer.

---

## Target Architecture

### Two mandatory layers everywhere

```
board-live-cards-core.ts      ← pure JS, zero I/O, all command logic
                                  parameterized by PlatformAdapters
                                  imports: card-compute, event-graph, continuous-event-graph
                                  zero imports of: fs, path, os, child_process, proper-lockfile

board-live-cards-adapters.ts  ← all adapter interfaces + pure domain types
                                  no implementation, no I/O
```

### One per-platform wiring layer

```
nodecli/
  board-live-cards-node-platform.ts   ← ALL Node I/O: fs.promises, lockfile, spawn
  board-live-cards-cli.ts             ← thin entry: wire platform, dispatch to core

pycli/
  platform.py                         ← Python I/O: open(), filelock, subprocess
  board_live_cards_pycli.py           ← thin entry: wire platform, dispatch to core

browser/
  browser-platform.ts                 ← localStorage, fetch, Web Worker (or no-op for spawn)

azure-fn/
  azure-fn-platform.ts                ← @azure/storage-blob + blob leases + Durable/Container Jobs
  function.ts                         ← HTTP/timer trigger entry
```

---

## Adapter Interfaces

All async (Promise-based). Node platform wraps sync operations in promises. Core is async throughout.

### CardStore
Stores card definitions (today: `card-source-kinds.json`).
```
readAllCards(scope): Promise<LiveCard[]>
writeCard(scope, card): Promise<void>
removeCard(scope, cardId): Promise<void>
```
Platform variants:
- Node: `fs.promises` on `card-source-kinds.json`
- Browser: `localStorage` key per board scope
- Azure: Cosmos DB document / Blob JSON
- Python: `open()` on `card-source-kinds.json`

### ConfigStore
Board-level configuration (today: `.task-executor`, `.inference-adapter` files).
```
readTaskExecutorConfig(scope): Promise<TaskExecutorConfig | null>
readInferenceAdapterConfig(scope): Promise<InferenceAdapterConfig | null>
```
Platform variants:
- Node/Python: files on disk
- Azure: App Configuration / environment variables
- Browser: hardcoded / constructor params

### SnapshotStore (already defined in `board-live-cards-state-snapshot-types.ts`)
```
readSnapshot(scope): Promise<StateSnapshotReadView>
commitSnapshot(scope, envelope): Promise<StateSnapshotCommitResult>
```
Platform variants:
- Node: `.state-snapshot/` tree (atomic writes, SHA256 OCC)
- Browser: `localStorage` (FNV hash OCC)
- Python: `pathlib` / `tempfile` (already implemented)
- Azure: Azure Blob + ETag optimistic concurrency

### LockingAdapter (already defined in `board-live-cards-lib-types.ts`)
```
acquireLock(scope): Promise<() => void>   // returns release fn
```
Platform variants:
- Node: `proper-lockfile`
- Browser: no-op (single-tab, no concurrent access)
- Python: `filelock`
- Azure: Azure Blob lease

### TaskExecutionQueueStore ← **replaces InvocationAdapter**
This is the key insight. Board's responsibility ends at enqueuing work. The caller decides how to drain the queue.

```
enqueueSourceFetch(scope, entry: SourceFetchRequest): Promise<void>
enqueueInference(scope, entry: InferenceRequest): Promise<void>
readPendingWork(scope): Promise<PendingWorkItem[]>
acknowledgeWork(scope, workId: string): Promise<void>
```

Board core calls `enqueueSourceFetch`/`enqueueInference` — that's it. Board does not spawn processes, does not know about CLI paths, does not know about subprocess.

**Who drains the queue:**
- Node CLI: reads queue, calls `process-runner` (spawn local process)
- Python CLI: reads queue, calls `subprocess.Popen` (local or docker)
- Azure Function: queue trigger fires automatically (Service Bus / Storage Queue)
- Browser: queue is in-memory, Web Worker drains it
- Remote/Docker: caller registers a SignalR handler or polls — entirely the platform's concern

**IPC protocol flexibility:**
Today the task-executor contract uses `--in <file> --out <file>` because files are the IPC medium. When the platform is CosmosDB or Azure Blob, the protocol shifts to `--in <blobUrl> --out <blobUrl>` or `--in <cosmosId>`. The `TaskExecutorConfig` shape needs to carry protocol-type so the platform wiring layer can build the right invocation.

```typescript
interface TaskExecutorConfig {
  command: string;
  args?: string[];
  protocol?: 'file' | 'blob-url' | 'cosmos-id' | 'http-body';
  extra?: Record<string, unknown>;
}
```

### BlobStore
Fetched source payload storage (immutable blobs, today: output files on disk).
```
readBlob(scope, ref): Promise<unknown>
writeBlob(scope, content): Promise<string>   // returns ref (path or URL or ID)
deleteBlob(scope, ref): Promise<void>
```
Platform variants:
- Node: file path under board dir
- Browser: `localStorage` key or IndexedDB
- Azure: Azure Blob container
- Python: file path

### TempStore
Cross-process IPC temp data (today: `os.tmpdir()` JSON files for `--in` params).
```
writeTempJson(content): Promise<string>     // returns ref
readTempJson(ref): Promise<unknown>
deleteTempJson(ref): Promise<void>
```
Platform variants:
- Node: `os.tmpdir()` files
- Browser: in-memory `Map`
- Azure: not needed (protocol uses blob URLs directly)
- Python: `tempfile`

### LogAdapter
```
log(level, message, data?): void
```

---

## PlatformAdapters bundle

```typescript
interface PlatformAdapters {
  cardStore: CardStore;
  configStore: ConfigStore;
  snapshotStore: StateSnapshotStore;
  lockingAdapter: LockingAdapter;
  taskQueue: TaskExecutionQueueStore;
  blobStore: BlobStore;
  tempStore: TempStore;
  logger?: LogAdapter;
}
```

---

## Core Logic — Open Questions (to discuss before proceeding)

1. **Drain loop ownership**: Today `process-accumulated-events` contains the drain loop that reads snapshot, applies events, writes back. In the new world, does core still own the drain loop, or does the platform call core once per dequeued item?

2. **Callback commands**: `task-completed`, `task-failed`, `source-data-fetched` etc. are called by the task-executor process back into the board CLI. In the queue model, do these become `acknowledgeWork` calls, or do they still write directly to snapshot?

3. **board/graph persistence timing**: Currently `run-sourcedefs-internal` and `run-inference-internal` read the full snapshot, run, and commit back. Does this change with async adapters?

4. **TaskExecutorConfig IPC protocol**: When platform is CosmosDB/Blob, what exactly gets passed as `--in`? A blob URL? A Cosmos document ID? This drives how `TempStore` / `BlobStore` interact with `TaskExecutorConfig.protocol`.

---

## What is NOT changing

- `card-compute` (CardCompute, JSONata expressions) — already isomorphic, used directly in core
- `continuous-event-graph` (createReactiveGraph, applyEvent, schedule) — already isomorphic
- `event-graph` (next, apply, planExecution) — already isomorphic
- `board-live-cards-state-snapshot-types.ts` — contracts stay, just promoted to adapters file
- Snapshot OCC semantics (expectedVersion + SHA256) — same on all platforms
- The 18 CLI commands — same semantics, just async and adapter-parameterized

---

## File inventory — what happens to current files

| Current file | Fate |
|---|---|
| `board-live-cards-cli-legacy.ts` | Delete (dead archive) |
| `board-live-cards-cli-board-commands.ts` | Fold into core |
| `board-live-cards-cli-callbacks.ts` | Fold into core |
| `board-live-cards-cli-card-commands.ts` | Fold into core |
| `board-live-cards-cli-execution-commands.ts` | Fold into core |
| `board-live-cards-cli-noncore.ts` | Fold into core |
| `board-live-cards-lib-types.ts` | Promoted → adapters.ts |
| `board-live-cards-lib-card-handler.ts` | Keep (already pure, used by core) |
| `board-live-cards-lib-board-status.ts` | Keep (already pure, used by core) |
| `board-live-cards-lib-node-adapters.ts` | Move → node-platform.ts |
| `board-live-cards-state-snapshot-types.ts` | Promoted → adapters.ts |
| `board-live-cards-state-snapshot-node.ts` | Move → node-platform.ts |
| `board-live-cards-state-snapshot-browser.ts` | Move → browser-platform.ts |
| `process-runner.ts` | Keep in nodecli/ (Node-specific) |
| `board-live-cards-cli.ts` | Slim to thin wiring entry |
