import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCardStore } from '../../src/cli/common/board-live-cards-lib.js';
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

  it('deletes both the index entry and the backing card file', () => {
    const store = freshStore();
    const json = createFsJsonStorage(tmpDir);

    expect(store.set({ body: { id: 'c1', title: 'hello' } }).status).toBe('success');
    expect(json.read('_index')).not.toBeNull();
    expect(json.read('c1')).toEqual(expect.objectContaining({ id: 'c1', title: 'hello' }));

    const delResult = store.del({ body: { ids: ['c1'] } });
    expect(delResult.status).toBe('success');

    expect(json.read('c1')).toBeNull();
    expect(store.get({ params: { id: 'c1' } }).status).toBe('fail');
    expect(json.read('_index')).toEqual({});
  });
});
