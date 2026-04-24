import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CardCompute, validateLiveCardDefinition } from '../../src/card-compute/index.js';
import type { ComputeNode } from '../../src/card-compute/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleBoardDir = path.join(repoRoot, 'examples', 'example-board');
const cardsDir = path.join(exampleBoardDir, 'cards');
// example-board1 keeps the original orders-domain cards used by the stable-outputs test.
const cardsDir1 = path.join(repoRoot, 'examples', 'example-board1', 'cards');

// ── portfolio-board seed data ────────────────────────────────────────────────
const HOLDINGS_SEED = [
  { ticker: 'AAPL',  quantity: 10, cost_basis: 150 },
  { ticker: 'MSFT',  quantity: 5,  cost_basis: 310 },
  { ticker: 'GOOGL', quantity: 2,  cost_basis: 280 },
  { ticker: 'TSLA',  quantity: 3,  cost_basis: 200 },
];

// Yahoo Finance chart API shape used by card-market-prices (chartApi source) and
// forwarded as the `quotes` token consumed by card-portfolio-value.
const QUOTES_SEED = {
  quoteResponse: {
    result: [
      { symbol: 'AAPL',  shortName: 'Apple Inc.',  regularMarketPrice: 180, regularMarketChange:  2.5, regularMarketChangePercent:  1.41 },
      { symbol: 'MSFT',  shortName: 'Microsoft',   regularMarketPrice: 420, regularMarketChange: -1.2, regularMarketChangePercent: -0.28 },
      { symbol: 'GOOGL', shortName: 'Alphabet',    regularMarketPrice: 165, regularMarketChange:  0.8, regularMarketChangePercent:  0.49 },
      { symbol: 'TSLA',  shortName: 'Tesla',       regularMarketPrice: 250, regularMarketChange: -5.0, regularMarketChangePercent: -1.96 },
    ],
  },
};

const POSITIONS_SEED = [
  { ticker: 'AAPL',  quantity: 10, cost_basis: 150, price: 180, value: 1800, 'gain_$':  300, 'gain_%':  20,    'chg_$':  25,  chg_pct:  1.41 },
  { ticker: 'MSFT',  quantity: 5,  cost_basis: 310, price: 420, value: 2100, 'gain_$':  550, 'gain_%':  35.48, 'chg_$':  -6,  chg_pct: -0.28 },
  { ticker: 'GOOGL', quantity: 2,  cost_basis: 280, price: 165, value:  330, 'gain_$': -230, 'gain_%': -41.07, 'chg_$':   1.6, chg_pct:  0.49 },
  { ticker: 'TSLA',  quantity: 3,  cost_basis: 200, price: 250, value:  750, 'gain_$':  150, 'gain_%':  25,    'chg_$': -15,  chg_pct: -1.96 },
];

// Mock fetched_sources injected as node._sourcesData for cards that have external
// sources (copilot / chartApi / http) which are not executed in unit tests.
const CARD_SOURCE_MOCKS: Record<string, Record<string, unknown>> = {
  'card-market-prices': {
    quotes: QUOTES_SEED,
  },
  'card-portfolio-intelligence': {
    analysis: {
      mix:    '- AAPL dominates at 36% of portfolio\n- All positions in US tech/growth',
      pnl:    '- Best: MSFT +35.5% (+$550)\n- Worst: GOOGL -41.1% (-$230)',
      risks:  '- AAPL: earnings next week\n- MSFT: antitrust probe\n- GOOGL: ad revenue slowdown\n- TSLA: delivery report due',
      action: '- Trim GOOGL and rotate into a dividend ETF given persistent underperformance',
    },
  },
};

// ── orders-domain seed data (used by example-board1 stable-outputs test) ────
const ORDER_SEED = [
  { id: 'ORD-1001', product: 'Widget A', quantity: 3, amount: 12400, region: 'North' },
  { id: 'ORD-1002', product: 'Widget B', quantity: 2, amount: 8700,  region: 'South' },
  { id: 'ORD-1003', product: 'Widget A', quantity: 4, amount: 15200, region: 'East'  },
  { id: 'ORD-1004', product: 'Widget C', quantity: 1, amount: 6300,  region: 'West'  },
  { id: 'ORD-1005', product: 'Widget B', quantity: 2, amount: 9100,  region: 'North' },
  { id: 'ORD-1006', product: 'Widget C', quantity: 3, amount: 9800,  region: 'South' },
];

const PRICE_SEED = [
  { product: 'Widget A', price: 4133.33, currency: 'USD' },
  { product: 'Widget B', price: 4450.0,  currency: 'USD' },
  { product: 'Widget C', price: 3266.67, currency: 'USD' },
];

const REGION_TOTALS_SEED = [
  { region: 'North', total: 21500 },
  { region: 'South', total: 18500 },
  { region: 'East',  total: 15200 },
  { region: 'West',  total:  6300 },
];

const TOP_REGION_SEED = { region: 'North', total: 21500 };

