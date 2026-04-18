/**
 * fetch-prices.js
 * Polls tmp_file1 in boardDir (cwd) until it has content.
 * tmp_file1 must contain JSON: { "AAPL": 198.50, "MSFT": 425.30, ... }
 * Outputs that JSON to stdout, then clears tmp_file1.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpFileCandidates = [
  path.join(process.cwd(), 'tmp_file1'),
  path.join(process.cwd(), 'board-runtime', 'tmp_file1'),
];

function getReadableTmpFile() {
  for (const tmpFile of tmpFileCandidates) {
    if (!fs.existsSync(tmpFile)) continue;
    const content = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (content) return { tmpFile, content };
  }
  return undefined;
}

function waitForFile() {
  const interval = setInterval(() => {
    const ready = getReadableTmpFile();
    if (!ready) return;

    clearInterval(interval);
    // Clear the file
    fs.writeFileSync(ready.tmpFile, '', 'utf-8');
    // Output JSON to stdout — execute-card-task.ts captures this
    process.stdout.write(ready.content + '\n');
  }, 500);
}

waitForFile();
