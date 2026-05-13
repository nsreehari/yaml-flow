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
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

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
  serializeRef,
} = await import(pathToFileURL(_adapterPath).href);

const FETCH_PRICES_JS = path.join(__dirname, 'portfolio-tracker-fetch-prices.js');

// ── Runtime directories ────────────────────────────────────────────────────────
const _TMP_BASE       = path.join(os.tmpdir(), `experiment-js-${process.pid}`);
const CARDSTORE_DIR   = path.join(_TMP_BASE, 'cardstore');
const BOARDRUNTIME_DIR = path.join(_TMP_BASE, 'boardruntime');
const OUTPUTS_DIR     = path.join(_TMP_BASE, 'outputs');

const CARDSTORE_REF    = serializeRef({ kind: 'fs-path', value: CARDSTORE_DIR });
const BOARDRUNTIME_REF = serializeRef({ kind: 'fs-path', value: BOARDRUNTIME_DIR });
const OUTPUTS_REF      = serializeRef({ kind: 'fs-path', value: OUTPUTS_DIR });
const notifySuffix     = Math.floor(Math.random() * 10000);
const NOTIFY_CHANNEL   = `yaml-flow-board-notify-portfolio-tracker-public-${notifySuffix}`;

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
  provides: [{ bindTo: 'prices', ref: 'computed_values.prices' }],
  card_data: {},
  compute: [{
    bindTo: 'prices',
    expr: '$merge($map(requires.holdings, function($h){ { $h.symbol: 100 } }))'
  }],
  view: {
    elements: [
      { kind: 'table', label: 'Market Prices',
        data: { bind: 'computed_values.prices' } }
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

function makeBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, path.join(_REPO_ROOT, 'dist', 'cli', 'node'), {
    onWarn: console.warn,
    notifyChannel: NOTIFY_CHANNEL,
  }));
}

function makeNonCoreBoard() {
  const br = parseRef(BOARDRUNTIME_REF);
  return createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, path.join(_REPO_ROOT, 'dist', 'cli', 'node'), { onWarn: console.warn }));
}

function makeCardStore() {
  const ref = parseRef(CARDSTORE_REF);
  const adapter = createFsBoardPlatformAdapter(ref, path.join(_REPO_ROOT, 'dist', 'cli', 'node'), { onWarn: console.warn });
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

// ── NS — notification state class (compact log + full payload map) ───────────
class NotificationState {
  constructor() {
    this.log = [];
    this.statusGen = 0;
    this.values = {
      status: null,
      computedValues: {},
      dataObjects: {},
      cards: {},
    };
  }

  append(event) {
    const at = new Date().toISOString();
    if (event.kind === 'status') {
      this.log.push({ at, type: event.kind, key: 'status' });
      this.values.status = event.status;
      this.statusGen++;
      return;
    }
    if (event.kind === 'computed_values') {
      this.log.push({ at, type: event.kind, key: event.cardId });
      this.values.computedValues[event.cardId] = event.values;
      return;
    }
    if (event.kind === 'data_object') {
      this.log.push({ at, type: event.kind, key: event.key });
      this.values.dataObjects[event.key] = event.payload;
      return;
    }
    if (event.kind === 'card_refreshed') {
      this.log.push({ at, type: event.kind, key: event.cardId });
      this.values.cards[event.cardId] = event.card;
    }
  }

  latestStatus() {
    return this.values.status;
  }

  countByType(type) {
    let count = 0;
    for (const n of this.log) {
      if (n.type === type) count++;
    }
    return count;
  }

  summary() {
    const byType = {};
    const keysByType = {
      computed_values: new Set(),
      data_object: new Set(),
      card_refreshed: new Set(),
      status: new Set(),
    };

    for (const n of this.log) {
      byType[n.type] = (byType[n.type] ?? 0) + 1;
      if (n.type in keysByType) keysByType[n.type].add(n.key);
    }

    return {
      totalNotifications: this.log.length,
      byType,
      keysByType: {
        computed_values: [...keysByType.computed_values].sort(),
        data_object: [...keysByType.data_object].sort(),
        card_refreshed: [...keysByType.card_refreshed].sort(),
        status: [...keysByType.status].sort(),
      },
      latestStatusSummary: this.values.status?.summary ?? null,
    };
  }
}

const NS = new NotificationState();

function appendNS(event) {
  NS.append(event);
}

function namedPipePath(pipeName) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${pipeName}`;
  return path.join(os.tmpdir(), `${pipeName}.sock`);
}

function startPipeConsumer(pipeName) {
  return new Promise((resolve, reject) => {
    const pipePath = namedPipePath(pipeName);
    const sockets = new Set();
    if (process.platform !== 'win32' && fs.existsSync(pipePath)) {
      try { fs.rmSync(pipePath, { force: true }); } catch { /* best-effort */ }
    }

    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        while (true) {
          const i = buf.indexOf('\n');
          if (i < 0) break;
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            const n = msg?.notification ?? msg;
            if (n && typeof n.kind === 'string') appendNS(n);
          } catch (e) {
            console.warn(`[pipe-consumer] invalid notification line: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      });
    });

    server.once('error', (e) => reject(e));
    server.listen(pipePath, () => resolve({ server, pipePath, sockets }));
  });
}

