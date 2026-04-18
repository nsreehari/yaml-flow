/**
 * execute-card-task — CLI script that runs a card's source scripts.
 *
 * Usage: node execute-card-task.js <card-file-path> <callback-token> <board-dir>
 *
 * For each entry in sources[]:
 *   1. Generates a per-source sourceToken (encodes callbackToken + card metadata + source metadata)
 *   2. Runs source.script via execFileSync (cwd = boardDir)
 *   3. On success:
 *        - Writes stdout to a tmp file (or notes that the script wrote outputFile directly)
 *        - Calls: board-live-cards source-data-fetched --tmp <tmpFile> --token <sourceToken>
 *   4. On failure:
 *        - Calls: board-live-cards source-data-fetch-failure --token <sourceToken> --reason <msg>
 *
 * The CLI commands append a task-progress event to the journal and drain the reactive graph.
 * card-handler is re-invoked via the task-progress route and updates runtime.json.
 * Never touches card.json.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeSourceToken } from './board-live-cards.js';

const [cardFilePath, callbackToken, boardDir] = process.argv.slice(2);

if (!cardFilePath || !callbackToken || !boardDir) {
  console.error('Usage: execute-card-task <card-file-path> <callback-token> <board-dir>');
  process.exit(1);
}

const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));

console.log(`[execute-card-task] Processing card "${card.id}"`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliScript = path.join(__dirname, 'board-live-cards.js');

type SourceDef = { script?: string; bindTo: string; outputFile?: string; optional?: boolean; timeout?: number };

function runSource(src: SourceDef): void {
  if (!src.script) return;

  console.log(`[execute-card-task] source.script: ${src.script} → bindTo=${src.bindTo}`);

  const sourceToken = encodeSourceToken({
    cbk: callbackToken,
    rg: boardDir,
    cid: card.id as string,
    b: src.bindTo,
    d: src.outputFile ?? '',
  });

  let stdout: string;
  try {
    stdout = execFileSync(src.script, {
      cwd: boardDir,
      shell: true,
      encoding: 'utf-8',
      timeout: src.timeout ?? 120_000,
    }).trim();
  } catch (err: unknown) {
    const reason = (err as Error).message ?? String(err);
    console.error(`[execute-card-task] source "${src.bindTo}" script failed:`, reason);
    execFile('node', [cliScript, 'source-data-fetch-failure', '--token', sourceToken, '--reason', reason], (e) => {
      if (e) console.error(`[execute-card-task] source-data-fetch-failure call failed:`, e.message);
    });
    return;
  }

  if (src.outputFile) {
    if (stdout) {
      // Script emitted stdout — write to a tmp file; CLI will rename into dest atomically
      const tmpFile = path.join(os.tmpdir(), `card-source-${src.bindTo}-${Date.now()}.json`);
      fs.writeFileSync(tmpFile, stdout);
      execFile('node', [cliScript, 'source-data-fetched', '--tmp', tmpFile, '--token', sourceToken], (e, out, err) => {
        if (e) console.error(`[execute-card-task] source-data-fetched call failed:`, e.message);
        if (out) console.log(out.trim());
        if (err) console.error(err.trim());
      });
    } else if (fs.existsSync(path.join(boardDir, src.outputFile))) {
      // Script wrote outputFile directly (no stdout) — use it as the tmp source
      const tmpFile = path.join(os.tmpdir(), `card-source-${src.bindTo}-${Date.now()}.json`);
      fs.copyFileSync(path.join(boardDir, src.outputFile), tmpFile);
      execFile('node', [cliScript, 'source-data-fetched', '--tmp', tmpFile, '--token', sourceToken], (e) => {
        if (e) console.error(`[execute-card-task] source-data-fetched call failed:`, e.message);
      });
    } else {
      console.warn(`[execute-card-task] source "${src.bindTo}" produced no stdout and outputFile is absent`);
      execFile('node', [cliScript, 'source-data-fetch-failure', '--token', sourceToken, '--reason', 'script produced no output'], (e) => {
        if (e) console.error(`[execute-card-task] source-data-fetch-failure call failed:`, e.message);
      });
    }
  } else {
    console.warn(`[execute-card-task] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
    execFile('node', [cliScript, 'source-data-fetch-failure', '--token', sourceToken, '--reason', 'no outputFile configured'], (e) => {
      if (e) console.error(`[execute-card-task] source-data-fetch-failure call failed:`, e.message);
    });
  }
}

const sources = (card.sources ?? []) as SourceDef[];
for (const src of sources) {
  runSource(src);
}
