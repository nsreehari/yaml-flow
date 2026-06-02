# yaml-flow storage adapter contract

This is the contract every "storage adapter" in `yaml-flow` (Firestore,
localStorage, in-memory FS, future SQL/cloud) is expected to satisfy.
Host applications consume adapters through `createInBrowserBoardTransport` /
the server runtime; they never call adapter internals directly.

## The bundle shape

Every adapter exposes a single `create<X>BoardRuntimeBundle(...)` entry point
that returns a `{ refs, boardAdapter }` pair:

```ts
{
  refs: BoardRefs,
  boardAdapter: AsyncBoardPlatformAdapter,
}
```

### `refs: BoardRefs`

Stable, serializable pointers into the adapter's storage layout. Host code uses
these as the canonical names for sub-stores; it MUST NOT construct ref strings
itself.

Required fields (all adapters, for uniform board construction):

| Field             | Type           | Meaning                                                              |
|-------------------|---------------|----------------------------------------------------------------------|
| `baseRef`         | `KindValueRef` | Root of the board's storage namespace (kind = adapter's namespace).  |
| `cardStoreRef`    | `string`       | Serialized ref the runtime uses to load/save the card list.          |
| `outputsStoreRef` | `string`       | Serialized ref where per-card output documents live.                 |
| `scratchStoreRef` | `string`       | Serialized ref for scratch / ephemeral content used by step machines. |
| `archiveStoreRef` | `string`       | Serialized ref for the archive factory's stream/blob namespace.       |
| `chatStoreRef` | `string`          | Serialized ref for persisted chat/session storage associated with the board. |
| `artifactsStoreRef` | `string`     | Serialized ref for card-level file/blob artifacts.                    |

For this contract, those seven fields are mandatory. A host constructing a
board should be able to rely on the same `refs` shape regardless of backend.
Adapters should not force capability probing for core board storage surfaces.

Each store ref may be supplied by the host in either of these forms:

- A serialized wire ref string: `b64:<base64url({ kind, value })>`
- A structured object before serialization: `{ kind: string, value: string }`

Host configuration layers may normalize object refs into serialized `b64:`
strings before handing them to the runtime bundle.

Recommended interface shape:

```ts
interface BoardRefs {
   baseRef: KindValueRef;
   cardStoreRef: string;
   outputsStoreRef: string;
   scratchStoreRef: string;
   archiveStoreRef: string;
   chatStoreRef: string;
   artifactsStoreRef: string;
}
```

### Ref kinds and mixed backends

The `*StoreRef` fields are intentionally backend-neutral. A host may point
different stores at different backends, for example:

- `cardStoreRef` → `local-storage`
- `outputsStoreRef` → `firestore`
- `chatStoreRef` → `firestore`
- `artifactsStoreRef` → `firebase-storage`

That is the preferred shape for hybrid board layouts.

Common ref kinds in browser-hosted deployments:

- `local-storage`
- `firestore`
- `firestore-board`
- `firebase-storage`

`firestore` refs identify a concrete collection-like storage path.

`firestore-board` refs identify a logical board root rather than a concrete
collection. This distinction matters most for archive routing: Firestore's
archive factory is board-scoped and derives its internal stream/blob
collections from a board root.

If you want `archiveStoreRef` to point at an alternate Firestore archive
target, express it as a `firestore-board` ref, not a generic `firestore`
collection path.

Example:

```ts
{
   archiveStoreRef: {
      kind: 'firestore-board',
      value: 'shared-archive-board'
   }
}
```

Not this:

```ts
{
   archiveStoreRef: {
      kind: 'firestore',
      value: 'boards/shared-archive-board/archive'
   }
}
```

The latter looks plausible but does not map cleanly onto Firestore's current
archive-factory semantics.

### `boardAdapter: AsyncBoardPlatformAdapter`

A fully-async board adapter built via `createHostedAsyncBoardPlatformAdapter`.
See `src/cli/cloud/board-platform-adapter-async.ts` for the full method list.
Highlights every adapter MUST implement:

- `kvStorage(namespace)` / `kvStorageForRef(ref)`
- `blobStorage(namespace)`
- `scratchStorage()` / `scratchStorageForRef(ref)`
- `archiveFactory()` / `archiveFactoryForRef(ref)`
- `journalStorage()`
- `boardWorkerStore()`
- `chatAgentStore()`
- `processAccumulatedStore()`
- `lock` (`AsyncAtomicRelayLock`)
- `dispatchExecution(ref, args)`
- `resolveBlob(ref)` returns `Promise<string>`
- `hashFn(value)` and `genId()` (synchronous)

