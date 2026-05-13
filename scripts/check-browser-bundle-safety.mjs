#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const bundlePath = path.join(process.cwd(), 'browser', 'board-livecards-localstorage.js');

if (!fs.existsSync(bundlePath)) {
  console.error('[browser-safety] missing browser bundle: browser/board-livecards-localstorage.js');
  process.exit(1);
}

const bundle = fs.readFileSync(bundlePath, 'utf8');

const forbidden = [
  /\bchild_process\b/g,
  /\bprocess\.binding\b/g,
  /\brequire\(["'](?:fs|path|os|child_process|module|node:)/g,
  /\bnew Function\(/g,
  /\beval\(/g,
];

let hasFailure = false;
for (const pattern of forbidden) {
  const matched = pattern.test(bundle);
  if (matched) {
    console.error(`[browser-safety] forbidden pattern found: ${pattern}`);
    hasFailure = true;
  } else {
    console.log(`[browser-safety] ok: ${pattern}`);
  }
}

if (hasFailure) {
  process.exitCode = 1;
}
