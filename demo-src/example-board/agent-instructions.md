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

  "source_defs": [
    { "bindTo": "raw", "outputFile": "my-card-raw.json", /* task-executor fields */ }
  ],

  "compute": [
    { "bindTo": "result", "expr": "/* JSONata expression */" }
  ],

  "provides": [
    { "bindTo": "published-token", "src": "computed_values.result" }
  ],

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
- **`source_defs` is NOT a valid data namespace** — it is the config array of source definitions. Use `fetched_sources.*` to reference fetched data.

### Stage 2 — Compute
- **Runs after source_defs.** Reads `requires.*`, `fetched_sources.*`, `card_data.*`.
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
- User edits `card_data` via a form/filter/todo/actions element
- An upstream card's `provides` value changes
- A card definition is updated via server API from the UI

**Authors never trigger recompute manually — just declare the data shape.**

---

## Task Completion

Task completion is determined by one rule: **a card is complete when all non-optional `source_defs[]` have been fetched**.

If completion requires a judgment call — e.g. "is the data sufficient?", "does this narrative indicate done?" — model it as data using the standard source → compute → provides chain (see LLM source pattern below). The card is complete when that source has been fetched.

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

### `editable-table`
Inline-editable table. Each cell is an `<input>`; changes save on blur. `writeTo` persists the updated array back to `card_data`. `columns` controls which fields appear. Optional `schema.properties` per column sets `type` (`number`/`integer` renders a numeric input). `addRow` (default `true`) shows a "+ Add row" button; `deleteRow` (default `true`) shows per-row delete buttons.
```json
{
  "kind": "editable-table",
  "label": "Holdings",
  "data": {
    "bind": "card_data.holdings",
    "writeTo": "card_data.holdings",
    "columns": ["ticker", "quantity"],
    "schema": {
      "properties": {
        "quantity": { "type": "number" }
      }
    }
  }
}
```
Pair with a `provides` pointing at `card_data.holdings` so downstream cards receive the live array. Use `addRow: false` / `deleteRow: false` to make the table append-only or read-fixed-length.

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
source_defs[mock/http/script] → fetched_sources.raw
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

### LLM verdict card (completion gating via source)
```
requires: ["some-data"]
source_defs: [{ bindTo: "verdict", outputFile: "...", copilot: { prompt_template: "..." } }]
compute: [{ bindTo: "isReady", expr: "fetched_sources.verdict.isTaskCompleted" }]
provides: [{ bindTo: "readiness-verdict", src: "fetched_sources.verdict" }]
view: badge(computed_values.isReady, colorMap) + text(fetched_sources.verdict.reason)
```
The task executor calls the LLM, writes `{ isTaskCompleted: bool, reason: string }` to `--out`.
The card is complete when the source is fetched. Downstream cards `requires: ["readiness-verdict"]`.

---

## Card Design Principles & Layout

See [agent-instructions-cardlayout.md](agent-instructions-cardlayout.md).

---

## Source `customFields` and the Task Executor

Every field on a source entry beyond `bindTo` and `outputFile` is a **customField**. The runtime passes the entire source object unchanged to the registered task executor — the executor is the sole interpreter of these fields.

> **Key principle:** The card author and the task executor author must agree on which customFields are supported. If a card uses `"http": {...}` but the executor only handles `"mock"` and `"copilot"`, the source fetch will fail. The executor must be designed to handle every source kind combination used in your board's cards.

Common customField conventions (demo executor supports `mock` and `copilot`):

| Field | Meaning |
|---|---|
| `"mock": "key"` | Reads from `mock.db` by key — local dev only |
| `"copilot": { "prompt_template": "...", "args": {} }` | LLM call; `{{key}}` interpolated from `_refs` (named data projections declared in `refs`), then explicit `args` |
| `"prompt_template": "..."` | Shorthand top-level LLM call (equivalent to `copilot.prompt_template`) |
| `"http": { "url": "...", "method": "GET" }` | HTTP/REST — implement in your executor |
| `"graphapi": { "query": "..." }` | Microsoft Graph API — implement in your executor |
| `"script": { "path": "...", "args": {} }` | Local script — implement in your executor |
| `"teams"`, `"mail"`, `"incidentdb"` | Any domain integration — define in your executor |