function getNS() { return NS; }

function checkResult(result, label) {
  if (result.status !== 'success') {
    console.error(`[ERROR] ${label}: ${result.status} — ${result.error}`);
    process.exit(1);
  }
  return result.data;
}

async function waitForCompleted(label, expectedCardCount, timeoutMs = 90_000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;
  const startGen = getNS().statusGen;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    pollCount++;

    // Only consider status updates that arrived after this wait began
    if (getNS().statusGen <= startGen) {
      if (pollCount % 4 === 0) {
        console.log(`[${label}] poll#${pollCount} waiting for new status notification via named pipe...`);
      }
      continue;
    }

    const nsStatus = getNS().latestStatus();
    if (!nsStatus) continue;

    const { card_count, completed, in_progress, pending, failed } = nsStatus.summary;

    if (card_count >= expectedCardCount && completed === card_count) {
      console.log(`[${label}] all ${card_count} card(s) completed (via named-pipe notification).`);
      return nsStatus;
    }
    if (pollCount % 4 === 0) {
      const notDone = nsStatus.cards.filter(c => c.status !== 'completed').map(c => `${c.name}:${c.status}`);
      console.log(`[${label}] poll#${pollCount} summary: ${card_count} cards, completed=${completed}, in_progress=${in_progress}, pending=${pending}, failed=${failed} | stuck: ${notDone.join(', ')}`);
    }
  }
  console.error(`[ERROR] ${label}: timed out waiting for all cards to complete.`);
  process.exit(1);
}

function sortedKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.keys(obj).sort();
}

function readOutputsDataObject(key) {
  const result = makeBoard().getOutputsDataObject({ params: { key } });
  return result.status === 'success' ? result.data : undefined;
}

function readOutputsComputedValues(key) {
  const result = makeBoard().getOutputsComputedValues({ params: { key } });
  return result.status === 'success' ? result.data : undefined;
}

async function waitForPortfolioOutputs(label, expectedHoldingsBySymbol, timeoutMs = 30_000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs;
  const expectedSymbols = Object.keys(expectedHoldingsBySymbol).sort();
  let pollCount = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    pollCount++;

    const prices = readOutputsDataObject('prices');
    const holdingsTable = readOutputsComputedValues('holdings-table');
    const rowsRaw = holdingsTable?.table?.rows;
    if (!prices || rowsRaw === undefined || rowsRaw === null) continue;
    const rows = [].concat(rowsRaw);

    const priceSymbols = sortedKeys(prices);
    const rowsBySymbol = Object.fromEntries(rows.map(r => [r.symbol, r.qty]));
    const rowSymbols = sortedKeys(rowsBySymbol);
    const hasSymbols = JSON.stringify(priceSymbols) === JSON.stringify(expectedSymbols)
      && JSON.stringify(rowSymbols) === JSON.stringify(expectedSymbols);

    let qtyMatches = true;
    for (const sym of expectedSymbols) {
      if (rowsBySymbol[sym] !== expectedHoldingsBySymbol[sym]) {
        qtyMatches = false;
        break;
      }
    }

    if (hasSymbols && qtyMatches) {
      return { prices, holdingsTable, rowsBySymbol };
    }

    if (pollCount % 5 === 0) {
      console.log(`[${label}] waiting for output convergence: symbols=${JSON.stringify(priceSymbols)} rows=${JSON.stringify(rowSymbols)}`);
    }
  }

  console.error(`[ERROR] ${label}: timed out waiting for outputs to match expected holdings.`);
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

const pipeConsumer = await startPipeConsumer(NOTIFY_CHANNEL);

