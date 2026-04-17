# Live Cards — Design

## Card Schema

Every card is a unified entity. No `type` field — behavior is determined by which sections are present.

```json
{
  "id": "portfolio",
  "requires": ["quotes", "holdings"],
  "provides": [{ "bindTo": "portfolio_value", "src": "computed_values.portfolio_value" }],
  "state": { "portfolio_value": 0 },
  "sources": [
    { "script": "fetch-holdings.sh", "bindTo": "holdings" }
  ],
  "optionalSources": [
    { "script": "fetch-news.sh", "bindTo": "news" }
  ],
  "compute": [
    { "bindTo": "total", "expr": "$sum(state.holdings.values)" },
    { "bindTo": "portfolio_value", "expr": "computed_values.total" }
  ]
}
```

## Sections

| Section | Purpose | Write target | Required |
|---------|---------|-------------|----------|
| `id` | Unique card identifier | — | yes |
| `state` | Seed values + source mutations. User-authored initial data. | disk (only sources mutate at runtime) | no |
| `requires` | Upstream tokens this card depends on. Read-only namespace at runtime. | — | no |
| `provides` | Keys to pluck from state/requires/computed for downstream. | — | no (defaults to `[id]`) |
| `sources` | Async fetches that MUST complete before task-completed. Each has `bindTo` targeting a `state` key. | `state[bindTo]` on disk | no |
| `optionalSources` | Same as sources but don't gate completion. Arrive later → card re-fires. | `state[bindTo]` on disk | no |
| `compute` | Ordered array of pure derivations. Reads `state.*` and `requires.*`. Writes to ephemeral computed_values via `bindTo`. | in-memory only (NOT persisted) | no |

## Two Read Namespaces

- **`requires.*`** — read-only, injected from upstream `task-completed.data`. Immutable within this card's lifecycle.
- **`state.*`** — card's persistent state on disk. Readable by compute. Only mutated by sources/optionalSources at runtime.

Compute expressions reference either `requires.X` or `state.X`. This prevents self-referential loops (e.g. `bindTo: "x", input: "state.x"` reads the seed value, not its own output).

## Compute

- **Ordered array** (not a map). Runs top-to-bottom, once per handler invocation.
- Each step: `{ bindTo: string, expr: string }` where `expr` is a [JSONata](https://jsonata.org) expression.
- Evaluated against `{ state, requires, computed_values }` — all three namespaces are accessible.
- Reads from `state.*`, `requires.*`, and earlier compute outputs in `computed_values.*`
- Writes to ephemeral `computed_values[bindTo]` — never persisted to disk.
- `computed_values` is discarded after provides are plucked.
- `CardCompute.run()` is **async** (returns `Promise<node>`). `CardCompute.resolve()` remains sync.

### JSONata expression examples

```json
{ "bindTo": "total",    "expr": "$sum(state.data.revenue)" }
{ "bindTo": "avg",      "expr": "$round($average(state.data.revenue), 0)" }
{ "bindTo": "label",   "expr": "\"Total: \" & $string(computed_values.total)" }
{ "bindTo": "topRows", "expr": "state.rows[value > 100]" }
{ "bindTo": "fromReq", "expr": "$sum(requires.upstream.prices)" }
```

Expressions have full JSONata power: path navigation, array operators (`$sum`, `$average`, `$count`, `$min`, `$max`), `$filter`, `$map`, `$string`, `$round`, predicates, conditionals, etc.

### Browser usage

JSONata must be loaded before `card-compute.js`:

```html
<script src="https://cdn.jsdelivr.net/npm/jsonata/jsonata.min.js"></script>
<script src="browser/card-compute.js"></script>
```

### Why no disk persistence for computed_values

- Downstream cards receive values through `provides` → `task-completed.data` → stored in graph state (`board-graph.json`).
- On re-fire, everything is rebuilt from scratch: read `state` from disk, inject `requires`, run compute.
- Nothing ever needs to read previous computed_values from disk.

## Handler Lifecycle

```
1. Card becomes eligible (all requires tokens satisfied upstream)
2. Read card.state from disk
3. Inject requires data (read-only, from upstream task-completed.data)
4. Run compute array top-to-bottom → ephemeral computed_values
5. Check: all sources[].bindTo keys present in state?
   YES → Build provides data (pluck from state + requires + computed_values)
         Emit task-completed with provides data
         Spawn undelivered optionalSources in background
   NO  → Spawn undelivered sources
         Return task-initiated (card stays in-progress)
6. Source delivers → writes state[bindTo] on disk → emits data-received → card re-fires from step 1
7. OptionalSource delivers → same as source → card re-fires → re-completes with richer data
```

## Provides Resolution

`provides` is `ProvidesBinding[]` where each entry is `{ bindTo: string, src: string }`.
`src` is an explicit path in one of the card's data namespaces: `state.*`, `requires.*`, or `computed_values.*`.
The value at `src` is resolved and emitted under the `bindTo` token name.

## Events

| Event | Who emits | What it does |
|-------|-----------|-------------|
| `task-completed` | card-handler | Sets task status=completed, stores provides data. Unblocks downstream. |
| `data-received` | source/optionalSource subprocess | Alias for task-restart. Resets card to not-started so it re-fires with new state. |
| `task-restart` | CLI retrigger | Same as data-received. Manual re-fire. |
| `task-failed` | handler/subprocess on error | Sets task status=failed. |

## Infinite Loop Prevention

1. Compute runs exactly once per handler invocation — no iterative convergence.
2. A card only re-fires on external events: upstream requires change, data-received from source, or manual retrigger.
3. Compute output does NOT trigger re-fire — it's ephemeral, not written to state.
4. The two-namespace separation (requires vs state) prevents self-referential loops — `state.x` in an expr reads the persisted seed, not the compute output.

## Disk Layout

```
card.json (on disk):
  id, requires, provides, state, sources, optionalSources, compute, meta

board-graph.json:
  Task statuses, provides data (from task-completed events)

board-journal.jsonl:
  Append-only event log
```

Sources are the **only** runtime writer to card.json's `state`. Compute is pure projection.
