# Board Server — MCP API Reference

Every board server exposes three MCP endpoints under `/api/boards/:boardId`:

| Endpoint | Content-Type | Purpose |
|---|---|---|
| `POST /api/boards/:boardId/mcp` | `application/json` → `application/json` | All tools except file downloads |
| `POST /api/boards/:boardId/mcp-controlplane` | `application/json` → `application/json` | Runtime state mutation and orchestration tools |
| `POST /api/boards/:boardId/mcp-raw` | `application/json` → `application/octet-stream` | File content download only (`inspect.file-contents`) |

## Request / response shape

```json
// POST /api/boards/:boardId/mcp
// POST /api/boards/:boardId/mcp-controlplane
{
  "tool": "<tool-name>",
  "args": { ... }
}

// Response (200)
{
  "status": "success",
  "data": { ... }
}

// Error (400 / 500)
{
  "error": "message"
}
```

## Naming conventions

Different surfaces deliberately use different identifier styles, matching the convention idiomatic for each surface:

| Surface | Style | Example |
|---|---|---|
| MCP `args` (request body fields) | `snake_case` | `card_id`, `turn_id`, `tail_turns`, `candidate_card_content` |
| MCP `data` (response body fields) | `camelCase` | `cardId`, `boardId`, `fileIdx`, `tailTurns` |
| HTTP URL query-string params (other routes) | `kebab-case` | `?tail-turns=1&turn-id=abc` (see [server-runtime-public-api-PARAMS.md](./server-runtime-public-api-PARAMS.md)) |
| CLI flags | `kebab-case` | `--card-id`, `--tail-turns` (see [board-live-cards-cli-PARAMS.md](./board-live-cards-cli-PARAMS.md)) |

The MCP server accepts exactly one wire spelling per arg field — the snake_case form. There are no camelCase or kebab-case aliases.

---

## Tool reference

Regular `/mcp` card-definition tools treat top-level `meta` as control-plane-only state. `manage.read-card` and `inspect.card-definition-and-runtime` omit `meta` from returned card definitions. `manage.upsert-card` accepts candidate cards that contain `meta`, but silently ignores the incoming `meta` and preserves any existing stored `meta` for that card. Use `/mcp-controlplane` for card metadata state.

### `discover.source-kinds`

Returns the known source-kind registry from the task executor.

**Args:** none

**Returns:**
```json
{
  "status": "success",
  "data": {
    "version": "...",
    "commonSourceFields": { ... },
    "sourceKinds": { "<kind>": { ... } }
  }
}
```

---

### `inspect.board-runtime-status`

Returns a summary of all registered cards and overall board state.

**Args:** none

**Returns:**
```json
{
  "status": "success",
  "data": {
    "meta": { ... },
    "summary": {
      "card_count": 2,
      "completed": 1,
      "eligible": 0,
      "pending": 0,
      "blocked": 0,
      "in_progress": 1,
      "failed": 0,
      "unresolved": 0
    },
    "cards": [
      {
        "card-id": "my-card",
        "status": "completed",
        "error": null,
        "requires": [],
        "requires_satisfied": [],
        "requires_missing": [],
        "provides_declared": ["output-key"],
        "provides_runtime": ["output-key"]
      }
    ]
  }
}
```

---

### `inspect.card-definition-and-runtime`

Returns the full card definition, its runtime state, and the current values of all `provides` outputs.

Top-level `meta` is omitted from `card_definition_and_static_data` on this regular `/mcp` surface.

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "card_status_in_board": {
      "name": "my-card",
      "status": "completed",
      "error": null,
      "requires": [],
      "requires_satisfied": [],
      "requires_missing": [],
      "provides_declared": ["output-key"],
      "provides_runtime": ["output-key"]
    },
    "card_definition_and_static_data": {
      "id": "my-card",
      "card_data": { ... },
      "source_defs": [ ... ]
    },
    "refs_for_fetched_source_files": {
      "output.json": "sha256:abc123..."
    },
    "runtime_data": {
      "requires": { "upstream-key": { ... } },
      "provides": { "output-key": { ... } },
      "computed_values": { ... },
      "rendered_view": {
        "layout": "...",
        "features": { ... },
        "elements": [ { "id": "el1", "kind": "text", "label": "Output", "visible": true, "resolved": "..." } ]
      }
    }
  }
}
```

---

### `inspect.chat-messages-on-cards`

Returns chat records for one or all cards, with flexible filtering.

**Args:**

| Field | Type | Default | Notes |
|---|---|---|---|
| `card_id` | string | — | Target card |
| `all_turns` | boolean | `false` | Return all turns (ignores `tail_turns`) |
| `tail_turns` | number | — | Last N user turns only |
| `tail` | number | — | Last N individual messages |
| `turn_id` | string | — | Only messages with this turn id |
| `tail_turns_before_id` | string | — | Requires `tail_turns`; messages before the given turn id |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "messages": [
      { "role": "user",      "text": "hello",     "turn": "abc123", "ts": "2026-05-28T10:00:00.000Z" },
      { "role": "system",   "text": "processing...", "turn": "abc123", "ts": "2026-05-28T10:00:00.100Z" },
      { "role": "assistant","text": "hi there",  "turn": "abc123", "ts": "2026-05-28T10:00:01.200Z" }
    ]
  }
}
```

