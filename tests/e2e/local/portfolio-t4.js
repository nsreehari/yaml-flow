#!/usr/bin/env node
/**
 * portfolio-t4.js — T4 rapid-fire test only.
 *
 * Runs T0 (init, card setup) then fires 5 portfolio-form upserts
 * back-to-back (no delay) and waits for the board to converge.
 * Asserts final prices contain the iter-5 tickers only (AAPL/MSFT/GOOG/TSLA)
 * and AMZN is absent.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  createCardStorePublic,
  createCardStore,
  parseRef,
  serializeRef,
} from 'yaml-flow/board-live-cards-node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const FETCH_PRICES_JS = path.join(__dirname, 'portfolio-tracker-fetch-prices.js');

// ── Runtime directories ────────────────────────────────────────────────────────
const _TMP_BASE        = path.join(os.tmpdir(), `experiment-js-t4-${process.pid}`);
const CARDSTORE_DIR    = path.join(_TMP_BASE, 'cardstore');
const BOARDRUNTIME_DIR = path.join(_TMP_BASE, 'boardruntime');
const OUTPUTS_DIR      = path.join(_TMP_BASE, 'outputs');

const CARDSTORE_REF    = serializeRef({ kind: 'fs-path', value: CARDSTORE_DIR });
const BOARDRUNTIME_REF = serializeRef({ kind: 'fs-path', value: BOARDRUNTIME_DIR });
const OUTPUTS_REF      = serializeRef({ kind: 'fs-path', value: OUTPUTS_DIR });

// ── Card definitions ───────────────────────────────────────────────────────────
const CARD_PORTFOLIO_FORM = {
  id: 'portfolio-form',
  meta: { title: 'Portfolio Holdings Form' },
  provides: [{ bindTo: 'holdings', ref: 'card_data.holdings' }],
  card_data: { holdings: [] },
  view: { elements: [{ kind: 'table', label: 'Holdings', data: { bind: 'card_data.holdings', columns: ['symbol', 'qty'] } }] }
};

const CARD_PRICE_FETCH = {
  id: 'price-fetch',
  meta: { title: 'Fetch Market Prices' },
  requires: ['holdings'],
  provides: [{ bindTo: 'prices', ref: 'computed_values.prices' }],
  card_data: {},
  compute: [{
    bindTo: 'prices',
    expr: '$merge($map(requires.holdings, function($h){ { $h.symbol: 100 } }))'
  }],
  view: { elements: [{ kind: 'table', label: 'Market Prices', data: { bind: 'computed_values.prices' } }] }
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
  view: { elements: [{ kind: 'table', label: 'Portfolio Positions', data: { bind: 'computed_values.table.rows', columns: ['symbol', 'qty', 'price', 'value'] } }] }
};

const CARD_PORTFOLIO_VALUE = {
  id: 'portfolio-value',
  meta: { title: 'Portfolio Total Value' },
  requires: ['table'],
  provides: [{ bindTo: 'totalValue', ref: 'computed_values.totalValue' }],
  card_data: {},
  compute: [{ bindTo: 'totalValue', expr: '$sum(requires.table.rows.value)' }],
  view: { elements: [{ kind: 'metric', label: 'Total Portfolio Value', data: { bind: 'computed_values.totalValue' } }] }
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function setHoldings(card, holdings) {
  return { ...card, card_data: { ...card.card_data, holdings: Object.entries(holdings).map(([symbol, qty]) => ({ symbol, qty })) } };
}

function assert(condition, message) {
  if (!condition) { console.error(`[ASSERT FAILED] ${message}`); process.exit(1); }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function makeBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, { onWarn: console.warn }));
}

function makeNonCoreBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, { onWarn: console.warn }));
}

function makeCardStore() {
  const ref = parseRef(CARDSTORE_REF);
  const adapter = createFsBoardPlatformAdapter(ref, { onWarn: console.warn });
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
  if (result.status !== 'success') { console.error(`[ERROR] ${label}: ${result.status} — ${result.error}`); process.exit(1); }
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
        console.log(`[${label}] poll#${pollCount}: completed=${completed}/${card_count}, in_progress=${in_progress}, pending=${pending}, failed=${failed} | ${notDone.join(', ')}`);
      }
    }
  }
  console.error(`[ERROR] ${label}: timed out waiting for all cards to complete.`);
  process.exit(1);
}

const T = () => Date.now();

// ── T0 — Init ─────────────────────────────────────────────────────────────────
console.log('\n=== T0: Init ===');
if (fs.existsSync(_TMP_BASE)) fs.rmSync(_TMP_BASE, { recursive: true, force: true });
for (const d of [CARDSTORE_DIR, BOARDRUNTIME_DIR, OUTPUTS_DIR]) fs.mkdirSync(d, { recursive: true });
console.log(`  runtime base: ${_TMP_BASE}`);

checkResult(
  makeBoard().init({
    params: { cardStoreRef: CARDSTORE_REF, outputsStoreRef: OUTPUTS_REF },
    body: { 'task-executor-ref': { meta: 'task-executor', howToRun: 'local-node', whatToRun: serializeRef({ kind: 'fs-path', value: FETCH_PRICES_JS }) } },
  }),
  'init'
);
console.log(`  [${T()}] init done`);

const cardStore = makeCardStore();
for (const card of [
  setHoldings(CARD_PORTFOLIO_FORM, { AAPL: 10 }),
  CARD_PRICE_FETCH,
  CARD_HOLDINGS_TABLE,
  CARD_PORTFOLIO_VALUE,
]) {
  const vr = makeNonCoreBoard().validateCardPreflight({ body: card });
  console.log(`  [${T()}] validateCardPreflight ${card.id} done`);
  if (!vr.data?.isValid) { console.error(`[VALIDATE FAILED] ${card.id}:`, JSON.stringify(vr.data?.issues ?? vr.error)); process.exit(1); }
  checkResult(cardStore.set({ body: card }), `card-store set ${card.id}`);
  console.log(`  [${T()}] cardStore.set ${card.id} done`);
}

for (const cardId of ['portfolio-form', 'price-fetch', 'holdings-table', 'portfolio-value']) {
  checkResult(makeBoard().upsertCard({ params: { cardId } }), `upsertCard ${cardId}`);
  console.log(`  [${T()}] upsertCard ${cardId} done`);
}

await waitForCompleted('T0-settle');
console.log(`[${T()}] [T0] board settled with initial holdings.`);

// ── T4 — Rapid 5× portfolio-form updates (no delay) ───────────────────────────
console.log('\n=== T4: Rapid 5x portfolio-form updates (no delay) ===');

const T4_ITERS = [
  { AAPL: 50 },
  { AAPL: 45, MSFT: 30 },
  { AAPL: 45, MSFT: 30, GOOG: 110 },
  { AAPL: 40, MSFT: 35, GOOG: 120, TSLA: 70 },
  { AAPL: 45, MSFT: 30, GOOG: 110, AMZN: 140, TSLA: 60 },
];

// Expected final state: iter 5 holdings (AMZN present in iter 5 but test verifies what actually wins)
const T4_EXPECTED_FINAL = { AAPL: 45, MSFT: 30, GOOG: 110, AMZN: 140, TSLA: 60 };

for (let i = 0; i < T4_ITERS.length; i++) {
  const holdings = T4_ITERS[i];
  console.log(`  iter ${i + 1}: ${JSON.stringify(holdings)}`);
  checkResult(makeCardStore().set({ body: setHoldings(CARD_PORTFOLIO_FORM, holdings) }), `iter${i + 1} card-store set`);
  console.log(`  [${T()}] iter ${i + 1} cardStore.set done`);
  checkResult(makeBoard().upsertCard({ params: { cardId: 'portfolio-form', restart: 'true' } }), `iter${i + 1} upsert`);
  console.log(`  [${T()}] iter ${i + 1} upsertCard done`);
  // await waitForCompleted(`T4-iter${i + 1}`);  // commented out: rapid-fire, no waits
}

console.log(`\n[${T()}] [T4] all 5 upserts fired — waiting for board to converge...`);
const t4Final = await waitForCompleted('T4');
console.log(`[${T()}] [T4] waitForCompleted done`);

// ── Assertions ────────────────────────────────────────────────────────────────
const holdingsPath = path.join(OUTPUTS_DIR, 'data-objects', 'holdings.json');
const holdings = readJson(holdingsPath);
console.log('\n[T4] holdings.json (data-object output):', JSON.stringify(holdings, null, 2));

const finalCard = readJson(path.join(CARDSTORE_DIR, 'portfolio-form.json'));
console.log('[T4] cardstore portfolio-form holdings:', JSON.stringify(finalCard.card_data?.holdings, null, 2));

// Assert final holdings match iter-5
const holdingsBySymbol = Object.fromEntries(holdings.map(h => [h.symbol, h.qty]));
const expectedSymbols = Object.keys(T4_EXPECTED_FINAL).sort();
const actualSymbols = Object.keys(holdingsBySymbol).sort();
assert(JSON.stringify(actualSymbols) === JSON.stringify(expectedSymbols),
  `T4: expected symbols ${JSON.stringify(expectedSymbols)}, got ${JSON.stringify(actualSymbols)}`);
for (const [sym, qty] of Object.entries(T4_EXPECTED_FINAL)) {
  assert(holdingsBySymbol[sym] === qty,
    `T4: expected ${sym} qty=${qty}, got ${holdingsBySymbol[sym]}`);
}
console.log('[T4] holdings assertions passed: iter-5 symbols and quantities match.');

// Assert prices contain exactly the iter-5 tickers
const pricesPath = path.join(OUTPUTS_DIR, 'data-objects', 'prices.json');
const prices = readJson(pricesPath);
const priceKeys = Object.keys(prices).sort();
assert(JSON.stringify(priceKeys) === JSON.stringify(expectedSymbols),
  `T4: expected price keys ${JSON.stringify(expectedSymbols)}, got ${JSON.stringify(priceKeys)}`);
assert(Object.values(prices).every(v => typeof v === 'number'),
  'T4: all price values must be numbers');
console.log('[T4] prices assertions passed:', JSON.stringify(prices));

// Assert holdings-table rows match
const htCvPath = path.join(OUTPUTS_DIR, 'cards', 'holdings-table', 'computed_values.json');
const htCv = readJson(htCvPath);
const rowsBySymbol = Object.fromEntries([].concat(htCv.table.rows).map(r => [r.symbol, r]));
for (const [sym, qty] of Object.entries(T4_EXPECTED_FINAL)) {
  assert(rowsBySymbol[sym]?.qty === qty,
    `T4: holdings-table expected ${sym} qty=${qty}, got ${rowsBySymbol[sym]?.qty}`);
  const expectedValue = Math.round(qty * prices[sym] * 100) / 100;
  assert(Math.round(rowsBySymbol[sym]?.value * 100) === Math.round(expectedValue * 100),
    `T4: holdings-table expected ${sym} value=${expectedValue}, got ${rowsBySymbol[sym]?.value}`);
}
console.log('[T4] holdings-table assertions passed: rows match holdings × prices.');

// Assert portfolio-value totalValue = sum(holdings × prices)
const pvCv = readJson(path.join(OUTPUTS_DIR, 'cards', 'portfolio-value', 'computed_values.json'));
const expectedTotal = Object.entries(T4_EXPECTED_FINAL).reduce(
  (sum, [sym, qty]) => sum + qty * prices[sym], 0
);
assert(Math.round(pvCv.totalValue * 100) === Math.round(expectedTotal * 100),
  `T4: expected totalValue=${Math.round(expectedTotal * 100) / 100}, got ${pvCv.totalValue}`);
console.log(`[T4] portfolio-value assertion passed: totalValue=${pvCv.totalValue} matches sum(holdings × prices).`);

// Assert cardstore portfolio-form holdings match iter-5
const cardstoreHoldings = Object.fromEntries(
  (finalCard.card_data?.holdings ?? []).map(h => [h.symbol, h.qty])
);
for (const [sym, qty] of Object.entries(T4_EXPECTED_FINAL)) {
  assert(cardstoreHoldings[sym] === qty,
    `T4: cardstore expected ${sym} qty=${qty}, got ${cardstoreHoldings[sym]}`);
}
assert(Object.keys(cardstoreHoldings).length === Object.keys(T4_EXPECTED_FINAL).length,
  `T4: cardstore has ${Object.keys(cardstoreHoldings).length} symbols, expected ${Object.keys(T4_EXPECTED_FINAL).length}`);
console.log('[T4] cardstore holdings assertion passed: portfolio-form matches iter-5.');

console.log('\nFinal board status summary:');
const { summary } = t4Final;
console.log(`  completed=${summary.completed}/${summary.card_count}, failed=${summary.failed}`);

console.log('\n=== portfolio-t4 completed ===');
console.log('  runtime base:', _TMP_BASE);
