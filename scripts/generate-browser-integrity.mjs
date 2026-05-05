#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = process.cwd();
const browserDir = path.join(root, 'browser');
const targets = [
  'board-livegraph-engine.js',
];

const files = {};

for (const name of targets) {
  const abs = path.join(browserDir, name);
  if (!fs.existsSync(abs)) {
    console.error(`[integrity] missing target: browser/${name}`);
    process.exit(1);
  }

  const content = fs.readFileSync(abs);
  const hash = createHash('sha256').update(content).digest('base64');
  files[`browser/${name}`] = {
    sha256: `sha256-${hash}`,
    bytes: content.length,
  };
}

const payload = {
  generatedAt: new Date().toISOString(),
  algorithm: 'sha256',
  files,
};

const outPath = path.join(browserDir, 'asset-integrity.json');
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`[integrity] wrote ${path.relative(root, outPath)}`);