When a system message references a file attachment, a `retrieval_hint` field is added:
```json
{ "role": "system", "text": "file uploaded: report.pdf as abc.pdf #0", "turn": "abc123",
  "retrieval_hint": "Retrieve using inspect-file-contents --card-id my-card --file-idx 0" }
```

---

### `inspect.file-contents` _(only on `/mcp-raw`)_

Downloads the raw bytes of a file attachment stored on a card.

**Endpoint:** `POST /api/boards/:boardId/mcp-raw`

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |
| `file_idx` | number | yes |

Optional slicing args (at most one): `head-lines`, `tail-lines` (text-like mime types only), `head-bytes`, `tail-bytes`.

**Default response:** raw bytes (`application/octet-stream`) with headers:
- `Content-Disposition: attachment; filename="<name>"`
- `Content-Type: <mime_type>`

**JSON-wrapped response (opt-in):** append `?resp=json-b64` to the URL. The server then returns `application/json` with the body base64-encoded and the file metadata alongside it, instead of streaming raw bytes. Use this when the caller cannot conveniently consume binary HTTP bodies (e.g. step-machine flows whose `output.data` must be a JSON object, or UIs that want a single JSON envelope).

```json
{
  "bodyBase64": "<base64 of (possibly sliced) bytes>",
  "mimeType": "<mime_type>",
  "filename": "<name>",
  "byteLength": <number>
}
```

Unknown values of `resp` are rejected with HTTP 400 (`{ "error": "unsupported resp mode: <value>" }`). Slicing args apply to both response shapes — `byteLength` reflects the sliced length.

**On `/mcp`:** this tool is rejected. Use `/mcp-raw`.

---

### `manage.read-card`

Reads the stored document for a single live card.

Top-level `meta` is omitted from cards returned on this regular `/mcp` surface.

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |

**Returns:** array containing the matching live card document (empty array if not found), wrapped in the MCP success envelope:
```json
{
  "status": "success",
  "data": [
    {
      "id": "my-card",
      "card_data": {
        "id": "my-card",
        "sources": [ ... ],
        "compute": { ... },
        "files": [ { "name": "report.pdf", "stored_name": "abc.pdf", "mime_type": "application/pdf", "size": 1024 } ]
      }
    }
  ]
}
```

---

### `manage.upsert-card`

Validates, stores, and registers a card definition. Triggers a board restart for the card.

If `candidate_card_content` contains top-level `meta`, regular `/mcp` strips it before validation/storage. Existing stored card `meta` is preserved and can only be changed through `/mcp-controlplane`.

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |
| `candidate_card_content` | object | yes — must include `id` matching `card_id` |

**Returns (success):**
```json
{
  "status": "success",
  "data": {
    "validation": { "status": "success", "data": { "isValid": true } },
    "card_saved": null,
    "board_result": { "status": "success" },
    "refresh_notify": { "status": "success" }
  }
}
```

**Returns (validation failure):**
```json
{ "error": "Validation failed" }
```

---

### `manage.remove-card`

Removes a card from both the live board runtime and persistent card storage.

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |

**Returns:** the card removal result. On success:
```json
{
  "status": "success",
  "data": {
    "board_result": { "status": "success" },
    "store_result": { "status": "success", "data": { "count": 1 } }
  }
}
```

> **Behavior notes:**
> - The card is fully removed from persistent storage. `readAll` will not return it after removal.
> - Re-upserting a card with the same `card_id` after removal creates a fresh card with no prior state.

---

### `stage-ai-response-and-any-attachments`

Stages an assistant response (with optional file attachments) directly into a card's chat store. Used by agent pipelines to inject a response without going through the SSE chat flow.

**Endpoint:** `POST /api/boards/:boardId/mcp`

**Args:**

