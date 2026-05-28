import { describe, expect, it } from 'vitest';

import {
  applyBoardNotifications,
  createBoardRuntimeSession,
  createDerivedBoardRuntime,
  defaultBoardPaths,
  prepareActionPayload,
  serverPayloadToBoardState,
  uploadCardFile,
} from '../../src/board-livecards-client/index.js';
import type { BoardRuntimeArtifactsPayload } from '../../src/board-livegraph-runtime/index.js';

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

function createSession() {
  return createBoardRuntimeSession({
    fetchServer: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    boardPaths: (boardId: string) => defaultBoardPaths(boardId),
    getServerOrigin: () => 'http://localhost:7799',
  });
}

describe('board-livecards-client runtime session', () => {
  it('adapts provided payloads into reusable board state', () => {
    const session = createSession();
    const state = session.attachProvidedState({ boardId: 'default', payload: PAYLOAD });

    expect(state?.cardIds).toEqual(['card-a', 'card-b']);
    expect(session.getBoardId()).toBe('default');
    expect(session.isConnected()).toBe(false);

    const rebuilt = serverPayloadToBoardState(PAYLOAD);
    expect(state).toEqual(rebuilt);
  });

  it('projects a derived runtime over shared session state and notification updates', () => {
    const session = createSession();
    session.attachProvidedState({ boardId: 'default', payload: PAYLOAD });

    const derived = createDerivedBoardRuntime({
      session,
      includeCard: (model) => model.id === 'card-a',
      mapPayload: (payload) => ({ ...(payload as Record<string, unknown>), view: 'solo' }),
    });

    expect(derived.getBoardId()).toBe('default');
    expect(derived.getClientId()).toBe(session.getClientId());
    expect(derived.getState()?.cardIds).toEqual(['card-a']);

    session.applyServerUpdate({
      kind: 'notification-batch',
      notifications: [{ kind: 'computed_values', cardId: 'card-a', values: { score: 123 } }],
    });

    expect(derived.getState()?.modelsById['card-a']?.computed_values).toEqual({ score: 123 });
    expect(derived.getFullState()?.modelsById['card-a']?.computed_values).toEqual({ score: 123 });
  });

  it('exposes the same notification reduction helper used by the shared session', () => {
    const state = serverPayloadToBoardState(PAYLOAD);
    const nextState = applyBoardNotifications(
      state,
      [{ kind: 'card_chats', cardId: 'card-a', messages: [{ role: 'assistant', text: 'hello' }], receiving: true }],
      () => PAYLOAD,
    );

    expect(nextState.modelsById['card-a']?.card_chats).toEqual({
      messages: [{ role: 'assistant', text: 'hello' }],
      processing: false,
      receiving: true,
    });
  });
});

describe('defaultBoardPaths — retriggerCard', () => {
  it('includes retriggerCard path builder', () => {
    const paths = defaultBoardPaths('my-board');
    expect(typeof paths.retriggerCard).toBe('function');
    expect(paths.retriggerCard('my-card')).toBe('/api/boards/my-board/cards/my-card/retrigger');
  });

  it('encodes card id in retriggerCard URL', () => {
    const paths = defaultBoardPaths('b');
    expect(paths.retriggerCard('card with spaces')).toBe('/api/boards/b/cards/card%20with%20spaces/retrigger');
  });
});

describe('session.retriggerCard', () => {
  it('issues POST to the retrigger endpoint', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const session = createBoardRuntimeSession({
      fetchServer: async (path, init) => {
        calls.push({ path, init });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      boardPaths: (boardId: string) => defaultBoardPaths(boardId),
      getServerOrigin: () => 'http://localhost:7799',
    });
    session.attachProvidedState({ boardId: 'board-1', payload: PAYLOAD });

    await session.retriggerCard('card-a');

    const call = calls.find((c) => c.path.includes('/retrigger'));
    expect(call).toBeTruthy();
    expect(call?.path).toBe('/api/boards/board-1/cards/card-a/retrigger');
    expect(call?.init?.method).toBe('POST');
  });
});

describe('board-livecards-client action upload turn propagation', () => {
  it('adds turn-id query parameter for in-chat uploads when provided', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fakeFile = { name: 'sample.txt', type: 'text/plain' } as unknown as File;

    const result = await uploadCardFile({
      fetchServer: async (path, init) => {
        calls.push({ path, init });
        return new Response(JSON.stringify({ file: { stored_name: 'sample.txt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      boardPaths: (boardId: string) => defaultBoardPaths(boardId),
      boardId: 'board-1',
      cardId: 'card-a',
      file: fakeFile,
      inChat: true,
      turnId: 'turn-xyz',
    });

    expect(result).toEqual({ stored_name: 'sample.txt' });
    expect(calls[0]?.path).toContain('/api/boards/board-1/cards/card-a/files?inChat=true&turn-id=turn-xyz');
  });

  it('forwards chat turn-id from payload while preparing chat-send action uploads', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fakeFile = { name: 'chat-file.txt', type: 'text/plain' } as unknown as File;

    const payload = await prepareActionPayload({
      fetchServer: async (path, init) => {
        calls.push({ path, init });
        return new Response(JSON.stringify({ file: { stored_name: 'chat-file.txt' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      boardPaths: (boardId: string) => defaultBoardPaths(boardId),
      boardId: 'board-1',
      cardId: 'card-a',
      actionType: 'chat-send',
      payload: {
        text: 'hello',
        'turn-id': 'turn-chat-1',
        files: [fakeFile],
      },
    });

    expect(calls[0]?.path).toContain('/api/boards/board-1/cards/card-a/files?inChat=true&turn-id=turn-chat-1');
    expect(payload.files).toEqual([]);
  });
});