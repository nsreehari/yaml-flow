#!/usr/bin/env node
/**
 * Build: example-board-src → examples/example-board
 *
 * This script is the authoritative source-to-distribution transform.
 * Run it whenever you change example-board-src/ to regenerate the npm-facing output.
 *
 * Transformations applied:
 *   HTML  ../../browser/<file>.js  →  https://cdn.jsdelivr.net/npm/yaml-flow/browser/<file>.js
 *   HTML  ../../browser/board-livecards-runtime-client.js  →  CDN URL above
 *
 * Files included in output (top-level; directories are included wholesale):
 *   agent-instructions.md
 *   agent-instructions-cardlayout.md
 *   cards/
 *   demo-chat-handler.js
 *   demo-server.js
 *   demo-server-config.json
 *   demo-shell.html
 *   demo-shell-browser.html
 *   demo-shell-with-server.html
 *   demo-task-executor.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = __dirname;
const OUT_DIR = path.resolve(__dirname, '../../examples/example-board');

const _pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
const CDN_BASE = `https://cdn.jsdelivr.net/npm/yaml-flow@${_pkg.version}`;

// ---------------------------------------------------------------------------
// Replacement rules — applied to every text file in order
// ---------------------------------------------------------------------------
const REPLACEMENTS = [
  // local browser bundles → CDN
  {
    from: 'src="../../browser/card-compute.js"',
    to:   `src="${CDN_BASE}/browser/card-compute.js"`,
  },
  {
    from: 'src="../../browser/live-cards.js"',
    to:   `src="${CDN_BASE}/browser/live-cards.js"`,
  },
  {
    from: 'src="../../browser/board-livegraph-engine.js"',
    to:   `src="${CDN_BASE}/browser/board-livegraph-engine.js"`,
  },
  // local runtime client script → CDN
  {
    from: 'src="../../browser/board-livecards-runtime-client.js"',
    to:   `src="${CDN_BASE}/browser/board-livecards-runtime-client.js"`,
  },
];

// Top-level entries to include in the output. Directories are copied wholesale.
// Anything not listed here is ignored — new files must be explicitly added.
const INCLUDE = new Set([
  'agent-instructions.md',
  'agent-instructions-cardlayout.md',
  'cards',
  'demo-chat-handler.js',
  'demo-server.js',
  'demo-server-config.json',
  'demo-shell.html',
  'demo-shell-browser.html',
  'demo-shell-with-server.html',
  'demo-task-executor.js',
]);

// Binary-safe file extensions — copied verbatim without UTF-8 decode
const BINARY_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyReplacements(content) {
  for (const { from, to } of REPLACEMENTS) {
    // Use split/join for literal replacement (no regex needed)
    content = content.split(from).join(to);
  }
  return content;
}

function isBinary(filePath) {
  return BINARY_EXTS.has(path.extname(filePath).toLowerCase());
}

function copyDir(srcDir, outDir, depth = 0) {
  fs.mkdirSync(outDir, { recursive: true });

  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    // At depth 0, only process entries explicitly listed in INCLUDE
    if (depth === 0 && !INCLUDE.has(entry.name)) {
      console.log(`  skip  ${entry.name}`);
      continue;
    }

    const srcPath = path.join(srcDir, entry.name);
    const outPath = path.join(outDir, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, outPath, depth + 1);
    } else if (isBinary(entry.name)) {
      fs.copyFileSync(srcPath, outPath);
      console.log(`  copy  ${path.relative(SRC_DIR, outPath)}`);
    } else {
      const original = fs.readFileSync(srcPath, 'utf8');
      const transformed = applyReplacements(original);
      fs.writeFileSync(outPath, transformed, 'utf8');
      const changed = original !== transformed;
      console.log(`  ${changed ? 'xfrm' : 'copy'}  ${path.relative(SRC_DIR, outPath)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const srcRel = path.relative(process.cwd(), SRC_DIR);
const outRel = path.relative(process.cwd(), OUT_DIR);
console.log(`\nBuilding example-board\n  src : ${srcRel}\n  out : ${outRel}\n`);

copyDir(SRC_DIR, OUT_DIR);

console.log('\nDone.\n');
