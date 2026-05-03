import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const boardCliPath = path.join(repoRoot, 'board-live-cards-cli.js');
const cardStoreCliPath = path.join(repoRoot, 'card-store.js');

export function runBoardCli(args, options = {}) {
  const { capture = false, cwd = process.cwd() } = options;
  const result = spawnSync(process.execPath, [boardCliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: capture ? 'pipe' : 'pipe',
    env: {
      ...process.env,
      BOARD_DIR: process.env.BOARD_DIR ?? '',
    },
  });

  if (result.error) {
    throw new Error(`Failed to launch board-live-cards-cli: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    throw new Error(`board-live-cards-cli failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }

  return capture ? (result.stdout ?? '') : '';
}

/** Spawn CLI with JSON piped to stdin. */
export function runBoardCliWithInput(args, inputJson, options = {}) {
  const { cwd = process.cwd() } = options;
  const result = spawnSync(process.execPath, [boardCliPath, ...args], {
    input: inputJson,
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      BOARD_DIR: process.env.BOARD_DIR ?? '',
    },
  });

  if (result.error) {
    throw new Error(`Failed to launch board-live-cards-cli: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    throw new Error(`board-live-cards-cli failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }

  return result.stdout ?? '';
}

/** Spawn card-store-cli with JSON piped to stdin. */
export function runCardStoreCliWithInput(args, inputJson, options = {}) {
  const { cwd = process.cwd() } = options;
  const result = spawnSync(process.execPath, [cardStoreCliPath, ...args], {
    input: inputJson,
    cwd,
    encoding: 'utf-8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    throw new Error(`Failed to launch card-store-cli: ${result.error.message}`);
  }

  if ((result.status ?? 1) !== 0) {
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    throw new Error(`card-store-cli failed (${result.status}): ${stderr || stdout || 'no output'}`);
  }

  return result.stdout ?? '';
}

export async function readStdinJson() {
  let raw = '';
  process.stdin.setEncoding('utf-8');

  for await (const chunk of process.stdin) {
    raw += chunk;
  }

  if (!raw.trim()) {
    return {};
  }

  return JSON.parse(raw);
}

export function writeResult(payload) {
  process.stdout.write(JSON.stringify(payload));
}

export function writeFailure(message) {
  writeResult({ result: 'failure', error: message });
}
