import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serializeRef } from '../../src/cli/common/storage-interface.js';

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

function makeStoreRef(boardDir: string): string {
  return serializeRef({ kind: 'fs-path', value: boardDir });
}

function runChatStoreStdin(input: unknown) {
  return spawnSync(process.execPath, [tsxCli, srcCli, '--stdin'], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: 'utf-8',
  });
}

function runChatStore(args: string[], input?: unknown) {
  return spawnSync(process.execPath, [tsxCli, srcCli, ...args], {
    cwd: repoRoot,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf-8',
  });
}

function parseStdout(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

describe('chat-store-cli stdin mode', () => {
  it('preserves single-command stdin envelopes', () => {
    const boardDir = makeBoardDir();
    const storeRef = makeStoreRef(boardDir);

    const appendRun = runChatStoreStdin({
      command: 'append',
      storeRef,
      cardId: 'card-1',
      role: 'assistant',
      text: 'hello from stdin',
      files: [],
    });

    expect(appendRun.status).toBe(0);
    expect(parseStdout(appendRun.stdout)).toEqual({ id: expect.any(String) });

    const readRun = runChatStoreStdin({
      command: 'read-all',
      storeRef,
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

  it('reads the suffix from the Nth-last user message via the CLI and stdin envelope', () => {
    const boardDir = makeBoardDir();
    const storeRef = makeStoreRef(boardDir);

    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'system', '--text', 'setup']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'user', '--text', 'first']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'assistant', '--text', 'first reply']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'user', '--text', 'second']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'assistant', '--text', 'second reply']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-last', '--role', 'tool', '--text', 'tool output']).status).toBe(0);

    const flagRun = runChatStore(['read-all', '--store-ref', storeRef, '--card-id', 'card-last', '--last-user-turns', '1']);
    expect(flagRun.status).toBe(0);
    expect(parseStdout(flagRun.stdout)).toEqual({
      records: [
        expect.objectContaining({ role: 'user', text: 'second' }),
        expect.objectContaining({ role: 'assistant', text: 'second reply' }),
        expect.objectContaining({ role: 'tool', text: 'tool output' }),
      ],
    });

    const stdinRun = runChatStoreStdin({
      command: 'read-all',
      storeRef,
      cardId: 'card-last',
      lastUserTurns: 2,
    });
    expect(stdinRun.status).toBe(0);
    expect(parseStdout(stdinRun.stdout)).toEqual({
      records: [
        expect.objectContaining({ role: 'user', text: 'first' }),
        expect.objectContaining({ role: 'assistant', text: 'first reply' }),
        expect.objectContaining({ role: 'user', text: 'second' }),
        expect.objectContaining({ role: 'assistant', text: 'second reply' }),
        expect.objectContaining({ role: 'tool', text: 'tool output' }),
      ],
    });
  });

  it('accepts a command envelope with shared defaults and sequential commands', () => {
    const boardDir = makeBoardDir();
    const storeRef = makeStoreRef(boardDir);

    const batchRun = runChatStoreStdin({
      storeRef,
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
      storeRef,
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
      storeRef,
      cardId: 'card-2',
    });
    expect(processingRun.status).toBe(0);
    expect(parseStdout(processingRun.stdout)).toEqual({ active: false });
  });

  it('supports turn-aware append and read flags', () => {
    const boardDir = makeBoardDir();
    const storeRef = makeStoreRef(boardDir);

    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-turns', '--role', 'user', '--text', 'A1', '--turn-id', 'turn-a']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-turns', '--role', 'assistant', '--text', 'A2', '--turn-id', 'turn-a']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-turns', '--role', 'user', '--text', 'B1', '--turn-id', 'turn-b']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-turns', '--role', 'assistant', '--text', 'B2', '--turn-id', 'turn-b']).status).toBe(0);
    expect(runChatStore(['append', '--store-ref', storeRef, '--card-id', 'card-turns', '--role', 'user', '--text', 'C1', '--turn-id', 'turn-c']).status).toBe(0);

    const byTurnRun = runChatStore(['read-all', '--store-ref', storeRef, '--card-id', 'card-turns', '--turn-id', 'turn-b']);
    expect(byTurnRun.status).toBe(0);
    expect(parseStdout(byTurnRun.stdout)).toEqual({
      records: [
        expect.objectContaining({ text: 'B1', turn: 'turn-b' }),
        expect.objectContaining({ text: 'B2', turn: 'turn-b' }),
      ],
    });

    const beforeAnchorRun = runChatStore([
      'read-all', '--store-ref', storeRef, '--card-id', 'card-turns', '--tail-turns', '1', '--tail-turns-before-id', 'turn-c',
    ]);
    expect(beforeAnchorRun.status).toBe(0);
    expect(parseStdout(beforeAnchorRun.stdout)).toEqual({
      records: [
        expect.objectContaining({ text: 'B1', turn: 'turn-b' }),
        expect.objectContaining({ text: 'B2', turn: 'turn-b' }),
      ],
    });
  });

  it('does not process stdin envelopes unless --stdin is passed explicitly', () => {
    const boardDir = makeBoardDir();
    const storeRef = makeStoreRef(boardDir);

    const appendRun = runChatStore([], {
      command: 'append',
      storeRef,
      cardId: 'card-implicit-stdin',
      role: 'assistant',
      text: 'should not be written',
      files: [],
    });

    expect(appendRun.status).toBe(0);
    expect(appendRun.stdout.trim()).toBe('');
    expect(appendRun.stderr).toContain('chat-store — chat history and state operations for a board card');

    const readRun = runChatStoreStdin({
      command: 'read-all',
      storeRef,
      cardId: 'card-implicit-stdin',
    });

    expect(readRun.status).toBe(0);
    expect(parseStdout(readRun.stdout)).toEqual({ records: [] });
  });

  it('rejects legacy stdin envelopes that send boardDir instead of storeRef', () => {
    const boardDir = makeBoardDir();

    const result = runChatStoreStdin({
      command: 'append',
      boardDir,
      cardId: 'card-legacy-envelope',
      role: 'assistant',
      text: 'legacy envelope',
      files: [],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('chat-store: stdin envelope missing "storeRef"');
  });
});