# Agent Instructions — Authoring yaml-flow Boards & Cards

## What Is This?

A **board** is a `board.yaml` file plus a folder of **card** JSON files. Cards are purely declarative — the runtime (board-livegraph-runtime) owns all state mutation and reactivity. Cards never imperative-call each other; they declare data dependencies and the runtime handles everything.

---

## Board File (`board.yaml`)

```yaml
name: My Dashboard
desc: Short description

connects:
  - id: my-db
    type: script          # or: http
    url: https://...      # for http type
    desc: Human description

vocabulary:
  tokens:
    healthy: { color: "green",  label: "Healthy" }
    warning: { color: "orange", label: "Warning" }
    alert:   { color: "red",    label: "Alert" }
```

`connects` entries describe available data connections. Their fields are passed to the task-executor and are not schema-enforced beyond `id` and `type`.

---

## Card File Structure

```json
{
  "id": "my-card",
  "meta": { "title": "Card Title", "tags": ["tag1"], "desc": "What this card does" },

  "requires": ["token-a", "token-b"],

  "sources": [
    { "bindTo": "raw", "outputFile": "my-card-raw.json", /* task-executor fields */ }
  ],

  "compute": [
    { "bindTo": "result", "expr": "/* JSONata expression */" }
  ],

  "provides": [
    { "bindTo": "published-token", "src": "computed_values.result" }
  ],

  "when_is_task_completed": "Optional: natural language for LLM inference",

  "view": {
    "elements": [ /* see Element Kinds below */ ],
    "layout": {
      "board":  { "col": 4, "order": 1 },
      "canvas": { "x": 50, "y": 50, "w": 280, "h": 180 }
    },
    "features": { "refresh": true, "chat": true }
  },

  "card_data": { /* initial mutable state */ }
}
```

---

## Strict Compute Order (within a card)

### Stage 1 — Sources
- **Runs first.** Parameterised by `requires.*` and `card_data.*` only.
- Each entry: `{ "bindTo": "key", "outputFile": "cache.json", ...customFields }`
  - `bindTo` → key under `fetched_sources`
  - `outputFile` → where the fetched result is cached
  - `customFields` → interpreted by the registered **task-executor** (examples: `mock`, `copilot`, `http`, `script`)
- Produces: `fetched_sources.*`

### Stage 2 — Compute
- **Runs after sources.** Reads `requires.*`, `fetched_sources.*`, `card_data.*`.
- Each entry: `{ "bindTo": "key", "expr": "<JSONata>" }`
- Produces: `computed_values.*`

### Stage 3 — Views & Provides
- **Resolved last.** Can reference all four namespaces:
  `requires.*`, `fetched_sources.*`, `card_data.*`, `computed_values.*`
- `view.elements[].data.bind` paths are resolved here.
- `provides[].src` paths are resolved here and published to the graph.

---

## provides / requires — The Dependency Graph

```json
// Publishing a token:
"provides": [
  { "bindTo": "orders",      "src": "fetched_sources.raw" },
  { "bindTo": "regionTotals","src": "computed_values.byRegion" },
  { "bindTo": "my-card",     "src": "card_data" }
]

// Consuming tokens:
"requires": ["orders", "selections", "my-card"]
```

- `provides` maps a token key to a dot-path inside this card's own namespaces.
- `requires` is a plain array of token key strings.
- In compute/source expressions, consumed tokens are at `requires.<key>`.
- For hyphenated keys, use JSONata `$lookup(requires, 'my-card')`.
- **These declarations are the only wiring needed** — the runtime builds the reactive DAG automatically.

---

## Reactivity

Every card is a live entity. Any of these events triggers automatic recompute of all downstream dependents in dependency order:
- A source finishes fetching (`fetched_sources` changes)
- An inference result arrives (`card_data.llm_task_completion_inference` set)
- User edits `card_data` via a form/filter/todo/actions element
- An upstream card's `provides` value changes
- A card definition is updated via server API from the UI

**Authors never trigger recompute manually — just declare the data shape.**

---

## Task Completion (`when_is_task_completed`)

