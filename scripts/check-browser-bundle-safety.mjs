#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const bundleNames = [
  'board-livecards-client.js',
  'server-runtime-controlface.js',
  'adapters/firestore-storage.js',
  'adapters/localstorage-storage.js',
  'adapters/firebase-storage.js',
];

const forbidden = [
  /\bchild_process\b/g,
  /\bprocess\.binding\b/g,
  /\brequire\(["'](?:fs|path|os|child_process|module|node:)/g,
  /\bnew Function\(/g,
  /\beval\(/g,
];

let hasFailure = false;
for (const bundleName of bundleNames) {
  const bundlePath = path.join(process.cwd(), 'browser', bundleName);
  if (!fs.existsSync(bundlePath)) {
    console.error(`[browser-safety] missing browser bundle: browser/${bundleName}`);
    hasFailure = true;
    continue;
  }
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  for (const pattern of forbidden) {
    const matched = pattern.test(bundle);
    if (matched) {
      console.error(`[browser-safety] ${bundleName}: forbidden pattern found: ${pattern}`);
      hasFailure = true;
    } else {
      console.log(`[browser-safety] ${bundleName}: ok: ${pattern}`);
    }
  }
}

if (hasFailure) {
  process.exitCode = 1;
}
