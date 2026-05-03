#!/usr/bin/env node
/**
 * portfolio-tracker-public.js
 *
 * Identical E2E logic to portfolio-tracker.py, implemented directly against
 * the yaml-flow public Node.js libraries — no CLI subprocess spawning.
 *
 * Imports:
 *   yaml-flow/board-live-cards-node  — createBoardLiveCardsPublic,
 *                                      createFsBoardPlatformAdapter,
 *                                      createCardStorePublic,
 *                                      createCardStore, parseRef, serializeRef
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

// ── Library imports ────────────────────────────────────────────────────────────
const _adapterPath = path.join(_REPO_ROOT, 'dist', 'cli', 'node', 'fs-board-adapter.js');
const {
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  createCardStorePublic,
  createCardStore,
  parseRef,
} = await import(pathToFileURL(_adapterPath).href);

const FETCH_PRICES_JS = path.join(__dirname, 'portfolio-tracker-fetch-prices.js');

// ── Runtime directories ────────────────────────────────────────────────────────
const _TMP_BASE       = path.join(os.tmpdir(), 'experiment-js');
const CARDSTORE_DIR   = path.join(_TMP_BASE, 'cardstore');
const BOARDRUNTIME_DIR = path.join(_TMP_BASE, 'boardruntime');
const OUTPUTS_DIR     = path.join(_TMP_BASE, 'outputs');

const CARDSTORE_REF    = `::fs-path::${CARDSTORE_DIR}`;
const BOARDRUNTIME_REF = `::fs-path::${BOARDRUNTIME_DIR}`;
const OUTPUTS_REF      = `::fs-path::${OUTPUTS_DIR}`;

// ── Card definitions ───────────────────────────────────────────────────────────
const CARD_PORTFOLIO_FORM = {
  id: 'portfolio-form',
  meta: { title: 'Portfolio Holdings Form' },
  provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
  card_data: { holdings: [] },
  view: {
    elements: [
      { kind: 'table', label: 'Holdings',
        data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } }
    ]
  }
};

const CARD_PRICE_FETCH = {
  id: 'price-fetch',
  meta: { title: 'Fetch Market Prices' },
  requires: ['holdings'],
  provides: [{ bindTo: 'prices', ref: 'fetched_sources.prices' }],
  card_data: {},
  source_defs: [{
    kind: 'mock-quotes',
    bindTo: 'prices',
    outputFile: 'prices.json',
    projections: { tickers: '$append([], requires.holdings.symbol)' }
  }],
  view: {
    elements: [
      { kind: 'table', label: 'Market Prices',
        data: { bind: 'fetched_sources.prices' } }
    ]
  }
};

const CARD_HOLDINGS_TABLE = {
  id: 'holdings-table',
  meta: { title: 'Holdings Table' },
  requires: ['holdings', 'prices'],
  provides: [{ bindTo: 'table', ref: 'computed_values.table' }],
  card_data: {},
  compute: [{
    bindTo: 'table',
    expr: '{ "rows": $map(requires.holdings, function($h) { { "symbol": $h.symbol, "qty": $h.qty, "price": $lookup(requires.prices, $h.symbol), "value": $h.qty * $lookup(requires.prices, $h.symbol) } }) }'
  }],
  view: {
    elements: [
      { kind: 'table', label: 'Portfolio Positions',
        data: { bind: 'computed_values.table.rows', columns: ['symbol', 'qty', 'price', 'value'] } }
    ]
  }
};

const CARD_PORTFOLIO_VALUE = {
  id: 'portfolio-value',
  meta: { title: 'Portfolio Total Value' },
  requires: ['table'],
  provides: [{ bindTo: 'totalValue', ref: 'computed_values.totalValue' }],
  card_data: {},
  compute: [
    { bindTo: 'totalValue', expr: '$sum(requires.table.rows.value)' }
  ],
  view: {
    elements: [
      { kind: 'metric', label: 'Total Portfolio Value',
        data: { bind: 'computed_values.totalValue' } }
    ]
  }
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function setHoldings(card, holdings) {
  return {
    ...card,
    card_data: {
      ...card.card_data,
      holdings: Object.entries(holdings).map(([symbol, qty]) => ({ symbol, qty })),
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`[ASSERT FAILED] ${message}`);
    process.exit(1);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function makeBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, _REPO_ROOT, { onWarn: console.warn }));
}

function makeNonCoreBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, _REPO_ROOT, { onWarn: console.warn }));
}

function makeCardStore() {
  const ref = parseRef(CARDSTORE_REF);
  const adapter = createFsBoardPlatformAdapter(ref, _REPO_ROOT, { onWarn: console.warn });
  const kv = adapter.kvStorageForRef(CARDSTORE_REF);
  const cardAdapterObj = {
    readIndex: () => kv.read('_index'),
    writeIndex: (idx) => kv.write('_index', idx),
    readCard: (id) => kv.read(id),
    writeCard: (id, card) => { kv.write(id, card); return id; },
    cardExists: (id) => kv.read(id) !== null,
    defaultCardKey: (id) => id,
  };
  return createCardStorePublic(createCardStore(cardAdapterObj, console.warn));
}

function checkResult(result, label) {
  if (result.status !== 'success') {
    console.error(`[ERROR] ${label}: ${result.status} — ${result.error}`);
    process.exit(1);
  }
  return result.data;
}

async function waitForCompleted(label, timeoutMs = 90_000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const result = makeBoard().status({});
    pollCount++;
    if (result.status === 'success') {
      const { card_count, completed, in_progress, pending, failed } = result.data.summary;
      if (card_count > 0 && completed === card_count) {
        console.log(`[${label}] all ${card_count} card(s) completed.`);
        return result.data;
      }
      if (pollCount % 4 === 0) {
        const notDone = result.data.cards.filter(c => c.status !== 'completed').map(c => `${c.name}:${c.status}`);
        console.log(`[${label}] poll#${pollCount} summary: ${card_count} cards, completed=${completed}, in_progress=${in_progress}, pending=${pending}, failed=${failed} | stuck: ${notDone.join(', ')}`);
      }
    }
  }
  console.error(`[ERROR] ${label}: timed out waiting for all cards to complete.`);
  process.exit(1);
}

// ── T0a — Create runtime directories ──────────────────────────────────────────
console.log('\n=== T0a: Create runtime directories ===');
if (fs.existsSync(_TMP_BASE)) {
  fs.rmSync(_TMP_BASE, { recursive: true, force: true });
  console.log(`  cleaned: ${_TMP_BASE} (including .tmp, .card-runtime, journal)`);
}
for (const d of [CARDSTORE_DIR, BOARDRUNTIME_DIR, OUTPUTS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
  console.log(`  created: ${d}`);
}

// ── T0b — Init board ───────────────────────────────────────────────────────────
console.log('\n=== T0b: Init board ===');
checkResult(
  makeBoard().init({
    params: { cardStoreRef: CARDSTORE_REF, outputsStoreRef: OUTPUTS_REF },
    body: {
      'task-executor-ref': {
        meta: 'task-executor',
        howToRun: 'local-node',
        whatToRun: `::fs-path::${FETCH_PRICES_JS}`,
      },
    },
  }),
  'init'
);
console.log(JSON.stringify({ status: 'success' }, null, 2));

// ── T0c — Validate and set all cards into card store ─────────────────────────
console.log('\n=== T0c: Validate and set all cards into card store ===');
const cardStore = makeCardStore();
for (const card of [
  setHoldings(CARD_PORTFOLIO_FORM, { NVDA: 100 }),
  CARD_PRICE_FETCH,
  CARD_HOLDINGS_TABLE,
  CARD_PORTFOLIO_VALUE,
]) {
  const vr = makeNonCoreBoard().validateTmpCard({ body: card });
  if (!vr.data?.isValid) {
    console.error(`[VALIDATE FAILED] card ${card.id}:`, JSON.stringify(vr.data?.issues ?? vr.error));
    process.exit(1);
  }
  console.log(`  [validate] ${card.id}: ok`);
  const r = checkResult(cardStore.set({ body: card }), `card-store set ${card.id}`);
  console.error(`card-store set: wrote ${r.count} card(s)`);
}

// ── T0d — Upsert cards to board ────────────────────────────────────────────────
console.log('\n=== T0d: Upsert cards to board ===');
for (const cardId of ['portfolio-form', 'price-fetch', 'holdings-table', 'portfolio-value']) {
  checkResult(makeBoard().upsertCard({ params: { cardId } }), `upsertCard ${cardId}`);
  console.log(JSON.stringify({ status: 'success' }, null, 2));
}

// ── T1 — Wait for all cards completed ──────────────────────────────────────────
console.log('\n=== T1: Wait for all cards completed ===');
await waitForCompleted('T1');

const pricesPath = path.join(OUTPUTS_DIR, 'data-objects', 'prices.json');
const htCvPath = path.join(OUTPUTS_DIR, 'cards', 'holdings-table', 'computed_values.json');
const pricesT1 = fs.existsSync(pricesPath) ? readJson(pricesPath) : null;
assert(typeof pricesT1 === 'object' && pricesT1 !== null && Object.keys(pricesT1).length > 0,
  'T1: prices.json is empty or not an object');
assert(JSON.stringify(Object.keys(pricesT1).sort()) === JSON.stringify(['NVDA']),
  `T1: expected keys {NVDA}, got ${JSON.stringify(Object.keys(pricesT1))}`);
assert(Object.values(pricesT1).every(v => typeof v === 'number'),
  'T1: all price values must be numbers');
const htCvT1 = readJson(htCvPath);
const rowsBySymbolT1 = Object.fromEntries([].concat(htCvT1.table.rows).map(r => [r.symbol, r.qty]));
assert(rowsBySymbolT1['NVDA'] === 100,
  `T1: expected NVDA qty=100, got ${rowsBySymbolT1['NVDA']}`);
console.log('[T1] assertion passed: prices.json has NVDA with numeric values, NVDA qty=100.');

// ── T2a — Update holdings (GOOG added) ────────────────────────────────────────
console.log('\n=== T2a: Update holdings (GOOG added) ===');
checkResult(
  makeCardStore().set({ body: setHoldings(CARD_PORTFOLIO_FORM, { NVDA: 50,  GOOG: 100 }) }),
  'card-store set portfolio-form'
);
console.error('card-store set: wrote 1 card(s)');

// ── T2b — Upsert portfolio-form with restart ───────────────────────────────────
console.log('\n=== T2b: Upsert portfolio-form --restart ===');
checkResult(
  makeBoard().upsertCard({ params: { cardId: 'portfolio-form', restart: 'true' } }),
  'upsertCard portfolio-form restart'
);
console.log(JSON.stringify({ status: 'success' }, null, 2));

// ── T2c — Wait and assert ──────────────────────────────────────────────────────
console.log('\n=== T2c: Wait for all cards completed ===');
await waitForCompleted('T2c');

const pricesT2c = readJson(pricesPath);
assert(JSON.stringify(Object.keys(pricesT2c).sort()) === JSON.stringify(['GOOG', 'NVDA']),
  `T2c: expected keys {GOOG, NVDA}, got ${JSON.stringify(Object.keys(pricesT2c))}`);

const htCvT2c = readJson(htCvPath);
assert(htCvT2c.table.rows.length === 2,
  `T2c: expected 2 rows in holdings-table, got ${htCvT2c.table.rows.length}`);
const rowsBySymbolT2c = Object.fromEntries([].concat(htCvT2c.table.rows).map(r => [r.symbol, r.qty]));
assert(rowsBySymbolT2c['NVDA'] === 50,
  `T2c: expected NVDA qty=50, got ${rowsBySymbolT2c['NVDA']}`);
assert(rowsBySymbolT2c['GOOG'] === 100,
  `T2c: expected GOOG qty=100, got ${rowsBySymbolT2c['GOOG']}`);
console.log('[T2c] assertions passed: 2 tickers in prices, 2 rows in holdings-table, NVDA qty=50, GOOG qty=100.');

// ── T3 — Retrigger price-fetch ─────────────────────────────────────────────────
console.log('\n=== T3: Retrigger price-fetch ===');
checkResult(makeBoard().retrigger({ params: { id: 'price-fetch' } }), 'retrigger price-fetch');
console.log(JSON.stringify({ status: 'success' }, null, 2));
await waitForCompleted('T3');

const pricesT3 = readJson(pricesPath);
assert(JSON.stringify(Object.keys(pricesT3).sort()) === JSON.stringify(['GOOG', 'NVDA']),
  `T3: expected keys {GOOG, NVDA}, got ${JSON.stringify(Object.keys(pricesT3))}`);
assert(JSON.stringify(pricesT3) !== JSON.stringify(pricesT2c),
  'T3: prices must differ from T2c values after retrigger');
const htCvT3 = readJson(htCvPath);
const rowsBySymbolT3 = Object.fromEntries([].concat(htCvT3.table.rows).map(r => [r.symbol, r.qty]));
assert(rowsBySymbolT3['NVDA'] === 50,
  `T3: expected NVDA qty=50, got ${rowsBySymbolT3['NVDA']}`);
assert(rowsBySymbolT3['GOOG'] === 100,
  `T3: expected GOOG qty=100, got ${rowsBySymbolT3['GOOG']}`);
const pvCvT3 = readJson(path.join(OUTPUTS_DIR, 'cards', 'portfolio-value', 'computed_values.json'));
const pvRowsT3 = Object.fromEntries([].concat(htCvT3.table.rows).map(r => [r.symbol, { qty: r.qty, price: r.price }]));
const expectedTotalT3 = Math.round(
  (pvRowsT3['NVDA'].qty * pvRowsT3['NVDA'].price + pvRowsT3['GOOG'].qty * pvRowsT3['GOOG'].price) * 100
) / 100;
assert(Math.round(pvCvT3.totalValue * 100) === Math.round(expectedTotalT3 * 100),
  `T3: expected totalValue=${expectedTotalT3}, got ${pvCvT3.totalValue}`);
console.log(`[T3] assertions passed: 2 tickers, prices differ from T2c, NVDA qty=50, GOOG qty=100, totalValue=${pvCvT3.totalValue}.`);

// ── T4 — Rapid 5× portfolio-form updates ──────────────────────────────────────
// console.log('\n=== T4: Rapid 5x portfolio-form updates ===');
// for (const holdings of [
//   { AAPL: 50 },
//   { AAPL: 45, MSFT: 30, },
//   { AAPL: 45, MSFT: 30, GOOG: 110, },
//   { AAPL: 40, MSFT: 35, GOOG: 120, TSLA: 70 },
//   { AAPL: 45, MSFT: 30, GOOG: 110, AMZN: 140, TSLA: 60 },
// ]) {
//   checkResult(makeCardStore().set({ body: setHoldings(CARD_PORTFOLIO_FORM, holdings) }),
//     'card-store set portfolio-form');
//   console.error('card-store set: wrote 1 card(s)');
//   checkResult(makeBoard().upsertCard({ params: { cardId: 'portfolio-form', restart: 'true' } }),
//     'upsertCard portfolio-form restart');
//   console.log(JSON.stringify({ status: 'success' }, null, 2));
//   await new Promise(r => setTimeout(r, 2000));
// }

// await waitForCompleted('T4');

// const pricesT4 = readJson(pricesPath);
// const t4Keys = Object.keys(pricesT4).sort();
// assert(JSON.stringify(t4Keys) === JSON.stringify(['AAPL', 'GOOG', 'MSFT', 'TSLA']),
//   `T4: expected keys {AAPL, MSFT, GOOG, TSLA}, got ${JSON.stringify(t4Keys)}`);
// assert(!('AMZN' in pricesT4), 'T4: AMZN must not be present');
// console.log('[T4] assertions passed: V5 tickers only, AMZN absent.');

// // ── T5 — Final status and cross-check ─────────────────────────────────────────
// console.log('\n=== T5: Print final status and cross-check ===');
// const finalStatusData = await waitForCompleted('T5');

// const fileStatus = readJson(path.join(OUTPUTS_DIR, 'status.json'));
// assert(JSON.stringify(finalStatusData, Object.keys(finalStatusData).sort()) ===
//        JSON.stringify(fileStatus, Object.keys(fileStatus).sort()),
//   'T5: board status does not match status.json snapshot');
// console.log('[T5] cross-check passed: CLI status matches status.json.');

// const htCvFinal = readJson(htCvPath);
// console.log('\nFinal portfolio positions table:');
// console.log(JSON.stringify(htCvFinal.table, null, 2));

// const V5_HOLDINGS = { AAPL: 40, MSFT: 35, GOOG: 120, TSLA: 70 };
// const pricesFinal = readJson(pricesPath);
// const pvCv = readJson(path.join(OUTPUTS_DIR, 'cards', 'portfolio-value', 'computed_values.json'));
// const totalValue = pvCv.totalValue;
// const expected = Object.entries(V5_HOLDINGS).reduce((s, [sym, qty]) => s + qty * pricesFinal[sym], 0);
// assert(Math.round(expected * 100) === Math.round(totalValue * 100),
//   `T5: totals mismatch: expected=${Math.round(expected * 100) / 100}, got=${totalValue}`);
// console.log(`[T5] totals assertion passed: expected=${Math.round(expected * 100) / 100}, totalValue=${totalValue}`);

console.log('\nFinal board status:');
const finalStatusData = makeBoard().status({}).data;
console.log(JSON.stringify(finalStatusData, null, 2));

console.log('\n=== portfolio-tracker-public completed successfully ===');
console.log('\n--- Runtime directories ---');
console.log('  cardstore:    ', CARDSTORE_DIR);
console.log('  boardruntime: ', BOARDRUNTIME_DIR);
console.log('  outputs:      ', OUTPUTS_DIR);
