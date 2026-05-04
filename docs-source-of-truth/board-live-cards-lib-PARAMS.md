# board-live-cards — Function Signature Reference

All methods share the same `CommandInput` / `CommandResult` envelope:

```ts
type CommandInput = {
  params?: Record<string, string | number | boolean>;  // identity / routing args
  body?:   unknown;                                    // structured payload
};

type CommandResult<T = undefined> =
  | { status: 'success'; data?: T }      // completed normally
  | { status: 'fail';    error: string } // bad caller input
  | { status: 'error';   error: string } // unexpected internal error
```

Transport adapters (CLI, HTTP, in-process) build `CommandInput` before calling any method.  
The public layer never knows how data arrived.

---

## `BoardLiveCardsPublic`
> Created via `createBoardLiveCardsPublic(baseRef, adapter)`

### Board management

```ts
init(input: CommandInput): CommandResult
  body:   { "task-executor-ref"?: ExecutionRef, "chat-handler-ref"?: ExecutionRef }

status(input: CommandInput): CommandResult<BoardStatusObject>
  (no params / no body)

removeCard(input: CommandInput): CommandResult
  params: { id }

retrigger(input: CommandInput): CommandResult
  params: { id }

processAccumulatedEvents(input: CommandInput): Promise<CommandResult>
  (no params / no body)
```

### Card management

```ts
upsertCard(input: CommandInput): CommandResult
  params: { cardId?, all?, restart? }   // cardId or all required; atomic across all cards
```

### Task callbacks
> `params.token` encodes the base-ref — no separate `baseRef` needed.

```ts
taskFailed(input: CommandInput): CommandResult
  params: { token, error? }

taskProgress(input: CommandInput): CommandResult
  params: { token }
  body:   { update: <update-object> }
```

### Source callbacks
> `params.token` encodes the base-ref — no separate `baseRef` needed.

```ts
sourceDataFetched(input: CommandInput): CommandResult
  params: { token, ref }   // ref is a ::kind::value string

sourceDataFetchFailure(input: CommandInput): CommandResult
  params: { token, reason? }
```

---

## `BoardLiveCardsNonCorePublic`
> Created via `createBoardLiveCardsNonCorePublic(baseRef, adapter)`

### Card validation

```ts
validateCard(input: CommandInput): CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>
  params: { cardId?, all? }             // cardId or all required

validateTmpCard(input: CommandInput): CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>
  body:   { "card-content": <card object> }
```

### Source probing

```ts
probeSource(input: CommandInput): CommandResult
  params: { cardId, sourceIdx, outRef }
  body:   { "mock-projections": <object> }   // from stdin

probeTmpSource(input: CommandInput): CommandResult
  params: { outRef }
  body:   { "source-def": <object>, "mock-projections": <object> }   // from stdin
```

### Task executor introspection

```ts
describeTaskExecutorCapabilities(input: CommandInput): CommandResult
  (no params / no body)
```

### Card store (direct read/write)

```ts
// Replaces updateInCardStore — handles both single and batch mutations.
updatesInCardStore(input: CommandInput): CommandResult
  body:   {
    "ops": Array<
      | { op: 'update'; id: string; 'card-content': unknown }
      | { op: 'delete'; id: string }
    >
  }   // from stdin

readFromCardStore(input: CommandInput): CommandResult<{ cards: Array<{ id: string; 'card-content': unknown }> }>
  body:   { "ids": string[] }   // from stdin
```

---

## `createCardHandlerFn` — internal signature
> Used internally by `drainCycle` to wire the card-handler into the ReactiveGraph.

```ts
createCardHandlerFn(
  baseRef: KindValueRef,
  journalId: string,
  adapters: CardHandlerAdapters,
  taskCompletedFn: (taskName: string, data: Record<string, unknown>) => void,
  _taskFailedFn: (taskName: string, error: string) => void,
  writeComputedValuesFn?: (cardId: string, values: Record<string, unknown>) => void,
  writeDataObjectsFn?: (data: Record<string, unknown>) => void,
): TaskHandlerFn
```

- `taskCompletedFn` — called synchronously when a card computes successfully. In `drainCycle`,
  this accumulates `task-completed` events into a local `TX` array (not the file journal).
- `writeComputedValuesFn` — optional override for `outputStore.writeComputedValues`.
  When provided by `drainCycle`, appends to a local `CX` array for deferred flush.
- `writeDataObjectsFn` — optional override for `outputStore.writeDataObjects`.
  When provided by `drainCycle`, appends to a local `DX` array for deferred flush.
- Both optional overrides default to calling the adapter directly if not supplied.

---

## drainCycle — TX accumulator loop
> Internal to `board-live-cards-public.ts`. Documented here as source of truth for the
> rapid-fire task-completion pattern.

```
1. Load envelope; read undrained journal events into TX.
2. Build overlays: RX (cardRuntime), sxCache+SX (sources), CX (computedValues), DX (dataObjects).
3. Create ReactiveGraph (rg) with card-handler wired to TX/CX/DX accumulation callbacks.
4. TX accumulator loop:
     while TX.length > 0:
       pending = TX; TX = [];
       rg.pushAll(pending);
       await rg.waitForHandlers();
5. finalLive = rg.getState(); await rg.dispose().
6. commitEnvelope(finalLive) — snapshot includes all completions.
7. Flush deferred writes: CX → writeComputedValues, DX → writeDataObjects,
   RX → realCardRuntimeStore, SX → realFetchedSourcesStore.
8. Dispatch source-fetch execution requests.
```

**Key invariant**: `task-completed` from in-process card-handlers never goes to the file journal
during a drain cycle. The file journal only receives `task-failed` (error path) and source-callback
events (`task-progress`). This ensures the snapshot committed at step 6 is always fully up-to-date
and rapid-fire restarts are resolved within a single `drainCycle` invocation.
