import { describe, expect, it, vi } from 'vitest';

import { createBoardLiveCardsMcp } from '../../src/cli/common/board-live-cards-mcp.js';

function makeDeps() {
  return {
    board: {
      status: vi.fn(() => ({ status: 'success', data: { meta: {}, summary: {}, cards: [] } })),
      getOutputsDataObject: vi.fn(() => ({ status: 'success', data: null })),
      getOutputsComputedValues: vi.fn(() => ({ status: 'success', data: {} })),
      getOutputsFetchedSources: vi.fn(() => ({ status: 'success', data: {} })),
      removeCard: vi.fn(() => ({ status: 'success' })),
      cardRefreshedNotify: vi.fn(() => ({ status: 'success', data: { notified: true } })),
      upsertCard: vi.fn(() => ({ status: 'success' })),
    },
    nonCore: {
      describeTaskExecutorCapabilities: vi.fn(() => ({ status: 'success', data: { version: '1.0', commonSourceDefFields: { bindTo: { type: 'string' } }, sourceKinds: { http: { title: 'HTTP' } } } })),
      validateCardPreflight: vi.fn(() => ({ status: 'success', data: { cardId: 'card-1', isValid: true, issues: [] } })),
      evalCardCompute: vi.fn(() => ({ status: 'success', data: { ok: true } })),
      probeSourcePreflight: vi.fn(() => ({ status: 'success', data: { ok: true } })),
      runSourcePreflight: vi.fn(() => ({ status: 'success', data: { ok: true } })),
      simulateCardCycle: vi.fn(() => ({ status: 'success', data: { ok: true } })),
    },
    cardStore: {
      get: vi.fn(() => ({ status: 'success', data: { cards: [{ id: 'card-1', card_data: { files: [{ stored_name: 'file-a.txt', name: 'file-a.txt' }] } }] } })),
      set: vi.fn(() => ({ status: 'success', data: { count: 1 } })),
      del: vi.fn(() => ({ status: 'success', data: { count: 1 } })),
      patch: vi.fn(() => ({ status: 'success', data: { count: 1 } })),
      appendFiles: vi.fn(() => ({ status: 'success', data: { files_added: [] } })),
    },
    chatStore: {
      readAll: vi.fn(() => ({
        status: 'success',
        data: {
          records: [
            { id: 'm1', role: 'user', text: 'hello', files: [] },
            { id: 'm2', role: 'system', text: 'file uploaded: file-a.txt as file-a.txt #0', files: [] },
          ],
        },
      })),
    },
    buildFileDownloadUrl: vi.fn(({ cardId, fileIdx }: { cardId: string; fileIdx: number }) => `/api/board/cards/${cardId}/files/${fileIdx}`),
    readFetchedSourceJsonByRef: vi.fn(() => ({ rows: [1, 2, 3] })),
  };
}

describe('BoardLiveCardsMcp', () => {
  it('reshapes discover source kinds output to wrapper shape', () => {
    const mcp = createBoardLiveCardsMcp(makeDeps());
    expect(mcp.discoverSourceKinds()).toEqual({
      version: '1.0',
      commonSourceFields: { bindTo: { type: 'string' } },
      sourceKinds: { http: { title: 'HTTP' } },
    });
  });

  it('reshapes board status cards to wrapper field names', () => {
    const deps = makeDeps();
    deps.board.status.mockReturnValue({
      status: 'success',
      data: {
        meta: { source: 'runtime' },
        summary: { card_count: 1, completed: 1, eligible: 0, pending: 0, blocked: 0, in_progress: 0, failed: 0, unresolved: 0 },
        cards: [{ name: 'card-1', status: 'completed', error: null, requires: [], requires_satisfied: [], requires_missing: [], provides_declared: [], provides_runtime: ['out.a'] }],
      },
    });
    const mcp = createBoardLiveCardsMcp(deps);

    expect(mcp.inspectBoardRuntimeStatus()).toEqual({
      meta: { source: 'runtime' },
      summary: { card_count: 1, completed: 1, eligible: 0, pending: 0, blocked: 0, in_progress: 0, failed: 0, unresolved: 0 },
      cards: [{ 'card-id': 'card-1', status: 'completed', error: null, requires: [], requires_satisfied: [], requires_missing: [], provides_declared: [], provides_runtime: ['out.a'] }],
    });
  });

  it('adds attachment retrieval_hint and applies tail slicing for inspect chat messages', () => {
    const mcp = createBoardLiveCardsMcp(makeDeps());
    expect(mcp.inspectChatMessagesOnCards({ cardId: 'card-1', tail: 1 })).toEqual({
      cardId: 'card-1',
      messages: [
        expect.objectContaining({
          role: 'system',
          retrieval_hint: 'Retrieve using inspect-file-contents --card-id card-1 --file-idx 0',
        }),
      ],
    });
  });

  it('preserves wrapper behavior by returning card_saved as null on successful manage upsert', () => {
    const mcp = createBoardLiveCardsMcp(makeDeps());
    expect(mcp.manageUpsertCard({ cardId: 'card-1', candidateCardContent: { id: 'card-1', card_data: {} } })).toEqual({
      status: 'success',
      data: {
        validation: { status: 'success', data: { cardId: 'card-1', isValid: true, issues: [] } },
        card_saved: null,
        board_result: { status: 'success' },
        refresh_notify: { status: 'success', data: { notified: true } },
      },
    });
  });

  it('returns a JSON download descriptor for inspect file contents', () => {
    const mcp = createBoardLiveCardsMcp(makeDeps());
    expect(mcp.inspectFileContents({ cardId: 'card-1', fileIdx: 0 })).toEqual({
      cardId: 'card-1',
      fileIdx: 0,
      downloadUrl: '/api/board/cards/card-1/files/0',
      name: 'file-a.txt',
      stored_name: 'file-a.txt',
    });
  });
});