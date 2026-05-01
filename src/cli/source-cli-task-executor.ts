#!/usr/bin/env node
/**
 * source-cli-task-executor.ts — Built-in task executor for `source.cli` sources.
 *
 * Implements the standard task-executor protocol so the board CLI always dispatches
 * source fetches through the same per-source path, whether or not a custom
 * .task-executor is configured.
 *
 * Subcommands:
 *   run-source-fetch --in-ref <::kind::value> --out-ref <::kind::value> [--err-ref <::kind::value>]
 *   describe-capabilities
 *
 * Supported source kind:
 *   cli — executes source_def.cli synchronously and writes stdout to --out-ref.
 *
 * In-ref envelope (written by board CLI dispatcher):
 *   { source_def: { cli, cwd?, boardDir?, timeout?, ... }, callback: { token, via } }
 *
 * The executor writes the trimmed stdout to --out-ref, then calls reportComplete()
 * which invokes `board-live-cards source-data-fetched` back-channel via the board CLI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseRef, blobStorageForRef, reportComplete, reportFailed } from './public-storage-adapter.js';
import type { KindValueRef, TaskCallback } from './public-storage-adapter.js';

// ============================================================================
// Command splitting — minimal implementation for source.cli strings.
// Handles single- and double-quoted segments. No glob/brace expansion.
// ============================================================================

function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of cmd) {
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * On Windows, execFileSync cannot find npm .cmd shims by bare name.
 * Check PATH for <name>.cmd / <name>.bat and return the resolved path.
 * Falls back to the original name (works for node.exe, python.exe, etc.).
 */
function resolveExecutable(rawCmd: string): string {
  if (process.platform !== 'win32') return rawCmd;
  if (path.isAbsolute(rawCmd) || rawCmd.includes('/') || rawCmd.includes('\\')) return rawCmd;
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of ['.cmd', '.bat']) {
      const candidate = path.join(dir, rawCmd + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return rawCmd;
}

// ============================================================================
// run-source-fetch
// ============================================================================

function runSourceFetch(argv: string[]): void {
  const inIdx  = argv.indexOf('--in-ref');
  const outIdx = argv.indexOf('--out-ref');
  const errIdx = argv.indexOf('--err-ref');
  const inRefStr  = inIdx  !== -1 ? argv[inIdx + 1]  : undefined;
  const outRefStr = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errRefStr = errIdx !== -1 ? argv[errIdx + 1] : undefined;

  if (!inRefStr || !outRefStr) {
    console.error('[source-cli-task-executor] Usage: run-source-fetch --in-ref <::kind::value> --out-ref <::kind::value> [--err-ref <::kind::value>]');
    process.exit(1);
  }

  let inRef: KindValueRef;
  let outRef: KindValueRef;
  let errRef: KindValueRef | undefined;
  try {
    inRef  = parseRef(inRefStr);
    outRef = parseRef(outRefStr);
    if (errRefStr) errRef = parseRef(errRefStr);
  } catch (e) {
    console.error(`[source-cli-task-executor] invalid ref: ${(e as Error).message}`);
    process.exit(1);
  }

  const inStorage  = blobStorageForRef(inRef!);
  const outStorage = blobStorageForRef(outRef!);
  const errStorage = errRef ? blobStorageForRef(errRef) : undefined;

  function fail(msg: string, callback?: TaskCallback): never {
    if (errStorage && errRef) { try { errStorage.write(errRef.value, msg); } catch { /* best-effort */ } }
    console.error(`[source-cli-task-executor] ${msg}`);
    if (callback) { try { reportFailed(callback, msg); } catch { /* best-effort */ } }
    process.exit(1);
  }

  const rawIn = inStorage.read(inRef!.value);
  if (rawIn === null) fail(`Input not found: ${inRefStr}`);

  let envelope: { source_def?: Record<string, unknown>; callback?: TaskCallback };
  try {
    envelope = JSON.parse(rawIn!) as typeof envelope;
  } catch (e) {
    fail(`Cannot parse input envelope: ${(e as Error).message}`);
  }

  // Support both new { source_def, callback } envelope and legacy raw source_def.
  const callback = envelope!.source_def != null ? envelope!.callback : undefined;
  const sourceDef = (envelope!.source_def ?? envelope!) as Record<string, unknown>;

  if (!sourceDef.cli || typeof sourceDef.cli !== 'string') {
    fail('source_def missing required field: cli (source-cli-task-executor only handles source.cli)', callback);
  }

  const timeout    = typeof sourceDef.timeout === 'number' ? sourceDef.timeout : 120_000;
  const cwd        = typeof sourceDef.cwd === 'string' && sourceDef.cwd ? sourceDef.cwd : process.cwd();
  const boardDir   = typeof sourceDef.boardDir === 'string' && sourceDef.boardDir ? sourceDef.boardDir : undefined;
  const bindTo     = typeof sourceDef.bindTo === 'string' ? sourceDef.bindTo : 'unknown';

  const parts = splitCommand(sourceDef.cli);
  if (parts.length === 0) fail('source_def.cli is empty', callback);

  const cmd     = resolveExecutable(parts[0]);
  const cliArgs = parts.slice(1);

  console.log(`[source-cli-task-executor] ${bindTo}: ${sourceDef.cli}`);

  let stdout: string;
  try {
    stdout = execFileSync(cmd, cliArgs, {
      shell: false,
      encoding: 'utf-8',
      timeout,
      cwd,
      env: { ...process.env, ...(boardDir ? { BOARD_DIR: boardDir } : {}) },
      maxBuffer: 50 * 1024 * 1024,
    }) as string;
  } catch (err) {
    fail(`cli execution failed: ${(err as Error).message}`, callback);
  }

  try {
    outStorage.write(outRef!.value, stdout!.trim());
  } catch (err) {
    fail(`Cannot write output: ${(err as Error).message}`, callback);
  }

  if (callback) {
    try {
      reportComplete(callback, outRef!);
    } catch (err) {
      console.error(`[source-cli-task-executor] reportComplete failed: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

// ============================================================================
// describe-capabilities
// ============================================================================

const CAPABILITIES = {
  version: '1.0',
  executor: 'source-cli-task-executor',
  subcommands: ['run-source-fetch', 'describe-capabilities'],
  sourceKinds: {
    cli: {
      description: 'Execute a shell command (source_def.cli) synchronously and capture stdout as the source data.',
      inputSchema: {
        cli: {
          type: 'string',
          required: true,
          description: 'Command string to execute. Quoted arguments are supported. Runs via execFileSync (no shell).',
        },
        timeout: {
          type: 'number',
          required: false,
          description: 'Execution timeout in milliseconds (default: 120000).',
        },
        cwd: {
          type: 'string',
          required: false,
          description: 'Working directory for the command (default: process.cwd()).',
        },
        boardDir: {
          type: 'string',
          required: false,
          description: 'Injected as BOARD_DIR environment variable.',
        },
      },
      outputShape: 'string — trimmed stdout of the command.',
    },
  },
};

// ============================================================================
// Entry point
// ============================================================================

const sub = process.argv[2];
if (sub === 'run-source-fetch') {
  runSourceFetch(process.argv.slice(3));
} else if (sub === 'describe-capabilities') {
  console.log(JSON.stringify(CAPABILITIES, null, 2));
} else {
  console.warn(`[source-cli-task-executor] Unknown subcommand: ${sub ?? '(none)'}`);
  process.exit(1);
}
