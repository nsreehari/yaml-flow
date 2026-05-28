import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFsBoardChatStorage } from '../../src/cli/node/fs-board-adapter.js';
import { createChatStorePublic } from '../../src/cli/common/chat-store-lib-public.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeStore() {
  const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-store-public-'));
  tmpDirs.push(boardDir);
  return createChatStorePublic(createFsBoardChatStorage(boardDir));
}

describe('chat-store public API command dispatch', () => {
  it('runs a single command envelope through the public API', () => {
    const store = makeStore();

    const append = store.run({
      command: 'append',
      cardId: 'card-1',
      role: 'assistant',
      text: 'public run',
      files: [],
    });

    expect(append).toEqual({ status: 'success', data: { id: expect.any(String) } });

    const read = store.run({ command: 'read-all', cardId: 'card-1' });
    expect(read).toEqual({
      status: 'success',
      data: {
        records: [
          expect.objectContaining({
            role: 'assistant',
            text: 'public run',
          }),
        ],
      },
    });
  });

  it('returns the suffix starting at the Nth-last user message through the public API', () => {
    const store = makeStore();

    store.append({ params: { cardId: 'card-last' }, body: { role: 'system', text: 'setup', files: [] } });
    store.append({ params: { cardId: 'card-last' }, body: { role: 'user', text: 'first', files: [] } });
    store.append({ params: { cardId: 'card-last' }, body: { role: 'assistant', text: 'first reply', files: [] } });
    store.append({ params: { cardId: 'card-last' }, body: { role: 'user', text: 'second', files: [] } });
    store.append({ params: { cardId: 'card-last' }, body: { role: 'assistant', text: 'second reply', files: [] } });
    store.append({ params: { cardId: 'card-last' }, body: { role: 'tool', text: 'tool output', files: [] } });

    const read = store.run({ command: 'read-all', cardId: 'card-last', lastUserTurns: 1 });
    expect(read).toEqual({
      status: 'success',
      data: {
        records: [
          expect.objectContaining({ role: 'user', text: 'second' }),
          expect.objectContaining({ role: 'assistant', text: 'second reply' }),
          expect.objectContaining({ role: 'tool', text: 'tool output' }),
        ],
      },
    });
  });

  it('runs a batch envelope with a shared cardId through the public API', () => {
    const store = makeStore();

    const batch = store.runBatch({
      cardId: 'card-2',
      commands: [
        { command: 'append', role: 'assistant', text: 'public batch', files: [] },
        { command: 'set-processing', active: false },
      ],
    });

    expect(batch).toEqual({
      status: 'success',
      data: {
        results: [
          { index: 0, command: 'append', data: { id: expect.any(String) } },
          { index: 1, command: 'set-processing', data: { ok: true } },
        ],
      },
    });

    expect(store.run({ command: 'is-processing', cardId: 'card-2' })).toEqual({
      status: 'success',
      data: { active: false },
    });
  });

  it('supports turn-aware read filtering and turn-tail slicing', () => {
    const store = makeStore();

    store.append({ params: { cardId: 'card-turns' }, body: { role: 'user', text: 'A1', files: [], turn: 'turn-a' } });
    store.append({ params: { cardId: 'card-turns' }, body: { role: 'assistant', text: 'A2', files: [], turn: 'turn-a' } });
    store.append({ params: { cardId: 'card-turns' }, body: { role: 'user', text: 'B1', files: [], turn: 'turn-b' } });
    store.append({ params: { cardId: 'card-turns' }, body: { role: 'assistant', text: 'B2', files: [], turn: 'turn-b' } });
    store.append({ params: { cardId: 'card-turns' }, body: { role: 'user', text: 'C1', files: [], turn: 'turn-c' } });

    const turnRead = store.run({ command: 'read-all', cardId: 'card-turns', turnId: 'turn-b' });
    expect(turnRead).toEqual({
      status: 'success',
      data: {
        records: [
          expect.objectContaining({ text: 'B1', turn: 'turn-b' }),
          expect.objectContaining({ text: 'B2', turn: 'turn-b' }),
        ],
      },
    });

    const tailRead = store.run({ command: 'read-all', cardId: 'card-turns', tailTurns: 1 });
    expect(tailRead).toEqual({
      status: 'success',
      data: {
        records: [
          expect.objectContaining({ text: 'C1', turn: 'turn-c' }),
        ],
      },
    });

    const beforeAnchorRead = store.run({
      command: 'read-all',
      cardId: 'card-turns',
      tailTurns: 1,
      tailTurnsBeforeId: 'turn-c',
    });
    expect(beforeAnchorRead).toEqual({
      status: 'success',
      data: {
        records: [
          expect.objectContaining({ text: 'B1', turn: 'turn-b' }),
          expect.objectContaining({ text: 'B2', turn: 'turn-b' }),
        ],
      },
    });
  });
});