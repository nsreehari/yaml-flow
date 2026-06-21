import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createBoardContainerLifecycle,
  createFsBoardContainerStorage,
} from '../../src/cli/node/fs-board-adapter.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('board container lifecycle', () => {
  it('provisions, updates, and deprecates a filesystem-backed board container', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-board-container-'));
    tmpDirs.push(rootDir);

    const boardsDir = path.join(rootDir, 'boards');
    const layoutsDir = path.join(rootDir, 'layouts');
    const deprecatedDir = path.join(rootDir, 'deprecated');
    const workspaceDir = path.join(rootDir, 'workspace-live');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'marker.txt'), 'hello', 'utf8');

    const storage = createFsBoardContainerStorage<Record<string, unknown>, Record<string, unknown>>({
      registry: {
        boardsIndexRef: { kind: 'fs-path', value: boardsDir },
        boardsLayoutRef: { kind: 'fs-path', value: layoutsDir },
        deprecatedContainerRef: { kind: 'fs-path', value: deprecatedDir },
      },
    });

    const lifecycle = createBoardContainerLifecycle({
      storage,
      hydrate(boardId, record) {
        return { id: boardId, ...record };
      },
      resolveWorkspaceDir(_board, record) {
        const baseRef = record?.refs && typeof record.refs === 'object' && !Array.isArray(record.refs)
          ? (record.refs as Record<string, unknown>).baseRef
          : null;
        return baseRef && typeof baseRef === 'object' && !Array.isArray(baseRef) && (baseRef as Record<string, unknown>).kind === 'fs-path'
          ? String((baseRef as Record<string, unknown>).value || '')
          : '';
      },
    });

    const record = {
      id: 'demo',
      label: 'Demo',
      metadata: { pageTitle: 'Before' },
      refs: {
        baseRef: { kind: 'fs-path', value: workspaceDir },
      },
    };

    const provisioned = await lifecycle.provision('demo', record, {
      layout: { canvas: { zoom: 1 } },
    });
    expect(provisioned.id).toBe('demo');

    const listed = await lifecycle.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe('demo');

    const metaSaved = await lifecycle.saveMeta('demo', { pageSubtitle: 'After' });
    expect(metaSaved?.metadata).toEqual({ pageTitle: 'Before', pageSubtitle: 'After' });

    const recordSaved = await lifecycle.saveRecord('demo', {
      label: 'Demo Updated',
      metadata: { smoke: true },
    });
    expect(recordSaved?.label).toBe('Demo Updated');
    expect(recordSaved?.metadata).toEqual({ pageTitle: 'Before', pageSubtitle: 'After', smoke: true });

    await lifecycle.saveLayout('demo', { canvas: { zoom: 2 } });
    expect(await lifecycle.getLayout('demo')).toEqual({ canvas: { zoom: 2 } });

    const archived = await lifecycle.deprecate('demo');
    expect(archived?.board?.id).toBe('demo');
    expect(fs.existsSync(String(archived?.archiveRecordPath || ''))).toBe(true);
    expect(fs.existsSync(path.join(String(archived?.archiveWorkspaceDir || ''), 'marker.txt'))).toBe(true);
    expect(await lifecycle.get('demo')).toBeNull();
  });
});