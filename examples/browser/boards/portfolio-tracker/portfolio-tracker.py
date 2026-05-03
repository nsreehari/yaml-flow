#!/usr/bin/env python3
"""portfolio-tracker.py — E2E orchestrator for the portfolio board demo.

Black-box CLI client. All board and card-store operations are performed by
shelling out to board-live-cards-cli and card-store-cli. No env vars. No
fallbacks or defaults.
"""

import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

# ── Path resolution ────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.normpath(os.path.join(_HERE, '..', '..', '..', '..'))

NODE = shutil.which('node')
if not NODE:
    print('[ERROR] node not found on PATH', file=sys.stderr)
    sys.exit(1)

BOARD_CLI       = os.path.join(_REPO_ROOT, 'board-live-cards-cli.js')
CARD_STORE_CLI  = os.path.join(_REPO_ROOT, 'card-store.js')
FETCH_PRICES_JS = os.path.join(_HERE, 'portfolio-tracker-fetch-prices.js')

# ── Runtime directories (under os.tmpdir()/experiment/) ───────────────────────
_TMP_BASE       = os.path.join(tempfile.gettempdir(), 'experiment')
CARDSTORE_DIR   = os.path.join(_TMP_BASE, 'cardstore')
BOARDRUNTIME_DIR = os.path.join(_TMP_BASE, 'boardruntime')
OUTPUTS_DIR     = os.path.join(_TMP_BASE, 'outputs')

CARDSTORE_REF    = f'::fs-path::{CARDSTORE_DIR}'
BOARDRUNTIME_REF = f'::fs-path::{BOARDRUNTIME_DIR}'
OUTPUTS_REF      = f'::fs-path::{OUTPUTS_DIR}'

