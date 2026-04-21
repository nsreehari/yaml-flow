# Example Board — Data Objects & Computed Values Demo

This example demonstrates the **token-centric data architecture** of board-live-cards:
- **Data Objects**: Emitted via `provides` bindings, persisted to `runtime-out/data-objects/`
- **Computed Values**: JSONata-evaluated per-card, persisted to `runtime-out/cards/<cardId>.computed.json`

## Quick Start

### 1. Initialize the Demo

```bash
cd examples/example-board
node demo-server.js &
```

The server will start on `http://localhost:7799`.

### 2. Open the UI

Visit: **[demo-shell-with-server.html](demo-shell-with-server.html)**

Click "Reset Board" to initialize with all cards.

### 3. Monitor Data Persistence

Watch files being created in `runtime-out/`:

```bash
watch -n 0.5 'find runtime-out -type f | sort'
```

Or open a new terminal:

```bash
ls -la runtime-out/data-objects/
ls -la runtime-out/cards/
```

## Data Flow Architecture

### Token Data Objects (Shared Token Map)

Cards emit data via `provides` bindings → written to `runtime-out/data-objects/`:

```
card-ex-source.json          →  runtime-out/data-objects/orders
  provides: ["orders"]
  sources: [...order data...]

card-ex-source-http.json     →  runtime-out/data-objects/prices
  provides: ["prices"]
  requires: ["orders"]

card-ex-filter.json          →  runtime-out/data-objects/selections
  provides: ["selections"]
  requires: ["orders"]
```

### SSE Payload to UI

Server publishes all tokens in a single map:

```javascript
{
  dataObjectsByToken: {
    orders:     [...],
    prices:     [...],
    selections: {...}
  },
  cardRuntimeById: {
    "card-ex-metric":   { computed_values: { totalRevenue: 61500 }, ... },
    "card-ex-chart":    { computed_values: { regionCounts: [...] }, ... },
    ...
  }
}
```

### UI Resolution

The runtime-artifacts-adapter resolves requires from the shared token map:

```javascript
// For each card with requires: ["orders", "prices"]
card.requires = {
  orders:  dataObjectsByToken.orders,
  prices:  dataObjectsByToken.prices
};

// UI binds paths like:
// - requires.orders[0].amount
// - requires.prices[2].price
// - computed_values.totalRevenue
```

## Card Examples

### Root Source (card-ex-source.json)

Fetches initial data, emits `orders` token:

```json
{
  "id": "card-ex-source",
  "provides": [{ "bindTo": "orders", "src": "sources.raw" }],
  "sources": [{ "bindTo": "raw", "outputFile": "card-ex-source-raw.json", "mock": "orders" }],
  "view": { "elements": [{ "kind": "table", "data": { "bind": "sources.raw" } }] },
  "card_data": {}
}
```

**Result File**: `runtime-out/data-objects/orders`

### Computed Metric (card-ex-metric.json)

Requires upstream token, computes KPI:

```json
{
  "id": "card-ex-metric",
  "requires": ["orders"],
  "compute": [
    { "bindTo": "totalRevenue", "expr": "$round($sum(requires.orders.amount), 2)" }
  ],
  "view": { "elements": [{ "kind": "metric", "label": "Revenue", "data": { "bind": "computed_values.totalRevenue" } }] },
  "card_data": {}
}
```

**Result File**: `runtime-out/cards/card-ex-metric.computed.json`

```json
{
  "schema_version": "v1",
  "card_id": "card-ex-metric",
  "card_data": {},
  "computed_values": {
    "totalRevenue": 61500
  },
  "sources_data": {}
}
```

### Filter/Interactive (card-ex-filter.json)

Allows user selections, emits `selections` token:

```json
{
  "id": "card-ex-filter",
  "requires": ["orders"],
  "provides": [{ "bindTo": "selections", "src": "card_data.fieldValues" }],
  "compute": [
    { "bindTo": "region", "expr": "$sort($distinct(requires.orders.region))" },
    { "bindTo": "product", "expr": "$sort($distinct(requires.orders.product))" }
  ],
  "view": {
    "elements": [
      { "kind": "filter", "data": { "bind": "computed_values", "writeTo": "card_data.fieldValues", "fields": {...} } }
    ]
  },
  "card_data": { "fieldValues": {} }
}
```

**Result File**: `runtime-out/data-objects/selections`

### Dependent Card (card-ex-table.json)

Filters using both upstream tokens:

```json
{
  "id": "card-ex-table",
  "requires": ["orders", "selections"],
  "compute": [
    {
      "bindTo": "filtered",
      "expr": "$filter(requires.orders, function($v){ ($exists(requires.selections.region) ? $v.region = requires.selections.region : true) and ... })"
    }
  ],
  "view": {
    "elements": [{ "kind": "table", "data": { "bind": "computed_values.filtered" } }]
  },
  "card_data": {}
}
```

