/**
 * E2E test: board attachment round-trip via published CLI interfaces.
 *
 * Steps:
 *   1. Create a temp board (board-live-cards-cli init)
 *   2. Create a card in the card store (card-store-cli set)
 *   3. Upload binary content to the artifacts store (artifacts-store-cli put)
 *   4. Add a file metadata entry to card_data.files (card-store-cli append-files)
 *   5. Retrieve the attachment with board-live-cards-cli get-attachment-content
 *   6. Verify byte-for-byte match against the original content
 *
 * All steps use only the published bundled CLIs under cli/bundled/.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const YAML_FLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const BUNDLED = path.join(YAML_FLOW_ROOT, 'cli', 'bundled');

const boardCli     = path.join(BUNDLED, 'board-live-cards-cli.mjs');
const cardCli      = path.join(BUNDLED, 'card-store-cli.mjs');
const artifactsCli = path.join(BUNDLED, 'artifacts-store-cli.mjs');

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

// ── CLI helpers ──────────────────────────────────────────────────────────────

interface RunResult { status: number | null; stdout: Buffer; stderr: string }

function run(cli: string, args: string[], input?: Buffer): RunResult {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: YAML_FLOW_ROOT,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout as Buffer,
    stderr: (result.stderr as Buffer).toString('utf-8'),
  };
}

function runOk(cli: string, args: string[], input?: Buffer): Buffer {
  const r = run(cli, args, input);
  if (r.status !== 0) {
    throw new Error(`CLI exited ${r.status}:\n${r.stderr}\nargs: ${args.join(' ')}`);
  }
  return r.stdout;
}

function parseOk(cli: string, args: string[], input?: Buffer): unknown {
  return JSON.parse(runOk(cli, args, input).toString('utf-8'));
}

// ── ref helpers ───────────────────────────────────────────────────────────────

function b64url(raw: string): string {
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fsRef(absPath: string): string {
  return `b64:${b64url(JSON.stringify({ kind: 'fs-path', value: absPath }))}`;
}

// ── test ──────────────────────────────────────────────────────────────────────

describe('e2e: get-attachment-content round-trip', () => {
  it('returns byte-for-byte the same content that was put into the artifacts store', () => {
    const boardDir      = mkTmp('attachment-e2e-board-');
    const cardStoreDir  = path.join(boardDir, '.cards');
    const outputsDir    = path.join(boardDir, '.outputs');
    const artifactsDir  = path.join(boardDir, 'files');
    fs.mkdirSync(cardStoreDir,  { recursive: true });
    fs.mkdirSync(outputsDir,    { recursive: true });
    fs.mkdirSync(artifactsDir,  { recursive: true });

    const boardRef        = fsRef(boardDir);
    const cardStoreRef    = fsRef(cardStoreDir);
    const outputsRef      = fsRef(outputsDir);
    const artifactsRef    = fsRef(artifactsDir);

    // ── 1. Init board ─────────────────────────────────────────────────────
    const initResult = parseOk(boardCli, [
      'init',
      '--base-ref',       boardRef,
      '--card-store-ref', cardStoreRef,
      '--outputs-store-ref', outputsRef,
      '--artifacts-store-ref', artifactsRef,
    ]) as { status: string };
    expect(initResult.status).toBe('success');

    // ── 2. Create card ────────────────────────────────────────────────────
    const cardId = 'test-card-1';
    const setResult = run(cardCli, ['set', '--store-ref', cardStoreRef],
      Buffer.from(JSON.stringify({ id: cardId, card_data: { v: 1, files: [] } })));
    expect(setResult.status).toBe(0);

    // ── 3. Upload binary content to artifacts store ───────────────────────
    // Use a binary payload (not pure UTF-8) to guarantee a real byte comparison.
    const originalBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, // PNG magic
      0x48, 0x65, 0x6c, 0x6c, 0x6f, // "Hello"
      0x00, 0x01, 0x02, 0xfe, 0xff, // some arbitrary bytes
    ]);
    const storedName = '001-sample.bin';
    const artifactKey = `${cardId}/${storedName}`;

    const putResult = parseOk(artifactsCli, [
      'put',
      '--store-ref', artifactsRef,
      '--key',       artifactKey,
      '--content-type', 'application/octet-stream',
    ], originalBytes) as { artifact: { key: string } };
    expect(putResult).toMatchObject({ artifact: { key: artifactKey } });

    // ── 4. Add file metadata to card_data.files ───────────────────────────
    const appendResult = run(cardCli, [
      'append-files',
      '--store-ref',  cardStoreRef,
      '--id',         cardId,
      '--value-json', JSON.stringify({
        stored_name: storedName,
        name:        'sample.bin',
        size:        originalBytes.byteLength,
        mime_type:   'application/octet-stream',
      }),
    ]);
    expect(appendResult.status).toBe(0);

    // ── 5. Retrieve attachment bytes via board CLI ─────────────────────────
    const receivedRaw = runOk(boardCli, [
      'get-attachment-content',
      '--base-ref', boardRef,
      '--card-id',  cardId,
      '--file-idx', '0',
    ]);

    // ── 6. Byte-for-byte comparison ───────────────────────────────────────
    expect(receivedRaw.byteLength).toBe(originalBytes.byteLength);
    expect(Buffer.compare(receivedRaw, originalBytes)).toBe(0);
  });
});