| Field | Type | Notes |
|---|---|---|
| `card_id` | string | required |
| `text` | string | response text |
| `turn_id` | string | turn id to associate the message with |
| `files` | array | optional array of file metadata objects |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "id": "msg-uuid-...",
    "role": "assistant",
    "turn": "abc123",
    "files": []
  }
}
```

---

### `stage-ai-failure-message`

Stages a system failure message directly into a card's chat store for a specific turn. Used by agent pipelines to record an AI failure without going through the SSE chat flow.

**Endpoint:** `POST /api/boards/:boardId/mcp`

**Args:**

| Field | Type | Notes |
|---|---|---|
| `card_id` | string | required |
| `turn_id` | string | required turn id to associate the failure message with |
| `failure` | string | required failure text written into the system message |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "id": "msg-uuid-...",
    "role": "system",
    "turn": "abc123",
    "files": []
  }
}
```

---

## `/mcp-controlplane` tools

Control-plane tools are intended for direct runtime-state mutation and orchestration tasks. They are separate from the regular `/mcp` surface.

### `getstate.is-chat-processing`

Reads whether a card chat is currently marked as processing.

**Args:**

| Field | Type | Required |
|---|---|---|
| `board_id` | string | yes |
| `card_id` | string | yes |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "boardId": "live",
    "cardId": "card-portfolio",
    "active": true
  }
}
```

---

### `setstate.chat-processing-started`

Marks a card chat as currently processing.

**Args:**

| Field | Type | Required |
|---|---|---|
| `board_id` | string | yes |
| `card_id` | string | yes |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "boardId": "live",
    "cardId": "card-portfolio",
    "active": true
  }
}
```

### `setstate.chat-processing-done`

Marks a card chat as no longer processing.

**Args:**

