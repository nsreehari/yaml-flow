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

| `task-progress` | `{ "update": <update-object> }` |
| `init` | `{ "task-executor-ref"?: <ExecutionRef>, "chat-handler-ref"?: <ExecutionRef> }` |

All other commands have no body.

> **Note**: `<ref>` below is a `b64:<base64url(json)>` string, e.g. `::fs-path::/boards/myboard`.

---

## Board management

```
init --base-ref <ref> --card-store-ref <ref> [--outputs-store-ref <ref>]  # body via stdin (optional)
  params: { cardStoreRef, outputsStoreRef? }                # --card-store-ref is required
  body: {                                                   # stdin
    "task-executor-ref"?: { "howToRun": "...", "whatToRun": "...", ... },
    "chat-handler-ref"?:  { "howToRun": "...", "whatToRun": "...", ... }
  }

status --base-ref <ref>
  → data: BoardStatus JSON

get-card-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" }

get-outputs-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" }

get-outputs --base-ref <ref> --type <data-object|computed-values> --key <key>
  params: { type, key }
  --type data-object     → data: the stored payload at data-objects/<key>, or null
  --type computed-values → data: the computed_values map for card <key>, or null

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

validate-card-preflight
  body: { "card-content": <card object> }              # stdin
  → data: { "cardId": "<card-id>", "isValid": true|false, "issues": ["<message>", ...] }
  # Same as validate-tmp-card but also delegates to executor's validate-card-preflight
  # subcommand (if registered) and merges any additional issues.
```

## Source probing

```
probe-source --base-ref <ref> --card-id <card-id> --source-idx <n> --out-ref <ref>
  params: { cardId, sourceIdx, outRef }
  body: { "mock-projections": <object> }               # stdin

probe-tmp-source --out-ref <ref>
  params: { outRef }
  body: { "source-def": <object>, "mock-projections": <object> }  # stdin

probe-source-preflight --source-idx <n>
  params: { sourceIdx }
  body: { "card-content": <card object>, "mock-projections"?: <object> }  # stdin
  # Lightweight readiness / reachability check. Delegates to executor's
  # probe-source-preflight subcommand (if registered). Does not fall back
  # to full source execution.

run-source-preflight --source-idx <n>
  params: { sourceIdx, outRef? }
  body: { "card-content": <card object>, "mock-projections"?: <object> }  # stdin
  # Real-flow source preflight. Delegates to executor's run-source-preflight
  # subcommand when supported. Falls back to full source execution otherwise.
```

## Compute evaluation

```
eval-card-compute
  body: {                                                              # stdin
    "card-content": <card object>,
    "mock-fetched-sources"?: { "<bindTo>": <data>, ... },
    "mock-requires"?: { "<cardId>": <computed_values>, ... }
  }
  → data: { "cardId": "<id>", "ok": true|false,
            "computed_values": { ... },
            "errors": [{ "bindTo": "<key>", "error": "<msg>" }, ...] }
  # Pure in-process expression evaluation — no executor, no board state.
```

## Full cycle simulation

```
simulate-card-cycle
  body: {                                                              # stdin
    "card-content": <card object>,
    "mock-fetched-sources"?: { "<bindTo>": <data>, ... },
    "mock-requires"?: { "<cardId>": <computed_values>, ... }
  }
  → data: { "cardId": "<id>", "ok": true|false,
            "validation": { "isValid": true|false, "issues": [...] },
            "source_probes": [{ "bindTo": "...", "reachable": true|false, ... }],
            "projection_errors": [{ "bindTo": "...", "key": "...", "error": "..." }],
            "computed_values": { ... },
            "compute_errors": [{ "bindTo": "<key>", "error": "<msg>" }, ...] }
  # Full pipeline: validate → resolve projections → probe sources → run compute.
```

## Task executor introspection

```
describe-task-executor-capabilities --base-ref <ref>   (no additional params)
```

## Task callbacks
> `--token` encodes the base-ref — no `--base-ref` flag needed.

```
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