**Result File**: `runtime-out/cards/card-ex-table.computed.json`

## Runtime Directory Structure

After initialization:

```
runtime-out/
├── data-objects/              ← Token data files (shared token map)
│   ├── orders
│   ├── prices
│   ├── selections
│   └── card-ex-form
├── cards/                      ← Per-card computed artifacts
│   ├── card-demo-orders.computed.json
│   ├── card-ex-chart.computed.json
│   ├── card-ex-filter.computed.json
│   ├── card-ex-form.computed.json
│   ├── card-ex-list.computed.json
│   ├── card-ex-markdown.computed.json
│   ├── card-ex-metric.computed.json
│   ├── card-ex-narrative.computed.json
│   ├── card-ex-source-http.computed.json
│   ├── card-ex-source.computed.json
│   ├── card-ex-status.computed.json
│   ├── card-ex-table.computed.json
│   └── card-ex-todo.computed.json
└── board-livegraph-status.json  ← Overall board state
```

## Testing the System

### 1. Check Data Objects Persistence

```bash
# View token files
cat runtime-out/data-objects/orders | jq '.' | head -20
cat runtime-out/data-objects/selections | jq '.'
cat runtime-out/data-objects/prices | jq '.'
```

### 2. Check Computed Values Persistence

```bash
# View computed artifacts
cat runtime-out/cards/card-ex-metric.computed.json | jq '.computed_values'
cat runtime-out/cards/card-ex-chart.computed.json | jq '.computed_values'
```

### 3. Verify SSE Payload

Open browser console and inspect SSE messages:

```javascript
// In demo-shell-with-server.html console:
// Watch for SSE events showing dataObjectsByToken and cardRuntimeById
```

## Best Practices

### For Card Authors

1. **Keep `provides` bindings simple**
   - Export the final, evaluated result
   - Use meaningful token names
   - Avoid renaming upstream data

2. **Use `requires` consistently**
   - All upstream dependencies declared
   - Case-sensitive token names
   - Use in `compute` expressions with `requires.tokenName` prefix

3. **Structure `compute` expressions clearly**
   - One compute step per output
   - Meaningful `bindTo` names
   - JSONata expressions simple and testable

4. **Manage `card_data` intentionally**
   - User inputs via `writeTo`
   - Persistent across sessions
   - Separate from source/compute data

### For Runtime Administrators

1. **Monitor runtime-out/data-objects/**
   - Should match active card `provides` declarations
   - File timestamps show update frequency
   - Use for debugging token flow

2. **Validate computed artifacts**
   - Check `schema_version: "v1"`
   - Verify all cards have artifacts after init
   - Monitor file sizes for performance

3. **Use demo server for local development**
   - Run `node demo-server.js`
   - Open demo-shell-with-server.html
   - Real-time persistence visibility

## Troubleshooting

### Data objects not appearing in SSE

1. Check card has `provides` binding
2. Verify `runtime-out/data-objects/` exists and has files
3. Check `demo-server.js` is reading from correct path

### Computed values incorrect

1. Verify JSONata expressions are syntactically valid
2. Check upstream `requires` tokens are available
3. Review artifact file timestamps

### UI not showing data

1. Open browser console, check for binding errors
2. Inspect SSE payload in Network tab
3. Verify `runtime-artifacts-adapter.js` is loaded

## References

- [board-live-cards CLI Reference](../../docs/board-live-cards-cli.html)
- [Browser Runtime Reference](../../docs/browser-runtime-livecards-boards.html)
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
  "card_data": {}
}
```

### Valid Top-Level Properties

`id`, `requires`, `provides`, `meta`, `view`, `card_data`, `sources`, `compute` — **nothing else**.

**No `type` field.** No `data` wrapper.

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique card identifier |
| `view` | object | Must have `elements` array with at least 1 element |
| `card_data` | object | Card data - authored input state (can be empty `{}`) |

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

Ordered JSONata expressions evaluated against `{ card_data, requires, sources, computed_values }`:

```json
"compute": [
  { "bindTo": "total", "expr": "$sum(sources.raw.amount)" },
  { "bindTo": "avg",   "expr": "$round(computed_values.total / $count(sources.raw), 2)" }
]
```

Later steps reference earlier ones via `computed_values.*`.

### View Element Kinds

17 kinds: `metric`, `table`, `chart`, `form`, `filter`, `list`, `notes`, `todo`, `alert`, `narrative`, `badge`, `text`, `markdown`, `custom`, `file-upload`, `chat`, `actions`

Elements bind to `computed_values.*`, `sources.*`, or `card_data.*`:
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
| `card-ex-markdown` | Static notes | No sources/requires, `card_data.content` with markdown |
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
