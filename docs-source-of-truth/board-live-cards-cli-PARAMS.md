# board-live-cards CLI — Parameter Reference

**Naming conventions:** CLI flags use `kebab-case` (e.g. `--card-id`, `--store-ref`, `--tail-turns`). JSON read from stdin and written to stdout uses `camelCase` field names (e.g. `cardId`, `boardId`). For the MCP HTTP surface (separate from this CLI) request `args` use `snake_case` — see [mcp-api-tools.md](./mcp-api-tools.md#naming-conventions).

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
| `validate-card-preflight` | `{ "card-content": <card object> }` |
| `probe-source-preflight` | `{ "card-content": <card object>, "mock-projections"?: <object> }` |
| `run-source-preflight` | `{ "card-content": <card object>, "mock-projections"?: <object> }` |
| `eval-card-compute` | `{ "card-content": <card object>, "mock-fetched-sources"?: <object>, "mock-requires"?: <object> }` |
| `simulate-card-cycle` | `{ "card-content": <card object>, "mock-fetched-sources"?: <object>, "mock-requires"?: <object> }` |
| `add-card-files` | file metadata object, array, or `{ "files": [...] }` (only when `--value-json` is omitted) |
| `init` | `{ "task-executor-ref"?: <ExecutionRef>, "chat-handler-flow"?: <unknown> }` (optional) |

All other commands have no body.

> **Note**: `<ref>` below is a `b64:<base64url(json)>` string, e.g. `::fs-path::/boards/myboard`.

---

## Board management

```
init --base-ref <ref> --card-store-ref <ref> --outputs-store-ref <ref> \
     [--scratch-store-ref <ref>] [--archive-store-ref <ref>] [--artifacts-store-ref <ref>]
     # body via stdin (optional)
  params: { cardStoreRef, outputsStoreRef, scratchStoreRef?, archiveStoreRef?, artifactsStoreRef? }
  body: {                                                   # stdin
    "task-executor-ref"?: { "howToRun": "...", "whatToRun": "...", ... },
    "chat-handler-flow"?: <unknown>     # opaque flow descriptor; stored as-is via writeChatHandlerFlow
  }
  # Note: `chatStoreRef` is accepted by the underlying lib but the CLI does not
  # currently expose a `--chat-store-ref` flag.

status --base-ref <ref>
  → data: BoardStatus JSON

get-card-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" }

get-outputs-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" }

get-scratch-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" | null }

get-archive-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" | null }

get-chat-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" | null }

get-artifacts-store-ref --base-ref <ref>
  → data: { "storeRef": "<b64:<base64url(json)>>" | null }

get-outputs --base-ref <ref> --type <data-object|computed-values|fetched_sources> (--key <key> | --all)
  params: { type, key?, all? }
  --type data-object      --key <key> → data: stored payload at data-objects/<key>, or null
  --type data-object      --all       → data: { <key>: <payload>, ... }
  --type computed-values  --key <id>  → data: computed_values map for card <id>, or null
  --type computed-values  --all       → data: { <cardId>: <computed_values>, ... }
  --type fetched_sources  --key <id>  → data: { <outputFile>: <b64-ref>, ... }
  --type fetched_sources  --all       → data: { <cardId>: { <outputFile>: <b64-ref>, ... }, ... }

remove-card --base-ref <ref> --id <card-id>
  params: { id }

add-card-files --base-ref <ref> --card-id <card-id> [--value-json <json>]
  params: { cardId }
  body: file metadata object | array | { "files": [...] }   # stdin when --value-json omitted
  → data: { cardId, files_added: [{ idx, entry }, ...], notified: true }

get-attachment-content --base-ref <ref> --card-id <card-id> [--file-idx <n>]
  params: { cardId, fileIdx? }
  # Raw binary attachment bytes are written to stdout (no CommandResult envelope).

card-refreshed-notify --base-ref <ref> --card-id <card-id>
  params: { cardId }

retrigger --base-ref <ref> --id <card-id>
  params: { id }

process-accumulated-events --base-ref <ref>
```

## Card management

```
upsert-card --base-ref <ref> (--card-id <card-id> | --all) [--restart]
  params: { cardId?, all?, restart? }   # --card-id or --all required
  → data: none                          #  either all cards succeed or none

validate-card-preflight
  body: { "card-content": <card object> }              # stdin
  → data: { "cardId": "<card-id>", "isValid": true|false, "issues": ["<message>", ...] }
  # Structural validation, then (for a registered task-executor, supports
  # `validate-card-preflight`) delegates to it and merges any executor-reported issues.
```

## Source probing

```
probe-source-preflight --source-idx <n>
  params: { sourceIdx }
  body: { "card-content": <card object>, "mock-projections"?: <object> }  # stdin
  # Lightweight readiness / reachability check. Delegates to executor's
  # probe-source-preflight subcommand (if registered). Does not fall back
  # to full source execution.

run-source-preflight --source-idx <n>
  params: { sourceIdx, outRef? }
  body: { "card-content": <card object>, "mock-projections"?: <object> }  # stdin
  → data: { "bindTo": "<bindTo>", "ok": true|false,
            "result": <parsed-json-or-raw-string-or-null>,
            "issues": ["<msg>", ...] }
  # Live-fetch-only source preflight. Always uses the real run-source-fetch path.
  # Requires a configured task executor for run-source-fetch.
  # Does not use executor run-source-preflight hooks or fallback modes.
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

task-progress --token <token> [--update <json>]
  params: { token }
  # --update is a JSON string parsed into { update: <obj> } and forwarded as body.
  # The lib method signature still takes body = { update: <object> }; the CLI
  # synthesizes that body from the flag (does not read stdin for this command).
```

## Source callbacks
> `--token` encodes the base-ref — no `--base-ref` flag needed.

```
source-data-fetched --token <token> --ref <ref>
  params: { token, ref }

source-data-fetch-failure --token <token> [--reason <message>]
  params: { token, reason? }
```