// ── T0b — Init board ───────────────────────────────────────────────────────────
console.log('\n=== T0b: Init board ===');
checkResult(
  makeBoard().init({
    params: { cardStoreRef: CARDSTORE_REF, outputsStoreRef: OUTPUTS_REF },
    body: {
      'task-executor-ref': {
        meta: 'task-executor',
        howToRun: 'local-node',
        whatToRun: serializeRef({ kind: 'fs-path', value: FETCH_PRICES_JS }),
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
await waitForCompleted('T1', 4);

const { prices: pricesT1, holdingsTable: htCvT1, rowsBySymbol: rowsBySymbolT1 } = await waitForPortfolioOutputs('T1', { NVDA: 100 });
assert(typeof pricesT1 === 'object' && pricesT1 !== null && Object.keys(pricesT1).length > 0,
  'T1: prices data object is empty or not an object');
assert(JSON.stringify(Object.keys(pricesT1).sort()) === JSON.stringify(['NVDA']),
  `T1: expected keys {NVDA}, got ${JSON.stringify(Object.keys(pricesT1))}`);
assert(Object.values(pricesT1).every(v => typeof v === 'number'),
  'T1: all price values must be numbers');
assert(rowsBySymbolT1['NVDA'] === 100,
  `T1: expected NVDA qty=100, got ${rowsBySymbolT1['NVDA']}`);
console.log('[T1] assertion passed: prices has NVDA with numeric values, NVDA qty=100.');

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
await waitForCompleted('T2c', 4);

const { prices: pricesT2c, holdingsTable: htCvT2c, rowsBySymbol: rowsBySymbolT2c } = await waitForPortfolioOutputs('T2c', { NVDA: 50, GOOG: 100 });
assert(JSON.stringify(Object.keys(pricesT2c).sort()) === JSON.stringify(['GOOG', 'NVDA']),
  `T2c: expected keys {GOOG, NVDA}, got ${JSON.stringify(Object.keys(pricesT2c))}`);

assert(htCvT2c.table.rows.length === 2,
  `T2c: expected 2 rows in holdings-table, got ${htCvT2c.table.rows.length}`);
assert(rowsBySymbolT2c['NVDA'] === 50,
  `T2c: expected NVDA qty=50, got ${rowsBySymbolT2c['NVDA']}`);
assert(rowsBySymbolT2c['GOOG'] === 100,
  `T2c: expected GOOG qty=100, got ${rowsBySymbolT2c['GOOG']}`);
console.log('[T2c] assertions passed: 2 tickers in prices, 2 rows in holdings-table, NVDA qty=50, GOOG qty=100.');

// ── T3 — Retrigger price-fetch ─────────────────────────────────────────────────
console.log('\n=== T3: Retrigger price-fetch ===');
checkResult(makeBoard().retrigger({ params: { id: 'price-fetch' } }), 'retrigger price-fetch');
console.log(JSON.stringify({ status: 'success' }, null, 2));
await waitForCompleted('T3', 4);

const { prices: pricesT3, rowsBySymbol: rowsBySymbolT3 } = await waitForPortfolioOutputs('T3', { NVDA: 50, GOOG: 100 });
assert(JSON.stringify(Object.keys(pricesT3).sort()) === JSON.stringify(['GOOG', 'NVDA']),
  `T3: expected keys {GOOG, NVDA}, got ${JSON.stringify(Object.keys(pricesT3))}`);
assert(rowsBySymbolT3['NVDA'] === 50,
  `T3: expected NVDA qty=50, got ${rowsBySymbolT3['NVDA']}`);
assert(rowsBySymbolT3['GOOG'] === 100,
  `T3: expected GOOG qty=100, got ${rowsBySymbolT3['GOOG']}`);
const pvCvT3 = checkResult(makeBoard().getOutputsComputedValues({ params: { key: 'portfolio-value' } }), 'T3 getOutputsComputedValues portfolio-value');
const expectedTotalT3 = Math.round(
  (rowsBySymbolT3['NVDA'] * pricesT3['NVDA'] + rowsBySymbolT3['GOOG'] * pricesT3['GOOG']) * 100
) / 100;
assert(Math.round(pvCvT3.totalValue * 100) === Math.round(expectedTotalT3 * 100),
  `T3: expected totalValue=${expectedTotalT3}, got ${pvCvT3.totalValue}`);
console.log(`[T3] assertions passed: 2 tickers, NVDA qty=50, GOOG qty=100, totalValue=${pvCvT3.totalValue}.`);

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

console.log('\nFinal board status (from NS):');
const finalStatusData = getNS().latestStatus();
console.log(JSON.stringify(finalStatusData, null, 2));

console.log('\nNotification summary (NS):');
console.log(JSON.stringify(getNS().summary(), null, 2));

console.log('\n=== portfolio-tracker-public completed successfully ===');
console.log('\n--- Runtime directories ---');
console.log('  cardstore:    ', CARDSTORE_DIR);
console.log('  boardruntime: ', BOARDRUNTIME_DIR);
console.log('  outputs:      ', OUTPUTS_DIR);

for (const socket of pipeConsumer.sockets) {
  try { socket.destroy(); } catch { /* best-effort */ }
}
await new Promise((resolve) => pipeConsumer.server.close(resolve));
if (process.platform !== 'win32' && fs.existsSync(pipeConsumer.pipePath)) {
  try { fs.rmSync(pipeConsumer.pipePath, { force: true }); } catch { /* best-effort */ }
}
process.exit(0);
