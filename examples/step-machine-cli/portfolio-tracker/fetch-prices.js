/**
 * fetch-prices.js
 * Polls for tmp_file1 payload and outputs JSON to stdout once available.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

const envBoardDir = (process.env.BOARD_DIR ?? '').trim();
const tmpFileName = String(getArgValue('--tmp-file-name') ?? process.env.TMP_FILE_NAME ?? 'tmp_file1').trim();
const tmpFilePath = envBoardDir ? path.join(envBoardDir, tmpFileName) : '';

if (!tmpFilePath) {
  console.error('BOARD_DIR environment variable is required for fetch-prices.js');
  process.exit(1);
}

function getReadableTmpFile() {
  if (!fs.existsSync(tmpFilePath)) return undefined;
  const content = fs.readFileSync(tmpFilePath, 'utf-8').trim();
  if (!content) return undefined;
  return { tmpFile: tmpFilePath, content };
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