| Value | Behaviour |
|---|---|
| *(absent or default)* | Task complete when all `sources[]` have been fetched |
| Natural language string | Invokes the registered **LLM inference adapter** with full card context; adapter reasons about completion |

### When to use `when_is_task_completed` (authoring decision)

**Default first.** Prefer the default (absent field) whenever task completion can be determined from computational signals — i.e. from the data already available in `fetched_sources`, `computed_values`, or `card_data`. Examples where the default is sufficient:
- A data-fetch card: done once all sources are fetched
- A form card: done once required `card_data` fields are non-empty (check in `compute[]`)
- A filter/selection card: done once a selection has been made

**Use LLM inference only when necessary.** Set `when_is_task_completed` to a natural language string when no deterministic signal can reliably determine completion — typically when:
- Completion depends on the *quality* or *sufficiency* of fetched data, not just its presence
- Completion requires interpreting unstructured content (e.g. "does the narrative indicate enough evidence?")
- Multiple conditions interact in ways that are hard to express as a JSONata expression
- The domain requires judgment that varies by context (e.g. "is the deployment genuinely healthy?")

Do **not** hesitate to use it when genuinely needed — LLM inference exists precisely for these judgment calls. But avoid it when a `compute[]` expression would suffice.

### Display pattern
LLM result is stored in `card_data.llm_task_completion_inference`.
```json
{ "kind": "badge", "data": { "bind": "card_data.llm_task_completion_inference.isTaskCompleted", "colorMap": { "true": "success", "false": "secondary" } } },
{ "kind": "text",  "style": "muted-italic", "data": { "bind": "card_data.llm_task_completion_inference.reason", "hideIfEmpty": true } }
```

---

## Element Kinds Reference

### `metric`
Single KPI value.
```json
{ "kind": "metric", "label": "Revenue", "data": { "bind": "computed_values.total" } }
```

### `badge`
Colour-coded status pill using Bootstrap colour names (`success`, `warning`, `danger`, `info`, `secondary`).
```json
{ "kind": "badge", "data": { "bind": "computed_values.health", "colorMap": { "Healthy": "success", "Low": "danger" } } }
```

### `text`
Plain or styled text. `style`: `muted`, `muted-italic`. Use `hideIfEmpty: true` to suppress if blank.
```json
{ "kind": "text", "label": "Note", "style": "muted-italic", "data": { "bind": "card_data.note", "hideIfEmpty": true } }
```

### `list`
Ordered list from an array. Optional `template` for string interpolation: `"{field1} — {field2}"`.
```json
{ "kind": "list", "data": { "bind": "computed_values.topItems", "template": "{name} — ${amount}" } }
```

### `table`
Data table. `columns` selects fields. `sortable: true` enables click-to-sort. `maxRows` caps display.
```json
{ "kind": "table", "data": { "bind": "fetched_sources.raw", "columns": ["id","name","value"], "sortable": true, "maxRows": 20 } }
```

### `chart`
Chart.js chart. `chartType`: `bar`, `line`, `pie`, `doughnut`, etc. `chartOptions` passed to Chart.js.
```json
{ "kind": "chart", "label": "By Region", "data": { "bind": "computed_values.regionCounts", "chartType": "bar", "chartOptions": { "indexAxis": "x" } } }
```

### `filter`
Interactive filter controls. `writeTo` persists selections into `card_data`. `fields` is a JSON Schema describing the filter fields.
```json
{
  "kind": "filter",
  "data": {
    "bind": "computed_values",
    "writeTo": "card_data.fieldValues",
    "fields": {
      "type": "object",
      "properties": {
        "region":  { "type": "string", "title": "Region" },
        "product": { "type": "string", "title": "Product" }
      }
    }
  }
}
```
Pair with a `provides` to publish `card_data.fieldValues` as a named token for downstream cards.

### `form`
Full editable form. `writeTo` path in `card_data`. `fields` is a JSON Schema (supports `enum`, `type`, `minimum`, `maximum`, `required`, etc.).
```json
{
  "kind": "form",
  "label": "Settings",
  "data": {
    "writeTo": "card_data.prefs",
    "fields": {
      "type": "object",
      "properties": {
        "region": { "type": "string", "title": "Region", "enum": ["North","South","East","West"] },
        "limit":  { "type": "number", "title": "Limit", "minimum": 0 }
      },
      "required": ["region"]
    }
  }
}
```

