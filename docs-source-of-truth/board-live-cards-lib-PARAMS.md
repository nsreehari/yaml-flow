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

getCardStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>
  (no params / no body)

getOutputsStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>
  (no params / no body)

getOutputsDataObject(input: CommandInput): CommandResult
  params: { key }   // key = the data-object token (e.g. "holdings")
  → data: stored payload at data-objects/<key>, or null

getOutputsComputedValues(input: CommandInput): CommandResult
  params: { key }   // key = card id
  → data: computed_values map for that card, or null

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
  params: { token, ref }   // ref is a b64:<base64url(json)> string

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

validateCardPreflight(input: CommandInput): CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>
  body:   { "card-content": <card object> }
  // Runs structural validation inline.
  // If a task-executor is registered and supports `validate-card-preflight`,
  // delegates to it via stdin and merges any executor-reported issues.
```

### Source probing

```ts
probeSource(input: CommandInput): CommandResult
  params: { cardId, sourceIdx, outRef }
  body:   { "mock-projections": <object> }   // from stdin

probeTmpSource(input: CommandInput): CommandResult
  params: { outRef }
  body:   { "source-def": <object>, "mock-projections": <object> }   // from stdin

probeSourcePreflight(input: CommandInput): CommandResult
  params: { sourceIdx, outRef? }
  body:   { "card-content": <card object>, "mock-projections"?: <object> }
  // If a task-executor is registered and supports `probe-source-preflight`,
  // delegates to it via stdin for a lightweight readiness / reachability check.
  // Does not fall back to the full source fetch path.

runSourcePreflight(input: CommandInput): CommandResult
  params: { sourceIdx, outRef? }
  body:   { "card-content": <card object>, "mock-projections"?: <object> }
  // Runs the selected source through the real fetch flow only.
  // Returns { bindTo, ok, result, issues }.
  // Fails when no task executor is configured.
  // Does not use executor `run-source-preflight` hooks or fallback modes.
```

### Compute evaluation

```ts
evalCardCompute(input: CommandInput): CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }>
  body:   {
    "card-content": <card object>,        // card with card_data, compute[], source_defs
    "mock-fetched-sources"?: <object>,     // keyed by source_defs[].bindTo
    "mock-requires"?: <object>             // keyed by dependency card id
  }
  // Evaluates the card's compute[] expressions against the supplied mock data.
  // Returns the resulting computed_values and any per-step errors.
  // Pure in-process — no executor, no board state, no real fetches.
```

### Full cycle simulation

```ts
simulateCardCycle(input: CommandInput): CommandResult<SimulateResult>
  body:   {
    "card-content": <card object>,
    "mock-fetched-sources"?: <object>,     // keyed by source_defs[].bindTo
    "mock-requires"?: <object>             // keyed by dependency card id
  }
  // Full pipeline: validate structure → resolve projections (from card_data + mock-requires)
  // → probe each source (if executor registered) → run compute expressions.
  // Returns: { cardId, ok, validation, source_probes[], projection_errors[], computed_values, compute_errors[] }
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
