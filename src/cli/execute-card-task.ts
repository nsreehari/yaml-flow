/**
 * Card Handler — CLI script that processes a card's source/optionalSource sections.
 *
 * Usage: node execute-card-task.js <card-file-path> <callback-token> <board-dir>
 *
 * Reads card JSON and handles all applicable sections:
 *   - sources[]:          invokes scripts, writes output to src.outputFile (NEVER touches card.json)
 *   - optionalSources[]:  same pattern but emits retrigger per source
 *   - asyncHelpers:       invokes async helper scripts
 *
 * Source delivery:
 *   If the script writes to src.outputFile directly (e.g. prices.json), execute-card-task
 *   just confirms the file exists after running.
 *   If the script writes to stdout, execute-card-task captures it and writes to src.outputFile.
 *
 * After all required sources deliver, emits task-restart so the card re-fires.
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

function runSourceScript(source: { script?: string; bindTo: string; outputFile?: string; timeout?: number }): boolean {
  if (!source.script) return false;

  console.log(`[card-handler] source.script: ${source.script} → outputFile=${source.outputFile ?? '(none)'}`);

  let stdout: string;
  try {
    stdout = execFileSync(source.script, {
      cwd: boardDir,
      shell: true,
      encoding: 'utf-8',
      timeout: source.timeout ?? 120_000,
    }).trim();
  } catch (err: unknown) {
    console.error(`[card-handler] source "${source.bindTo}" script failed:`, (err as Error).message);
    return false;
  }

  // If script wrote to stdout, capture it to outputFile
  if (stdout && source.outputFile) {
    const outputPath = path.join(boardDir, source.outputFile);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, stdout);
    console.log(`[card-handler] source delivered (stdout→file) → ${source.outputFile}`);
    return true;
  }

  // Script may have written outputFile directly (no stdout)
  if (source.outputFile && fs.existsSync(path.join(boardDir, source.outputFile))) {
    console.log(`[card-handler] source delivered (file) → ${source.outputFile}`);
    return true;
  }

  if (stdout) {
    // stdout with no outputFile configured — log only (legacy passthrough)
    console.log(`[card-handler] source "${source.bindTo}" produced stdout but has no outputFile configured`);
  }

  return false;
}

// --- Sources section (gate required, emit retrigger once all have run) ---
const sources = (card.sources ?? []) as { script?: string; bindTo: string; outputFile?: string; timeout?: number }[];
let anySourceDelivered = false;
for (const src of sources) {
  const delivered = runSourceScript(src);
  if (delivered) anySourceDelivered = true;
}

// Retrigger so card-handler re-evaluates with the now-delivered outputFiles
if (sources.length > 0 && anySourceDelivered) {
  execFile('node', [cliScript, 'retrigger', '--rg', boardDir, '--task', card.id], (err, stdout, stderr) => {
    if (err) console.error(`[card-handler] retrigger failed for "${card.id}":`, err.message);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
  });
}

// --- OptionalSources section (backward compat: separate top-level array) ---
// New cards embed optional: true on sources[] entries; legacy cards may use optionalSources[].
const optionalSources = (card.optionalSources ?? []) as { script?: string; bindTo: string; outputFile?: string; timeout?: number }[];
for (const src of optionalSources) {
  const delivered = runSourceScript(src);
  if (delivered) {
    // Retrigger per optional source so the card can re-run with enriched sources context
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