### `todo`
Interactive checklist. Items are `{ text, done }` objects stored in `card_data`.
```json
{ "kind": "todo", "label": "Tasks", "data": { "bind": "card_data.items", "writeTo": "card_data.items", "placeholder": "Add a task…" } }
```

### `actions`
Button row. Events bubble to the board-level chat/action handler. `style` is a Bootstrap colour name.
```json
{
  "kind": "actions",
  "label": "Workflow",
  "data": {
    "buttons": [
      { "id": "approve",  "label": "Approve",  "style": "success" },
      { "id": "escalate", "label": "Escalate", "style": "danger" }
    ]
  }
}
```

### `markdown`
Free-text Markdown rendered in the card. Typically bound to a `card_data` string field.
```json
{ "kind": "markdown", "data": { "bind": "card_data.content" } }
```
Set initial content in `card_data.content`.

### `narrative`
AI-generated streaming text. Bind to a `fetched_sources` path populated by a `copilot` source.
```json
{ "kind": "narrative", "data": { "bind": "fetched_sources.raw" } }
```
Pair with `"features": { "refresh": true, "chat": true }` in `view`.

### `notes`
Editable free-text notes field (similar to markdown but editable by the user).

### `alert`
Alert/callout display element.

### `custom`
Custom element kind — behaviour defined by the host application.

---

## Common Card Patterns

### Root source card
```
sources[mock/http/script] → fetched_sources.raw
provides: [{ bindTo: "orders", src: "fetched_sources.raw" }]
view: table showing the raw data
```

### Compute chain card
```
requires: ["orders"]
compute: JSONata aggregation → computed_values.result
provides: [{ bindTo: "regionTotals", src: "computed_values.result" }]
view: table or metric
```

### Multi-level chain (4 levels example)
```
card-source     provides "orders"
card-totals     requires "orders"       provides "regionTotals"
card-top        requires "regionTotals" provides "topRegion"
card-alert      requires "topRegion", "regionTotals"   (no further provides)
```

### Filter → filtered table
```
card-filter   provides "selections"  (src: card_data.fieldValues)
card-table    requires "orders", "selections"
              compute: $filter(requires.orders, fn → match selections)
```

### Form → dependent card
```
card-form     provides "card-ex-form"  (src: card_data)
card-child    requires "card-ex-form"
              compute: $lookup(requires, 'card-ex-form').prefs.field
```

### Async LLM inference card
```
requires: ["some-data"]
compute: derive status value
when_is_task_completed: "Task is done when X condition is met…"
view: badge(colorMap) + text(llm_task_completion_inference.reason, hideIfEmpty)
```

---

## Layout

```json
"layout": {
  "board":  { "col": 4, "order": 5 },
  "canvas": { "x": 300, "y": 400, "w": 280, "h": 180 }
}
```

- `board.col` — Bootstrap 12-column span: `3`=quarter, `4`=third, `6`=half, `8`=two-thirds, `12`=full
- `board.order` — ascending integer, controls vertical sort in board view
- `canvas` — pixel coordinates/size for drag-layout (canvas mode)

---

## Source `customFields` and the Task Executor

Every field on a source entry beyond `bindTo` and `outputFile` is a **customField**. The runtime passes the entire source object unchanged to the registered task executor — the executor is the sole interpreter of these fields.

> **Key principle:** The card author and the task executor author must agree on which customFields are supported. If a card uses `"http": {...}` but the executor only handles `"mock"` and `"copilot"`, the source fetch will fail. The executor must be designed to handle every source kind combination used in your board's cards.

Common customField conventions (demo executor supports `mock` and `copilot`):

