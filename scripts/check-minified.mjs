/**
 * check-minified.mjs
 *
 * Asserts that all compiled JS artifacts in lib/
 * are actually minified.  Fails the build if any file looks like
 * unminified output (too many short lines relative to file size).
 *
 * Vendor files (jsonata-sync.cjs) are excluded — they are pre-built
 * and already compact but structured differently.
 *
 * Run as part of the release gate: npm run check:minified
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const VENDOR_EXCLUDE = new Set(['jsonata-sync.cjs']);

/**
 * Files that are genuinely minified but too small / inherently compact to
 * produce avg chars/line >= MIN_AVG_CHARS_PER_LINE.  Exempt rather than
 * lower the global threshold.
 */
const COMPACT_EXEMPT = new Set([
  'board-worker-adapter.js',
  'board-worker-adapter.cjs',
]);
const DIRS_TO_CHECK = ['lib'];

/** Minimum average chars-per-line to consider a file minified. */
const MIN_AVG_CHARS_PER_LINE = 300;

/** Skip files smaller than this (tiny re-exports etc. are trivially compact). */
const MIN_SIZE_BYTES = 2000;

function* walkJs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkJs(full);
    } else if (/\.(js|cjs|mjs)$/.test(entry.name) && !VENDOR_EXCLUDE.has(entry.name) && !COMPACT_EXEMPT.has(entry.name)) {
      yield full;
    }
  }
}

let failures = 0;
let checked = 0;

for (const dir of DIRS_TO_CHECK) {
  for (const file of walkJs(dir)) {
    const size = statSync(file).size;
    if (size < MIN_SIZE_BYTES) continue;

    const content = readFileSync(file, 'utf-8');
    const nonEmptyLines = content.split('\n').filter((l) => l.trim().length > 0);
    const avgCharsPerLine = content.length / (nonEmptyLines.length || 1);

    checked++;
    if (avgCharsPerLine < MIN_AVG_CHARS_PER_LINE) {
      console.error(`  FAIL (unminified): ${file}  avg ${avgCharsPerLine.toFixed(0)} chars/line`);
      failures++;
    } else {
      console.log(`  ok: ${file}  avg ${avgCharsPerLine.toFixed(0)} chars/line`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${checked} file(s) appear unminified. Ensure all tsup configs have minify: true and the esbuild bundler script uses minify: true.`);
  process.exit(1);
}

console.log(`\nAll ${checked} checked JS artifacts are minified.`);
