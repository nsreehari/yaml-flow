/**
 * Live Cards Disk Roundtrip — Integration Test
 *
 * Tests the full lifecycle:
 *   1. Write 4 live card JSONs to disk (stock portfolio theme)
 *   2. Load them, feed into liveCardsToReactiveGraph
 *   3. Wrap every handler with an "update-card" layer that writes
 *      the card JSON back to disk after each task completes
 *   4. Simulate events → verify disk state
 *   5. addNode (chart card) → verify new card on disk
 *   6. removeNode (portfolio-value) → verify disk reflects removal
 *   7. More dynamic mutations + verifications
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

/** Read a card JSON from disk. */
function readCard(dir: string, id: string): LiveCard {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8'));
}

/** Write a card JSON to disk. */
function writeCard(dir: string, card: LiveCard): void {
  fs.writeFileSync(path.join(dir, `${card.id}.json`), JSON.stringify(card, null, 2));
}

// ============================================================================
// Card definitions (stock portfolio theme)
// ============================================================================

function makePortfolioCards(): LiveCard[] {
  const holdings: LiveCard = {
    id: 'holdings',
    type: 'source',
    meta: { title: 'Portfolio Holdings' },
    data: { provides: { holdings: 'state.holdings' } },
    state: {
      holdings: [
        { symbol: 'AAPL', shares: 50 },
        { symbol: 'MSFT', shares: 30 },
        { symbol: 'GOOG', shares: 20 },
      ],
    },
  };

  const priceFeed: LiveCard = {
    id: 'price-feed',
    type: 'source',
    meta: { title: 'Live Price Feed' },
    data: { provides: { prices: 'state.prices' } },
    state: {
      prices: {
        AAPL: 195.50,
        MSFT: 420.10,
        GOOG: 176.30,
      },
    },
  };

  // valuator does a cross-reference join (holdings × prices) → positions.
  // CardCompute can't do cross-card joins, so we provide a cardHandler.
  const valuator: LiveCard = {
    id: 'valuator',
    type: 'card',
    meta: { title: 'Position Valuator' },
    data: { requires: ['holdings', 'price-feed'] },
    state: {},
  };

  // portfolio-value uses CardCompute: sum + count over valuator.positions
  const portfolioValue: LiveCard = {
    id: 'portfolio-value',
    type: 'card',
    meta: { title: 'Total Portfolio Value' },
    data: { requires: ['valuator'] },
    state: {},
    compute: {
      totalValue: { fn: 'sum', input: 'state.valuator.positions', field: 'value' },
      positionCount: { fn: 'count', input: 'state.valuator.positions' },
    },
  };

  return [holdings, priceFeed, valuator, portfolioValue];
}

// ============================================================================
// Simulated market prices
// ============================================================================

const marketPrices = {
  round1: { AAPL: 195.50, MSFT: 420.10, GOOG: 176.30 } as Record<string, number>,
  round2: { AAPL: 201.00, MSFT: 418.75, GOOG: 180.50 } as Record<string, number>,
};

// ============================================================================
// Test suite
// ============================================================================