| Field | Meaning |
|---|---|
| `"mock": "key"` | Reads from `mock.db` by key — local dev only |
| `"copilot": { "prompt_template": "...", "args": {} }` | LLM call; `{{key}}` interpolated from `_requires`, `_sourcesData`, `_computed_values`, then explicit `args` |
| `"prompt_template": "..."` | Shorthand top-level LLM call (equivalent to `copilot.prompt_template`) |
| `"http": { "url": "...", "method": "GET" }` | HTTP/REST — implement in your executor |
| `"graphapi": { "query": "..." }` | Microsoft Graph API — implement in your executor |
| `"script": { "path": "...", "args": {} }` | Local script — implement in your executor |
| `"teams"`, `"mail"`, `"incidentdb"` | Any domain integration — define in your executor |

Sources can reference upstream data in their customFields (e.g. `"url": "https://api.example.com/{{orderId}}"`) — the executor receives `_requires`, `_sourcesData`, `_computed_values` to resolve such references. See [Task Executor Protocol](#task-executor-protocol) for the full `--in` payload shape.

### Optional source field
- `optionalForCompletionGating: true` — marks this source as optional for default task-completion gating. If set, the card can complete even if this source hasn't been fetched yet.

## `when_is_task_completed` and the Inference Adapter

This optional card field controls the task-completion mechanism:

- **Absent or omitted**: task is complete when all non-optional `sources[]` have been fetched (default, no LLM needed).
- **Set to a natural language string**: the registered inference adapter is invoked with the full card context (requires, sourcesData, computed_values, card_data, provides) and the string as `completionRule`. The adapter reasons about whether the task is complete and returns `isTaskCompleted: boolean`.

> **Key principle:** The inference adapter must be capable of evaluating every `when_is_task_completed` string used across your board's cards. If a card asks "Has the deployment been validated?" but the adapter only knows about revenue thresholds, the adapter must handle the unknown case gracefully (return `isTaskCompleted: false` with a reason).

The `completionRule` string is passed verbatim to the adapter. Write it as a clear, self-contained question or condition the LLM can answer from the provided context. Examples:
- `"All required form fields are filled and the total is above zero"`
- `"The deployment status indicates success"`
- `"Revenue data is sufficient to draw conclusions"`

See [Inference Adapter Protocol](#inference-adapter-protocol) for the full `--in` / `--out` contract.

---

## Validating Cards

### CLI (recommended for authoring)
```bash
# Validate all cards in example-board
npm run validate:cards -- "examples/example-board/cards/*.json"

# Validate any glob pattern
npm run validate:cards -- "path/to/cards/*.json"
```
Uses `validateLiveCardDefinition` — structural + schema checks, reports all errors per file.

### Programmatic
```typescript
import { validateLiveCardSchema } from 'yaml-flow/card-compute';
// or for the most thorough check:
import { validateLiveCardDefinition } from 'yaml-flow/src/card-compute/schema-validator.js';

const result = validateLiveCardDefinition(cardObject);
if (!result.ok) {
  console.error(result.errors); // string[]
}
```

| Function | Validates |
|---|---|
| `validateLiveCardDefinition` | Full structural + schema check (most thorough, used by CLI) |
| `validateLiveCardSchema` | AJV JSON Schema check against `schema/live-cards.schema.json` |
| `validateLiveCardRuntimeExpressions` | JSONata expression syntax in `compute[].expr` |
| `validateLiveCard` | Basic structural shape check |

### Schema reference
When in doubt about allowed fields, consult:
- `yaml-flow/schema/live-cards.schema.json` — canonical JSON Schema for cards
- `yaml-flow/browser/live-cards.schema.json` — browser-bundled copy (same content)

### What the validator checks
- `id` required, non-empty string
- `card_data` required, must be an object
- `requires` must be array of strings (if present)
- `provides` must be array of `{ bindTo: string, src: string }` (if present)
- `compute[]` each entry must have `bindTo` + `expr` strings
- `sources[]` each entry must have `bindTo` + `outputFile` strings; both must be unique across the array
- `view.elements` required, non-empty; each element must have a valid `kind`
- Top-level unknown keys are flagged as errors
- Valid element `kind` values: `metric`, `table`, `chart`, `form`, `filter`, `list`, `notes`, `todo`, `alert`, `narrative`, `badge`, `text`, `markdown`, `custom`

---

## mock.db

A JSON file at the board root keyed by mock name. Used by `"mock": "key"` sources. Replace with real task-executor integrations in production.

---

## Task Executor Protocol

The task executor is a **card-source-driven** component — its behaviour is determined entirely by the `customFields` defined on each card's `sources[]` entries. One executor is registered for the whole board, but it must know how to handle every source kind (`mock`, `copilot`, `http`, `graphapi`, etc.) used by any card on the board. The executor is the only handler where the card's source definition directly drives what the handler needs to do. It is registered once per board:

```bash
node board-live-cards-cli.js init-board --board-dir ./my-board --task-executor ./my-executor.js
# stores path in <boardDir>/.task-executor
```

### Invocation

```bash
node <executor.js> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
```

- **`--in`** — path to a JSON file containing a single source object (one entry from `sources[]`), enriched by the runtime with extra context fields:

```json
{
  "bindTo": "raw",
  "outputFile": "my-card-raw.json",
  "cwd": "/absolute/path/to/board",
  "boardDir": "/absolute/path/to/board",
  "_requires": { "token-a": { ... }, "token-b": { ... } },
  "_sourcesData": { "previously-fetched-source-key": { ... } },
  "_computed_values": { "result": "..." },
  /* ...any other customFields from the card source definition */
}
```

- `_requires` — resolved values for all card `requires` tokens
- `_sourcesData` — already-fetched sources for this card (earlier in sources[] order)
- `_computed_values` — current computed_values for the card

- **`--out`** — path to write the fetched value as raw JSON (any shape; stored under `fetched_sources.<bindTo>`)
- **`--err`** — optional path to write a plain-text error message on failure

### Supported source kinds (by convention)

| `customField` | Meaning |
|---|---|
| `"mock": "key"` | Lookup `key` in `mock.db` — local dev |
| `"copilot": { "prompt_template": "..." }` | LLM call; supports `{{key}}` interpolation against `_requires`, `_sourcesData`, `_computed_values` |
| `"http": { "url": "...", "method": "GET" }` | HTTP/REST fetch |
| `"graphapi": { "query": "..." }` | Microsoft Graph API query |
| `"script": { "path": "...", "args": {} }` | Run a local script |
| `"teams"`, `"mail"`, `"incidentdb"` | Custom integrations in your executor |

All customFields are executor-defined — the runtime passes them through unchanged.

### Exit codes
- **0** — success; runtime reads `--out`
- **non-zero** — failure; runtime reads `--err` if present

---

## Inference Adapter Protocol

The inference adapter is a **board-wide generic LLM reasoner** — one adapter serves all cards on the board. It does not depend on any card's source definitions. Its job is to receive the card context and the `completionRule` question (the card's `when_is_task_completed` string), call an LLM directly (e.g. Copilot via CLI), and return a boolean decision with a reason. The card context is passed in `--in`; the adapter uses it as grounding for the LLM prompt.

The demo adapter (`demo-inference-adapter.js`) shows this pattern: builds a prompt from card context + completionRule, calls Copilot, parses `isTaskCompleted` from the JSON response. Rule-based fallback is acceptable only as a degraded mode when the LLM is unavailable.

The adapter is invoked only when a card has a custom `when_is_task_completed` string. Register once per board:

```bash
node board-live-cards-cli.js init-board --board-dir ./my-board --inference-adapter ./my-adapter.js
# stores path in <boardDir>/.inference-adapter
```

### How inference is triggered (two-phase async)

1. The runtime CLI spawns an internal subprocess: `board-live-cards-cli run-inference-internal --in <input.json> --token <inferenceToken>` (internal token encodes callback context)
2. That internal subprocess calls your adapter: `node <adapter.js> run-inference --in <input.json> --out <result.json> --err <error.txt>`
3. Adapter writes result to `--out` and exits.
4. Internal subprocess reads result and calls `inference-done` back to the runtime.

As an adapter author, you only implement step 2 — your adapter receives `--in`, `--out`, `--err`.

### Invocation

```bash
node <adapter.js> run-inference --in <input.json> --out <result.json> [--err <error.txt>]
```

- **`--in`** — path to a JSON file with:

```json
{
  "cardId": "my-card",
  "taskName": "my-card",
  "completionRule": "All required fields are filled and validated",
  "context": {
    "requires":        { "token-a": { ... } },
    "sourcesData":     { "raw": { ... } },
    "computed_values": { "result": "..." },
    "provides":        [{ "bindTo": "published-token", "src": "computed_values.result" }],
    "card_data":       { ... }
  }
}
```

- **`--out`** — path to write your result JSON (see shape below)
- **`--err`** — optional path to write a plain-text error message on failure

### Output (`--out`)

```json
{
  "isTaskCompleted": true,
  "reason": "All required fields are present and valid.",
  "evidence": "Optional supporting detail string"
}
```

- `isTaskCompleted` — **boolean** (required); `true` = task is done
- `reason` — human-readable explanation (required)
- `evidence` — optional detail string

> **Important:** `isTaskCompleted` must be a boolean, not a string. Never use `"status": "task-completed"` — the runtime does not recognise that field.

### Result storage
The inference result is stored in `card_data.llm_task_completion_inference` and is typically rendered using:
```json
{ "kind": "badge", "data": { "bind": "card_data.llm_task_completion_inference.isTaskCompleted", "colorMap": { "true": "success", "false": "secondary" } } },
{ "kind": "text",  "data": { "bind": "card_data.llm_task_completion_inference.reason", "hideIfEmpty": true } }
```

---

## Chat Handler Protocol

The chat handler is a **universal LLM component** — it does not depend on card sources, card model fields, or board state. Its sole job is: read the conversation, call the LLM, write the response.

Enable chat on a card by setting `"chat": true` in the card's `view.features`:
```json
"view": {
  "features": { "chat": true }
}
```

Register once per board:
```bash
node board-live-cards-cli.js init-board --board-dir ./my-board --chat-handler ./my-chat-handler.js
# stores path in <boardDir>/.chat-handler
```

### Invocation

```bash
node <handler.js> --boardId <id> --cardId <id> --extraEncJson <base64json>
```

- **`--boardId`** — board identifier
- **`--cardId`** — the specific card where the user clicked the chat button
- **`--extraEncJson`** — base64-encoded JSON: `{ chatDir, boardDir, lastChatFile }`
  - `chatDir` — absolute path to the directory holding all chat message files for this card
  - `boardDir` — absolute path to the board runtime directory
  - `lastChatFile` — filename of the user message just written (e.g. `007_user.txt`)

### Chat message files

Messages are stored as serial-numbered `.txt` files in `chatDir`:
- `001_user.txt`, `002-assistant.txt`, `003_user.txt`, … (alternating)
- The handler reads **all** files to reconstruct conversation history, writes the next `<serial>-assistant.txt`

### What the handler must do

1. Read all `*_user.txt` / `*-assistant.txt` files from `chatDir` (sorted) → conversation history
2. Build a system prompt scoped to `cardId` / `boardId` as grounding context
3. Call the LLM directly (e.g. Copilot CLI) with `cwd: boardDir` — running from `boardDir` gives the LLM natural file context
4. Write the response to `<nextSerial>-assistant.txt` in `chatDir`

### System prompt guidance

The chat is always scoped to the card where the chat button is embedded. The LLM should:
- Help the user understand, explore, or act on **that card's data**
- Be concise — this is an inline embedded chat, not a full conversation window
- Reference specific values when answering
- Ask one short clarifying question if intent is ambiguous

```javascript
// Minimal system prompt example:
`You are a helpful assistant embedded in a live data card (card: "${cardId}", board: "${boardId}").
Help the user understand and act on the data shown in this card.
Be concise. Ground answers in the card's data context.`
```

### LLM invocation

Call Copilot CLI directly from `boardDir` — same pattern as `demo-task-executor.js`:
```javascript
execFileSync(copilotBin, ['--allow-all'], {
  input: fullPrompt,
  encoding: 'utf-8',
  cwd: boardDir,         // ← run from boardDir for natural file context
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

No rule-based fallback needed. If the LLM fails, write a short acknowledgment message so the user sees something rather than silence.
