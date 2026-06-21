#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createBoardContainerLifecycle,
  createFsBoardContainerStorage,
} from 'yaml-flow/board-live-cards-node';

function main() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-board-container-example-'));
  const boardsDir = path.join(rootDir, 'boards');
  const layoutsDir = path.join(rootDir, 'layouts');
  const deprecatedDir = path.join(rootDir, 'deprecated');
  const workspaceDir = path.join(rootDir, 'workspace-demo');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const storage = createFsBoardContainerStorage({
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
      return record?.refs?.baseRef?.kind === 'fs-path' ? String(record.refs.baseRef.value || '') : '';
    },
  });

  const boardRecord = {
    id: 'demo-board',
    label: 'Demo Board',
    metadata: { pageTitle: 'Lifecycle Demo' },
    refs: {
      baseRef: { kind: 'fs-path', value: workspaceDir },
    },
  };

  return lifecycle.provision('demo-board', boardRecord, {
    layout: { canvas: { zoom: 1, panX: 0, panY: 0 } },
  })
    .then(async () => {
      console.log('provisioned:', await lifecycle.get('demo-board'));
      await lifecycle.saveMeta('demo-board', { pageSubtitle: 'Example Subtitle' });
      await lifecycle.saveLayout('demo-board', { canvas: { zoom: 1.25, panX: 24, panY: 12 } });
      console.log('updated record:', await lifecycle.get('demo-board'));
      console.log('updated layout:', await lifecycle.getLayout('demo-board'));
      const archived = await lifecycle.deprecate('demo-board');
      console.log('archived:', archived);
    })
    .finally(() => {
      fs.rmSync(rootDir, { recursive: true, force: true });
    });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});