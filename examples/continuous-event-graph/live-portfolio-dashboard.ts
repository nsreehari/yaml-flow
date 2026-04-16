/**
 * Live Portfolio Dashboard — Dynamic Reactive Graph Example
 *
 * A comprehensive example demonstrating:
 *  - Live cards on disk → reactive graph bridge (liveCardsToReactiveGraph)
 *  - Custom card handlers with cross-card data joins
 *  - Dynamic node lifecycle: addNode / removeNode at runtime
 *  - Graph wiring mutations: addRequires / removeRequires / addProvides / removeProvides
 *  - Multi-round data updates via push / pushAll
 *  - retrigger / retriggerAll for manual re-computation
 *  - Full disk roundtrip: card state persisted after every drain cycle
 *
 * Graph topology (8 initial cards):
 *
 *   holdings ─────┐
 *                  ├─→ valuator ─→ portfolio-value
 *   price-feed ───┘         │
 *                           └─→ sector-breakdown
 *   news-feed ─→ sentiment
 *   benchmark ──(standalone)
 *
 * Dynamically added: allocation-chart, risk-score, daily-pnl,
 *   value-alert, summary, correlation, combined-view
 *
 * Run with: npx tsx examples/continuous-event-graph/live-portfolio-dashboard.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import type { LiveCard } from '../../src/continuous-event-graph/live-cards-bridge.js';
import type { TaskConfig } from '../../src/event-graph/types.js';
import type { TaskHandlerFn, TaskHandlerInput, ReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import { liveCardsToReactiveGraph } from '../../src/continuous-event-graph/live-cards-bridge.js';

// ============================================================================
// Helpers
// ============================================================================

const ts = () => new Date().toISOString();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const log = (label: string, ...args: unknown[]) => console.log(`\n[${label}]`, ...args);

function readCard(dir: string, id: string): LiveCard {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
}

function writeCard(dir: string, card: LiveCard): void {
  fs.writeFileSync(path.join(dir, `${card.id}.json`), JSON.stringify(card, null, 2));
}

function printDiskCard(dir: string, id: string) {
  const card = readCard(dir, id);
  const stateKeys = Object.keys(card.state ?? {});
  console.log(`  📄 ${id}.json — keys: [${stateKeys.join(', ')}]`);
  for (const [k, v] of Object.entries(card.state ?? {})) {
    const preview = JSON.stringify(v);
    console.log(`     ${k}: ${preview.length > 100 ? preview.slice(0, 100) + '…' : preview}`);
  }
}

// ============================================================================
// 1. Define the initial 8 live cards
// ============================================================================

const cards: LiveCard[] = [
  // Sources
  {
    id: 'holdings', type: 'source',
    meta: { title: 'Portfolio Holdings' },
    data: { provides: { holdings: 'state.holdings' } },
    state: {
      holdings: [
        { symbol: 'AAPL', shares: 50, sector: 'tech' },
        { symbol: 'MSFT', shares: 30, sector: 'tech' },
        { symbol: 'GOOG', shares: 20, sector: 'tech' },
        { symbol: 'JPM', shares: 40, sector: 'finance' },
        { symbol: 'JNJ', shares: 25, sector: 'healthcare' },
      ],
    },
  },
  {
    id: 'price-feed', type: 'source',
    meta: { title: 'Live Price Feed' },
    data: { provides: { prices: 'state.prices' } },
    state: { prices: { AAPL: 195.50, MSFT: 420.10, GOOG: 176.30, JPM: 198.20, JNJ: 155.80 } },
  },
  {
    id: 'news-feed', type: 'source',
    meta: { title: 'Market News Feed' },
    state: {
      headlines: [
        { symbol: 'AAPL', headline: 'Apple beats Q4 estimates', sentiment: 0.8 },
        { symbol: 'JPM', headline: 'JPMorgan raises dividend', sentiment: 0.6 },
        { symbol: 'JNJ', headline: 'JNJ faces litigation risk', sentiment: -0.4 },
      ],
    },
  },
  {
    id: 'benchmark', type: 'source',
    meta: { title: 'S&P 500 Benchmark' },
    state: { index: 'SPY', value: 5280.50, dailyReturn: 0.45 },
  },
  // Compute cards
  {
    id: 'valuator', type: 'card',
    meta: { title: 'Position Valuator' },
    data: { requires: ['holdings', 'price-feed'] },
    state: {},
  },
  {
    id: 'portfolio-value', type: 'card',
    meta: { title: 'Total Portfolio Value' },
    data: { requires: ['valuator'] },
    state: {},
  },
  {
    id: 'sector-breakdown', type: 'card',
    meta: { title: 'Sector Breakdown' },
    data: { requires: ['valuator'] },
    state: {},
  },
  {
    id: 'sentiment', type: 'card',
    meta: { title: 'News Sentiment Score' },
    data: { requires: ['news-feed'] },
    state: {},
  },
];

// ============================================================================
// 2. Handler factory — reads engine state, computes, resolves callback
// ============================================================================

let graphRef: ReactiveGraph | null = null;

function makeHandler(
  id: string,
  computeFn: (engine: ReturnType<ReactiveGraph['getState']>) => Record<string, unknown>,
  dir: string,
): TaskHandlerFn {
  return async (input: TaskHandlerInput) => {
    const result = computeFn(graphRef!.getState());
    try {
      const diskCard = readCard(dir, id);
      diskCard.state = { ...diskCard.state, ...result };
      writeCard(dir, diskCard);
    } catch { /* card may not exist yet */ }
    graphRef!.resolveCallback(input.callbackToken, result);
    return 'task-initiated';
  };
}

