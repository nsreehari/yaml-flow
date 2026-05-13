#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const budgets = [
  { file: 'lib/index.js', maxBytes: 280_000 },
  { file: 'lib/index.cjs', maxBytes: 280_000 },
  { file: 'cli/node/board-live-cards-cli.js', maxBytes: 240_000 },
  { file: 'cli/node/fs-board-adapter.js', maxBytes: 240_000 },
  { file: 'browser/board-livecards-localstorage.js', maxBytes: 85_000 },
];

let hasFailure = false;

for (const { file, maxBytes } of budgets) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) {
    console.error(`[budget] missing artifact: ${file}`);
    hasFailure = true;
    continue;
  }

  const actual = fs.statSync(abs).size;
  const status = actual <= maxBytes ? 'ok' : 'exceeded';
  const line = `[budget] ${status} ${file} (${actual} / ${maxBytes} bytes)`;

  if (actual <= maxBytes) {
    console.log(line);
  } else {
    console.error(line);
    hasFailure = true;
  }
}

if (hasFailure) {
  process.exitCode = 1;
}