const TOKEN_FIXTURES: Record<string, unknown> = {
  // portfolio board
  holdings:         HOLDINGS_SEED,
  quotes:           QUOTES_SEED,
  positions:        POSITIONS_SEED,
  portfolio_mix:    '- AAPL dominates at 36%\n- Tech-heavy',
  portfolio_pnl:    '- Best: MSFT\n- Worst: GOOGL',
  portfolio_risks:  '- AAPL: earnings risk',
  portfolio_action: '- Trim GOOGL',
  // example-board1 orders domain
  orders:        ORDER_SEED,
  prices:        PRICE_SEED,
  selections:    {},
  'card-ex-form': { preferences: { favoriteProduct: 'Widget A', preferredRegion: 'North' } },
  regionTotals:  REGION_TOTALS_SEED,
  topRegion:     TOP_REGION_SEED,
};

function listCardFiles(): string[] {
  return fs.readdirSync(cardsDir).filter(file => file.endsWith('.json')).sort();
}

function readCard(cardFile: string, dir = cardsDir): ComputeNode {
  return JSON.parse(fs.readFileSync(path.join(dir, cardFile), 'utf8')) as ComputeNode;
}

function buildRequires(card: ComputeNode): Record<string, unknown> {
  const requires = Array.isArray(card.requires) ? card.requires : [];
  const missing = requires.filter(token => !(token in TOKEN_FIXTURES));

  expect(
    missing,
    `${card.id ?? 'unknown-card'} requires example fixtures for: ${missing.join(', ')}`,
  ).toEqual([]);

  return Object.fromEntries(requires.map(token => [token, TOKEN_FIXTURES[token]]));
}

async function computeCard(cardFile: string, requires: Record<string, unknown>, dir = cardsDir): Promise<ComputeNode> {
  const node = readCard(cardFile, dir);
  node.requires = requires;
  await CardCompute.run(node);
  return node;
}

function resolvePath(obj: unknown, pathValue: string): unknown {
  return pathValue.split('.').reduce<unknown>((current, key) => {
    if (current == null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

describe('example-board', () => {
  it('keeps all example-board card definitions valid', () => {
    for (const file of listCardFiles()) {
      const node = readCard(file);
      const result = validateLiveCardDefinition(node);
      expect(result.ok, `${file}: ${result.errors.join('; ')}`).toBe(true);
    }
  });

  it('smoke-runs compute for every example-board card with compute steps', async () => {
    for (const file of listCardFiles()) {
      const node = readCard(file);
      if (!Array.isArray(node.compute) || node.compute.length === 0) continue;

      node.requires = buildRequires(node);
      // Pass mock fetched_sources for cards with external sources (copilot/chartApi/http)
      // that are not executed during unit tests.
      const sourcesData = node.id ? CARD_SOURCE_MOCKS[node.id] : undefined;
      await CardCompute.run(node, sourcesData ? { sourcesData } : undefined);

      expect(node.computed_values, `${file} should populate computed_values`).toBeTruthy();
      for (const step of node.compute) {
        expect(
          resolvePath(node.computed_values, step.bindTo),
          `${file} should populate computed_values.${step.bindTo}`,
        ).not.toBeUndefined();
      }
    }
  });

  it('produces stable compute outputs for representative cards (example-board1)', async () => {
    const filterCard = await computeCard('card-ex-filter.json', { orders: ORDER_SEED }, cardsDir1);
    expect(filterCard.computed_values).toEqual({
      region: ['East', 'North', 'South', 'West'],
      product: ['Widget A', 'Widget B', 'Widget C'],
    });

    const metricCard = await computeCard('card-ex-metric.json', { orders: ORDER_SEED }, cardsDir1);
    expect(metricCard.computed_values?.totalRevenue).toBe(61500);

    const listCard = await computeCard('card-ex-list.json', { orders: ORDER_SEED }, cardsDir1);
    expect(Array.from((listCard.computed_values?.topProducts as Iterable<string>) ?? [])).toEqual([
      'Widget A — $15200',
      'Widget A — $12400',
      'Widget C — $9800',
      'Widget B — $9100',
      'Widget B — $8700',
    ]);

    const tableCard = await computeCard('card-ex-table.json', {
      orders: ORDER_SEED,
      selections: { region: 'North' },
    }, cardsDir1);
    expect(Array.from((tableCard.computed_values?.filtered as Iterable<Record<string, unknown>>) ?? [])).toEqual([
      { id: 'ORD-1001', product: 'Widget A', quantity: 3, amount: 12400, region: 'North' },
      { id: 'ORD-1005', product: 'Widget B', quantity: 2, amount: 9100, region: 'North' },
    ]);

    const statusCard = await computeCard('card-ex-status.json', { orders: ORDER_SEED }, cardsDir1);
    expect(statusCard.computed_values?.health).toEqual({
      label: 'Moderate',
      value: 61500,
      orders: 6,
    });

    const chartCard = await computeCard('card-ex-chart.json', { orders: ORDER_SEED }, cardsDir1);
    const normalizedChart = [...((chartCard.computed_values?.regionCounts as Array<{ region: string; count: number }>) ?? [])]
      .sort((a, b) => a.region.localeCompare(b.region));
    expect(normalizedChart).toEqual([
      { region: 'East', count: 1 },
      { region: 'North', count: 2 },
      { region: 'South', count: 2 },
      { region: 'West', count: 1 },
    ]);

    const sourceHttpCard = await computeCard('card-ex-source-http.json', {
      orders: ORDER_SEED,
      prices: PRICE_SEED,
    }, cardsDir1);
    expect(sourceHttpCard.computed_values?.PRODUCT_LIST).toBe('Widget A,Widget B,Widget C');
  });
});