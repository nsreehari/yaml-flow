/**
 * Card Handler — CLI script that processes a card's source/optionalSource sections.
 *
 * Usage: node execute-card-task.js <card-file-path> <callback-token> <board-dir>
 *
 * Reads card JSON and handles all applicable sections:
 *   - sources[]:          invokes scripts, writes state[bindTo] on disk, emits data-received (task-restart)
 *   - optionalSources[]:  same as sources but don't gate completion
 *   - asyncHelpers:       invokes async helper scripts
 *
 * Each source delivery emits task-restart so the card re-fires with new state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [cardFilePath, callbackToken, boardDir] = process.argv.slice(2);

if (!cardFilePath || !callbackToken || !boardDir) {
  console.error('Usage: execute-card-task <card-file-path> <callback-token> <board-dir>');
  process.exit(1);
}

const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));

console.log(`[card-handler] Processing card "${card.id}"`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScript = path.join(__dirname, 'board-live-cards.js');

function runSourceScript(source: { script?: string; bindTo: string; timeout?: number }): unknown {
  if (!source.script) return undefined;
  console.log(`[card-handler] source.script: ${source.script} → bindTo=${source.bindTo}`);
  const stdout = execFileSync(source.script, {
    cwd: boardDir,
    shell: true,
    encoding: 'utf-8',
    timeout: source.timeout ?? 120_000,
  });
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

// --- Sources section (gate completion) ---
const sources = (card.sources ?? []) as { script?: string; bindTo: string; timeout?: number }[];
for (const src of sources) {
  const data = runSourceScript(src);
  if (data !== undefined) {
    // Write to card.state[bindTo] on disk
    card.state = card.state ?? {};
    card.state[src.bindTo] = data;
    fs.writeFileSync(cardFilePath, JSON.stringify(card, null, 2));
    console.log(`[card-handler] source delivered → state.${src.bindTo}`);
  }
}

// After all sources deliver, emit task-restart so the card re-fires
// (the card-handler will see sources delivered and emit task-completed)
if (sources.length > 0) {
  execFile('node', [cliScript, 'retrigger', '--rg', boardDir, '--task', card.id], (err, stdout, stderr) => {
    if (err) console.error(`[card-handler] retrigger failed for "${card.id}":`, err.message);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
  });
}

// --- OptionalSources section (don't gate completion) ---
const optionalSources = (card.optionalSources ?? []) as { script?: string; bindTo: string; timeout?: number }[];
for (const src of optionalSources) {
  const data = runSourceScript(src);
  if (data !== undefined) {
    card.state = card.state ?? {};
    card.state[src.bindTo] = data;
    fs.writeFileSync(cardFilePath, JSON.stringify(card, null, 2));
    console.log(`[card-handler] optionalSource delivered → state.${src.bindTo}`);
    // Emit task-restart (data-received) so card re-fires with richer data
    execFile('node', [cliScript, 'retrigger', '--rg', boardDir, '--task', card.id], (err) => {
      if (err) console.error(`[card-handler] retrigger failed for "${card.id}":`, err.message);
    });
  }
}

// --- AsyncHelpers section ---
if (card.asyncHelpers) {
  console.log(`[card-handler] asyncHelpers: processing`);
  // TODO: Interpret asyncHelpers section and execute appropriate work
}
