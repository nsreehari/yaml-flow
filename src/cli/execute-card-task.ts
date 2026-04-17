/**
 * Card Handler — CLI script that processes a card's sections.
 *
 * Usage: node execute-card-task.js <card-file-path> <callback-token> <board-dir>
 *
 * Reads card JSON and handles all applicable sections:
 *   - source section:       invokes external data fetch (API, websocket, etc.)
 *   - compute section:      runs CardCompute.run() inline
 *   - asyncHelpers section: invokes async helper scripts
 *
 * Once all work is complete, calls back:
 *   board-live-cards task-completed --rg <board-dir> --token <callback-token> --data <json>
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode } from '../card-compute/index.js';

const [cardFilePath, callbackToken, boardDir] = process.argv.slice(2);

if (!cardFilePath || !callbackToken || !boardDir) {
  console.error('Usage: execute-card-task <card-file-path> <callback-token> <board-dir>');
  process.exit(1);
}

const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));
const result: Record<string, unknown> = {};

console.log(`[card-handler] Processing card "${card.id}" type=${card.type}`);

// --- Source section ---
if (card.source) {
  const kind = String(card.source.kind ?? 'unknown');
  console.log(`[card-handler] source: kind=${kind}`);

  if (card.source.script) {
    // source.script: run the command, capture stdout as JSON result
    const cmd = card.source.script;
    console.log(`[card-handler] source.script: ${cmd}`);
    const stdout = execFileSync(cmd, {
      cwd: boardDir,
      shell: true,
      encoding: 'utf-8',
      timeout: card.source.timeout ?? 120_000,
    });
    const trimmed = stdout.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        Object.assign(result, parsed);
        console.log(`[card-handler] source.script: captured keys=[${Object.keys(parsed).join(', ')}]`);
      } catch {
        // Non-JSON stdout — store as raw text
        result.sourceOutput = trimmed;
        console.log(`[card-handler] source.script: captured raw output (${trimmed.length} chars)`);
      }
    }
  }
  // TODO: Interpret other source.kind values ('api' | 'websocket' | 'static' | 'llm')
}

// --- Compute section ---
if (card.compute) {
  const computeNode: ComputeNode = {
    id: card.id,
    state: { ...card.state },
    compute: card.compute,
  };
  CardCompute.run(computeNode);
  console.log(`[card-handler] compute: done, keys=[${Object.keys(computeNode.state ?? {}).join(', ')}]`);
  result.state = computeNode.state;
}

// --- AsyncHelpers section ---
if (card.asyncHelpers) {
  console.log(`[card-handler] asyncHelpers: processing`);
  // TODO: Interpret asyncHelpers section and execute appropriate work
}

// --- Callback ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScript = path.join(__dirname, 'board-live-cards.js');
const dataJson = JSON.stringify(result);

execFile('node', [cliScript, 'task-completed', '--rg', boardDir, '--token', callbackToken, '--data', dataJson], (err, stdout, stderr) => {
  if (err) {
    console.error(`[card-handler] callback failed for "${card.id}":`, err.message);
    // Attempt task-failed as fallback
    execFile('node', [cliScript, 'task-failed', '--rg', boardDir, '--token', callbackToken, '--error', err.message], (err2) => {
      if (err2) console.error(`[card-handler] task-failed fallback also failed:`, err2.message);
    });
    return;
  }
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
});
