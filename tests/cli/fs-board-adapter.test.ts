import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createFsBoardChatStorage,
  createFsChatStorageForRefRoot,
  createFsBoardFileArtifactsStore,
  createFsBlobStorage,
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

  it('treats a chat store ref path as the chat-store root', () => {
    const boardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-fs-chat-ref-'));
    tmpDirs.push(boardDir);
    const chatStoreDir = path.join(boardDir, 'chat');
    const store = createFsChatStorageForRefRoot(chatStoreDir);

    store.append('card-1', 'assistant', 'hello', []);
    store.setProcessing('card-1', true);

    expect(fs.existsSync(path.join(chatStoreDir, 'journal', 'card-1.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(chatStoreDir, 'kv', 'chats', 'card-1', 'processing.json'))).toBe(true);
    expect(fs.existsSync(path.join(chatStoreDir, 'chats', 'card-1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(chatStoreDir, '.kv', 'chat', 'chats', 'card-1', 'processing.json'))).toBe(false);
  });

  it('renameKey moves blob content and returns false for a missing source key', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-fs-blob-'));
    tmpDirs.push(rootDir);
    const blob = createFsBlobStorage(rootDir);

    blob.write('staged/demo.txt', 'hello');

    expect(blob.renameKey('staged/demo.txt', 'live/demo.txt')).toBe(true);
    expect(blob.read('staged/demo.txt')).toBeNull();
    expect(blob.read('live/demo.txt')).toBe('hello');
    expect(blob.renameKey('staged/missing.txt', 'live/missing.txt')).toBe(false);
  });
});