| Field | Type | Required |
|---|---|---|
| `board_id` | string | yes |
| `card_id` | string | yes |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "boardId": "live",
    "cardId": "card-portfolio",
    "active": false
  }
}
```

### `getstate.card-private`

Reads control-plane-owned card metadata under `meta.chat.*`.

**Args:**

| Field | Type | Required |
|---|---|---|
| `board_id` | string | yes |
| `card_id` | string | yes |
| `key` | string | yes, must be under `chat.*` |

**Returns:**
```json
{
  "status": "success",
  "data": {
    "boardId": "live",
    "cardId": "card-portfolio",
    "key": "chat.foundry_thread_id",
    "exists": true,
    "value": "thread_abc"
  }
}
```

### `setstate.card-private`

Sets control-plane-owned card metadata under `meta.chat.*` using the card store patch path `meta.<key>`.

**Args:**

| Field | Type | Required |
|---|---|---|
| `board_id` | string | yes |
| `card_id` | string | yes |
| `key` | string | yes, must be under `chat.*` |
| `value` | any JSON value | yes |

**Example:**
```json
{
  "tool": "setstate.card-private",
  "args": {
    "board_id": "live",
    "card_id": "card-portfolio",
    "key": "chat.foundry_thread_id",
    "value": "thread_abc"
  }
}
```

**Returns:**
```json
{
  "status": "success",
  "data": {
    "boardId": "live",
    "cardId": "card-portfolio",
    "key": "chat.foundry_thread_id"
  }
}
```

### `manage.upload-card-file`

Uploads a file to a card's attachment store (outside the chat flow).

**Args — provide exactly one of `bytes`, `text`, or `base64`:**

| Field | Type | Notes |
|---|---|---|
| `board_id` | string | required |
| `card_id` | string | required |
| `file_name` | string | required |
| `content_type` | string | optional, default `application/octet-stream` |
| `bytes` | number[] | raw byte array |
| `text` | string | UTF-8 encoded |
| `base64` | string | base64 or base64url encoded |

**Returns:** the stored file metadata object in the MCP success envelope:
```json
{
  "status": "success",
  "data": {
    "ok": true,
    "file": {
      "fileIdx": 2,
      "name": "report.pdf",
      "stored_name": "abc123.pdf",
      "mime_type": "application/pdf",
      "size": 204800,
      "uploaded_at": "2026-05-28T10:00:00.000Z"
    }
  }
}
```

---

## `preflight.*` tools

Preflight tools let you test a **candidate card definition** in-memory without committing it to the board.

### Quick Reference

All preflight tools are invoked through:

```json
{
  "tool": "preflight.<name>",
  "args": { ... }
}
```

| Tool | MCP `args` shape | Success `data` shape |
|---|---|---|
| `preflight.validate-candidate-card-definition` | `{ "candidate_card_content": <card> }` | `{ "cardId": string, "isValid": boolean, "issues": string[] }` |
| `preflight.materialize-candidate-card` | `{ "candidate_card_content": <card>, "mock_requires": {}, "mock_fetched_sources": {} }` | `{ "cardId": string, "ok": boolean, "computed_values": object, "errors": Array<{ bindTo, error }>, "provides_outputs": object, "rendered_view": object }` |
| `preflight.probe-single-source-in-candidate-card` | `{ "candidate_card_content": <card>, "source_idx": number, "mock_projections": {} }` | `{ "bindTo": string, "reachable": boolean, "latencyMs"?: number, "note"?: string }` |
| `preflight.run-single-source-in-candidate-card` | `{ "candidate_card_content": <card>, "source_idx": number, "mock_projections": {} }` | `{ "bindTo": string, "ok": boolean, "result": unknown, "issues": string[] }` |
| `preflight.run-single-source-in-live-card` | `{ "card_id": string, "source_idx": number, "mock_requires": {} }` | `{ "bindTo": string, "ok": boolean, "result": unknown, "issues": string[] }` |
| `preflight.run-one-cycle-with-candidate-card` | `{ "candidate_card_content": <card>, "mock_requires": {} }` | `{ "cardId": string, "ok": boolean, "issues": string[], "provides_outputs": object, "rendered_view": object }` |

Unless otherwise noted, successful HTTP responses use the normal MCP envelope:

```json
{
  "status": "success",
  "data": { ... }
}
```

### `preflight.validate-candidate-card-definition`

Schema-validates a candidate card.

**Args:**

| Field | Type | Required |
|---|---|---|
| `candidate_card_content` | object | yes |

**MCP request body:**
```json
{
  "tool": "preflight.validate-candidate-card-definition",
  "args": {
    "candidate_card_content": { "id": "my-card", "card_data": {} }
  }
}
```

**Returns (valid):**
```json
{ "status": "success", "data": { "cardId": "my-card", "isValid": true, "issues": [] } }
```

**Returns (invalid):** outer `status` is still `"success"` — the validator ran cleanly, it just found problems:
```json
{ "status": "success", "data": { "cardId": "my-card", "isValid": false, "issues": [ "view.elements[0].kind is required", "source_defs[0].bindTo is duplicate" ] } }
```

---

### `preflight.materialize-candidate-card`

Evaluates the card's `compute[]` steps with the supplied mocks. Does **not** run sources and does **not** produce a rendered view — use `preflight.run-one-cycle-with-candidate-card` for a full pipeline simulation.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `candidate_card_content` | object | required |
| `mock_requires` | object | required — may be empty, but the key must be present |
| `mock_fetched_sources` | object | required — may be empty, but the key must be present |

**MCP request body:**
```json
{
  "tool": "preflight.materialize-candidate-card",
  "args": {
    "candidate_card_content": { "id": "my-card", "card_data": {}, "compute": [] },
    "mock_requires": {},
    "mock_fetched_sources": {}
  }
}
```

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "ok": true,
    "computed_values": { "title": "My Report", "count": 42 },
    "errors": [],
    "provides_outputs": {
      "output-key": { "title": "My Report", "count": 42 }
    },
    "rendered_view": {
      "layout": "stack",
      "features": {},
      "elements": [
        { "id": "summary", "kind": "text", "label": "Summary", "visible": true, "resolved": "My Report" }
      ]
    }
  }
}
```

`errors` is an array of `{ "bindTo": string, "error": string }`. On compute failure `ok` is `false` and `errors` lists each broken binding:
```json
{ "status": "success", "data": { "cardId": "my-card", "ok": false, "computed_values": {}, "errors": [ { "bindTo": "title", "error": "undefined variable" } ], "provides_outputs": {}, "rendered_view": { "layout": null, "features": null, "elements": [] } } }
```

If `mock_requires` or `mock_fetched_sources` is omitted entirely, the MCP call fails with a 400-style error such as `{ "error": "MCP tool requires mock_requires" }`.

---

### `preflight.probe-single-source-in-candidate-card`

Calls the registered task executor's `probe-source-preflight` hook for a single source in a candidate card — tests reachability without fetching data. **Requires a task executor to be registered**; returns an error if none is configured.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `candidate_card_content` | object | required |
| `source_idx` | number | index into the card's `source_defs` array |
| `mock_projections` | object | optional mock projection data |

**MCP request body:**
```json
{
  "tool": "preflight.probe-single-source-in-candidate-card",
  "args": {
    "candidate_card_content": { "id": "my-card", "card_data": {}, "source_defs": [ ... ] },
    "source_idx": 0,
    "mock_projections": {}
  }
}
```

**Returns:** connectivity / readiness metadata for the source — does **not** return fetched data:
```json
{
  "status": "success",
  "data": {
    "bindTo": "my-source",
    "reachable": true,
    "latencyMs": 45,
    "note": "endpoint reachable"
  }
}
```

