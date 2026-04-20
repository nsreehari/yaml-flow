/**
 * fetch-prices.js
 * Polls for tmp_file1 payload and outputs JSON to stdout once available.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const envBoardDir = (process.env.BOARD_DIR ?? '').trim();
const tmpFileCandidates = [
  envBoardDir ? path.join(envBoardDir, 'tmp_file1') : '',
  path.join(process.cwd(), 'tmp_file1'),
  path.join(process.cwd(), 'board-runtime', 'tmp_file1'),
  path.join(process.cwd(), '..', 'board-runtime', 'tmp_file1'),
].filter(Boolean);

function getReadableTmpFile() {
  for (const tmpFile of tmpFileCandidates) {
    if (!fs.existsSync(tmpFile)) continue;
    const content = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (content) return { tmpFile, content };
  }
  return undefined;
}

function waitForFile(timeoutMs = 120000) {
  const started = Date.now();
  const interval = setInterval(() => {
    if (Date.now() - started > timeoutMs) {
      clearInterval(interval);
      console.error('Timed out waiting for tmp_file1 market prices input.');
      process.exit(1);
    }

    const ready = getReadableTmpFile();
    if (!ready) return;

    clearInterval(interval);
    fs.writeFileSync(ready.tmpFile, '', 'utf-8');
    process.stdout.write(`${ready.content}\n`);
  }, 250);
}

waitForFile();
