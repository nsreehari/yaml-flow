/**
 * Guard test: verifies that the supported browser localstorage bundle re-exports
 * the same selector surface as the TypeScript source.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  selectAllLiveCardModels as selectAllLiveCardModelsSource,
  selectLiveCardModel as selectLiveCardModelSource,
  type BoardRuntimeArtifactsPayload,
} from '../../src/board-livegraph-runtime/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserBundlePath = path.join(repoRoot, 'browser', 'board-livecards-localstorage.js');

type BoardLiveCardsLocalStorageApi = {
  create: (namespace: string, opts?: Record<string, unknown>) => unknown;
  selectLiveCardModel: typeof selectLiveCardModelSource;
  selectAllLiveCardModels: typeof selectAllLiveCardModelsSource;
};

let _cachedBrowserApi: BoardLiveCardsLocalStorageApi | null = null;

const PAYLOAD: BoardRuntimeArtifactsPayload = {
  cardDefinitions: [
    {
      id: 'portfolio',
      card_data: { title: 'Portfolio', holdings: [{ symbol: 'MSFT', qty: 3 }] },
      requires: ['prices'],
    },
    {
      id: 'prices',
      card_data: { title: 'Prices' },
      provides: [{ bindTo: 'prices', ref: 'card_data.snapshot' }],
    },
  ],
  cardRuntimeById: {
    portfolio: {
      schema_version: 'v1',
      card_id: 'portfolio',
      card_data: { subtitle: 'Updated from runtime' },
      computed_values: { totalValue: 1234 },
    },
  },
  dataObjectsByToken: {
    prices: { MSFT: 412.2 },
    alerts: [{ level: 'info' }],
  },
  statusSnapshot: {
    cards: [
      {
        name: 'portfolio',
        status: 'completed',
        runtime: { last_transition_at: '2026-05-13T00:00:00.000Z' },
      },
      {
        name: 'prices',
        status: 'failed',
        runtime: { last_transition_at: '2026-05-13T00:01:00.000Z' },
        error: { message: 'upstream failed' },
      },
    ],
  },
};

function loadBrowserRuntime(): BoardLiveCardsLocalStorageApi {
  if (_cachedBrowserApi) return _cachedBrowserApi;

  const source = fs.readFileSync(browserBundlePath, 'utf-8');
  vm.runInThisContext(source, { filename: browserBundlePath });

  const api = (globalThis as Record<string, unknown>).BoardLiveCardsLocalStorage;
  if (!api || typeof api !== 'object') {
    throw new Error(
      'Failed to load browser BoardLiveCardsLocalStorage API — run "npm run build:browser" first.',
    );
  }
  const create = (api as Record<string, unknown>).create;
  const selectLiveCardModel = (api as Record<string, unknown>).selectLiveCardModel;
  const selectAllLiveCardModels = (api as Record<string, unknown>).selectAllLiveCardModels;
  if (typeof create !== 'function' || typeof selectLiveCardModel !== 'function' || typeof selectAllLiveCardModels !== 'function') {
    throw new Error(
      'browser/board-livecards-localstorage.js does not export the supported localstorage bundle API — ' +
      'bundle is out of sync with the TypeScript source.',
    );
  }
  _cachedBrowserApi = api as BoardLiveCardsLocalStorageApi;
  return _cachedBrowserApi;
}
describe('board-livecards-localstorage browser/TS parity', () => {
  it('browser bundle exports the supported localstorage surface', () => {
    const api = loadBrowserRuntime();
    expect(typeof api.create).toBe('function');
    expect(typeof api.selectLiveCardModel).toBe('function');
    expect(typeof api.selectAllLiveCardModels).toBe('function');
  });

  it('selectLiveCardModel matches the TypeScript source behavior', () => {
    const api = loadBrowserRuntime();
    expect(api.selectLiveCardModel(PAYLOAD, 'portfolio')).toEqual(
      selectLiveCardModelSource(PAYLOAD, 'portfolio'),
    );
  });

  it('selectAllLiveCardModels matches the TypeScript source behavior', () => {
    const api = loadBrowserRuntime();
    expect(api.selectAllLiveCardModels(PAYLOAD)).toEqual(
      selectAllLiveCardModelsSource(PAYLOAD),
    );
  });
});
