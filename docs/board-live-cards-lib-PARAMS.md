# board-live-cards — Function Signature Reference

All functions return:
```ts
type CommandResult<T = undefined> =
  | { status: "success"; data?: T }
  | { status: "fail";    error: string }
  | { status: "error";   error: string }
```

---

## Board management

```ts
init(baseRef: string, taskExecutor?: string, chatHandler?: string): CommandResult

status(baseRef: string): CommandResult<BoardStatus>

removeCard(baseRef: string, id: string): CommandResult

retrigger(baseRef: string, id: string): CommandResult

processAccumulatedEvents(baseRef: string): CommandResult
```

## Card management

```ts
upsertCard(baseRef: string, cardId: string, restart?: boolean): CommandResult

validateCard(baseRef: string, cardId: string): CommandResult

validateTmpCard(cardRef: string): CommandResult
```

## Source probing

```ts
probeSource(cardId: string, sourceIdx: number, mockProjections: object, outRef: string,
            baseRef?: string): CommandResult

probeTmpSource(sourceDef: object, mockProjections: object, outRef: string): CommandResult
```

## Task executor introspection

```ts
describeTaskExecutorCapabilities(baseRef: string): CommandResult
```

## Task callbacks
> `token` encodes the base-ref — no `baseRef` param needed.

```ts
taskCompleted(token: string, data?: object): CommandResult

taskFailed(token: string, error?: string): CommandResult

taskProgress(token: string, update?: object): CommandResult
```

## Source callbacks
> `token` encodes the base-ref — no `baseRef` param needed.

```ts
sourceDataFetched(token: string, ref: string): CommandResult

sourceDataFetchFailure(token: string, reason?: string): CommandResult
```