describe('live cards → disk roundtrip integration', () => {
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
  // Core helper: build graph with disk-sync onDrain + valuator cardHandler
  // --------------------------------------------------------------------------

  function buildGraphWithDiskSync(
    cards: LiveCard[],
  ) {
    // Write cards to disk
    for (const card of cards) {
      writeCard(tmpDir, card);
    }

    let graphRef: ReactiveGraph | null = null;

    // Valuator: join holdings × prices → positions
    const valuatorHandler: TaskHandlerFn = async (input: TaskHandlerInput) => {
      const engine = graphRef!.getState();
      const holdingsData = engine.state.tasks.holdings?.data ?? {};
      const priceData = engine.state.tasks['price-feed']?.data ?? {};
      const holdingsList = (holdingsData as any).holdings ?? [];
      const prices = (priceData as any).prices ?? {};

      const positions = holdingsList.map((h: any) => ({
        symbol: h.symbol,
        shares: h.shares,
        price: prices[h.symbol] ?? 0,
        value: h.shares * (prices[h.symbol] ?? 0),
      }));

      graphRef!.resolveCallback(input.callbackToken, { positions });
      return 'task-initiated';
    };

    // Portfolio-value: sum positions from engine state (not via CardCompute sharedState)
    const portfolioValueHandler: TaskHandlerFn = async (input: TaskHandlerInput) => {
      const engine = graphRef!.getState();
      const valuatorData = engine.state.tasks.valuator?.data ?? {};
      const positions = (valuatorData as any).positions ?? [];
      const totalValue = positions.reduce((s: number, p: any) => s + (p.value ?? 0), 0);
      const positionCount = positions.length;

      graphRef!.resolveCallback(input.callbackToken, { totalValue, positionCount });
      return 'task-initiated';
    };

    const result = liveCardsToReactiveGraph(cards, {
      cardHandlers: {
        valuator: valuatorHandler,
        'portfolio-value': portfolioValueHandler,
      },
      reactiveOptions: {
        onDrain: (_events, live) => {
          // After each drain, sync all task data back to disk
          for (const [taskName, taskState] of Object.entries(live.state.tasks)) {
            if (taskState.data && Object.keys(taskState.data).length > 0) {
              try {
                const diskCard = readCard(tmpDir, taskName);
                diskCard.state = { ...diskCard.state, ...taskState.data };
                writeCard(tmpDir, diskCard);
              } catch {
                // Card may not exist on disk yet (e.g. dynamically added)
              }
            }
          }
        },
      },
    });

    graphRef = result.graph;
    graphResult = result;
    return result;
  }

  // --------------------------------------------------------------------------
  // Test 1: Initial cascade — all 4 cards compute and sync to disk
  // --------------------------------------------------------------------------

  it('step 1-5: initial cascade computes all cards and syncs to disk', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Push to trigger the cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    // Verify engine state — all completed
    const state = rg.getState();
    expect(state.state.tasks.holdings.status).toBe('completed');
    expect(state.state.tasks['price-feed'].status).toBe('completed');
    expect(state.state.tasks.valuator.status).toBe('completed');
    expect(state.state.tasks['portfolio-value'].status).toBe('completed');

    // Verify disk: holdings card
    const holdingsOnDisk = readCard(tmpDir, 'holdings');
    expect(holdingsOnDisk.state!.holdings).toHaveLength(3);
    expect((holdingsOnDisk.state!.holdings as any[])[0].symbol).toBe('AAPL');

    // Verify disk: price-feed card
    const pricesOnDisk = readCard(tmpDir, 'price-feed');
    expect((pricesOnDisk.state!.prices as any).AAPL).toBe(195.50);

    // Verify disk: valuator — positions with computed values
    const valuatorOnDisk = readCard(tmpDir, 'valuator');
    const positions = valuatorOnDisk.state!.positions as any[];
    expect(positions).toHaveLength(3);
    const aaplPos = positions.find((p: any) => p.symbol === 'AAPL');
    expect(aaplPos.shares).toBe(50);
    expect(aaplPos.price).toBe(195.50);
    expect(aaplPos.value).toBe(50 * 195.50);

    // Verify disk: portfolio-value — totals from CardCompute
    const pvOnDisk = readCard(tmpDir, 'portfolio-value');
    expect(pvOnDisk.state!.positionCount).toBe(3);
    expect(pvOnDisk.state!.totalValue).toBe(
      50 * 195.50 + 30 * 420.10 + 20 * 176.30,
    );
  });

  // --------------------------------------------------------------------------
  // Test 2: Simulate price update → data-changed cascade
  // --------------------------------------------------------------------------

  it('step 4: price update cascades through valuator and portfolio-value', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    const pvBefore = readCard(tmpDir, 'portfolio-value');
    const totalBefore = pvBefore.state!.totalValue as number;

    // Push new price data directly (simulates external price feed update)
    rg.push({
      type: 'task-completed',
      taskName: 'price-feed',
      data: { prices: marketPrices.round2 },
      timestamp: ts(),
    });
    await ticks(100);

    // Valuator and portfolio-value should have re-computed with new prices
    const pvAfter = readCard(tmpDir, 'portfolio-value');
    const totalAfter = pvAfter.state!.totalValue as number;

    const expectedTotal = 50 * 201.00 + 30 * 418.75 + 20 * 180.50;
    expect(totalAfter).toBe(expectedTotal);
    expect(totalAfter).not.toBe(totalBefore);

    // Valuator positions should reflect new prices
    const valuatorAfter = readCard(tmpDir, 'valuator');
    const positionsAfter = valuatorAfter.state!.positions as any[];
    const aaplPos = positionsAfter.find((p: any) => p.symbol === 'AAPL');
    expect(aaplPos.price).toBe(201.00);
    expect(aaplPos.value).toBe(50 * 201.00);
  });

  // --------------------------------------------------------------------------
  // Test 3: Add a new holding → cascade
  // --------------------------------------------------------------------------

  it('step 4: adding a holding recalculates portfolio', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    // Push both source updates — add TSLA
    const newHoldings = [
      { symbol: 'AAPL', shares: 50 },
      { symbol: 'MSFT', shares: 30 },
      { symbol: 'GOOG', shares: 20 },
      { symbol: 'TSLA', shares: 15 },
    ];
    const newPrices = { AAPL: 195.50, MSFT: 420.10, GOOG: 176.30, TSLA: 168.75 };

    rg.pushAll([
      {
        type: 'task-completed',
        taskName: 'holdings',
        data: { holdings: newHoldings },
        timestamp: ts(),
      },
      {
        type: 'task-completed',
        taskName: 'price-feed',
        data: { prices: newPrices },
        timestamp: ts(),
      },
    ]);
    await ticks(100);

    // Verify: 4 positions
    const valuatorOnDisk = readCard(tmpDir, 'valuator');
    const positions = valuatorOnDisk.state!.positions as any[];
    expect(positions).toHaveLength(4);
    expect(positions.find((p: any) => p.symbol === 'TSLA')).toBeDefined();

    // Total includes TSLA
    const pvOnDisk = readCard(tmpDir, 'portfolio-value');
    expect(pvOnDisk.state!.positionCount).toBe(4);
    const expectedTotal = 50 * 195.50 + 30 * 420.10 + 20 * 176.30 + 15 * 168.75;
    expect(pvOnDisk.state!.totalValue).toBe(expectedTotal);
  });

  // --------------------------------------------------------------------------
  // Test 4: addNode — dynamic chart card
  // --------------------------------------------------------------------------

  it('step 6-7: addNode for allocation-chart card, verify on disk', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    // Create chart card JSON
    const chartCard: LiveCard = {
      id: 'allocation-chart',
      type: 'card',
      meta: { title: 'Portfolio Allocation Chart' },
      data: { requires: ['valuator', 'portfolio-value'] },
      state: {},
    };
    writeCard(tmpDir, chartCard);

    // Register handler — compute allocation percentages
    rg.registerHandler('allocation-chart', async (input: TaskHandlerInput) => {
      const engine = rg.getState();
      const positions = (engine.state.tasks.valuator?.data as any)?.positions ?? [];
      const totalValue = (engine.state.tasks['portfolio-value']?.data as any)?.totalValue ?? 0;

      const allocations = positions.map((p: any) => ({
        symbol: p.symbol,
        value: p.value,
        pct: totalValue > 0 ? Math.round(p.value / totalValue * 10000) / 100 : 0,
      }));

      const result = { allocations };

      // Sync to disk
      const diskCard = readCard(tmpDir, chartCard.id);
      diskCard.state = { ...diskCard.state, ...result };
      writeCard(tmpDir, diskCard);

      rg.resolveCallback(input.callbackToken, result);
      return 'task-initiated';
    });

    // Add the node to the live graph
    rg.addNode('allocation-chart', {
      requires: ['valuator', 'portfolio-value'],
      provides: ['allocation-chart'],
      taskHandlers: ['allocation-chart'],
    } as TaskConfig);

    await ticks(100);

    // Verify: chart card computed on disk
    const chartOnDisk = readCard(tmpDir, 'allocation-chart');
    const allocations = chartOnDisk.state!.allocations as any[];
    expect(allocations).toHaveLength(3);

    // Percentages should sum to ~100
    const totalPct = allocations.reduce((s: number, a: any) => s + a.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);

    // AAPL allocation check
    const totalValue = 50 * 195.50 + 30 * 420.10 + 20 * 176.30;
    const aaplAlloc = allocations.find((a: any) => a.symbol === 'AAPL');
    expect(aaplAlloc.pct).toBeCloseTo((50 * 195.50 / totalValue) * 100, 1);

    // Engine confirms completed
    expect(rg.getState().state.tasks['allocation-chart'].status).toBe('completed');
  });

  // --------------------------------------------------------------------------
  // Test 5: removeNode — remove portfolio-value
  // --------------------------------------------------------------------------

  it('step 8-9: removeNode removes task from engine, disk card remains', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    // Verify portfolio-value completed
    expect(rg.getState().state.tasks['portfolio-value'].status).toBe('completed');

    // Remove from engine
    rg.removeNode('portfolio-value');

    // Engine no longer has the task
    expect(rg.getState().state.tasks['portfolio-value']).toBeUndefined();

    // Disk card still exists with its last computed state
    const pvOnDisk = readCard(tmpDir, 'portfolio-value');
    expect(pvOnDisk.state!.totalValue).toBeDefined();

    // Schedule doesn't include it
    const sched = rg.getSchedule();
    expect(sched.eligible).not.toContain('portfolio-value');
  });

  // --------------------------------------------------------------------------
  // Test 6: Full dynamic cycle — add, retrigger cascade, remove
  // --------------------------------------------------------------------------

  it('step 10: add risk-score → price change cascades → remove chain', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    // --- Phase A: Add "risk-score" card ---
    const riskCard: LiveCard = {
      id: 'risk-score',
      type: 'card',
      meta: { title: 'Portfolio Risk Score' },
      data: { requires: ['valuator'] },
      state: {},
    };
    writeCard(tmpDir, riskCard);

    rg.registerHandler('risk-score', async (input: TaskHandlerInput) => {
      const positions = (rg.getState().state.tasks.valuator?.data as any)?.positions ?? [];
      const values = positions.map((p: any) => p.value ?? 0);
      const total = values.reduce((s: number, v: number) => s + v, 0);
      const maxConcentration = total > 0 ? Math.max(...values) / total : 0;
      const riskLevel = maxConcentration > 0.5 ? 'high' : maxConcentration > 0.3 ? 'medium' : 'low';
      const result = { maxConcentration: Math.round(maxConcentration * 100) / 100, riskLevel };

      // Sync to disk
      const diskCard = readCard(tmpDir, riskCard.id);
      diskCard.state = { ...diskCard.state, ...result };
      writeCard(tmpDir, diskCard);

      rg.resolveCallback(input.callbackToken, result);
      return 'task-initiated';
    });

    rg.addNode('risk-score', {
      requires: ['valuator'],
      provides: ['risk-score'],
      taskHandlers: ['risk-score'],
    } as TaskConfig);

    await ticks(100);

    // Risk-score computed
    const riskOnDisk = readCard(tmpDir, 'risk-score');
    expect(riskOnDisk.state!.riskLevel).toBeDefined();
    expect(['high', 'medium', 'low']).toContain(riskOnDisk.state!.riskLevel);
    expect(rg.getState().state.tasks['risk-score'].status).toBe('completed');

    // --- Phase B: Price change → cascades through valuator → risk-score ---
    rg.push({
      type: 'task-completed',
      taskName: 'price-feed',
      data: { prices: marketPrices.round2 },
      timestamp: ts(),
    });
    await ticks(100);

    // Valuator re-ran with new prices
    const valuatorState = rg.getState().state.tasks.valuator;
    expect(valuatorState.status).toBe('completed');
    const newPositions = (valuatorState.data as any)?.positions ?? [];
    const aaplPos = newPositions.find((p: any) => p.symbol === 'AAPL');
    expect(aaplPos.price).toBe(201.00);

    // Risk-score also re-computed
    expect(rg.getState().state.tasks['risk-score'].status).toBe('completed');

    // --- Phase C: Remove valuator ---
    rg.removeNode('valuator');
    expect(rg.getState().state.tasks.valuator).toBeUndefined();

    // risk-score and portfolio-value already completed — scheduler skips them.
    // But the valuator token can no longer be produced (no producer in config).
    const configAfterRemove = rg.getState().config;
    expect(configAfterRemove.tasks.valuator).toBeUndefined();
    // risk-score still has its completed data intact
    expect(rg.getState().state.tasks['risk-score'].status).toBe('completed');
    expect(rg.getState().state.tasks['portfolio-value'].status).toBe('completed');

    // --- Phase D: Clean up — remove both orphaned nodes ---
    rg.removeNode('risk-score');
    rg.removeNode('portfolio-value');

    const remaining = Object.keys(rg.getState().state.tasks);
    expect(remaining).toEqual(expect.arrayContaining(['holdings', 'price-feed']));
    expect(remaining).not.toContain('valuator');
    expect(remaining).not.toContain('risk-score');
    expect(remaining).not.toContain('portfolio-value');

    // Disk still has all files
    expect(fs.existsSync(path.join(tmpDir, 'risk-score.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'valuator.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'portfolio-value.json'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // Test 7: Add multiple independent downstream nodes
  // --------------------------------------------------------------------------

  it('step 10: add summary + alert, both depend on portfolio-value', async () => {
    const cards = makePortfolioCards();
    const { graph: rg } = buildGraphWithDiskSync(cards);

    // Initial cascade
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    const totalValue = 50 * 195.50 + 30 * 420.10 + 20 * 176.30;

    // --- Add summary card ---
    writeCard(tmpDir, { id: 'summary', type: 'card', data: { requires: ['portfolio-value'] }, state: {} });

    rg.registerHandler('summary', async (input) => {
      const pvData = rg.getState().state.tasks['portfolio-value']?.data ?? {};
      const tv = (pvData as any).totalValue ?? 0;
      const result = { text: `Portfolio: $${tv.toFixed(2)}`, totalValue: tv };
      const diskCard = readCard(tmpDir, 'summary');
      diskCard.state = { ...diskCard.state, ...result };
      writeCard(tmpDir, diskCard);
      rg.resolveCallback(input.callbackToken, result);
      return 'task-initiated' as const;
    });

    rg.addNode('summary', {
      requires: ['portfolio-value'],
      provides: ['summary'],
      taskHandlers: ['summary'],
    } as TaskConfig);

    // --- Add alert card ---
    writeCard(tmpDir, { id: 'value-alert', type: 'card', data: { requires: ['portfolio-value'] }, state: {} });

    rg.registerHandler('value-alert', async (input) => {
      const pvData = rg.getState().state.tasks['portfolio-value']?.data ?? {};
      const tv = (pvData as any).totalValue ?? 0;
      const threshold = 25000;
      const result = { triggered: tv > threshold, threshold, currentValue: tv };
      const diskCard = readCard(tmpDir, 'value-alert');
      diskCard.state = { ...diskCard.state, ...result };
      writeCard(tmpDir, diskCard);
      rg.resolveCallback(input.callbackToken, result);
      return 'task-initiated' as const;
    });

    rg.addNode('value-alert', {
      requires: ['portfolio-value'],
      provides: ['value-alert'],
      taskHandlers: ['value-alert'],
    } as TaskConfig);

    await ticks(100);

    // Both completed
    expect(rg.getState().state.tasks.summary.status).toBe('completed');
    expect(rg.getState().state.tasks['value-alert'].status).toBe('completed');

    // Summary on disk
    const summaryOnDisk = readCard(tmpDir, 'summary');
    expect(summaryOnDisk.state!.text).toContain('Portfolio:');
    expect(summaryOnDisk.state!.totalValue).toBe(totalValue);

    // Alert on disk
    const alertOnDisk = readCard(tmpDir, 'value-alert');
    expect(alertOnDisk.state!.threshold).toBe(25000);
    expect(alertOnDisk.state!.triggered).toBe(totalValue > 25000);
    expect(alertOnDisk.state!.currentValue).toBe(totalValue);

    // Remove portfolio-value → summary and value-alert completed but orphaned.
    // (Completed tasks are skipped by scheduler, so they won't appear in unresolved.)
    rg.removeNode('portfolio-value');
    expect(rg.getState().config.tasks['portfolio-value']).toBeUndefined();
    // summary and value-alert still have their completed data
    expect(rg.getState().state.tasks.summary.status).toBe('completed');
    expect(rg.getState().state.tasks['value-alert'].status).toBe('completed');
  });
});
