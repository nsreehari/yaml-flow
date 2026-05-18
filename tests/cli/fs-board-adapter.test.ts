import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createFsBoardChatStorage,
  createFsBoardFileArtifactsStore,
} from '../../src/cli/node/fs-board-adapter.js';

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('fs-board-adapter helpers', () => {
  it('does not double the chats path when boardDir already points at the chats directory', () => {
    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-fs-chat-'));
    tmpDirs.push(boardDir);
    const chatsDir = path.join(boardDir, 'chats');
    const store = createFsBoardChatStorage(chatsDir);

    store.append('card-1', 'assistant', 'hello', []);

    expect(fs.existsSync(path.join(chatsDir, 'card-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(chatsDir, 'chats', 'card-1.jsonl'))).toBe(false);
  });

  it('does not double the files path when baseDir already points at the files directory', () => {
    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-fs-files-'));
    tmpDirs.push(boardDir);
    const filesDir = path.join(boardDir, 'files');
    const store = createFsBoardFileArtifactsStore(filesDir);

    store.putBytes('card-1/demo.txt', new TextEncoder().encode('hello'), 'text/plain');

    expect(fs.existsSync(path.join(filesDir, 'card-1', 'demo.txt'))).toBe(true);
    expect(fs.existsSync(path.join(filesDir, 'files', 'card-1', 'demo.txt'))).toBe(false);
  });
});