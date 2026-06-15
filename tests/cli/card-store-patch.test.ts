import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  SYS_KEYS_BOARD_STATE_INIT_CARD_ID,
  createCardStore,
  createSysKeysBoardStateInitCard,
} from '../../src/cli/common/board-live-cards-lib.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createFsCardStorageAdapter } from '../../src/cli/node/storage-fs-adapters.js';
import { createFsJsonStorage } from '../../src/cli/node/storage-fs-adapters.js';

describe('card-store patch API', () => {
  let tmpDir = '';

  function freshStore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-store-patch-'));
    return createCardStorePublic(createCardStore(createFsCardStorageAdapter(tmpDir)));
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('patches nested card_data path via params.path', () => {
    const store = freshStore();
    const setResult = store.set({ body: { id: 'c1', card_data: { form: { count: 1 } } } });
    expect(setResult.status).toBe('success');

    const patchResult = store.patch({
      params: { id: 'c1', path: 'card_data.form.count' },
      body: { value: 42 },
    });
    expect(patchResult.status).toBe('success');

    const getResult = store.get({ params: { id: 'c1' } });
    expect(getResult.status).toBe('success');
    if (getResult.status === 'success') {
      const card = getResult.data.cards[0] as Record<string, unknown>;
      const cardData = card.card_data as Record<string, unknown>;
      const form = cardData.form as Record<string, unknown>;
      expect(form.count).toBe(42);
    }
  });

  it('fails patch when id or path is missing', () => {
    const store = freshStore();
    expect(store.patch({ params: { path: 'x.y' }, body: { value: 1 } }).status).toBe('fail');
    expect(store.patch({ params: { id: 'c1' }, body: { value: 1 } }).status).toBe('fail');
  });

  it('appends file metadata to card_data.files', () => {
    const store = freshStore();
    const setResult = store.set({ body: { id: 'c1', card_data: { files: [{ name: 'a.txt' }] } } });
    expect(setResult.status).toBe('success');

    const appendResult = store.appendFiles({
      params: { id: 'c1' },
      body: { name: 'b.txt', size: 20 },
    });
    expect(appendResult.status).toBe('success');
    if (appendResult.status === 'success') {
      expect(appendResult.data).toEqual({
        files_added: [{ idx: 1, entry: { name: 'b.txt', size: 20 } }],
      });
    }

    const getResult = store.get({ params: { id: 'c1' } });
    expect(getResult.status).toBe('success');
    if (getResult.status === 'success') {
      const card = getResult.data.cards[0] as Record<string, unknown>;
      const cardData = card.card_data as Record<string, unknown>;
      expect(cardData.files).toEqual([
        { name: 'a.txt' },
        { name: 'b.txt', size: 20 },
      ]);
    }
  });

  it('accepts body.files arrays for appendFiles', () => {
    const store = freshStore();
    expect(store.set({ body: { id: 'c1', card_data: {} } }).status).toBe('success');

    const appendResult = store.appendFiles({
      params: { id: 'c1' },
      body: { files: [{ name: 'a.txt' }, { name: 'b.txt' }] },
    });
    expect(appendResult.status).toBe('success');
    if (appendResult.status === 'success') {
      expect(appendResult.data).toEqual({
        files_added: [
          { idx: 0, entry: { name: 'a.txt' } },
          { idx: 1, entry: { name: 'b.txt' } },
        ],
      });
    }
  });

  it('deletes both the index entry and the backing card file', () => {
    const store = freshStore();
    const json = createFsJsonStorage(tmpDir);

    expect(store.set({ body: { id: 'c1', title: 'hello' } }).status).toBe('success');
    expect(json.read('_index')).not.toBeNull();
    expect(json.read('c1')).toEqual(expect.objectContaining({ id: 'c1', title: 'hello' }));

    const delResult = store.del({ body: { ids: ['c1'] } });
    expect(delResult.status).toBe('success');

    expect(json.read('c1')).toBeNull();
    expect(store.get({ params: { id: 'c1' } }).status).toBe('error');
    expect(json.read('_index')).toEqual({});
  });

  it('blocks __sys_keys_board_state_init from public read-all and known-id reads', () => {
    const store = freshStore();

    expect(store.set({ body: createSysKeysBoardStateInitCard() }).status).toBe('success');
    expect(store.set({ body: { id: 'public-card', card_data: { ok: true } } }).status).toBe('success');

    const getAllResult = store.get({});
    expect(getAllResult.status).toBe('success');
    if (getAllResult.status === 'success') {
      expect(getAllResult.data.cards.map((card) => card.id)).toEqual(['public-card']);
    }

    expect(store.get({ params: { id: SYS_KEYS_BOARD_STATE_INIT_CARD_ID } }).status).toBe('error');

    const batchResult = store.buildNotificationBatch({});
    expect(batchResult.status).toBe('success');
    if (batchResult.status === 'success') {
      expect(batchResult.data.notifications).toEqual([
        expect.objectContaining({ kind: 'card_refreshed', cardId: 'public-card' }),
      ]);
    }
  });
});
