# portfolio-tracker.py — E2E Example Plan

## Overview

A Python script (`portfolio-tracker.py`) that orchestrates the full T0–T5 lifecycle of the
portfolio board demo. It is a black-box CLI client: all board and card-store operations are
performed by shelling out to `board-live-cards-cli` and `card-store-cli`. No env vars. No
fallbacks or defaults.

A companion Node script (`portfolio-tracker-fetch-prices.js`) is registered as the board's task
executor. It handles `run-source-fetch` requests for source_defs with `kind: "mock-quotes"`,
generating random prices for whatever tickers are projected.

All runtime state lives in three directories under `os.tmpdir()/experiment/` created fresh
each run. Python may read from the `outputs` directory for assertions only — it never reads
from `cardstore` or `boardruntime`. All writes go through CLI calls.

---

## Files Created by This Work

| File | Location | Purpose |
|---|---|---|
| `portfolio-tracker.py` | `examples/browser/boards/portfolio-tracker/` | Main Python orchestrator |
| `portfolio-tracker-fetch-prices.js` | `examples/browser/boards/portfolio-tracker/` | Price-fetch task executor (Node) |

---

## Runtime Directories

Created under `os.tmpdir()/experiment/` at T0a:

| Name | Kind-Ref | Purpose |
|---|---|---|
| `cardstore` | `::fs-path::<abs>` | Card store (card-store-cli target) |
| `boardruntime` | `::fs-path::<abs>` | Board state (board-live-cards-cli `--base-ref`) |
| `outputs` | `::fs-path::<abs>` | Board outputs store (`--outputs-store-ref`) |

---

## portfolio-tracker-fetch-prices.js — Protocol

**CLI contract** (identical to `portfolio-tracker-task-executor.cjs`):
```
node portfolio-tracker-fetch-prices.js run-source-fetch \
  --in-ref <::kind::value> \
  --out-ref <::kind::value> \
  --err-ref <::kind::value>
```

**Imports from `yaml-flow/storage-refs`:** `parseRef`, `blobStorageForRef`, `reportComplete`, `reportFailed`

**Logic:**
1. Parse args: `run-source-fetch`, `--in-ref`, `--out-ref`, `--err-ref` — fail hard if any missing
2. Read input envelope from `inRef` via `blobStorageForRef` — fail hard if missing
3. Parse envelope: extract `callback` (if `source_def` key present) and `sourceDef`
4. Validate `sourceDef.kind === 'mock-quotes'` — fail hard if missing or different
5. Extract `sourceDef._projections.tickers` — fail hard if missing or not an array
6. Wait a random 200–300 ms (`await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 100))`)
7. Generate a random price (2 decimal places, range 210.00–399.99) for each ticker
8. Write resulting JSON object `{ "TICKER": price, ... }` (as a string) to `outRef`
9. Call `reportComplete(callback, outRef)` if callback present, else `process.exit(0)`
10. On any thrown error: write error message to `errRef`, call `reportFailed` if callback present, else `process.exit(1)`

**Output written to `outRef`:** JSON object string mapping each ticker to a random price, e.g. `{"AAPL":198.52,"MSFT":312.07}`.

---

## price-fetch Card — source_def

The `CARD_PRICE_FETCH` inline dict has `source_defs[0]` with:
- `kind`: `"mock-quotes"` — no `cli` field; the task executor dispatches on this kind
- `bindTo`: `"prices"`, `outputFile`: `"prices.json"`
- `projections.tickers`: `"requires.holdings.symbol"`

The board's task executor (`portfolio-tracker-fetch-prices.js`) is registered at init time
and handles `run-source-fetch` requests for any source_def with `kind: "mock-quotes"`.

---

## Python Helper: `set_holdings`

```python
def set_holdings(card_json: dict, holdings: dict[str, int]) -> dict:
    """
    Returns a new card dict with card_data.holdings replaced.

    Args:
        card_json:  the portfolio-form card loaded from JSON (not mutated)
        holdings:   { "SYMBOL": qty, ... }  e.g. {"AAPL": 50, "MSFT": 30}

    Returns:
        A new dict with card_data.holdings = [{"symbol": k, "qty": v}, ...]
        in the same order as the input dict.
    """
    import copy
    card = copy.deepcopy(card_json)
    card["card_data"]["holdings"] = [
        {"symbol": symbol, "qty": qty}
        for symbol, qty in holdings.items()
    ]
    return card
```

**Usage pattern** wherever holdings need to change:
```python
updated = set_holdings(CARD_PORTFOLIO_FORM, {"AAPL": 50, "MSFT": 30, "GOOG": 100})
run_card_store_set(cardstore_ref, updated)
run_board_upsert(boardruntime_ref, "portfolio-form", restart=True)
```

`CARD_PORTFOLIO_FORM` is the inline constant. It is never mutated — `set_holdings` always works
from a deep copy.

## Inline Card Definitions

All four cards are defined as Python dicts directly in `portfolio-tracker.py`.
No `cards/` directory is read at runtime.