# ── Inline card definitions ────────────────────────────────────────────────────
CARD_PORTFOLIO_FORM = {
    "id": "portfolio-form",
    "meta": {"title": "Portfolio Holdings Form"},
    "provides": [{"bindTo": "holdings", "ref": "card_data.holdings"}],
    "card_data": {"holdings": []},
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
        "expr": (
            '{ "rows": $map(requires.holdings, function($h) { '
            '{ "symbol": $h.symbol, "qty": $h.qty, '
            '"price": $lookup(requires.prices, $h.symbol), '
            '"value": $h.qty * $lookup(requires.prices, $h.symbol) } }) }'
        )
    }],
    "view": {
        "elements": [
            {"kind": "table", "label": "Portfolio Positions",
             "data": {"bind": "computed_values.table.rows",
                      "columns": ["symbol", "qty", "price", "value"]}}
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

# ── Helpers ────────────────────────────────────────────────────────────────────
def set_holdings(card_json: dict, holdings: dict) -> dict:
    card = copy.deepcopy(card_json)
    card["card_data"]["holdings"] = [
        {"symbol": symbol, "qty": qty}
        for symbol, qty in holdings.items()
    ]
    return card


def run_board(*args):
    subprocess.run([NODE, BOARD_CLI, *args], check=True, shell=False)


def run_board_with_input(*args, input_json: str):
    subprocess.run(
        [NODE, BOARD_CLI, *args],
        input=input_json, check=True, shell=False, text=True,
    )


def run_board_capture(*args) -> str:
    result = subprocess.run(
        [NODE, BOARD_CLI, *args],
        check=True, shell=False, capture_output=True, text=True,
    )
    return result.stdout


def run_card_store_set(card: dict):
    subprocess.run(
        [NODE, CARD_STORE_CLI, 'set', '--store-ref', CARDSTORE_REF],
        input=json.dumps(card), check=True, shell=False, text=True,
    )


def read_json(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def wait_for_completed(label: str, timeout_s: float = 90.0, poll_s: float = 0.5):
    required_names = {'portfolio-form', 'price-fetch', 'holdings-table', 'portfolio-value'}
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        raw = run_board_capture('status', '--base-ref', BOARDRUNTIME_REF)
        data = json.loads(raw).get('data', {})
        cards = data.get('cards', [])
        completed = {c['name'] for c in cards if c.get('status') == 'completed'}
        if required_names.issubset(completed):
            print(f'[{label}] all cards completed.')
            return
        time.sleep(poll_s)
    # timed out — print status and exit
    raw = run_board_capture('status', '--base-ref', BOARDRUNTIME_REF)
    print(f'[ERROR] {label}: timed out waiting for all cards to complete.', file=sys.stderr)
    print(raw, file=sys.stderr)
    sys.exit(1)


# ── T0a — Create runtime directories ──────────────────────────────────────────
print('\n=== T0a: Create runtime directories ===')
if os.path.exists(_TMP_BASE):
    shutil.rmtree(_TMP_BASE)
for d in (CARDSTORE_DIR, BOARDRUNTIME_DIR, OUTPUTS_DIR):
    os.makedirs(d)
    print(f'  created: {d}')

# ── T0b — Init board ───────────────────────────────────────────────────────────
print('\n=== T0b: Init board ===')
_task_executor_body = json.dumps({
    'task-executor-ref': {
        'meta': 'task-executor',
        'howToRun': 'local-node',
        'whatToRun': f'::fs-path::{FETCH_PRICES_JS}',
    }
})
run_board_with_input(
    'init',
    '--base-ref', BOARDRUNTIME_REF,
    '--card-store-ref', CARDSTORE_REF,
    '--outputs-store-ref', OUTPUTS_REF,
    input_json=_task_executor_body,
)

# ── T0c — Set all cards into card store ────────────────────────────────────────
print('\n=== T0c: Set all cards into card store ===')
run_card_store_set(set_holdings(CARD_PORTFOLIO_FORM, {"AAPL": 50, "MSFT": 30}))
run_card_store_set(CARD_PRICE_FETCH)
run_card_store_set(CARD_HOLDINGS_TABLE)
run_card_store_set(CARD_PORTFOLIO_VALUE)

# ── T0d — Upsert cards to board ────────────────────────────────────────────────
print('\n=== T0d: Upsert cards to board ===')
for _card_id in ('portfolio-form', 'price-fetch', 'holdings-table', 'portfolio-value'):
    run_board('upsert-card', '--base-ref', BOARDRUNTIME_REF, '--card-id', _card_id)

# ── T1 — Wait for all cards completed ──────────────────────────────────────────
print('\n=== T1: Wait for all cards completed ===')
wait_for_completed('T1')

_prices_path = os.path.join(OUTPUTS_DIR, 'data-objects', 'prices.json')
_prices_t1 = read_json(_prices_path)
assert isinstance(_prices_t1, dict) and len(_prices_t1) > 0, \
    'T1: prices.json is empty or not an object'
assert set(_prices_t1.keys()) == {'AAPL', 'MSFT'}, \
    f'T1: expected keys {{AAPL, MSFT}}, got {set(_prices_t1.keys())}'
assert all(isinstance(v, (int, float)) for v in _prices_t1.values()), \
    'T1: all price values must be numbers'
print('[T1] assertion passed: prices.json has AAPL, MSFT with numeric values.')

# ── T2a — Update holdings (GOOG added) ────────────────────────────────────────
print('\n=== T2a: Update holdings (GOOG added) ===')
run_card_store_set(set_holdings(CARD_PORTFOLIO_FORM, {"AAPL": 50, "MSFT": 30, "GOOG": 100}))

# ── T2b — Upsert portfolio-form with --restart ─────────────────────────────────
print('\n=== T2b: Upsert portfolio-form --restart ===')
run_board('upsert-card', '--base-ref', BOARDRUNTIME_REF,
          '--card-id', 'portfolio-form', '--restart')

# ── T2c — Wait and assert ──────────────────────────────────────────────────────
print('\n=== T2c: Wait for all cards completed ===')
wait_for_completed('T2c')

_prices_t2c = read_json(_prices_path)
assert set(_prices_t2c.keys()) == {'AAPL', 'MSFT', 'GOOG'}, \
    f'T2c: expected keys {{AAPL, MSFT, GOOG}}, got {set(_prices_t2c.keys())}'

_ht_cv_path = os.path.join(OUTPUTS_DIR, 'cards', 'holdings-table', 'computed_values.json')
_ht_cv_t2c = read_json(_ht_cv_path)
assert len(_ht_cv_t2c['table']['rows']) == 3, \
    f'T2c: expected 3 rows in holdings-table, got {len(_ht_cv_t2c["table"]["rows"])}'
print('[T2c] assertions passed: 3 tickers in prices, 3 rows in holdings-table.')

# ── T3 — Retrigger price-fetch, wait ──────────────────────────────────────────
print('\n=== T3: Retrigger price-fetch ===')
run_board('retrigger', '--base-ref', BOARDRUNTIME_REF, '--id', 'price-fetch')
wait_for_completed('T3')

_prices_t3 = read_json(_prices_path)
assert set(_prices_t3.keys()) == {'AAPL', 'MSFT', 'GOOG'}, \
    f'T3: expected 3 tickers, got {set(_prices_t3.keys())}'
assert _prices_t3 != _prices_t2c, \
    'T3: prices must differ from T2c values after retrigger (random regeneration)'
print('[T3] assertions passed: 3 tickers, prices differ from T2c.')

# ── T4 — Rapid 5× portfolio-form updates (queue stress test) ──────────────────
print('\n=== T4: Rapid 5x portfolio-form updates ===')
for _holdings in [
    {"AAPL": 50, "MSFT": 30, "GOOG": 100, "AMZN": 40},              # V3
    {"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 40, "TSLA": 60},  # V4
    {"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 100},              # V4a
    {"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 140, "TSLA": 60}, # V4b
    {"AAPL": 40, "MSFT": 35, "GOOG": 120, "TSLA": 70},               # V5
]:
    run_card_store_set(set_holdings(CARD_PORTFOLIO_FORM, _holdings))
    run_board('upsert-card', '--base-ref', BOARDRUNTIME_REF,
              '--card-id', 'portfolio-form', '--restart')

wait_for_completed('T4')

_prices_t4 = read_json(_prices_path)
assert set(_prices_t4.keys()) == {'AAPL', 'MSFT', 'GOOG', 'TSLA'}, \
    f'T4: expected keys {{AAPL, MSFT, GOOG, TSLA}}, got {set(_prices_t4.keys())}'
assert 'AMZN' not in _prices_t4, \
    'T4: AMZN must not be present (board must have settled on V5 holdings)'
print('[T4] assertions passed: V5 tickers only, AMZN absent.')

# ── T5 — Print final status and cross-check ────────────────────────────────────
print('\n=== T5: Print final status and cross-check ===')

# Step 1: Wait for all cards completed (stable state before any assertions)
wait_for_completed('T5')

# Step 2: Capture live CLI status
_cli_raw = run_board_capture('status', '--base-ref', BOARDRUNTIME_REF)
_cli_status = json.loads(_cli_raw)['data']

# Step 3: Read status.json from outputs store
_file_status = read_json(os.path.join(OUTPUTS_DIR, 'status.json'))

# Step 4: Cross-check CLI vs file status
assert json.dumps(_cli_status, sort_keys=True) == json.dumps(_file_status, sort_keys=True), \
    'T5: CLI status does not match status.json snapshot'
print('[T5] cross-check passed: CLI status matches status.json.')

# Step 5: Print holdings-table computed values
_ht_cv = read_json(_ht_cv_path)
print('\nFinal portfolio positions table:')
print(json.dumps(_ht_cv['table'], indent=2))

# Step 6: Totals cross-verify: holdings × prices == totalValue
V5_HOLDINGS = {"AAPL": 40, "MSFT": 35, "GOOG": 120, "TSLA": 70}
_prices_final = read_json(_prices_path)
_pv_cv = read_json(
    os.path.join(OUTPUTS_DIR, 'cards', 'portfolio-value', 'computed_values.json')
)
_total_value = _pv_cv['totalValue']
_expected = sum(qty * _prices_final[sym] for sym, qty in V5_HOLDINGS.items())
assert round(_expected, 2) == round(_total_value, 2), \
    f'T5: totals mismatch: expected={round(_expected, 2)}, got={round(_total_value, 2)}'
print(f'[T5] totals assertion passed: expected={round(_expected, 2)}, totalValue={round(_total_value, 2)}')

# Step 7: Print full CLI status
print('\nFinal board status:')
print(json.dumps(_cli_status, indent=2))

print('\n=== portfolio-tracker completed successfully ===')
