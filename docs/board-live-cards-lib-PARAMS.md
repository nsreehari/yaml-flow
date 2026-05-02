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
taskCompleted(input: CommandInput): CommandResult
  params: { token }
  body:   { data: <data-object> }

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
