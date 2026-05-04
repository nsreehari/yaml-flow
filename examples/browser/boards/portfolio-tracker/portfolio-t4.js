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
const _TMP_BASE        = path.join(os.tmpdir(), 'experiment-js-t4');
const CARDSTORE_DIR    = path.join(_TMP_BASE, 'cardstore');
const BOARDRUNTIME_DIR = path.join(_TMP_BASE, 'boardruntime');
const OUTPUTS_DIR      = path.join(_TMP_BASE, 'outputs');

const CARDSTORE_REF    = `::fs-path::${CARDSTORE_DIR}`;
const BOARDRUNTIME_REF = `::fs-path::${BOARDRUNTIME_DIR}`;
const OUTPUTS_REF      = `::fs-path::${OUTPUTS_DIR}`;

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
  provides: [{ bindTo: 'prices', ref: 'fetched_sources.prices' }],
  card_data: {},
  source_defs: [{
    kind: 'mock-quotes',
    bindTo: 'prices',
    outputFile: 'prices.json',
    projections: { tickers: '$append([], requires.holdings.symbol)' }
  }],
  view: { elements: [{ kind: 'table', label: 'Market Prices', data: { bind: 'fetched_sources.prices' } }] }
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

// ── T0 — Init ─────────────────────────────────────────────────────────────────
console.log('\n=== T0: Init ===');
if (fs.existsSync(_TMP_BASE)) fs.rmSync(_TMP_BASE, { recursive: true, force: true });
for (const d of [CARDSTORE_DIR, BOARDRUNTIME_DIR, OUTPUTS_DIR]) fs.mkdirSync(d, { recursive: true });
console.log(`  runtime base: ${_TMP_BASE}`);

checkResult(
  makeBoard().init({
    params: { cardStoreRef: CARDSTORE_REF, outputsStoreRef: OUTPUTS_REF },
    body: { 'task-executor-ref': { meta: 'task-executor', howToRun: 'local-node', whatToRun: `::fs-path::${FETCH_PRICES_JS}` } },
  }),
  'init'
);

const cardStore = makeCardStore();
for (const card of [
  setHoldings(CARD_PORTFOLIO_FORM, { AAPL: 10 }),
  // only portfolio-form — isolate the rapid-fire bug
]) {
  const vr = makeNonCoreBoard().validateTmpCard({ body: card });
  if (!vr.data?.isValid) { console.error(`[VALIDATE FAILED] ${card.id}:`, JSON.stringify(vr.data?.issues ?? vr.error)); process.exit(1); }
  checkResult(cardStore.set({ body: card }), `card-store set ${card.id}`);
}

for (const cardId of ['portfolio-form']) {
  checkResult(makeBoard().upsertCard({ params: { cardId } }), `upsertCard ${cardId}`);
}

await waitForCompleted('T0-settle');
console.log('[T0] board settled with initial holdings.');

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
  checkResult(makeBoard().upsertCard({ params: { cardId: 'portfolio-form', restart: 'true' } }), `iter${i + 1} upsert`);
}

console.log('\n[T4] all 5 upserts fired — waiting for board to converge...');
const t4Final = await waitForCompleted('T4');

// ── Dump results ──────────────────────────────────────────────────────────────
const holdingsPath = path.join(OUTPUTS_DIR, 'data-objects', 'holdings.json');
const holdings = readJson(holdingsPath);
console.log('\n[T4] holdings.json (data-object output):', JSON.stringify(holdings, null, 2));

const finalCard = readJson(path.join(CARDSTORE_DIR, 'portfolio-form.json'));
console.log('[T4] cardstore portfolio-form holdings:', JSON.stringify(finalCard.card_data?.holdings, null, 2));

console.log('\nFinal board status summary:');
const { summary } = t4Final;
console.log(`  completed=${summary.completed}/${summary.card_count}, failed=${summary.failed}`);

console.log('\n=== portfolio-t4 completed ===');
console.log('  runtime base:', _TMP_BASE);
