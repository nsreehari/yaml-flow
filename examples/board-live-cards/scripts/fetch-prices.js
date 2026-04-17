/**
 * fetch-prices.js
 * Polls tmp_file1 in boardDir (cwd) until it has content.
 * tmp_file1 must contain JSON: { "AAPL": 198.50, "MSFT": 425.30, ... }
 * Outputs that JSON to stdout, then clears tmp_file1.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const tmpFile = path.join(process.cwd(), 'tmp_file1');

function waitForFile() {
  const interval = setInterval(() => {
    if (!fs.existsSync(tmpFile)) return;
    const content = fs.readFileSync(tmpFile, 'utf-8').trim();
    if (!content) return;

    clearInterval(interval);
    // Clear the file
    fs.writeFileSync(tmpFile, '', 'utf-8');
    // Output JSON to stdout — execute-card-task.ts captures this
    process.stdout.write(content + '\n');
  }, 500);
}

waitForFile();
