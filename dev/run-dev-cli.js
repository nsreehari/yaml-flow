#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

export async function runDevCli({
  cliFileName,
  srcFileName = cliFileName.replace(/\.js$/, '.ts'),
  label,
  argv = process.argv.slice(2),
}) {
  const builtCli = path.join(repoRoot, 'cli', 'node', cliFileName);
  const distCli = path.join(repoRoot, 'dist', 'cli', 'node', cliFileName);
  const srcCli = path.join(repoRoot, 'src', 'cli', 'node', srcFileName);

  if (fs.existsSync(builtCli)) {
    await runImportedCli(builtCli, argv, label);
    return;
  }

  if (fs.existsSync(distCli)) {
    await runImportedCli(distCli, argv, label);
    return;
  }

  if (fs.existsSync(srcCli)) {
    const result = spawnSync(process.execPath, [tsxCli, srcCli, ...argv], {
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
    });

    if (result.error) {
      console.error(`[${label}] Failed to launch dev fallback: ${result.error.message}`);
      process.exit(1);
    }

    process.exit(result.status ?? 0);
  }

  console.error(`[${label}] Could not find built, dist, or src CLI entrypoint.`);
  process.exit(1);
}

async function runImportedCli(filePath, argv, label) {
  const mod = await import(pathToFileUrl(filePath).href);
  if (typeof mod.cli !== 'function') {
    console.error(`[${label}] Module does not export cli(): ${filePath}`);
    process.exit(1);
  }

  try {
    await mod.cli(argv);
  } catch (err) {
    if (mod.CliExitError && err instanceof mod.CliExitError) {
      process.exit(err.code);
    }
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error(msg);
    process.exit(1);
  }
}

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return new URL(`file:///${resolved.startsWith('/') ? resolved.slice(1) : resolved}`);
}