```python
CARD_PORTFOLIO_FORM = {
    "id": "portfolio-form",
    "meta": {"title": "Portfolio Holdings Form"},
    "provides": [{"bindTo": "holdings", "ref": "card_data.holdings"}],
    "card_data": {"holdings": []},  # always set via set_holdings() before use
    "view": {
        "elements": [
            {"kind": "table", "label": "Holdings",
             "data": {"bind": "card_data.holdings", "columns": ["symbol", "qty"]}}
        ]
    }
}

CARD_PRICE_FETCH = {
    "id": "price-fetch",
    "meta": {"title": "Fetch Market Prices"},
    "requires": ["holdings"],
    "provides": [{"bindTo": "prices", "ref": "fetched_sources.prices"}],
    "card_data": {},
    "source_defs": [{
        "kind": "mock-quotes",
        "bindTo": "prices",
        "outputFile": "prices.json",
        "projections": {"tickers": "requires.holdings.symbol"}
    }],
    "view": {
        "elements": [
            {"kind": "table", "label": "Market Prices",
             "data": {"bind": "fetched_sources.prices"}}
        ]
    }
}

CARD_HOLDINGS_TABLE = {
    "id": "holdings-table",
    "meta": {"title": "Holdings Table"},
    "requires": ["holdings", "prices"],
    "provides": [{"bindTo": "table", "ref": "computed_values.table"}],
    "card_data": {},
    "compute": [{
        "bindTo": "table",
        "expr": "{ \"rows\": $map(requires.holdings, function($h) { { \"symbol\": $h.symbol, \"qty\": $h.qty, \"price\": $lookup(requires.prices, $h.symbol), \"value\": $h.qty * $lookup(requires.prices, $h.symbol) } }) }"
    }],
    "view": {
        "elements": [
            {"kind": "table", "label": "Portfolio Positions",
             "data": {"bind": "computed_values.table.rows", "columns": ["symbol", "qty", "price", "value"]}}
        ]
    }
}

CARD_PORTFOLIO_VALUE = {
    "id": "portfolio-value",
    "meta": {"title": "Portfolio Total Value"},
    "requires": ["table"],
    "provides": [{"bindTo": "totalValue", "ref": "computed_values.totalValue"}],
    "card_data": {},
    "compute": [
        {"bindTo": "totalValue", "expr": "$sum(requires.table.rows.value)"}
    ],
    "view": {
        "elements": [
            {"kind": "metric", "label": "Total Portfolio Value",
             "data": {"bind": "computed_values.totalValue"}}
        ]
    }
}
```

All four card dicts are fully defined constants — no mutation needed at startup.
The absolute path to `portfolio-tracker-fetch-prices.js` (resolved from `__file__`) is
only needed for the board init `task-executor-ref`, not for any card field.

---
 — Create runtime directories

Create the following three directories (fail hard if creation fails):
- `<tmpdir>/experiment/cardstore`
- `<tmpdir>/experiment/boardruntime`
- `<tmpdir>/experiment/outputs`

### T0b — Init board

Shell out to `board-live-cards-cli`:
```
board-live-cards-cli init \
  --base-ref ::fs-path::<boardruntime> \
  --card-store-ref ::fs-path::<cardstore> \
  --outputs-store-ref ::fs-path::<outputs>
```
With JSON body piped to stdin:
```json
{
  "task-executor-ref": {
    "meta": "task-executor",
    "howToRun": "local-node",
    "whatToRun": "::fs-path::<abs_path_to_portfolio-tracker-fetch-prices.js>"
  }
}
```

`portfolio-tracker-fetch-prices.js` is the board's task executor. It is invoked for every
`run-source-fetch` dispatch and handles `kind: "mock-quotes"` source_defs directly.

### T0c — Set all cards into card store

Pipe each of the four inline card dicts to `card-store-cli set --store-ref ::fs-path::<cardstore>`:
- `set_holdings(CARD_PORTFOLIO_FORM, {"AAPL": 50, "MSFT": 30})`
- `CARD_PRICE_FETCH` (static — `kind: "mock-quotes"` and `projections` already set)
- `CARD_HOLDINGS_TABLE`
- `CARD_PORTFOLIO_VALUE`

### T0d — Upsert cards to board

For each card id (`portfolio-form`, `price-fetch`, `holdings-table`, `portfolio-value`):
```
board-live-cards-cli upsert-card \
  --base-ref ::fs-path::<boardruntime> \
  --card-id <id>
```
No `--restart` flag on initial upsert.

---

### T1 — Wait for all cards completed

Poll `board-live-cards-cli status --base-ref ::fs-path::<boardruntime>` (JSON output) every 500 ms.
Required cards: `portfolio-form`, `price-fetch`, `holdings-table`, `portfolio-value`.
Timeout: 90 s. On timeout: print status and exit with error.

