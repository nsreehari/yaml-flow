# Example Board — LiveCard v4 Format Reference

This reference board demonstrates how to write cards in **LiveCard v4 schema format** (yaml-flow 4.0.0).
All cards follow `live-cards.schema.json`, which can be found at `node_modules/yaml-flow/schema/live-cards.schema.json`.

## LiveCard v4 Card Structure

Every card is a JSON object with these top-level properties only (`additionalProperties: false`):

```json
{
  "id": "card-<unique-id>",
  "meta": { "title": "Display Title", "tags": [], "desc": "Tooltip" },
  "requires": ["upstream-token"],
  "provides": [{ "bindTo": "my-token", "src": "sources.raw" }],
  "sources": [{
    "bindTo": "raw",
    "outputFile": "card-xxx-raw.json",
    "script": "node fetch-data.js --out card-xxx-raw.json"
  }],
  "compute": [
    { "bindTo": "total", "expr": "$sum(sources.raw.amount)" }
  ],
  "view": {
    "elements": [{ "kind": "table", "data": { "bind": "sources.raw" } }],
    "layout": { "board": { "col": 6 } },
    "features": { "refresh": true }
  },
  "state": {}
}
```

### Valid Top-Level Properties

`id`, `requires`, `provides`, `meta`, `view`, `state`, `sources`, `compute` — **nothing else**.

**No `type` field.** No `data` wrapper.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique card identifier |
| `view` | object | Must have `elements` array with at least 1 element |
| `state` | object | Card state (can be empty `{}`) |

### Dependencies via Tokens

- `requires: ["orders"]` — token names this card depends on (top-level string array)
- `provides: [{ bindTo: "orders", src: "sources.raw" }]` — named outputs for downstream cards
- The CLI builds the dependency graph from requires/provides automatically
- Cards with no `requires` are root cards (sources execute first)

### Sources

Data sources in the `sources[]` array. Each entry is passed **verbatim** to the registered task-executor.
The schema only mandates `bindTo`. All other properties are yours — add whatever your task-executor needs (`kind`, `url`, `connectId`, `query`, etc.). The full object is the `--in` JSON to the executor.

Schema-native properties:

| Property | Type | Description |
|----------|------|-------------|
| `bindTo` | string | **Required.** Key under `sources.*` available in compute expressions |
| `outputFile` | string | Board-relative path the executor writes JSON result to |
| `script` | string | Fallback: shell command run when no `.task-executor` is registered |
| `timeout` | integer | Executor timeout in ms (default: 120000) |
| `optionalForCompletionGating` | boolean | When true, this source doesn't block `task-completed` |

```json
"sources": [{
  "bindTo": "raw",
  "outputFile": "card-orders-raw.json",
  "script": "node scripts/fetch-orders.js --out card-orders-raw.json"
}]
```

### Compute with JSONata

Ordered JSONata expressions evaluated against `{ state, requires, sources, computed_values }`:

```json
"compute": [
  { "bindTo": "total", "expr": "$sum(sources.raw.amount)" },
  { "bindTo": "avg",   "expr": "$round(computed_values.total / $count(sources.raw), 2)" }
]
```

Later steps reference earlier ones via `computed_values.*`.

### View Element Kinds

17 kinds: `metric`, `table`, `chart`, `form`, `filter`, `list`, `notes`, `todo`, `alert`, `narrative`, `badge`, `text`, `markdown`, `custom`, `file-upload`, `chat`, `actions`

Elements bind to `computed_values.*`, `sources.*`, or `state.*`:
```json
{ "kind": "metric", "label": "Total", "data": { "bind": "computed_values.total" } }
```

### Layout

Cards can declare layout hints for board mode and/or canvas mode:

```json
"layout": {
  "board":  { "col": 6, "order": 1 },
  "canvas": { "x": 50, "y": 50, "w": 300, "h": 200 }
}
```

### Features

```json
"features": { "refresh": true, "chat": false, "notes": false }
```

### Meta Extensions

| Field | Description |
|-------|-------------|
| `meta.title` | Display title |
| `meta.tags` | Semantic tags |
| `meta.desc` | Tooltip description |
| `meta.prompt` | LLM prompt for narrative cards |
| `meta.notes` | User scratchpad — agents do NOT write here |

## Example Cards

| Card | Pattern | Demonstrates |
|------|---------|-------------|
| `card-ex-source` | Root data source | `sources` with `script`, `provides` token downstream |
| `card-ex-source-http` | External API source | `requires` upstream, `sources` with params, variable substitution |
| `card-ex-filter` | Interactive filter | `filter` element, `writeTo`, `provides` user selections |
| `card-ex-metric` | Single KPI | `metric` element, JSONata `$sum` + `$round` |
| `card-ex-list` | Top-N ranking | `list` element, JSONata `$sort` + array slice |
| `card-ex-table` | Filtered data table | `table` element, multi-token `requires`, JSONata filter pipeline |
| `card-ex-chart` | Bar chart | `chart` element, `chartType`, computed aggregation |
| `card-ex-status` | Health badge | `badge` + `metric` multi-element, JSONata threshold logic |
| `card-ex-markdown` | Static notes | No sources/requires, `state.content` with markdown |
| `card-ex-narrative` | AI summary | `narrative` element, `meta.prompt`, upstream data deps |
| `card-ex-todo` | Task tracker | `todo` element, `writeTo` for persistent user input |

## DAG

```
card-ex-source (root — fetches order data)
  ├─► card-ex-source-http (fetches pricing for upstream items)
  ├─► card-ex-filter (interactive — provides user selections)
  ├─► card-ex-metric (compute: $sum)
  ├─► card-ex-list (compute: sort + slice)
  ├─► card-ex-chart (compute: group + count)
  ├─► card-ex-table (requires: source + filter)
  ├─► card-ex-status (compute: threshold)
  └─► card-ex-narrative (prompt + upstream data)

card-ex-markdown (standalone)
card-ex-todo (standalone)
```

## Validation

```bash
# If your board has a validate script:
node .github/scripts/validate-live-card.js <cardId>
node .github/scripts/validate-live-card.js --all

# Or via the CLI:
npx board-live-cards-cli status --rg .board-runtime --json
```
