/**
 * build.mjs — Minify wrapper scripts into dist/.
 *
 * Each .js file is minified individually (not bundled) so that sibling
 * imports (e.g. ./shared_helpers.js) resolve at runtime from the same
 * dist/ directory.
 *
 * Usage:
 *   node build.mjs            # from wrapper-scripts/cli/
 *   npm run build              # via package.json script
 */

import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = __dirname;
const OUT = join(__dirname, 'dist');

// Scripts to exclude from the dist build
const EXCLUDE = new Set(['build.mjs', 'test-scripts.js']);

const entries = readdirSync(SRC)
  .filter(f => f.endsWith('.js') && !EXCLUDE.has(f));

// Clean & recreate dist/
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const file of entries) {
  buildSync({
    entryPoints: [join(SRC, file)],
    outfile: join(OUT, file),
    format: 'esm',
    platform: 'node',
    target: 'node18',
    minify: true,
    // Keep the shebang for scripts that have one
    banner: { js: '#!/usr/bin/env node' },
    // Don't bundle — preserve sibling ./imports and node: imports
    bundle: false,
  });
}

console.log(`Built ${entries.length} scripts → dist/`);
for (const f of entries.sort()) console.log(`  ${f}`);
