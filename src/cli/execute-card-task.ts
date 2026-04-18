/**
 * execute-card-task — CLI script that runs a card's source scripts.
 *
 * Usage: node execute-card-task.js <card-file-path> <callback-token> <board-dir>
 *
 * For each entry in sources[]:
 *   - Runs source.script via execFileSync (cwd = boardDir)
 *   - If the script emits stdout, writes it to source.outputFile
 *   - If the script wrote source.outputFile directly, confirms the file is present
 *   - Never touches card.json
 *
 * After all sources have been attempted, retriggers the card if any outputFile was written.
 * Optional sources (optional: true) are included in the same pass — they retrigger per delivery.
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

  return false;
}

// Run all sources (required and optional) — same delivery path for both.
// Required sources (optional:false) are retriggered in a single batch after all have run.
// Optional sources (optional:true) retrigger individually on delivery.
const sources = (card.sources ?? []) as { script?: string; bindTo: string; outputFile?: string; optional?: boolean; timeout?: number }[];
const requiredSources = sources.filter((s) => !s.optional);
const optionalSources = sources.filter((s) => s.optional);

let anyRequiredDelivered = false;
for (const src of requiredSources) {
  if (runSourceScript(src)) anyRequiredDelivered = true;
}

if (requiredSources.length > 0 && anyRequiredDelivered) {
  execFile('node', [cliScript, 'retrigger', '--rg', boardDir, '--task', card.id], (err, stdout, stderr) => {
    if (err) console.error(`[card-handler] retrigger failed for "${card.id}":`, err.message);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
  });
}

for (const src of optionalSources) {
  if (runSourceScript(src)) {
    execFile('node', [cliScript, 'retrigger', '--rg', boardDir, '--task', card.id], (err) => {
      if (err) console.error(`[card-handler] retrigger failed for "${card.id}":`, err.message);
    });
  }
}
