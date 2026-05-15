import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  applyNotification as applyNotificationSource,
  buildBoardState as buildBoardStateSource,
  deriveBoardState as deriveBoardStateSource,
} from '../../src/cli/common/board-state-reducer.js';
import {
  selectAllLiveCardModels as selectAllLiveCardModelsSource,
  selectLiveCardModel as selectLiveCardModelSource,
  type BoardRuntimeArtifactsPayload,
} from '../../src/board-livegraph-runtime/index.js';

type BrowserBoardLiveCardsClientApi = {
  buildBoardState: typeof buildBoardStateSource;
  applyNotification: typeof applyNotificationSource;
  deriveBoardState: typeof deriveBoardStateSource;
  selectLiveCardModel: typeof selectLiveCardModelSource;
  selectAllLiveCardModels: typeof selectAllLiveCardModelsSource;
  createBoardRuntimeClient: (options: Record<string, unknown>) => unknown;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserClientPath = path.join(repoRoot, 'browser', 'board-livecards-client.js');

let _cachedBrowserApi: BrowserBoardLiveCardsClientApi | null = null;

const PAYLOAD: BoardRuntimeArtifactsPayload = {
  cardDefinitions: [
    { id: 'card-a', card_data: { title: 'Card A' }, requires: ['prices'] },
    { id: 'card-b', card_data: { title: 'Card B' } },
  ],
  cardRuntimeById: {
    'card-a': {
      schema_version: 'v1',
      card_id: 'card-a',
      card_data: { subtitle: 'Runtime value' },
      computed_values: { score: 99 },
    },
  },
  dataObjectsByToken: {
    prices: { AAPL: 201.1 },
  },
  statusSnapshot: {
    cards: [
      {
        name: 'card-a',
        status: 'completed',
        runtime: { last_transition_at: '2026-05-13T00:00:00.000Z' },
      },
      {
        name: 'card-b',
        status: 'in-progress',
        runtime: { last_transition_at: '2026-05-13T00:01:00.000Z' },
      },
    ],
  },
};

function loadBrowserClient(): BrowserBoardLiveCardsClientApi {
  if (_cachedBrowserApi) return _cachedBrowserApi;

  const source = fs.readFileSync(browserClientPath, 'utf-8');
  vm.runInThisContext(source, { filename: browserClientPath });

  const browserApi = (globalThis as Record<string, unknown>).BoardLiveCardsClient;
  if (!browserApi || typeof browserApi !== 'object') {
    throw new Error('Failed to load browser BoardLiveCardsClient API');
  }
  _cachedBrowserApi = browserApi as BrowserBoardLiveCardsClientApi;
  return _cachedBrowserApi;
}

describe('board-livecards-client parity', () => {
  it('exports the supported public client surface', () => {
    const api = loadBrowserClient();
    expect(typeof api.createBoardRuntimeClient).toBe('function');
    expect(typeof api.buildBoardState).toBe('function');
    expect(typeof api.applyNotification).toBe('function');
    expect(typeof api.deriveBoardState).toBe('function');
    expect(typeof api.selectLiveCardModel).toBe('function');
    expect(typeof api.selectAllLiveCardModels).toBe('function');
  });

  it('keeps browser and source selector exports in sync', () => {
    const api = loadBrowserClient();
    expect(api.selectLiveCardModel(PAYLOAD, 'card-a')).toEqual(
      selectLiveCardModelSource(PAYLOAD, 'card-a'),
    );
    expect(api.selectAllLiveCardModels(PAYLOAD)).toEqual(
      selectAllLiveCardModelsSource(PAYLOAD),
    );
  });

  it('keeps browser and source board-state reducer behavior in sync', () => {
    const api = loadBrowserClient();
    const serverState = buildBoardStateSource(PAYLOAD, null, selectLiveCardModelSource);
    const browserState = api.buildBoardState(PAYLOAD, null, api.selectLiveCardModel);

    expect(browserState).toEqual(serverState);

    const notifications = [
      { kind: 'computed_values', cardId: 'card-a', values: { score: 101 } },
      { kind: 'data_object', key: 'prices', payload: { AAPL: 205.5 } },
      {
        kind: 'status',
        status: {
          cards: [
            {
              name: 'card-b',
              status: 'failed',
              runtime: { last_transition_at: '2026-05-13T00:02:00.000Z' },
              error: { message: 'network issue' },
            },
          ],
        },
      },
    ];

    expect(
      api.applyNotification(browserState, notifications, api.selectLiveCardModel, () => PAYLOAD),
    ).toEqual(
      applyNotificationSource(serverState, notifications, selectLiveCardModelSource, () => PAYLOAD),
    );
  });

  it('keeps browser and source derived board view behavior in sync', () => {
    const api = loadBrowserClient();
    const serverState = buildBoardStateSource(PAYLOAD, null, selectLiveCardModelSource);
    const browserState = api.buildBoardState(PAYLOAD, null, api.selectLiveCardModel);

    const sourceDerived = deriveBoardStateSource(serverState, {
      includeCard: (model) => model.id === 'card-a',
      mapCard: (model) => ({
        ...model,
        card_data: { ...(model.card_data as Record<string, unknown>), pane: 'ingest' },
      }),
      mapPayload: (payload) => ({ ...(payload as Record<string, unknown>), derivedView: 'ingest' }),
    });
    const browserDerived = api.deriveBoardState(browserState, {
      includeCard: (model) => model.id === 'card-a',
      mapCard: (model) => ({
        ...model,
        card_data: { ...(model.card_data as Record<string, unknown>), pane: 'ingest' },
      }),
      mapPayload: (payload) => ({ ...(payload as Record<string, unknown>), derivedView: 'ingest' }),
    });

    expect(browserDerived).toEqual(sourceDerived);
    expect(browserDerived.cardIds).toEqual(['card-a']);
    expect(browserDerived.modelsById['card-a']?.card_chats).toEqual(sourceDerived.modelsById['card-a']?.card_chats);
  });
});