Common optional hooks on the adapter surface are:

- `callbackTransport`
- `supportsDirectSourceOutput(ref)`
- `requestProcessAccumulated()`
- `publishBoardChangeNotifications(notifications)`
- `warn(msg)`

All `*Storage` factories return objects satisfying the corresponding
`Async*Storage` interface in `src/cli/cloud/storage-async-interface.ts`.

Important distinction: `queueStorage`, `chatAgentQueueStorage`, and
`processAccumulatedQueueStorage` are construction-time inputs on
`HostedAsyncBoardPlatformAdapterOptions`, not members of
`AsyncBoardPlatformAdapter`. The adapter surface exposes the derived worker /
queue stores via `boardWorkerStore()`, `chatAgentStore()`, and
`processAccumulatedStore()`.

### `options: <X>BoardAdapterOptions`

All bundle factories accept the same hooks object:

```ts
{
  requestProcessAccumulated?: () => void | Promise<void>;
  publishBoardChangeNotifications?: (notifications: unknown[]) => void | Promise<void>;
}
```

The host wires these to its own runtime scheduler / SSE fan-out. They are
optional; adapters MUST tolerate `undefined`.

## Composing adapters: blob/scratch override

Some adapters (notably Firestore) are great for documents but a poor fit for
binary blobs. The pattern is to layer a dedicated blob adapter on top of the
base bundle, replacing only the blob/scratch namespaces:

```ts
const { refs, boardAdapter } = createFirestoreBoardRuntimeBundle(db, boardId, hooks);
const composed = wrapWithFirebaseStorageBlobs(boardAdapter, storage, boardId);
return { refs, boardAdapter: composed };
```

Override helpers MUST:

1. Preserve every method on the wrapped adapter not explicitly overridden
   (use object spread, not handwritten forwarding).
2. Replace `blobStorage`, `scratchStorage`, `scratchStorageForRef` (and
   `resolveBlob` for the override's own ref kind) only.
3. Use a single, namespaced storage root (e.g. `boards/<boardId>/blobs`,
   `boards/<boardId>/scratch`) so cleanup is a single delete.
4. Preserve the original `refs` shape. Blob/scratch overrides are storage
   implementation swaps, not board-layout contract changes.

## Authoring a new adapter — checklist

1. Define `<X>BoardRefs` with at minimum `baseRef`, `cardStoreRef`,
   `outputsStoreRef`, `scratchStoreRef`, `archiveStoreRef`, `chatStoreRef`, and
   `artifactsStoreRef`.
2. Export `create<X>BoardRefs(boardId)` separately so hosts can reason about
   ref shapes before constructing the adapter.
3. Implement the full `AsyncBoardPlatformAdapter` surface using
   `createHostedAsyncBoardPlatformAdapter`. Wire the queue/lock/journal
   primitives to native equivalents when possible; fall back to the in-memory
   helpers in `localstorage-storage/index.ts` for local/demo use.
4. Ensure the adapter exposes `boardWorkerStore()`, `chatAgentStore()`, and
   `processAccumulatedStore()`. If you start from queue primitives, wrap them
   through `createHostedAsyncBoardPlatformAdapter` rather than documenting the
   queues themselves as part of the final adapter contract.
5. `resolveBlob` MUST return `Promise<string>`. If the adapter stores binary
   data, decode it (UTF-8 by default) before returning — never return raw
   base64 envelopes.
6. Export `create<X>BoardRuntimeBundle(boardId, options)` returning
   `{ refs, boardAdapter }`. This is the only entry point hosts should use.
   When practical, accept host-supplied `refs` overrides so board layout can
   be driven from config rather than hardcoded inside the adapter.
7. Add a browser entry under `browser/adapters/<x>-storage.ts` if the adapter
   is intended for browser hosts; tsup will emit it as an IIFE that publishes
   a global named matching the directory.
8. Add unit tests under `tests/<x>-storage*.test.ts` exercising at minimum:
   - `refs` shape and stability
   - blob round-trip including `readBytes` / `writeBytes`
   - `resolveBlob` for both text and binary blobs
   - worker/queue store enqueue/lease/ack
   - journal append/readAfter cursor semantics
