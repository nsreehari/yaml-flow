import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { serializeRef } from '../../src/cli/common/storage-interface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcCli = path.join(repoRoot, 'src', 'cli', 'node', 'card-store-cli.ts');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const tmpDir = tmpDirs.pop();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeStoreRef() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-store-cli-'));
  tmpDirs.push(tmpDir);
  return {
    dir: tmpDir,
    storeRef: serializeRef({ kind: 'fs-path', value: tmpDir }),
  };
}

function runCardStore(args: string[], input?: string) {
  return spawnSync(process.execPath, [tsxCli, srcCli, ...args], {
    cwd: repoRoot,
    input,
    encoding: 'utf-8',
  });
}

describe('card-store-cli', () => {
  it('del removes both the index entry and the backing card file', () => {
    const { dir, storeRef } = makeStoreRef();

    const setRun = runCardStore(['set', '--store-ref', storeRef], JSON.stringify({ id: 'c1', title: 'hello' }));
    expect(setRun.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'c1.json'))).toBe(true);

    const delRun = runCardStore(['del', '--store-ref', storeRef, '--id', 'c1']);
    expect(delRun.status).toBe(0);
    expect(fs.existsSync(path.join(dir, 'c1.json'))).toBe(false);

    const indexPath = path.join(dir, '_index.json');
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(indexPath, 'utf-8'))).toEqual({});
  });

  it('rejects the removed delete alias', () => {
    const { storeRef } = makeStoreRef();

    const result = runCardStore(['delete', '--store-ref', storeRef, '--id', 'c1']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('card-store: unknown command "delete"');
  });

  it('append-files appends file metadata to card_data.files', () => {
    const { storeRef } = makeStoreRef();

    const setRun = runCardStore(['set', '--store-ref', storeRef], JSON.stringify({ id: 'c1', card_data: { files: [{ name: 'a.txt' }] } }));
    expect(setRun.status).toBe(0);

    const appendRun = runCardStore([
      'append-files',
      '--store-ref',
      storeRef,
      '--id',
      'c1',
      '--value-json',
      JSON.stringify({ name: 'b.txt', size: 20 }),
    ]);
    expect(appendRun.status).toBe(0);
    expect(appendRun.stderr).toContain('card-store append-files: appended 1 file(s)');

    const getRun = runCardStore(['get', '--store-ref', storeRef, '--id', 'c1']);
    expect(getRun.status).toBe(0);
    const cards = JSON.parse(getRun.stdout) as Array<Record<string, unknown>>;
    const cardData = cards[0].card_data as Record<string, unknown>;
    expect(cardData.files).toEqual([
      { name: 'a.txt' },
      { name: 'b.txt', size: 20 },
    ]);
  });
});