# Board Server — MCP API Reference

Every board server exposes two MCP endpoints under `/api/boards/:boardId`:

| Endpoint | Content-Type | Purpose |
|---|---|---|
| `POST /api/boards/:boardId/mcp` | `application/json` → `application/json` | All tools except file downloads |
| `POST /api/boards/:boardId/mcp-raw` | `application/json` → `application/octet-stream` | File content download only (`inspect.file-contents`) |

## Request / response shape

```json
// POST /api/boards/:boardId/mcp
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

---

## Tool reference

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
| `all-turns` | boolean | `false` | Return all turns (ignores `tail-turns`) |
| `tail-turns` | number | — | Last N user turns only |
| `tail` | number | — | Last N individual messages |
| `turn-id` | string | — | Only messages with this turn id |
| `tail-turns-before-id` | string | — | Requires `tail-turns`; messages before the given turn id |

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

**On `/mcp-raw`:** returns raw bytes (`application/octet-stream`) with headers:
- `Content-Disposition: attachment; filename="<name>"`
- `Content-Type: <mime_type>`

**On `/mcp`:** this tool is rejected. Use `/mcp-raw`.

---

### `manage.read-card`

Reads the stored document for a single live card.

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

### `manage.deprecate`

Removes a card from the board.

**Args:**

| Field | Type | Required |
|---|---|---|
| `card_id` | string | yes |

**Returns:** the `board.removeCard` result normalized into the MCP success envelope. On success:
```json
{ "status": "success", "data": {} }
```

---

### `manage.upload-card-file`

Uploads a file to a card's attachment store (outside the chat flow).

**Args — provide exactly one of `bytes`, `text`, or `base64`:**

| Field | Type | Notes |
|---|---|---|
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

### `stage-ai-response-and-any-attachments`

Stages an assistant response (with optional file attachments) directly into a card's chat store. Used by agent pipelines to inject a response without going through the SSE chat flow.

**Args:**

| Field | Type | Notes |
|---|---|---|
| `card_id` | string | required |
| `text` | string | response text |
| `turn-id` | string | turn id to associate the message with |
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