Sources can access upstream data via the `refs` property — named JSONata projections from `card_data` or `requires` that the engine evaluates before invoking the executor. The executor receives `_refs` containing the resolved values. See [source_defs refs](#source_defs-refs) and [Task Executor Protocol](#task-executor-protocol) for details.

### source_defs refs

The optional `refs` map lets a source definition declare which upstream data it needs. Each key maps to a JSONata expression rooted at `card_data` or `requires`. The engine evaluates these before invoking the executor and attaches the results as `_refs` on the source payload.

```json
"source_defs": [
  {
    "bindTo": "quotes",
    "outputFile": "quotes.json",
    "refs": {
      "holdings": "requires.holdings",
      "topHoldings": "requires.holdings[weight > 0.05]",
      "threshold": "card_data.threshold"
    },
    "chartApi": {
      "tickersFrom": "holdings.ticker"
    }
  }
]
```

**Rules:**
- Only `card_data` and `requires` are valid namespaces in `refs` expressions
- `fetched_sources`, `computed_values`, and `source_defs` are **forbidden** in refs
- Full JSONata syntax is supported (same as `compute[].expr`)
- Sources without `refs` receive `_refs: {}` — executor must handle empty refs gracefully
- `tickersFrom: "refKey.fieldName"` reads from `_refs[refKey]` — the `refs` key must exist

### Optional source field
- `optionalForCompletionGating: true` — marks this source as optional for default task-completion gating. If set, the card can complete even if this source hasn't been fetched yet.

### Discovering supported source kinds

Rather than guessing which source `customFields` the registered executor supports, query it directly:

```bash
node board-live-cards-cli.js describe-task-executor-capabilities --rg <boardDir>
```

This invokes the executor's `describe-capabilities` subcommand and prints its capabilities JSON to stdout. The output includes:
- **`sourceKinds`** — every source kind the executor handles (e.g. `mock`, `copilot`, `http`, `chartApi`), each with:
  - `description` — what the kind does
  - `inputSchema` — the exact `customFields` the executor expects on the source entry
  - `outputShape` — the shape of the JSON written to `--out`
  - `example` — sample input/output pair
- **`extraSchema`** — fields available via `--extra` (board topology context)
- **`subcommands`** — supported subcommands (typically `run-source-fetch` + `describe-capabilities`)

**Use this before authoring a card** to confirm the executor handles your intended source kind and to discover the correct field names and types. If the kind is missing from the output, the executor needs extending before the card will work.

Example output (excerpt):
```json
{
  "sourceKinds": {
    "mock": {
      "description": "Look up a key in a hardcoded MOCK_DB dictionary.",
      "inputSchema": { "mock": { "type": "string", "required": true } }
    },
    "copilot": {
      "description": "Invoke GitHub Copilot CLI with an interpolated prompt template.",
      "inputSchema": {
        "copilot": { "type": "object", "properties": { "prompt_template": { "type": "string" } } }
      }
    }
  }
}
```

## LLM Calls — Use a Source

**All LLM calls belong in source_defs[], handled by the task executor.** There is one mechanism for external calls — source_defs.

To incorporate LLM reasoning into a card:

1. Add a source entry with a `copilot` (or equivalent) customField and an `outputFile`.
2. The task executor calls the LLM and writes the result JSON to `--out`.
3. Card compute reads `fetched_sources.<bindTo>` and derives tokens from it.
4. The card provides those tokens downstream like any other.

```json
"source_defs": [
  {
    "bindTo": "verdict",
    "outputFile": "my-card-verdict.json",
    "copilot": {
      "prompt_template": "Given this data: {{positions}} — is the portfolio sufficiently diversified? Return JSON: { \"isTaskCompleted\": bool, \"reason\": string }"
    }
  }
]
```

If the LLM needs computed values (which compute first), chain two cards: Card A computes → Card B `requires` Card A's provides → Card B's source calls the LLM with those values.

> **One mechanism for everything.** Sources → compute → provides is the complete model. Every card an agent authors follows this shape regardless of whether the data comes from a database, an API, or an LLM.

---

## Validating Cards

### CLI (recommended for authoring)
```bash
# Validate a single card
node board-live-cards-cli.js validate-card --card cards/my-card.json

# Validate all cards matching a glob
node board-live-cards-cli.js validate-card --card-glob "cards/*.json"
```
Checks JSON Schema structure, JSONata expression syntax in `compute[].expr`, and `provides[].src` namespace validity. Reports per-file OK/FAIL with detailed errors. Exits with code 1 if any card fails.

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
- `provides[].src` must start with a valid namespace: `card_data`, `requires`, `fetched_sources`, or `computed_values`
- `compute[]` each entry must have `bindTo` + `expr` strings; `expr` must be valid JSONata
- `source_defs[]` each entry must have `bindTo` + `outputFile` strings; both must be unique across the array
- `view.elements` required, non-empty; each element must have a valid `kind`
- Top-level unknown keys are flagged as errors
- Valid element `kind` values: `metric`, `table`, `editable-table`, `chart`, `form`, `filter`, `list`, `notes`, `todo`, `alert`, `narrative`, `badge`, `text`, `markdown`, `custom`

---

## mock.db

A JSON file at the board root keyed by mock name. Used by `"mock": "key"` source_defs. Replace with real task-executor integrations in production.

---

## Task Executor Protocol

The task executor is a **card-source-driven** component — its behaviour is determined entirely by the `customFields` defined on each card's `source_defs[]` entries. One executor is registered for the whole board, but it must know how to handle every source kind (`mock`, `copilot`, `http`, `graphapi`, etc.) used by any card on the board. The executor is the only handler where the card's source definition directly drives what the handler needs to do. It is registered once per board:

```bash
node board-live-cards-cli.js init ./my-board --task-executor ./my-executor.js
# stores path in <boardDir>/.task-executor
```

### Invocation

```bash
node <executor.js> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
```

- **`--in`** — path to a JSON file containing a single source object (one entry from `source_defs[]`), enriched by the runtime with extra context fields:

```json
{
  "bindTo": "raw",
  "outputFile": "my-card-raw.json",
  "cwd": "/absolute/path/to/board",
  "boardDir": "/absolute/path/to/board",
  "_refs": { "holdings": [ ... ], "threshold": 0.05 },
  /* ...any other customFields from the card source definition */
}
```

- `_refs` — resolved values for all entries declared in the source's `refs` map (evaluated from `card_data`/`requires` before executor invocation). Empty object `{}` if `refs` was not declared.

- **`--out`** — path to write the fetched value as raw JSON (any shape; stored under `fetched_sources.<bindTo>`)
- **`--err`** — optional path to write a plain-text error message on failure

### Supported source kinds (by convention)

| `customField` | Meaning |
|---|---|
| `"mock": "key"` | Lookup `key` in `mock.db` — local dev |
| `"copilot": { "prompt_template": "..." }` | LLM call; supports `{{key}}` interpolation against `_refs` |
| `"http": { "url": "...", "method": "GET" }` | HTTP/REST fetch |
| `"graphapi": { "query": "..." }` | Microsoft Graph API query |
| `"script": { "path": "...", "args": {} }` | Run a local script |
| `"teams"`, `"mail"`, `"incidentdb"` | Custom integrations in your executor |

All customFields are executor-defined — the runtime passes them through unchanged.

### Exit codes
- **0** — success; runtime reads `--out`
- **non-zero** — failure; runtime reads `--err` if present

### Probing a source before deploying

Before adding a card to a running board, agents should validate that each source can actually be fetched. Use the `probe-source` command — it reads the card file, extracts the source at the chosen index, builds the exact same `--in` payload the runtime would build, invokes the registered executor, and reports pass/fail.

```bash
node board-live-cards-cli.js probe-source \
  --card cards/card-market-prices.json \
  --source-idx 0 \
  --rg <boardRuntimeDir> \
  --mock-refs '{"holdings":[{"ticker":"AAPL","quantity":10},{"ticker":"MSFT","quantity":5}]}'
```

| Flag | Required | Description |
|---|---|---|
| `--card <card.json>` | yes | Path to the card file to probe |
| `--source-idx <n>` | no (default 0) | 0-based index into `source_defs[]` |
| `--source-bind <name>` | no | Select source by `bindTo` name instead of index |
| `--mock-refs <json>` | no | JSON string (or `@file.json`) providing the `_refs` values the source needs. If omitted, `_refs` is `{}`. |
| `--rg <boardDir>` | no | Board runtime directory used to locate `.task-executor`. Defaults to the card file's directory. |
| `--out <result.json>` | no | Write the raw fetch result to this path |

**Output:** the command prints a human-readable report ending with a machine-readable `[probe-source:result]` JSON line. Exit `0` = `PROBE_PASS`, exit `1` = `PROBE_FAIL`.

**`--mock-refs` is the agent's responsibility.** Craft the minimal payload that exercises the source — for example, if the card declares `"refs": { "holdings": "requires.holdings" }` and the source uses `tickersFrom: "holdings.ticker"`, supply `{"holdings":[{"ticker":"AAPL","quantity":1}]}`.

**Workflow for agents authoring a new card:**
1. **Discover available source kinds** — run `describe-task-executor-capabilities` to see exactly which source kinds the registered executor supports, their required `customFields`, and expected output shapes. Only use source kinds present in this output.
   ```bash
   node board-live-cards-cli.js describe-task-executor-capabilities --rg <boardDir>
   ```
2. **Author the card JSON** with `source_defs[]`, `compute[]`, `provides[]`, and `view` using only the source kinds confirmed in step 1.
3. **Validate the card structure** — run `validate-card` to catch schema errors, invalid JSONata expressions, and namespace violations before attempting any live fetch.
   ```bash
   node board-live-cards-cli.js validate-card --card cards/my-card.json
   ```
   Fix any reported errors and re-run until validation passes.
4. **Probe each source** — run `probe-source` with representative `--mock-refs` data to confirm the executor can successfully fetch each source.
5. If `PROBE_PASS` → proceed with `upsert-card`.
6. If `PROBE_FAIL` → inspect the error, fix the source definition or executor, retry from step 3.

**Workflow for agents editing an existing card:**
1. Make the change to the card JSON.
2. **Validate immediately** — run `validate-card` after every edit.
   ```bash
   node board-live-cards-cli.js validate-card --card cards/my-card.json
   ```
3. If validation fails, fix the reported errors and re-run — repeat until the card is clean.
4. If the change touches a `source_defs[]` entry, also run `probe-source` to confirm the source still fetches correctly before deploying.

---



---

## Chat Handler Protocol

The chat handler is a **universal LLM component** — it does not depend on card source_defs, card model fields, or board state. Its sole job is: read the conversation, call the LLM, write the response.

Enable chat on a card by setting `"chat": true` in the card's `view.features`:
```json
"view": {
  "features": { "chat": true }
}
```

Register once per board:
```bash
node board-live-cards-cli.js init ./my-board --chat-handler ./my-chat-handler.js
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