function addDynamicCard(
  rg: ReactiveGraph, dir: string, card: LiveCard,
  computeFn: (engine: ReturnType<ReactiveGraph['getState']>) => Record<string, unknown>,
  taskConfig: { requires?: string[]; provides?: string[] },
) {
  writeCard(dir, card);
  rg.registerHandler(card.id, makeHandler(card.id, computeFn, dir));
  rg.addNode(card.id, {
    requires: taskConfig.requires,
    provides: taskConfig.provides ?? [card.id],
    taskHandlers: [card.id],
  } as TaskConfig);
}

// ============================================================================
// 3. Main — run the full lifecycle
// ============================================================================

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-portfolio-'));
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║       Live Portfolio Dashboard — Reactive Graph Demo      ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`Card directory: ${tmpDir}`);

  // Write initial cards to disk
  for (const card of cards) writeCard(tmpDir, card);

  // ── Phase 1: Build reactive graph from live cards ──────────────────────

  log('PHASE 1', 'Building reactive graph from 8 live cards on disk');

  const result = liveCardsToReactiveGraph(cards, {
    cardHandlers: {
      valuator: makeHandler('valuator', (engine) => {
        const holdingsList = (engine.state.tasks.holdings?.data as any)?.holdings ?? [];
        const priceMap = (engine.state.tasks['price-feed']?.data as any)?.prices ?? {};
        return {
          positions: holdingsList.map((h: any) => ({
            symbol: h.symbol, shares: h.shares, sector: h.sector,
            price: priceMap[h.symbol] ?? 0,
            value: h.shares * (priceMap[h.symbol] ?? 0),
          })),
        };
      }, tmpDir),
      'portfolio-value': makeHandler('portfolio-value', (engine) => {
        const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
        const totalValue = positions.reduce((s: number, p: any) => s + p.value, 0);
        return { totalValue, positionCount: positions.length };
      }, tmpDir),
      'sector-breakdown': makeHandler('sector-breakdown', (engine) => {
        const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
        const bySector: Record<string, number> = {};
        for (const p of positions) bySector[p.sector] = (bySector[p.sector] ?? 0) + p.value;
        const total = positions.reduce((s: number, p: any) => s + p.value, 0);
        const sectors = Object.entries(bySector).map(([sector, value]) => ({
          sector, value, pct: total > 0 ? Math.round(value / total * 10000) / 100 : 0,
        }));
        return { sectors, sectorCount: sectors.length };
      }, tmpDir),
      sentiment: makeHandler('sentiment', (engine) => {
        const headlines = (engine.state.tasks['news-feed']?.data as any)?.headlines ?? [];
        const avg = headlines.length > 0
          ? headlines.reduce((s: number, h: any) => s + (h.sentiment ?? 0), 0) / headlines.length : 0;
        return { avgSentiment: Math.round(avg * 100) / 100, headlineCount: headlines.length, bullish: avg > 0.2 };
      }, tmpDir),
    },
    reactiveOptions: {
      onDrain: (_events, live) => {
        for (const [taskName, taskState] of Object.entries(live.state.tasks)) {
          if (taskState.data && Object.keys(taskState.data).length > 0) {
            try {
              const diskCard = readCard(tmpDir, taskName);
              diskCard.state = { ...diskCard.state, ...taskState.data };
              writeCard(tmpDir, diskCard);
            } catch { /* not on disk yet */ }
          }
        }
      },
    },
  });

  graphRef = result.graph;
  const rg = result.graph;

  // Kick off the initial cascade
  rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
  await sleep(200);

  log('PHASE 1 RESULT', `${Object.keys(rg.getState().state.tasks).length} tasks completed`);
  printDiskCard(tmpDir, 'portfolio-value');
  printDiskCard(tmpDir, 'sector-breakdown');
  printDiskCard(tmpDir, 'sentiment');

  // ── Phase 2: Dynamically grow to 15 cards ──────────────────────────────

  log('PHASE 2', 'Adding 7 dynamic cards → 15 total');

  addDynamicCard(rg, tmpDir, {
    id: 'allocation-chart', type: 'card', data: { requires: ['valuator', 'portfolio-value'] }, state: {},
  }, (e) => {
    const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
    const tot = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
    return { allocations: pos.map((p: any) => ({ sym: p.symbol, pct: tot > 0 ? Math.round(p.value / tot * 10000) / 100 : 0 })) };
  }, { requires: ['valuator', 'portfolio-value'] });

  addDynamicCard(rg, tmpDir, {
    id: 'risk-score', type: 'card', data: { requires: ['valuator'] }, state: {},
  }, (e) => {
    const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
    const vals = pos.map((p: any) => p.value);
    const total = vals.reduce((s: number, v: number) => s + v, 0);
    const maxConc = total > 0 ? Math.max(...vals) / total : 0;
    return { maxConcentration: Math.round(maxConc * 100) / 100, riskLevel: maxConc > 0.5 ? 'high' : maxConc > 0.3 ? 'medium' : 'low' };
  }, { requires: ['valuator'] });

  addDynamicCard(rg, tmpDir, {
    id: 'daily-pnl', type: 'card', data: { requires: ['portfolio-value', 'benchmark'] }, state: {},
  }, (e) => {
    const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
    const benchReturn = (e.state.tasks.benchmark?.data as any)?.dailyReturn ?? 0;
    const portfolioReturn = 1.2;
    return { pnl: Math.round(tv * (portfolioReturn / 100) * 100) / 100, alpha: Math.round((portfolioReturn - benchReturn) * 100) / 100 };
  }, { requires: ['portfolio-value', 'benchmark'] });

  addDynamicCard(rg, tmpDir, {
    id: 'value-alert', type: 'card', data: { requires: ['portfolio-value'] }, state: {},
  }, (e) => {
    const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
    return { triggered: tv > 25000, threshold: 25000, currentValue: tv };
  }, { requires: ['portfolio-value'] });

  addDynamicCard(rg, tmpDir, {
    id: 'summary', type: 'card', data: { requires: ['portfolio-value', 'sentiment'] }, state: {},
  }, (e) => {
    const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
    const mood = (e.state.tasks.sentiment?.data as any)?.bullish ? 'bullish' : 'bearish';
    return { text: `Portfolio: $${tv.toFixed(2)} — Market: ${mood}`, totalValue: tv, mood };
  }, { requires: ['portfolio-value', 'sentiment'] });

  addDynamicCard(rg, tmpDir, {
    id: 'correlation', type: 'card', data: { requires: ['valuator', 'benchmark'] }, state: {},
  }, (e) => {
    const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
    const techVal = pos.filter((p: any) => p.sector === 'tech').reduce((s: number, p: any) => s + p.value, 0);
    const total = pos.reduce((s: number, p: any) => s + p.value, 0);
    return { techWeight: total > 0 ? Math.round(techVal / total * 100) / 100 : 0 };
  }, { requires: ['valuator', 'benchmark'] });

  addDynamicCard(rg, tmpDir, {
    id: 'combined-view', type: 'card', data: { requires: ['summary', 'sector-breakdown', 'risk-score'] }, state: {},
  }, (e) => ({
    summaryMood: (e.state.tasks.summary?.data as any)?.mood ?? '?',
    sectors: (e.state.tasks['sector-breakdown']?.data as any)?.sectorCount ?? 0,
    risk: (e.state.tasks['risk-score']?.data as any)?.riskLevel ?? 'unknown',
    ready: true,
  }), { requires: ['summary', 'sector-breakdown', 'risk-score'] });

  await sleep(300);

  const taskCount = Object.keys(rg.getState().state.tasks).length;
  const allCompleted = Object.values(rg.getState().state.tasks).every(t => t.status === 'completed');
  log('PHASE 2 RESULT', `${taskCount} cards, all completed: ${allCompleted}`);
  printDiskCard(tmpDir, 'combined-view');
  printDiskCard(tmpDir, 'risk-score');

  // ── Phase 3: addProvides — create a new token ──────────────────────────

  log('PHASE 3', 'addProvides: benchmark now also produces "market-data" token');

  rg.addProvides('benchmark', ['market-data']);
  console.log('  benchmark provides:', rg.getState().config.tasks.benchmark.provides);

  addDynamicCard(rg, tmpDir, {
    id: 'market-context', type: 'card', data: { requires: ['market-data'] }, state: {},
  }, (e) => {
    const bench = e.state.tasks.benchmark?.data as any ?? {};
    return { indexValue: bench.value ?? 0, context: 'provided via market-data token' };
  }, { requires: ['market-data'] });
  await sleep(100);

  log('PHASE 3 RESULT', `${Object.keys(rg.getState().state.tasks).length} cards`);
  printDiskCard(tmpDir, 'market-context');

  // ── Phase 4: addRequires — wire sentiment into combined-view ───────────

  log('PHASE 4', 'addRequires: wiring news-feed into combined-view');

  const requiresBefore = [...(rg.getState().config.tasks['combined-view'].requires ?? [])];
  rg.addRequires('combined-view', ['news-feed']);
  const requiresAfter = rg.getState().config.tasks['combined-view'].requires ?? [];
  console.log(`  combined-view requires: ${requiresBefore.join(', ')} → ${requiresAfter.join(', ')}`);

  // ── Phase 5: removeProvides + removeNode ───────────────────────────────

  log('PHASE 5', 'removeProvides "market-data" from benchmark, then remove 2 nodes');

  rg.removeProvides('benchmark', ['market-data']);
  console.log('  benchmark provides after removal:', rg.getState().config.tasks.benchmark.provides);

  rg.removeNode('allocation-chart');
  rg.removeNode('market-context');
  console.log(`  Remaining cards: ${Object.keys(rg.getState().state.tasks).length}`);

  // ── Phase 6: Push updated prices → full cascade ────────────────────────

  log('PHASE 6', 'Pushing round-2 prices: AAPL 201, MSFT 418.75, GOOG 180.50');

  rg.push({
    type: 'task-completed', taskName: 'price-feed',
    data: { prices: { AAPL: 201.00, MSFT: 418.75, GOOG: 180.50, JPM: 202.10, JNJ: 153.40 } },
    timestamp: ts(),
  });
  await sleep(200);

  printDiskCard(tmpDir, 'portfolio-value');
  printDiskCard(tmpDir, 'daily-pnl');

  // ── Phase 7: pushAll — new holdings (add TSLA) + round-3 prices ────────

  log('PHASE 7', 'pushAll: adding TSLA holding + round-3 prices');

  rg.pushAll([
    {
      type: 'task-completed', taskName: 'holdings',
      data: {
        holdings: [
          { symbol: 'AAPL', shares: 50, sector: 'tech' },
          { symbol: 'MSFT', shares: 30, sector: 'tech' },
          { symbol: 'GOOG', shares: 20, sector: 'tech' },
          { symbol: 'JPM', shares: 40, sector: 'finance' },
          { symbol: 'JNJ', shares: 25, sector: 'healthcare' },
          { symbol: 'TSLA', shares: 10, sector: 'tech' },
        ],
      },
      timestamp: ts(),
    },
    {
      type: 'task-completed', taskName: 'price-feed',
      data: { prices: { AAPL: 205.25, MSFT: 422.00, GOOG: 182.10, JPM: 199.80, JNJ: 157.10, TSLA: 168.75 } },
      timestamp: ts(),
    },
  ]);
  await sleep(200);

  printDiskCard(tmpDir, 'portfolio-value');
  printDiskCard(tmpDir, 'sector-breakdown');
  printDiskCard(tmpDir, 'risk-score');

  // ── Phase 8: removeRequires + re-add node with different wiring ────────

  log('PHASE 8', 'removeRequires news-feed from combined-view, re-add allocation-chart (simpler wiring)');

  rg.removeRequires('combined-view', ['news-feed']);
  console.log('  combined-view requires:', rg.getState().config.tasks['combined-view'].requires);

  addDynamicCard(rg, tmpDir, {
    id: 'allocation-chart', type: 'card', data: { requires: ['valuator'] }, state: {},
  }, (e) => {
    const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
    const total = pos.reduce((s: number, p: any) => s + p.value, 0);
    return { allocations: pos.map((p: any) => ({ sym: p.symbol, pct: total > 0 ? Math.round(p.value / total * 10000) / 100 : 0 })) };
  }, { requires: ['valuator'] });
  await sleep(100);

  printDiskCard(tmpDir, 'allocation-chart');

  // ── Phase 9: retriggerAll — bulk refresh ───────────────────────────────

  log('PHASE 9', 'retriggerAll: refreshing the full computation pipeline');

  rg.retriggerAll(['valuator', 'portfolio-value', 'sector-breakdown', 'sentiment']);
  await sleep(200);

  // ── Phase 10: Watchlist — form input source + derived price card ────────

  log('PHASE 10', 'Adding watchlist (form input) + watchlist-prices (derived)');

  // Watchlist is a "source" card — it has no handler, data is pushed externally
  // (simulating a user typing symbols into a form)
  const watchlistCard: LiveCard = {
    id: 'watchlist', type: 'source',
    meta: { title: 'Watchlist (User Input)' },
    data: { provides: { watchlist: 'state.symbols' } },
    state: { symbols: ['NVDA', 'AMD', 'AMZN'] },
  };
  writeCard(tmpDir, watchlistCard);
  rg.registerHandler('watchlist', makeHandler('watchlist', (engine) => {
    // Source handler just returns current state — data comes via external push
    return {};
  }, tmpDir));
  rg.addNode('watchlist', {
    provides: ['watchlist'],
    taskHandlers: ['watchlist'],
  } as TaskConfig);

  // Push the initial watchlist data (simulating form submission)
  rg.push({
    type: 'task-completed', taskName: 'watchlist',
    data: { symbols: ['NVDA', 'AMD', 'AMZN'] },
    timestamp: ts(),
  });
  await sleep(100);

  console.log('  watchlist submitted: NVDA, AMD, AMZN');

  // Watchlist-prices card — reads the watchlist symbols and the price-feed,
  // then extracts the latest prices for watched symbols
  addDynamicCard(rg, tmpDir, {
    id: 'watchlist-prices', type: 'card',
    meta: { title: 'Watchlist Latest Prices' },
    data: { requires: ['watchlist', 'price-feed'] }, state: {},
  }, (engine) => {
    const symbols: string[] = (engine.state.tasks.watchlist?.data as any)?.symbols ?? [];
    const allPrices: Record<string, number> = (engine.state.tasks['price-feed']?.data as any)?.prices ?? {};
    const watchPrices = symbols.map(sym => ({
      symbol: sym,
      price: allPrices[sym] ?? null,
      available: sym in allPrices,
    }));
    const available = watchPrices.filter(w => w.available);
    const missing = watchPrices.filter(w => !w.available);
    return {
      watchPrices,
      availableCount: available.length,
      missingCount: missing.length,
      missingSymbols: missing.map(m => m.symbol),
    };
  }, { requires: ['watchlist', 'price-feed'] });
  await sleep(100);

  printDiskCard(tmpDir, 'watchlist-prices');

  // Now push updated prices that include the watchlist symbols
  log('PHASE 10b', 'Pushing prices that include NVDA, AMD, AMZN');
  rg.push({
    type: 'task-completed', taskName: 'price-feed',
    data: { prices: {
      AAPL: 205.25, MSFT: 422.00, GOOG: 182.10, JPM: 199.80, JNJ: 157.10, TSLA: 168.75,
      NVDA: 135.50, AMD: 164.20, AMZN: 192.80,
    }},
    timestamp: ts(),
  });
  await sleep(200);

  console.log('  After prices include watchlist symbols:');
  printDiskCard(tmpDir, 'watchlist-prices');

  // User updates watchlist (adds META, removes AMD)
  log('PHASE 10c', 'User edits watchlist: [NVDA, AMZN, META]');
  rg.push({
    type: 'task-completed', taskName: 'watchlist',
    data: { symbols: ['NVDA', 'AMZN', 'META'] },
    timestamp: ts(),
  });
  await sleep(200);

  printDiskCard(tmpDir, 'watchlist-prices');

  const finalState = rg.getState();
  const completedCount = Object.values(finalState.state.tasks).filter(t => t.status === 'completed').length;
  const totalCards = Object.keys(finalState.state.tasks).length;

  // ── Final summary ──────────────────────────────────────────────────────

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                     Final Dashboard                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`  Total cards: ${totalCards}`);
  console.log(`  Completed:   ${completedCount}/${totalCards}`);
  console.log(`  Card directory: ${tmpDir}`);
  console.log('\n  Active cards:');
  for (const name of Object.keys(finalState.state.tasks).sort()) {
    const t = finalState.state.tasks[name];
    const dataKeys = t.data ? Object.keys(t.data).join(', ') : '(no data)';
    console.log(`    ${t.status === 'completed' ? '✅' : '⏳'} ${name} — ${dataKeys}`);
  }

  console.log('\n  Disk roundtrip verification:');
  for (const name of Object.keys(finalState.state.tasks).sort()) {
    const exists = fs.existsSync(path.join(tmpDir, `${name}.json`));
    console.log(`    ${exists ? '💾' : '❌'} ${name}.json`);
  }

  // ── Schedule info ──────────────────────────────────────────────────────

  const sched = rg.getSchedule();
  console.log(`\n  Schedule: ${sched.eligible.length} eligible, ${sched.blocked.length} blocked, ${sched.unresolved.length} unresolved`);

  // ── Journal stats ──────────────────────────────────────────────────────

  const journal = rg.getState().journal ?? [];
  console.log(`  Journal: ${journal.length} events recorded`);

  // Cleanup
  rg.dispose();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n  Cleaned up. Done.');
}

main().catch(console.error);