> If no task executor is configured the call fails with an HTTP error such as `{ "error": "No task-executor registered for this board" }`.

---

### `preflight.run-single-source-in-candidate-card`

Executes a single source in a candidate card and returns the real fetched output. This path is live-fetch-only and **requires a configured task executor**.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `candidate_card_content` | object | required |
| `source_idx` | number | index into the card's `source_defs` array |
| `mock_projections` | object | optional mock projection data |

**MCP request body:**
```json
{
  "tool": "preflight.run-single-source-in-candidate-card",
  "args": {
    "candidate_card_content": { "id": "my-card", "card_data": {}, "source_defs": [ ... ] },
    "source_idx": 0,
    "mock_projections": {}
  }
}
```

**Returns:**
```json
{
  "status": "success",
  "data": {
    "bindTo": "my-source",
    "ok": true,
    "result": { "items": [ ... ] },
    "issues": []
  }
}
```

On live fetch failure the command still returns `status: "success"`, but with `ok: false` and a populated `issues` list:

```json
{
  "status": "success",
  "data": {
    "bindTo": "my-source",
    "ok": false,
    "result": null,
    "issues": ["Probe failed: network timeout"]
  }
}
```

Field notes:

- `result` is parsed JSON when possible; otherwise it is returned as a raw string
- `issues` is empty on success and contains live-fetch errors when `ok` is `false`
- If no task executor is configured, the call fails with an HTTP error such as `{ "error": "No task-executor registered for this board" }`
- Request-shape problems such as an out-of-range `source_idx` also fail with an HTTP error, for example `{ "error": "sourceIdx 4 out of range (card has 1 source(s))" }`

---

### `preflight.run-single-source-in-live-card`

Executes a single source using an already-saved live card in card storage. This is useful when you want run-source behavior without supplying `candidate_card_content`.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `card_id` | string | required; id of an existing live card |
| `source_idx` | number | required; index into the card's `source_defs` array |
| `mock_requires` | object | required; same contract as `preflight.run-one-cycle-with-candidate-card` |

**MCP request body:**
```json
{
  "tool": "preflight.run-single-source-in-live-card",
  "args": {
    "card_id": "card-market-prices",
    "source_idx": 0,
    "mock_requires": {}
  }
}
```

**Returns:** same shape as `preflight.run-single-source-in-candidate-card`:
```json
{
  "status": "success",
  "data": {
    "bindTo": "my-source",
    "ok": true,
    "result": { "items": [ ... ] },
    "issues": []
  }
}
```

On execution failure this still returns `status: "success"` with `ok: false` and `issues` populated.

```json
{
  "status": "success",
  "data": {
    "bindTo": "my-source",
    "ok": false,
    "result": null,
    "issues": ["Probe failed: network timeout"]
  }
}
```

Request/config errors fail with HTTP error envelopes, for example:

- `{ "error": "Card \"missing-card\" not found" }`
- `{ "error": "sourceIdx 4 out of range (card has 1 source(s))" }`
- `{ "error": "MCP tool requires mock_requires" }`

---

### `preflight.run-one-cycle-with-candidate-card`

Runs a full computation cycle (all sources → compute) against a candidate card in-memory and returns the simplified MCP-facing runtime shape. Nothing is persisted.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `candidate_card_content` | object | required |
| `mock_requires` | object | optional mock values for `requires` keys |

**MCP request body:**
```json
{
  "tool": "preflight.run-one-cycle-with-candidate-card",
  "args": {
    "candidate_card_content": { "id": "my-card", "card_data": {}, "provides": [], "view": {} },
    "mock_requires": {}
  }
}
```

**Returns:**
```json
{
  "status": "success",
  "data": {
    "cardId": "my-card",
    "ok": true,
    "issues": [],
    "provides_outputs": {
      "output-key": { "title": "My Report", "count": 42 }
    },
    "rendered_view": {
      "layout": "stack",
      "features": {},
      "elements": [
        { "id": "summary", "kind": "text", "label": "Summary", "visible": true, "resolved": "My Report" }
      ]
    }
  }
}
```

Field notes:

- `issues` is a flattened list built from validation issues, source probe errors, projection errors, and compute errors
- `provides_outputs` is resolved from the card's public `provides[]` bindings; if no `provides[]` is declared, the default binding is `{ "bindTo": cardId, "ref": "card_data" }`
- `rendered_view` is materialized from the simulated runtime node using the card's `view`
- The MCP facade intentionally hides low-level `validation`, `source_probes`, `projection_errors`, and `compute_errors` details behind `ok` + `issues`

---


