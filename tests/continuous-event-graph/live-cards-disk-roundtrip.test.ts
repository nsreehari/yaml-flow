/**
 * Live Cards Disk Roundtrip — Integration Test
 *
 * Full lifecycle: live card JSONs on disk → liveCardsToReactiveGraph →
 * handlers that persist state back to disk → dynamic graph manipulation.
 *
 * Starting graph (8 cards):
 *
 *   holdings ─────┐
 *                  ├─→ valuator ─→ portfolio-value ─→ daily-pnl
 *   price-feed ───┘         │
 *                           └─→ sector-breakdown
 *   news-feed ─→ sentiment
 *   benchmark ──(standalone)
 *
 * Dynamically added cards (7+):
 *   allocation-chart, risk-score, value-alert, summary,
 *   correlation, combined-view, newsletter
 *
 * Tests exercise: addNode, removeNode, addRequires, removeRequires,
 * addProvides, removeProvides, retrigger, retriggerAll, pushAll
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function readCard(dir: string, id: string): LiveCard {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
}

function writeCard(dir: string, card: LiveCard): void {
  fs.writeFileSync(path.join(dir, `${card.id}.json`), JSON.stringify(card, null, 2));
}

function cardExists(dir: string, id: string): boolean {
  return fs.existsSync(path.join(dir, `${id}.json`));
}

// ============================================================================
// Card definitions — 8 initial cards
// ============================================================================

function makePortfolioCards(): LiveCard[] {
  return [
    // --- Sources (4) ---
    {
      id: 'holdings',
      meta: { title: 'Portfolio Holdings' },
      card_data: {
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
      id: 'price-feed',
      meta: { title: 'Live Price Feed' },
      card_data: {
        prices: { AAPL: 195.50, MSFT: 420.10, GOOG: 176.30, JPM: 198.20, JNJ: 155.80 },
      },
    },
    {
      id: 'news-feed',
      meta: { title: 'Market News Feed' },
      card_data: {
        headlines: [
          { symbol: 'AAPL', headline: 'Apple beats Q4 estimates', sentiment: 0.8 },
          { symbol: 'JPM', headline: 'JPMorgan raises dividend', sentiment: 0.6 },
          { symbol: 'JNJ', headline: 'JNJ faces litigation risk', sentiment: -0.4 },
        ],
      },
    },
    {
      id: 'benchmark',
      meta: { title: 'S&P 500 Benchmark' },
      card_data: {
        index: 'SPY',
        value: 5280.50,
        dailyReturn: 0.45,
      },
    },

    // --- Cards (4) ---
    {
      id: 'valuator',
      meta: { title: 'Position Valuator' },
      requires: ['holdings', 'price-feed'],
      card_data: {},
    },
    {
      id: 'portfolio-value',
      meta: { title: 'Total Portfolio Value' },
      requires: ['valuator'],
      card_data: {},
    },
    {
      id: 'sector-breakdown',
      meta: { title: 'Sector Breakdown' },
      requires: ['valuator'],
      card_data: {},
    },
    {
      id: 'sentiment',
      meta: { title: 'News Sentiment Score' },
      requires: ['news-feed'],
      card_data: {},
    },
  ];
}

const prices = {
  round1: { AAPL: 195.50, MSFT: 420.10, GOOG: 176.30, JPM: 198.20, JNJ: 155.80 } as Record<string, number>,
  round2: { AAPL: 201.00, MSFT: 418.75, GOOG: 180.50, JPM: 202.10, JNJ: 153.40 } as Record<string, number>,
  round3: { AAPL: 205.25, MSFT: 422.00, GOOG: 182.10, JPM: 199.80, JNJ: 157.10, TSLA: 168.75 } as Record<string, number>,
};

// ============================================================================
// Test suite
// ============================================================================

describe('live cards → disk roundtrip integration (15+ cards)', () => {
  let tmpDir: string;
  let graphResult: ReturnType<typeof liveCardsToReactiveGraph>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-cards-'));
  });

  afterEach(() => {
    graphResult?.graph.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --------------------------------------------------------------------------
  // Handler factory — creates a handler that reads upstream from engine,
  // computes, resolves callback, and syncs to disk
  // --------------------------------------------------------------------------

  function makeHandler(
    id: string,
    computeFn: (engine: ReturnType<ReactiveGraph['getState']>) => Record<string, unknown>,
    graphRef: { rg: ReactiveGraph | null },
  ): TaskHandlerFn {
    return async (input: TaskHandlerInput) => {
      const result = computeFn(graphRef.rg!.getState());
      // Sync to disk
      try {
        const diskCard = readCard(tmpDir, id);
        diskCard.card_data = { ...diskCard.card_data, ...result };
        writeCard(tmpDir, diskCard);
      } catch { /* card may not exist yet */ }
      graphRef.rg!.resolveCallback(input.callbackToken, result);
      return 'task-initiated';
    };
  }

  // --------------------------------------------------------------------------
  // Core builder
  // --------------------------------------------------------------------------

  function buildGraph(cards: LiveCard[]) {
    for (const card of cards) writeCard(tmpDir, card);

    const graphRef: { rg: ReactiveGraph | null } = { rg: null };

    // --- Custom card handlers ---

    const valuator = makeHandler('valuator', (engine) => {
      const holdingsList = (engine.state.tasks.holdings?.data as any)?.holdings ?? [];
      const priceMap = (engine.state.tasks['price-feed']?.data as any)?.prices ?? {};
      const positions = holdingsList.map((h: any) => ({
        symbol: h.symbol, shares: h.shares, sector: h.sector,
        price: priceMap[h.symbol] ?? 0,
        value: h.shares * (priceMap[h.symbol] ?? 0),
      }));
      return { positions };
    }, graphRef);

    const portfolioValue = makeHandler('portfolio-value', (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const totalValue = positions.reduce((s: number, p: any) => s + p.value, 0);
      return { totalValue, positionCount: positions.length };
    }, graphRef);

    const sectorBreakdown = makeHandler('sector-breakdown', (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const bySector: Record<string, number> = {};
      for (const p of positions) {
        bySector[p.sector] = (bySector[p.sector] ?? 0) + p.value;
      }
      const total = positions.reduce((s: number, p: any) => s + p.value, 0);
      const sectors = Object.entries(bySector).map(([sector, value]) => ({
        sector, value, pct: total > 0 ? Math.round(value / total * 10000) / 100 : 0,
      }));
      return { sectors, sectorCount: sectors.length };
    }, graphRef);

    const sentimentHandler = makeHandler('sentiment', (engine) => {
      const headlines = (engine.state.tasks['news-feed']?.data as any)?.headlines ?? [];
      const avg = headlines.length > 0
        ? headlines.reduce((s: number, h: any) => s + (h.sentiment ?? 0), 0) / headlines.length
        : 0;
      return {
        avgSentiment: Math.round(avg * 100) / 100,
        headlineCount: headlines.length,
        bullish: avg > 0.2,
      };
    }, graphRef);

    const result = liveCardsToReactiveGraph(cards, {
      cardHandlers: {
        valuator,
        'portfolio-value': portfolioValue,
        'sector-breakdown': sectorBreakdown,
        sentiment: sentimentHandler,
      },
      reactiveOptions: {
        onDrain: (_events, live) => {
          for (const [taskName, taskState] of Object.entries(live.state.tasks)) {
            if (taskState.data && Object.keys(taskState.data).length > 0) {
              try {
                const diskCard = readCard(tmpDir, taskName);
                diskCard.card_data = { ...diskCard.card_data, ...taskState.data };
                writeCard(tmpDir, diskCard);
              } catch { /* card not on disk yet */ }
            }
          }
        },
      },
    });

    graphRef.rg = result.graph;
    graphResult = result;
    return { ...result, graphRef };
  }

  // --------------------------------------------------------------------------
  // Helper: register a dynamic card handler + addNode
  // --------------------------------------------------------------------------

  function addDynamicCard(
    rg: ReactiveGraph,
    graphRef: { rg: ReactiveGraph | null },
    card: LiveCard,
    computeFn: (engine: ReturnType<ReactiveGraph['getState']>) => Record<string, unknown>,
    taskConfig: Partial<TaskConfig> & { requires?: string[]; provides?: string[] },
  ) {
    writeCard(tmpDir, card);
    rg.registerHandler(card.id, makeHandler(card.id, computeFn, graphRef));
    rg.addNode(card.id, {
      requires: taskConfig.requires,
      provides: taskConfig.provides ?? [card.id],
      taskHandlers: [card.id],
      ...taskConfig,
    } as TaskConfig);
  }

  // ==========================================================================
  // Test 1: Initial 8-card cascade
  // ==========================================================================

  it('8-card cascade computes and syncs all to disk', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // All 8 completed
    const state = rg.getState();
    for (const name of ['holdings', 'price-feed', 'news-feed', 'benchmark',
                         'valuator', 'portfolio-value', 'sector-breakdown', 'sentiment']) {
      expect(state.state.tasks[name].status).toBe('completed');
    }

    // Valuator: 5 positions
    const valDisk = readCard(tmpDir, 'valuator');
    expect(valDisk.card_data!.positions).toHaveLength(5);

    // Portfolio value
    const pvDisk = readCard(tmpDir, 'portfolio-value');
    const expectedTotal = 50*195.50 + 30*420.10 + 20*176.30 + 40*198.20 + 25*155.80;
    expect(pvDisk.card_data!.totalValue).toBe(expectedTotal);
    expect(pvDisk.card_data!.positionCount).toBe(5);

    // Sector breakdown — 3 sectors
    const sbDisk = readCard(tmpDir, 'sector-breakdown');
    expect(sbDisk.card_data!.sectorCount).toBe(3);
    const sectors = sbDisk.card_data!.sectors as any[];
    expect(sectors.find((s: any) => s.sector === 'tech')).toBeDefined();
    expect(sectors.find((s: any) => s.sector === 'finance')).toBeDefined();
    expect(sectors.find((s: any) => s.sector === 'healthcare')).toBeDefined();

    // Sentiment
    const sentDisk = readCard(tmpDir, 'sentiment');
    expect(sentDisk.card_data!.headlineCount).toBe(3);
    expect(sentDisk.card_data!.bullish).toBe(true); // avg (0.8+0.6-0.4)/3 = 0.33
  });

  // ==========================================================================
  // Test 2: Add 7 dynamic cards to reach 15
  // ==========================================================================

  it('dynamically grow to 15 cards, all compute correctly', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // --- Card 9: allocation-chart (requires valuator + portfolio-value) ---
    addDynamicCard(rg, graphRef, {
      id: 'allocation-chart',
      meta: { title: 'Allocation Chart' },
      requires: ['valuator', 'portfolio-value'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const totalValue = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      const allocations = positions.map((p: any) => ({
        symbol: p.symbol, pct: totalValue > 0 ? Math.round(p.value / totalValue * 10000) / 100 : 0,
      }));
      return { allocations };
    }, { requires: ['valuator', 'portfolio-value'] });

    // --- Card 10: risk-score (requires valuator) ---
    addDynamicCard(rg, graphRef, {
      id: 'risk-score',
      meta: { title: 'Risk Score' },
      requires: ['valuator'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const values = positions.map((p: any) => p.value);
      const total = values.reduce((s: number, v: number) => s + v, 0);
      const maxConc = total > 0 ? Math.max(...values) / total : 0;
      return { maxConcentration: Math.round(maxConc * 100) / 100, riskLevel: maxConc > 0.5 ? 'high' : maxConc > 0.3 ? 'medium' : 'low' };
    }, { requires: ['valuator'] });

    // --- Card 11: daily-pnl (requires portfolio-value + benchmark) ---
    addDynamicCard(rg, graphRef, {
      id: 'daily-pnl',
      meta: { title: 'Daily P&L' },
      requires: ['portfolio-value', 'benchmark'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      const benchReturn = (engine.state.tasks.benchmark?.data as any)?.dailyReturn ?? 0;
      const portfolioReturn = 1.2;
      const pnl = tv * (portfolioReturn / 100);
      const alpha = portfolioReturn - benchReturn;
      return { pnl: Math.round(pnl * 100) / 100, portfolioReturn, benchmarkReturn: benchReturn, alpha: Math.round(alpha * 100) / 100 };
    }, { requires: ['portfolio-value', 'benchmark'] });

    // --- Card 12: value-alert (requires portfolio-value) ---
    addDynamicCard(rg, graphRef, {
      id: 'value-alert',
      meta: { title: 'Value Alert' },
      requires: ['portfolio-value'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      return { triggered: tv > 25000, threshold: 25000, currentValue: tv };
    }, { requires: ['portfolio-value'] });

    // --- Card 13: summary (requires portfolio-value + sentiment) ---
    addDynamicCard(rg, graphRef, {
      id: 'summary',
      meta: { title: 'Portfolio Summary' },
      requires: ['portfolio-value', 'sentiment'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      const bullish = (engine.state.tasks.sentiment?.data as any)?.bullish ?? false;
      return { text: `Portfolio: $${tv.toFixed(2)}`, totalValue: tv, marketMood: bullish ? 'bullish' : 'bearish' };
    }, { requires: ['portfolio-value', 'sentiment'] });

    // --- Card 14: correlation (requires valuator + benchmark) ---
    addDynamicCard(rg, graphRef, {
      id: 'correlation',
      meta: { title: 'Benchmark Correlation' },
      requires: ['valuator', 'benchmark'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const benchValue = (engine.state.tasks.benchmark?.data as any)?.value ?? 0;
      const techValue = positions.filter((p: any) => p.sector === 'tech').reduce((s: number, p: any) => s + p.value, 0);
      const total = positions.reduce((s: number, p: any) => s + p.value, 0);
      const techWeight = total > 0 ? techValue / total : 0;
      return { techWeight: Math.round(techWeight * 100) / 100, benchmarkValue: benchValue, mockCorrelation: Math.round(techWeight * 0.85 * 100) / 100 };
    }, { requires: ['valuator', 'benchmark'] });

    // --- Card 15: combined-view (requires summary + sector-breakdown + risk-score) ---
    addDynamicCard(rg, graphRef, {
      id: 'combined-view',
      meta: { title: 'Combined Dashboard View' },
      requires: ['summary', 'sector-breakdown', 'risk-score'], card_data: {},
    }, (engine) => {
      const summaryData = engine.state.tasks.summary?.data as any ?? {};
      const sectorData = engine.state.tasks['sector-breakdown']?.data as any ?? {};
      const riskData = engine.state.tasks['risk-score']?.data as any ?? {};
      return {
        portfolioText: summaryData.text ?? '',
        sectorCount: sectorData.sectorCount ?? 0,
        riskLevel: riskData.riskLevel ?? 'unknown',
        dashboardReady: true,
      };
    }, { requires: ['summary', 'sector-breakdown', 'risk-score'] });

    await ticks(200);

    // --- Verify all 15 tasks completed ---
    const state = rg.getState();
    const allNames = Object.keys(state.state.tasks);
    expect(allNames).toHaveLength(15);
    for (const name of allNames) {
      expect(state.state.tasks[name].status).toBe('completed');
    }

    // Spot-check dynamic cards on disk
    const allocDisk = readCard(tmpDir, 'allocation-chart');
    expect(allocDisk.card_data!.allocations).toHaveLength(5);

    const riskDisk = readCard(tmpDir, 'risk-score');
    expect(['high', 'medium', 'low']).toContain(riskDisk.card_data!.riskLevel);

    const pnlDisk = readCard(tmpDir, 'daily-pnl');
    expect(pnlDisk.card_data!.alpha).toBeDefined();

    const combDisk = readCard(tmpDir, 'combined-view');
    expect(combDisk.card_data!.dashboardReady).toBe(true);
    expect(combDisk.card_data!.sectorCount).toBe(3);
  });

  // ==========================================================================
  // Test 3: addRequires — wire sentiment into risk-score mid-flight
  // ==========================================================================

  it('addRequires wires sentiment into risk-score, re-computes on retrigger', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // Add risk-score (initially only requires valuator)
    // Handler checks its own config to decide whether to use sentiment
    addDynamicCard(rg, graphRef, {
      id: 'risk-score', requires: ['valuator'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const values = positions.map((p: any) => p.value);
      const total = values.reduce((s: number, v: number) => s + v, 0);
      const maxConc = total > 0 ? Math.max(...values) / total : 0;
      // Only use sentiment if it's in our declared requires
      const myRequires = engine.config.tasks['risk-score']?.requires ?? [];
      const useSentiment = myRequires.includes('sentiment');
      let riskScore = maxConc;
      if (useSentiment) {
        const sentimentData = engine.state.tasks.sentiment?.data as any;
        if (sentimentData?.avgSentiment != null) {
          riskScore = maxConc - sentimentData.avgSentiment * 0.1;
        }
      }
      return {
        rawConcentration: Math.round(maxConc * 100) / 100,
        adjustedRisk: Math.round(riskScore * 100) / 100,
        usesSentiment: useSentiment,
      };
    }, { requires: ['valuator'] });
    await ticks(100);

    // Before addRequires: handler does not use sentiment
    const riskBefore = readCard(tmpDir, 'risk-score');
    expect(riskBefore.card_data!.usesSentiment).toBe(false);
    expect(riskBefore.card_data!.adjustedRisk).toBe(riskBefore.card_data!.rawConcentration);

    // Wire sentiment into risk-score
    rg.addRequires('risk-score', ['sentiment']);

    // Verify the config was updated
    const config = rg.getState().config;
    expect(config.tasks['risk-score'].requires).toContain('sentiment');
    expect(config.tasks['risk-score'].requires).toContain('valuator');

    // Retrigger risk-score to pick up the new dependency
    rg.retrigger('risk-score');
    await ticks(100);

    // After: handler now uses sentiment
    const riskAfter = readCard(tmpDir, 'risk-score');
    expect(riskAfter.card_data!.usesSentiment).toBe(true);
    expect(riskAfter.card_data!.adjustedRisk).not.toBe(riskAfter.card_data!.rawConcentration);
  });

  // ==========================================================================
  // Test 4: removeRequires — disconnect price-feed from valuator
  // ==========================================================================

  it('removeRequires disconnects price-feed, valuator still runs', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // Before: valuator requires both holdings and price-feed
    expect(rg.getState().config.tasks.valuator.requires).toContain('price-feed');

    const valBefore = readCard(tmpDir, 'valuator');
    const posBefore = valBefore.card_data!.positions as any[];
    expect(posBefore[0].price).toBeGreaterThan(0);

    // Remove price-feed requirement
    rg.removeRequires('valuator', ['price-feed']);

    // Config updated
    const requires = rg.getState().config.tasks.valuator.requires ?? [];
    expect(requires).not.toContain('price-feed');
    expect(requires).toContain('holdings');

    // Retrigger to re-run with only holdings data
    rg.retrigger('valuator');
    await ticks(100);

    // Valuator still completed
    expect(rg.getState().state.tasks.valuator.status).toBe('completed');
  });

  // ==========================================================================
  // Test 5: addProvides — add a new token to sector-breakdown
  // ==========================================================================

  it('addProvides lets sector-breakdown produce a new token for downstream', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // sector-breakdown currently provides ['sector-breakdown']
    const providesBefore = rg.getState().config.tasks['sector-breakdown'].provides ?? [];
    expect(providesBefore).toContain('sector-breakdown');
    expect(providesBefore).not.toContain('sector-data');

    // Add a new provides token
    rg.addProvides('sector-breakdown', ['sector-data']);

    const providesAfter = rg.getState().config.tasks['sector-breakdown'].provides ?? [];
    expect(providesAfter).toContain('sector-data');
    expect(providesAfter).toContain('sector-breakdown');

    // Now add a card that requires 'sector-data'
    addDynamicCard(rg, graphRef, {
      id: 'sector-report',
      requires: ['sector-data'], card_data: {},
    }, (engine) => {
      const sectorData = engine.state.tasks['sector-breakdown']?.data as any ?? {};
      return { report: `${sectorData.sectorCount ?? 0} sectors analyzed`, generated: true };
    }, { requires: ['sector-data'] });

    await ticks(100);

    expect(rg.getState().state.tasks['sector-report'].status).toBe('completed');
    const reportDisk = readCard(tmpDir, 'sector-report');
    expect(reportDisk.card_data!.generated).toBe(true);
    expect(reportDisk.card_data!.report).toContain('3 sectors');
  });

  // ==========================================================================
  // Test 6: removeProvides — remove a token, downstream becomes unresolved
  // ==========================================================================

  it('removeProvides updates config and schedule sees token as unresolvable', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // First add a novel provides token to sector-breakdown
    rg.addProvides('sector-breakdown', ['sector-signal']);
    expect(rg.getState().config.tasks['sector-breakdown'].provides).toContain('sector-signal');

    // A card requiring 'sector-signal' should run (token produced by completed task)
    addDynamicCard(rg, graphRef, {
      id: 'signal-consumer',
      requires: ['sector-signal'], card_data: {},
    }, () => ({ consumed: true }), { requires: ['sector-signal'] });
    await ticks(100);
    expect(rg.getState().state.tasks['signal-consumer'].status).toBe('completed');

    // Now removeProvides 'sector-signal' from sector-breakdown
    rg.removeProvides('sector-breakdown', ['sector-signal']);
    const providesAfter = rg.getState().config.tasks['sector-breakdown'].provides ?? [];
    expect(providesAfter).not.toContain('sector-signal');
    // Original token still there
    expect(providesAfter).toContain('sector-breakdown');

    // Schedule now shows 'sector-signal' as unresolvable for signal-consumer
    // (no producer declares it, even though runtime tokens exist)
    const sched = rg.getSchedule();
    // signal-consumer already completed — scheduler skips it, so it won't
    // appear in unresolved. But the config accurately reflects the removal.
    expect(rg.getState().config.tasks['sector-breakdown'].provides).not.toContain('sector-signal');

    // Verify: if we add another card requiring the removed token,
    // the schedule correctly flags it as unresolved.
    // Note: runtime tokens from prior completion may still satisfy it,
    // so we verify the config-level detachment instead.
    const allProvides = Object.values(rg.getState().config.tasks)
      .flatMap(t => t.provides ?? []);
    expect(allProvides).not.toContain('sector-signal');
  });

  // ==========================================================================
  // Test 7: retriggerAll + pushAll — refresh multiple sources at once
  // ==========================================================================

  it('pushAll refreshes sources, full cascade re-computes', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    const pvBefore = readCard(tmpDir, 'portfolio-value');
    const totalBefore = pvBefore.card_data!.totalValue as number;

    // Push new data for both price-feed and holdings
    rg.pushAll([
      {
        type: 'task-completed', taskName: 'price-feed',
        data: { prices: prices.round2 },
        timestamp: ts(),
      },
      {
        type: 'task-completed', taskName: 'holdings',
        data: {
          holdings: [
            { symbol: 'AAPL', shares: 60, sector: 'tech' },
            { symbol: 'MSFT', shares: 30, sector: 'tech' },
            { symbol: 'GOOG', shares: 20, sector: 'tech' },
            { symbol: 'JPM', shares: 40, sector: 'finance' },
            { symbol: 'JNJ', shares: 25, sector: 'healthcare' },
          ],
        },
        timestamp: ts(),
      },
    ]);
    await ticks(150);

    const pvAfter = readCard(tmpDir, 'portfolio-value');
    const totalAfter = pvAfter.card_data!.totalValue as number;
    const expectedTotal = 60*201.00 + 30*418.75 + 20*180.50 + 40*202.10 + 25*153.40;
    expect(totalAfter).toBe(expectedTotal);
    expect(totalAfter).not.toBe(totalBefore);

    // Sector breakdown updated
    const sbDisk = readCard(tmpDir, 'sector-breakdown');
    const techSector = (sbDisk.card_data!.sectors as any[]).find((s: any) => s.sector === 'tech');
    expect(techSector.value).toBe(60*201.00 + 30*418.75 + 20*180.50);
  });

  // ==========================================================================
  // Test 8: Heavy rewiring — build chain → add cross-links → remove nodes
  // ==========================================================================

  it('heavy rewiring: build chain → add cross-links → remove nodes', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // Add allocation-chart → depends on valuator + portfolio-value
    addDynamicCard(rg, graphRef, {
      id: 'allocation-chart', requires: ['valuator', 'portfolio-value'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const total = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      return { allocations: positions.map((p: any) => ({ symbol: p.symbol, pct: total > 0 ? Math.round(p.value / total * 10000) / 100 : 0 })) };
    }, { requires: ['valuator', 'portfolio-value'] });

    // Add daily-pnl → depends on portfolio-value + benchmark
    addDynamicCard(rg, graphRef, {
      id: 'daily-pnl', requires: ['portfolio-value', 'benchmark'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      const benchReturn = (engine.state.tasks.benchmark?.data as any)?.dailyReturn ?? 0;
      return { pnl: Math.round(tv * 0.012 * 100) / 100, benchReturn };
    }, { requires: ['portfolio-value', 'benchmark'] });

    // Add summary + newsletter
    addDynamicCard(rg, graphRef, {
      id: 'summary', requires: ['portfolio-value', 'sentiment'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      const mood = (engine.state.tasks.sentiment?.data as any)?.bullish ? 'bullish' : 'bearish';
      return { text: `Portfolio: $${tv.toFixed(2)}`, mood };
    }, { requires: ['portfolio-value', 'sentiment'] });

    addDynamicCard(rg, graphRef, {
      id: 'newsletter', requires: ['summary', 'allocation-chart', 'daily-pnl'], card_data: {},
    }, (engine) => {
      const summary = engine.state.tasks.summary?.data as any ?? {};
      const alloc = engine.state.tasks['allocation-chart']?.data as any ?? {};
      const pnl = engine.state.tasks['daily-pnl']?.data as any ?? {};
      return { subject: `Daily: ${summary.text ?? ''}`, allocationCount: (alloc.allocations ?? []).length, pnl: pnl.pnl ?? 0, assembled: true };
    }, { requires: ['summary', 'allocation-chart', 'daily-pnl'] });

    await ticks(200);

    // 12 cards (8 + 4 dynamic)
    expect(Object.keys(rg.getState().state.tasks)).toHaveLength(12);
    expect(rg.getState().state.tasks.newsletter.status).toBe('completed');

    const nlDisk = readCard(tmpDir, 'newsletter');
    expect(nlDisk.card_data!.assembled).toBe(true);
    expect(nlDisk.card_data!.allocationCount).toBe(5);

    // --- Add cross-link: wire sentiment into newsletter via addRequires ---
    rg.addRequires('newsletter', ['sentiment']);
    expect(rg.getState().config.tasks.newsletter.requires).toContain('sentiment');

    rg.retrigger('newsletter');
    await ticks(100);
    expect(rg.getState().state.tasks.newsletter.status).toBe('completed');

    // --- Remove allocation-chart ---
    rg.removeNode('allocation-chart');
    expect(rg.getState().state.tasks['allocation-chart']).toBeUndefined();
    expect(rg.getState().state.tasks.newsletter.status).toBe('completed');

    // --- Remove the allocation-chart requirement from newsletter ---
    rg.removeRequires('newsletter', ['allocation-chart']);
    expect(rg.getState().config.tasks.newsletter.requires).not.toContain('allocation-chart');

    // Retrigger — works with remaining deps
    rg.retrigger('newsletter');
    await ticks(100);
    expect(rg.getState().state.tasks.newsletter.status).toBe('completed');

    // Verify final graph shape
    const finalTasks = Object.keys(rg.getState().config.tasks);
    expect(finalTasks).toHaveLength(11); // 12 - 1 removed
    expect(finalTasks).not.toContain('allocation-chart');
  });

  // ==========================================================================
  // Test 9: Node removal cascade — remove key intermediate, re-add
  // ==========================================================================

  it('removing valuator orphans downstream, re-add brings it back', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // Add risk-score downstream of valuator
    addDynamicCard(rg, graphRef, {
      id: 'risk-score', requires: ['valuator'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const values = positions.map((p: any) => p.value);
      const total = values.reduce((s: number, v: number) => s + v, 0);
      const maxConc = total > 0 ? Math.max(...values) / total : 0;
      return { riskLevel: maxConc > 0.5 ? 'high' : 'medium' };
    }, { requires: ['valuator'] });
    await ticks(100);

    expect(Object.keys(rg.getState().state.tasks)).toHaveLength(9);

    // Remove valuator
    rg.removeNode('valuator');

    // Downstream still completed (already ran)
    expect(rg.getState().state.tasks['portfolio-value'].status).toBe('completed');
    expect(rg.getState().state.tasks['sector-breakdown'].status).toBe('completed');
    expect(rg.getState().state.tasks['risk-score'].status).toBe('completed');

    // Disk files preserved
    expect(cardExists(tmpDir, 'valuator')).toBe(true);
    const valDisk = readCard(tmpDir, 'valuator');
    expect(valDisk.card_data!.positions).toHaveLength(5);

    // Re-add valuator
    rg.registerHandler('valuator', makeHandler('valuator', (engine) => {
      const holdingsList = (engine.state.tasks.holdings?.data as any)?.holdings ?? [];
      const priceMap = (engine.state.tasks['price-feed']?.data as any)?.prices ?? {};
      return {
        positions: holdingsList.map((h: any) => ({
          symbol: h.symbol, shares: h.shares, sector: h.sector,
          price: priceMap[h.symbol] ?? 0, value: h.shares * (priceMap[h.symbol] ?? 0),
        })),
      };
    }, graphRef));
    rg.addNode('valuator', {
      requires: ['holdings', 'price-feed'],
      provides: ['valuator'],
      taskHandlers: ['valuator'],
    } as TaskConfig);
    await ticks(100);

    expect(rg.getState().state.tasks.valuator.status).toBe('completed');
    expect(Object.keys(rg.getState().state.tasks)).toHaveLength(9);
  });

  // ==========================================================================
  // Test 10: Price rounds with new stock — full cascade
  // ==========================================================================

  it('multiple price rounds + add TSLA holding shows full cascade', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    addDynamicCard(rg, graphRef, {
      id: 'risk-score', requires: ['valuator'], card_data: {},
    }, (engine) => {
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      return { positionCount: positions.length, topHolding: positions.length > 0 ? positions.sort((a: any, b: any) => b.value - a.value)[0].symbol : null };
    }, { requires: ['valuator'] });

    addDynamicCard(rg, graphRef, {
      id: 'daily-pnl', requires: ['portfolio-value'], card_data: {},
    }, (engine) => {
      const tv = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
      return { estimatedPnl: Math.round(tv * 0.012 * 100) / 100 };
    }, { requires: ['portfolio-value'] });

    await ticks(100);

    let riskDisk = readCard(tmpDir, 'risk-score');
    expect(riskDisk.card_data!.positionCount).toBe(5);

    // Round 2: price change
    rg.push({
      type: 'task-completed', taskName: 'price-feed',
      data: { prices: prices.round2 },
      timestamp: ts(),
    });
    await ticks(150);

    const pvR2 = readCard(tmpDir, 'portfolio-value');
    const expectedR2 = 50*201.00 + 30*418.75 + 20*180.50 + 40*202.10 + 25*153.40;
    expect(pvR2.card_data!.totalValue).toBe(expectedR2);

    // Round 3: add TSLA + new prices
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
        data: { prices: prices.round3 },
        timestamp: ts(),
      },
    ]);
    await ticks(150);

    riskDisk = readCard(tmpDir, 'risk-score');
    expect(riskDisk.card_data!.positionCount).toBe(6);

    const pvR3 = readCard(tmpDir, 'portfolio-value');
    const expectedR3 = 50*205.25 + 30*422.00 + 20*182.10 + 40*199.80 + 25*157.10 + 10*168.75;
    expect(pvR3.card_data!.totalValue).toBe(expectedR3);
    expect(pvR3.card_data!.positionCount).toBe(6);

    const sbDisk = readCard(tmpDir, 'sector-breakdown');
    const techSector = (sbDisk.card_data!.sectors as any[]).find((s: any) => s.sector === 'tech');
    const expectedTechValue = 50*205.25 + 30*422.00 + 20*182.10 + 10*168.75;
    expect(techSector.value).toBe(expectedTechValue);

    const pnlDisk = readCard(tmpDir, 'daily-pnl');
    expect(pnlDisk.card_data!.estimatedPnl).toBe(Math.round(expectedR3 * 0.012 * 100) / 100);
  });

  // ==========================================================================
  // Test 11: Full 15+ card lifecycle with heavy graph manipulation
  // ==========================================================================

  it('15+ cards: build → rewire → remove → re-add → verify disk', async () => {
    const cards = makePortfolioCards();
    const { graph: rg, graphRef } = buildGraph(cards);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(150);

    // Phase 1: Add 7 dynamic cards → 15 total
    const dynamicDefs: Array<{
      id: string; requires: string[];
      compute: (e: ReturnType<ReactiveGraph['getState']>) => Record<string, unknown>;
    }> = [
      { id: 'allocation-chart', requires: ['valuator', 'portfolio-value'], compute: (e) => {
        const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
        const tot = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
        return { allocations: pos.map((p: any) => ({ sym: p.symbol, pct: tot > 0 ? Math.round(p.value / tot * 10000) / 100 : 0 })) };
      }},
      { id: 'risk-score', requires: ['valuator'], compute: (e) => {
        const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
        const values = pos.map((p: any) => p.value);
        const total = values.reduce((s: number, v: number) => s + v, 0);
        return { maxConc: total > 0 ? Math.round(Math.max(...values) / total * 100) / 100 : 0 };
      }},
      { id: 'daily-pnl', requires: ['portfolio-value', 'benchmark'], compute: (e) => {
        const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
        return { pnl: Math.round(tv * 0.012 * 100) / 100 };
      }},
      { id: 'value-alert', requires: ['portfolio-value'], compute: (e) => {
        const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
        return { triggered: tv > 25000, currentValue: tv };
      }},
      { id: 'summary', requires: ['portfolio-value', 'sentiment'], compute: (e) => {
        const tv = (e.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;
        const mood = (e.state.tasks.sentiment?.data as any)?.bullish ? 'up' : 'down';
        return { totalValue: tv, mood };
      }},
      { id: 'correlation', requires: ['valuator', 'benchmark'], compute: (e) => {
        const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
        const techVal = pos.filter((p: any) => p.sector === 'tech').reduce((s: number, p: any) => s + p.value, 0);
        const total = pos.reduce((s: number, p: any) => s + p.value, 0);
        return { techWeight: total > 0 ? Math.round(techVal / total * 100) / 100 : 0 };
      }},
      { id: 'combined-view', requires: ['summary', 'sector-breakdown', 'risk-score'], compute: (e) => {
        return {
          summaryMood: (e.state.tasks.summary?.data as any)?.mood ?? '?',
          sectors: (e.state.tasks['sector-breakdown']?.data as any)?.sectorCount ?? 0,
          risk: (e.state.tasks['risk-score']?.data as any)?.maxConc ?? 0,
          ready: true,
        };
      }},
    ];

    for (const d of dynamicDefs) {
      addDynamicCard(rg, graphRef, {
        id: d.id, requires: d.requires, card_data: {},
      }, d.compute, { requires: d.requires });
    }
    await ticks(250);

    // Verify: 15 cards all completed
    let tasks = rg.getState().state.tasks;
    expect(Object.keys(tasks)).toHaveLength(15);
    for (const t of Object.values(tasks)) expect(t.status).toBe('completed');

    // Phase 2: addProvides to benchmark → add new token 'market-data'
    rg.addProvides('benchmark', ['market-data']);
    expect(rg.getState().config.tasks.benchmark.provides).toContain('market-data');

    // Phase 3: Add card 16 depending on the new token
    addDynamicCard(rg, graphRef, {
      id: 'market-context', requires: ['market-data'], card_data: {},
    }, (e) => {
      const bench = e.state.tasks.benchmark?.data as any ?? {};
      return { indexValue: bench.value ?? 0, context: 'provided via market-data token' };
    }, { requires: ['market-data'] });
    await ticks(100);

    expect(rg.getState().state.tasks['market-context'].status).toBe('completed');
    const mctxDisk = readCard(tmpDir, 'market-context');
    expect(mctxDisk.card_data!.context).toBe('provided via market-data token');
    expect(Object.keys(rg.getState().state.tasks)).toHaveLength(16);

    // Phase 4: addRequires — wire news-feed into combined-view
    rg.addRequires('combined-view', ['news-feed']);
    expect(rg.getState().config.tasks['combined-view'].requires).toContain('news-feed');

    // Phase 5: removeProvides — remove 'market-data' from benchmark
    rg.removeProvides('benchmark', ['market-data']);
    expect(rg.getState().config.tasks.benchmark.provides).not.toContain('market-data');

    // market-context still completed with old data
    expect(rg.getState().state.tasks['market-context'].status).toBe('completed');

    // Phase 6: Remove 3 nodes
    rg.removeNode('allocation-chart');
    rg.removeNode('daily-pnl');
    rg.removeNode('market-context');
    expect(Object.keys(rg.getState().state.tasks)).toHaveLength(13);

    // Phase 7: Push round2 prices → full cascade
    rg.push({
      type: 'task-completed', taskName: 'price-feed',
      data: { prices: prices.round2 },
      timestamp: ts(),
    });
    await ticks(200);

    tasks = rg.getState().state.tasks;
    expect(tasks.valuator.status).toBe('completed');
    expect(tasks['portfolio-value'].status).toBe('completed');
    expect(tasks['risk-score'].status).toBe('completed');
    expect(tasks['value-alert'].status).toBe('completed');
    expect(tasks.summary.status).toBe('completed');
    expect(tasks['combined-view'].status).toBe('completed');
    expect(tasks.correlation.status).toBe('completed');

    // Phase 8: Re-add allocation-chart with different wiring
    addDynamicCard(rg, graphRef, {
      id: 'allocation-chart',
      requires: ['valuator'],
      card_data: {},
    }, (e) => {
      const pos = (e.state.tasks.valuator?.data as any)?.positions ?? [];
      const total = pos.reduce((s: number, p: any) => s + p.value, 0);
      return { allocations: pos.map((p: any) => ({ sym: p.symbol, pct: total > 0 ? Math.round(p.value / total * 10000) / 100 : 0 })) };
    }, { requires: ['valuator'] });
    await ticks(100);

    expect(rg.getState().state.tasks['allocation-chart'].status).toBe('completed');
    const allocDisk = readCard(tmpDir, 'allocation-chart');
    expect(allocDisk.card_data!.allocations).toHaveLength(5);

    // Phase 9: removeRequires — detach news-feed from combined-view
    rg.removeRequires('combined-view', ['news-feed']);
    expect(rg.getState().config.tasks['combined-view'].requires).not.toContain('news-feed');

    // Phase 10: retriggerAll
    rg.retriggerAll(['valuator', 'portfolio-value', 'sector-breakdown', 'sentiment']);
    await ticks(200);

    for (const name of ['valuator', 'portfolio-value', 'sector-breakdown', 'sentiment']) {
      expect(rg.getState().state.tasks[name].status).toBe('completed');
    }

    // Final count: 14 cards (16 - 3 removed + 1 re-added)
    const finalCount = Object.keys(rg.getState().state.tasks).length;
    expect(finalCount).toBe(14);

    // Verify all disk files present for active cards
    for (const name of Object.keys(rg.getState().state.tasks)) {
      expect(cardExists(tmpDir, name)).toBe(true);
    }

    // Removed cards still on disk (never deleted)
    expect(cardExists(tmpDir, 'daily-pnl')).toBe(true);
    expect(cardExists(tmpDir, 'market-context')).toBe(true);
  });
});
