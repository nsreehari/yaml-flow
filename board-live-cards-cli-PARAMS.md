# board-live-cards CLI — Parameter Reference

All commands output:
```json
{ "status": "success|fail|error", "data?": { ... }, "error?": "text message" }
```
- `data` and `error` are optional on `success`
- `error` is mandatory on `fail` and `error`

---

## Board management

```
init --base-ref <::kind::value> [--task-executor <script>] [--chat-handler <script>]

status --base-ref <::kind::value>  // outputs BoardStatus Json in data

remove-card --base-ref <::kind::value> --id <card-id>


retrigger --base-ref <::kind::value> --id <card-id>

process-accumulated-events --base-ref <::kind::value>
```

## Card management

```
upsert-card --base-ref <::kind::value> --card-id <id> [--restart]

validate-card --base-ref <::kind::value> --card-id <id>

validate-tmp-card --card-ref <cardref>
```

## Source probing

```
probe-source [--base-ref <::kind::value>] --card-id <id> --source-idx <n>
             --mock-projections <json> --out-ref <resultref>

probe-tmp-source --source-def <sourcedef> --mock-projections <json> --out-ref <resultref>
```

## Task executor introspection

```
describe-task-executor-capabilities --base-ref <::kind::value>
```

## Task callbacks
> Token encodes the base-ref — no `--base-ref` needed.

```
task-completed --token <callbackToken> [--data <json>]

task-failed --token <callbackToken> [--error <message>]

task-progress --token <callbackToken> [--update <json>]
```

## Source callbacks
> Token encodes the base-ref — no `--base-ref` needed.

```
source-data-fetched --token <sourceToken> --ref <sourcefile>

source-data-fetch-failure --token <sourceToken> [--reason <message>]
```
