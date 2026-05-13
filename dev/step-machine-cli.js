#!/usr/bin/env node

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distCli = path.join(repoRoot, 'lib', 'cli', 'node', 'step-machine-cli.js');

const distUrl = new URL(`file:///${path.resolve(distCli).replace(/\\/g, '/').replace(/^\//, '')}`);
const { cli, CliExitError } = await import(distUrl.href);

try {
  await cli(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliExitError) {
    process.exit(err.code);
  }
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(msg);
  process.exit(1);
}

