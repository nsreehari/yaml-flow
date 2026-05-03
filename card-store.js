#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distCli = path.join(__dirname, 'dist', 'cli', 'node', 'card-store-cli.js');
const srcCli = path.join(__dirname, 'src', 'cli', 'node', 'card-store-cli.ts');
const tsxCli = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (fs.existsSync(distCli)) {
  const { cli } = await import(pathToFileUrl(distCli).href);
  await cli(process.argv.slice(2));
} else if (fs.existsSync(srcCli)) {
  const result = spawnSync(process.execPath, [tsxCli, srcCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[card-store] Failed to launch dev fallback: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
} else {
  console.error('[card-store] Could not find dist or src CLI entrypoint.');
  process.exit(1);
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return new URL(`file:///${resolved.startsWith('/') ? resolved.slice(1) : resolved}`);
}
