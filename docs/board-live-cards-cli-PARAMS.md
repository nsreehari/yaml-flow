# board-live-cards CLI — Parameter Reference

## CommandInput / CommandResult

Every command accepts a `CommandInput` (built from CLI flags + stdin) and writes a `CommandResult` JSON to stdout:

```ts
type CommandInput = {
  params?: Record<string, string | number | boolean>;  // from CLI flags
  body?:   unknown;                                    // from piped stdin (JSON)
};

// stdout — one of:
{ "status": "success", "data": { ... } }   // data present when there is output
{ "status": "fail",    "error": "..." }    // bad caller input (missing flag, not found, …)
{ "status": "error",   "error": "..." }    // unexpected internal error
```

**CLI transport rules**
- `--flag <value>` scalar flags → `params`
- Piped JSON on stdin (`readStdinBody()`) → `body`; returns `undefined` when stdin is a TTY
- The same `CommandInput`/`CommandResult` shapes are used by in-process and HTTP callers
- `--base-ref` is a **routing flag** — it selects the board instance but is never placed in `params`
- Commands with no additional flags pass an empty input `{}`; no `params:` line is shown for them

**Commands that read `body` from stdin**

| Command | stdin body shape |
|---------|-----------------|
| `validate-tmp-card` | `{ "card-content": <card object> }` |
| `probe-source` | `{ "mock-projections": <object> }` |
| `probe-tmp-source` | `{ "source-def": <object>, "mock-projections": <object> }` |
| `updates-in-card-store` | `{ "ops": [ { op, id, "card-content"? }, ... ] }` |
| `read-from-card-store` | `{ "ids": ["<card-id>", ...] }` |
| `task-completed` | `{ "data": <data-object> }` |
| `task-progress` | `{ "update": <update-object> }` |
| `init` | `{ "task-executor-ref"?: <ExecutionRef>, "chat-handler-ref"?: <ExecutionRef> }` |

All other commands have no body.

> **Note**: `<ref>` below is a `::kind::value` string, e.g. `::fs-path::/boards/myboard`.

---

## Board management

```
init --base-ref <ref>                                        # body via stdin (optional)
  body: {                                                    # stdin
    "task-executor-ref"?: { "howToRun": "...", "whatToRun": "...", ... },
    "chat-handler-ref"?:  { "howToRun": "...", "whatToRun": "...", ... }
  }

status --base-ref <ref>
  → data: BoardStatus JSON

remove-card --base-ref <ref> --id <card-id>
  params: { id }

retrigger --base-ref <ref> --id <card-id>
  params: { id }

process-accumulated-events --base-ref <ref>
```

## Card management

```
upsert-card --base-ref <ref> (--card-id <card-id> | --all) [--restart]
  params: { cardId?, all?, restart? }   # --card-id or --all required
  → data: none                          #  either all cards succeed or none

validate-card --base-ref <ref> (--card-id <card-id> | --all)
  params: { cardId?, all? }             # --card-id or --all required
  → data: [{ "cardId": "<card-id>", "isValid": true|false, "issues": ["<message>", ...] }, ...]

validate-tmp-card
  body: { "card-content": <card object> }              # stdin
  → data: { "cardId": "<card-id>", "isValid": true|false, "issues": ["<message>", ...] }
```

## Source probing

```
probe-source --base-ref <ref> --card-id <card-id> --source-idx <n> --out-ref <ref>
  params: { cardId, sourceIdx, outRef }
  body: { "mock-projections": <object> }               # stdin

probe-tmp-source --out-ref <ref>
  params: { outRef }
  body: { "source-def": <object>, "mock-projections": <object> }  # stdin
```

## Card store

```
updates-in-card-store --base-ref <ref>
  body: {                                              # stdin
    "ops": [
      { "op": "update", "id": "<card-id>", "card-content": <card object> },
      { "op": "delete", "id": "<card-id>" }
    ]
  }

read-from-card-store --base-ref <ref>
  body: { "ids": ["<card-id>", ...] }                 # stdin
  → data: { "cards": [{ "id": "<card-id>", "card-content": <card object> }] }
```

## Task executor introspection

```
describe-task-executor-capabilities --base-ref <ref>   (no additional params)
```

## Task callbacks
> `--token` encodes the base-ref — no `--base-ref` flag needed.

```
task-completed --token <token>
  params: { token }
  body: { "data": <data-object> }                     # stdin

task-failed --token <token> [--error <message>]
  params: { token, error? }

task-progress --token <token>
  params: { token }
  body: { "update": <update-object> }                 # stdin
```

## Source callbacks
> `--token` encodes the base-ref — no `--base-ref` flag needed.

```
source-data-fetched --token <token> --ref <ref>
  params: { token, ref }

source-data-fetch-failure --token <token> [--reason <message>]
  params: { token, reason? }
```
