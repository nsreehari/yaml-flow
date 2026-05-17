import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcCli = path.join(repoRoot, 'src', 'cli', 'node', 'chat-store-cli.ts');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeBoardDir(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-store-cli-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

function runChatStoreStdin(input: unknown) {
  return spawnSync(process.execPath, [tsxCli, srcCli, '--stdin'], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
}

function parseStdout(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

describe('chat-store-cli stdin mode', () => {
  it('preserves single-command stdin envelopes', () => {
    const boardDir = makeBoardDir();

    const appendRun = runChatStoreStdin({
      command: 'append',
      boardDir,
      cardId: 'card-1',
      role: 'assistant',
      text: 'hello from stdin',
      files: [],
    });

    expect(appendRun.status).toBe(0);
    expect(parseStdout(appendRun.stdout)).toEqual({ id: expect.any(String) });

    const readRun = runChatStoreStdin({
      command: 'read-all',
      boardDir,
      cardId: 'card-1',
    });

    expect(readRun.status).toBe(0);
    expect(parseStdout(readRun.stdout)).toEqual({
      records: [
        expect.objectContaining({
          role: 'assistant',
          text: 'hello from stdin',
        }),
      ],
    });
  });

  it('accepts a command envelope with shared defaults and sequential commands', () => {
    const boardDir = makeBoardDir();

    const batchRun = runChatStoreStdin({
      boardDir,
      cardId: 'card-2',
      commands: [
        {
          command: 'append',
          role: 'assistant',
          text: 'batched reply',
          files: [],
        },
        {
          command: 'set-processing',
          active: false,
        },
      ],
    });

    expect(batchRun.status).toBe(0);
    expect(parseStdout(batchRun.stdout)).toEqual({
      results: [
        { index: 0, command: 'append', data: { id: expect.any(String) } },
        { index: 1, command: 'set-processing', data: { ok: true } },
      ],
    });

    const readRun = runChatStoreStdin({
      command: 'read-all',
      boardDir,
      cardId: 'card-2',
    });
    expect(readRun.status).toBe(0);
    expect(parseStdout(readRun.stdout)).toEqual({
      records: [
        expect.objectContaining({
          role: 'assistant',
          text: 'batched reply',
        }),
      ],
    });

    const processingRun = runChatStoreStdin({
      command: 'is-processing',
      boardDir,
      cardId: 'card-2',
    });
    expect(processingRun.status).toBe(0);
    expect(parseStdout(processingRun.stdout)).toEqual({ active: false });
  });
});