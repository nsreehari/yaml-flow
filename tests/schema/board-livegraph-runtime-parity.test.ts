/**
 * Guard test: verifies that the built browser/board-livegraph-runtime.js bundle
 * exposes the same runtime behaviour as the TypeScript source.
 *
 * Specifically checks that:
 *  - createBoardLiveGraphRuntime is exported from the IIFE bundle
 *  - A card executes end-to-end (sources → compute → provides)
 *  - getNodes() returns nodes with the correct shape:
 *      { id, fetched_sources, computed_values, requires, card_data, runtime_state }
 *  - fetched_sources, computed_values and requires are populated correctly
 *
 * If this test fails it means the browser bundle is out of date with the TS source
 * and `npm run build:browser` must be re-run.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import jsonata from 'jsonata';

import { createBoardLiveGraphRuntime as serverCreateRuntime } from '../../src/board-livegraph-runtime/index.js';
import type { LiveCardRuntimeModel } from '../../src/board-livegraph-runtime/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserBundlePath = path.join(repoRoot, 'browser', 'board-livegraph-runtime.js');

type BoardLiveGraphRuntimeApi = {
  createBoardLiveGraphRuntime: typeof serverCreateRuntime;
};

// The IIFE sets BoardLiveGraph as non-configurable, so we load once and cache.
let _cachedBrowserApi: BoardLiveGraphRuntimeApi | null = null;

function loadBrowserRuntime(): BoardLiveGraphRuntimeApi {
  if (_cachedBrowserApi) return _cachedBrowserApi;

  (globalThis as Record<string, unknown>).jsonata = jsonata;

  const source = fs.readFileSync(browserBundlePath, 'utf-8');
  vm.runInThisContext(source, { filename: browserBundlePath });

  const api = (globalThis as Record<string, unknown>).BoardLiveGraph;
  if (!api || typeof api !== 'object') {
    throw new Error(
      'Failed to load browser BoardLiveGraph API — run "npm run build:browser" first.',
    );
  }
  const factory = (api as Record<string, unknown>).createBoardLiveGraphRuntime;
  if (typeof factory !== 'function') {
    throw new Error(
      'browser/board-livegraph-runtime.js does not export createBoardLiveGraphRuntime — ' +
      'bundle is out of sync with the TypeScript source.',
    );
  }
  _cachedBrowserApi = api as BoardLiveGraphRuntimeApi;
  return _cachedBrowserApi;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Run a board, wait for all cards to reach completed/failed, return nodes. */
async function getNodeSnapshot(
  createRuntime: typeof serverCreateRuntime,
  cards: Parameters<typeof serverCreateRuntime>[0],
  taskExecutor: Parameters<typeof serverCreateRuntime>[1]['taskExecutor'],
): Promise<LiveCardRuntimeModel[]> {
  const rt = createRuntime(cards, { taskExecutor });
  const cardIds = cards.map((c) => (c as { id: string }).id);

  rt.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });

  // Poll until all cards complete (or 5 s timeout)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(50);
    const state = rt.getState();
    const allDone = cardIds.every((id) => {
      const s = state.state.tasks[id]?.status;
      return s === 'completed' || s === 'failed';
    });
    if (allDone) break;
  }

  const nodes = rt.getNodes();
  rt.dispose();
  return nodes;
}

const CARDS = [
  {
    id: 'src-card',
    provides: [{ bindTo: 'orders', src: 'fetched_sources.raw' }],
    sources: [{ bindTo: 'raw', mock: 'orders' }],
    card_data: {},
  },
  {
    id: 'compute-card',
    requires: ['orders'],
    compute: [
      { bindTo: 'total', expr: '$sum(requires.orders.amount)' },
      { bindTo: 'count', expr: '$count(requires.orders)' },
    ],
    card_data: {},
  },
] as Parameters<typeof serverCreateRuntime>[0];

const ORDER_DATA = [
  { id: 'O1', amount: 100 },
  { id: 'O2', amount: 200 },
];

const mockExecutor: Parameters<typeof serverCreateRuntime>[1]['taskExecutor'] = async ({ card }) => {
  const out: Record<string, unknown> = {};
  for (const src of card.sources ?? []) {
    if (src.mock === 'orders') out[src.bindTo] = ORDER_DATA;
  }
  return out;
};

describe('board-livegraph-runtime browser/TS parity', () => {
  it('browser bundle exports createBoardLiveGraphRuntime', () => {
    const api = loadBrowserRuntime();
    expect(typeof api.createBoardLiveGraphRuntime).toBe('function');
  });

  it('node shape matches between server and browser after execution', async () => {
    const { createBoardLiveGraphRuntime: browserCreate } = loadBrowserRuntime();

    const [serverNodes, browserNodes] = await Promise.all([
      getNodeSnapshot(serverCreateRuntime, CARDS, mockExecutor),
      getNodeSnapshot(browserCreate, CARDS, mockExecutor),
    ]);

    // Both should return models for every card
    expect(browserNodes.map((n) => n.id).sort()).toEqual(serverNodes.map((n) => n.id).sort());

    for (const serverNode of serverNodes) {
      const browserNode = browserNodes.find((n) => n.id === serverNode.id);
      expect(browserNode, `browser missing node for ${serverNode.id}`).toBeDefined();
      if (!browserNode) continue;

      // Shape: required top-level keys must be present
      const requiredKeys: (keyof LiveCardRuntimeModel)[] = [
        'id', 'card', 'card_data', 'fetched_sources', 'requires', 'computed_values', 'runtime_state',
      ];
      for (const key of requiredKeys) {
        expect(browserNode, `browser node "${serverNode.id}" missing key "${key}"`).toHaveProperty(key);
      }

      // computed_values must match
      expect(browserNode.computed_values).toEqual(serverNode.computed_values);

      // fetched_sources must match
      expect(browserNode.fetched_sources).toEqual(serverNode.fetched_sources);
    }
  });

  it('src-card fetched_sources.raw is populated from taskExecutor', async () => {
    const { createBoardLiveGraphRuntime: browserCreate } = loadBrowserRuntime();

    const nodes = await getNodeSnapshot(browserCreate, CARDS, mockExecutor);
    const srcNode = nodes.find((n) => n.id === 'src-card');

    expect(srcNode).toBeDefined();
    expect(srcNode!.fetched_sources).toEqual({ raw: ORDER_DATA });
  });

  it('compute-card computed_values are derived from requires.orders', async () => {
    const { createBoardLiveGraphRuntime: browserCreate } = loadBrowserRuntime();

    const nodes = await getNodeSnapshot(browserCreate, CARDS, mockExecutor);
    const computeNode = nodes.find((n) => n.id === 'compute-card');

    expect(computeNode).toBeDefined();
    expect(computeNode!.computed_values).toEqual({ total: 300, count: 2 });
  });
});
