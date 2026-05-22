/**
 * build-cli-bundled.mjs
 *
 * Runs esbuild over the six CLI entrypoints that tsup already built into
 * cli/node/ and produces fully self-contained ESM bundles in cli/bundled/.
 *
 * Each bundle:
 *  - has a #!/usr/bin/env node shebang (works as a bin entry)
 *  - inlines all npm dependencies
 *  - externalises only Node.js built-ins (fs, path, os, crypto, …)
 *  - targets Node 20
 *
 * Run AFTER build:cli (tsup must have already written cli/node/*.js).
 */

import { build } from 'esbuild';
import { mkdirSync, existsSync, cpSync } from 'fs';

const ENTRYPOINTS = [
  'board-live-cards-cli',
  'step-machine-cli',
  'batch-runner-cli',
  'card-store-cli',
  'artifacts-store-cli',
  'chat-store-cli',
];

mkdirSync('cli/bundled', { recursive: true });

for (const name of ENTRYPOINTS) {
  const infile = `cli/node/${name}.js`;
  if (!existsSync(infile)) {
    console.warn(`  [skip] ${infile} not found`);
    continue;
  }

  await build({
    entryPoints: [infile],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: `cli/bundled/${name}.mjs`,
    minify: true,
    // The createRequire shim is required because some bundled CJS deps
    // (graceful-fs via proper-lockfile) use dynamic require() of Node built-ins.
    // Without it, esbuild's polyfill throws "Dynamic require of X is not supported".
    // Note: do NOT add #!/usr/bin/env node here — esbuild automatically moves any
    // shebang from the source entrypoint to the top of the output. Adding it in the
    // banner too produces a duplicate shebang (syntax error) for CLI entrypoints
    // that already have one in their source.
    banner: { js: 'import{createRequire}from"module";const require=createRequire(import.meta.url);' },
  });

  console.log(`  Bundled cli/bundled/${name}.mjs`);
}

// jsonata-loader.ts uses createRequire(import.meta.url) to load ./jsonata-sync.cjs
// at runtime from the bundle's own directory — copy the vendor file as a sibling.
const jsonataSrc = 'src/card-compute/jsonata-sync.cjs';
if (existsSync(jsonataSrc)) {
  cpSync(jsonataSrc, 'cli/bundled/jsonata-sync.cjs');
  console.log('  Copied jsonata-sync.cjs to cli/bundled/');
}