**Assertion (T1):** After all completed, read `<outputs>/data-objects/prices.json`
(the `prices` data object published from `CARD_PRICE_FETCH`'s `provides[0].bindTo`).
Assert it is a non-empty JSON object whose keys are exactly `["AAPL", "MSFT"]` and
all values are numbers.

---

### T2a — Update portfolio-form holdings (GOOG added)

Apply `set_holdings(portfolio_form_template, {"AAPL": 50, "MSFT": 30, "GOOG": 100})` and pipe to
`card-store-cli set --store-ref ::fs-path::<cardstore>`.

### T2b — Upsert portfolio-form with restart

```
board-live-cards-cli upsert-card --base-ref ::fs-path::<boardruntime> --card-id portfolio-form --restart
```

No price-fetch card update needed — the `projections.tickers` expression is re-evaluated on next dispatch.

### T2c — Wait for all cards completed

Same poll as T1.

**Assertion (T2c):** Read `<outputs>/data-objects/prices.json` — keys must now be exactly
`["AAPL", "MSFT", "GOOG"]` (3 tickers). Read `<outputs>/cards/holdings-table/computed_values.json`
— assert `table.rows` has 3 entries.

---

### T3 — Retrigger price-fetch, wait

1. `board-live-cards-cli retrigger --base-ref ::fs-path::<boardruntime> --id price-fetch`
2. Wait for all cards completed (same poll)

**Assertion (T3):** Read `<outputs>/data-objects/prices.json` — must still have 3 tickers;
prices will differ from T2c values (random regeneration).

---

### T4 — Rapid 5× portfolio-form updates (queue stress test)

For each version: apply `set_holdings`, pipe to `card-store-cli set`, then `upsert-card --restart`.
All three set+upsert pairs are issued back-to-back without waiting between them.

| Version | `set_holdings` call |
|---|---|
| V3 | `{"AAPL": 50, "MSFT": 30, "GOOG": 100, "AMZN": 40}` |
| V4 | `{"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 40, "TSLA": 60}` |
| V4a | `{"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 100}` |
| V4b | `{"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 140, "TSLA": 60}` |
| V5 | `{"AAPL": 40, "MSFT": 35, "GOOG": 120, "TSLA": 70}` |

No price-fetch card updates needed — tickers projection re-evaluates from holdings on each dispatch.

After all three are issued: wait for all cards completed (same poll).

**Assertion (T4):** Read `<outputs>/data-objects/prices.json` — keys must be exactly
`["AAPL", "MSFT", "GOOG", "TSLA"]` (board settled on the V5 tickers).
Assert `"AMZN"` is not present.

---

### T5 — Print final status and cross-check

1. **Wait for all cards completed** — same poll as T1.
   Only proceed once all four cards report `completed`.
2. Shell out to `board-live-cards-cli status --base-ref ::fs-path::<boardruntime>` with
   `capture_output=True`. Parse stdout as JSON — this is the live-computed status object.
3. Read `<outputs>/status.json` directly from disk and parse as JSON.
   (The board writes its status snapshot to the outputs store on every drain.)
4. **Assertion (T5 cross-check):** Assert
   `json.dumps(cli_status, sort_keys=True) == json.dumps(file_status, sort_keys=True)`
   i.e. the status returned by the CLI exactly matches the snapshot in the outputs dir.
5. Read `<outputs>/cards/holdings-table/computed_values.json` and print `computed_values["table"]`
   formatted (the final portfolio positions table).
6. **Assertion (T5 totals):** Cross-verify holdings × prices = totalValue:
   - Python already has the V5 holdings inline: `{"AAPL": 40, "MSFT": 35, "GOOG": 120, "TSLA": 70}`
   - Read `<outputs>/data-objects/prices.json` → prices dict
   - Read `<outputs>/cards/portfolio-value/computed_values.json` → `total_value = computed_values["totalValue"]`
   - Compute `expected = sum(qty * prices[symbol] for symbol, qty in V5_HOLDINGS.items())`
   - Assert `round(expected, 2) == round(total_value, 2)`
7. Print `cli_status` formatted.

---

## CLI Invocation Pattern (Python)

All CLI calls use `subprocess.run` with:
- `check=True` (fail hard on non-zero exit)
- `input=<json string>` for commands that require stdin body (init, card-store set)
- `capture_output=False` (inherit stdio) unless status output is needed
- `shell=False`
- No env manipulation

The `node` executable path and all script paths are resolved as absolute paths at the top of
`portfolio-tracker.py` using `__file__` and `os.path`.

---

## Constraints (Non-Negotiable)

- Assertions and cross-verifications are only performed after the preceding wait-for-completed
  poll has returned successfully — never while any card status is pending or running
- Zero environment variables set or read by `portfolio-tracker.py` or `portfolio-tracker-fetch-prices.js`
- No fallbacks, defaults, or optional paths anywhere
- Python may read from `<outputs>/` for assertions only
- Python never reads from `cardstore` or `boardruntime`
- All writes to runtime dirs go through CLI calls
- `portfolio-tracker-fetch-prices.js` generates random prices — it has no external price signal mechanism
