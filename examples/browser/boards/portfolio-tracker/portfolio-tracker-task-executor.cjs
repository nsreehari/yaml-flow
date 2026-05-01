#!/usr/bin/env node
/**
 * Portfolio Tracker Task-Executor
 * 
 * Implements the run-source-fetch protocol for board-live-cards.
 * This script acts as an external task-executor that can be registered via .task-executor file.
 * 
 * Contract:
 *   portfolio-tracker-task-executor.js run-source-fetch --in-ref <::kind::value> --out-ref <::kind::value> --err-ref <::kind::value>
 */

const { execSync } = require('child_process');
const { parseRef, blobStorageForRef, reportComplete, reportFailed } = require('yaml-flow/storage-refs');

// Parse command line arguments
const args = process.argv.slice(2);
let subcommand = '';
let inRefStr = '';
let outRefStr = '';
let errRefStr = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === 'run-source-fetch') {
    subcommand = 'run-source-fetch';
  } else if (args[i] === '--in-ref' && i + 1 < args.length) {
    inRefStr = args[i + 1];
  } else if (args[i] === '--out-ref' && i + 1 < args.length) {
    outRefStr = args[i + 1];
  } else if (args[i] === '--err-ref' && i + 1 < args.length) {
    errRefStr = args[i + 1];
  }
}

if (subcommand !== 'run-source-fetch' || !inRefStr || !outRefStr || !errRefStr) {
  console.error('Usage: portfolio-tracker-task-executor.js run-source-fetch --in-ref <::kind::value> --out-ref <::kind::value> --err-ref <::kind::value>');
  process.exit(1);
}

const inRef   = parseRef(inRefStr);
const outRef  = parseRef(outRefStr);
const errRef  = parseRef(errRefStr);
const inStorage  = blobStorageForRef(inRef);
const outStorage = blobStorageForRef(outRef);
const errStorage = blobStorageForRef(errRef);

try {
  const rawIn = inStorage.read(inRef.value);
  if (!rawIn) throw new Error(`Input not found: ${inRefStr}`);

  // Payload may be { source_def, callback } (new protocol) or raw source def (legacy).
  const envelope = JSON.parse(rawIn);
  const callback = envelope.source_def ? envelope.callback : undefined;
  const sourceDef = envelope.source_def ?? envelope;

  const { cli: sourceCliCommand } = sourceDef;
  if (!sourceCliCommand) {
    throw new Error('cli is required in source definition');
  }
  
  console.log(`[portfolio-tracker-task-executor] Executing: ${sourceCliCommand}`);
  
  let output;
  try {
    output = execSync(sourceCliCommand, {
      encoding: 'utf-8',
      timeout: (sourceDef.timeout ?? 120) * 1000,
      cwd: sourceDef.cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (execErr) {
    output = execErr.stdout || '';
    if (!output) {
      throw new Error(`Command execution failed: ${execErr.message}`);
    }
  }
  
  outStorage.write(outRef.value, output.trim());
  console.log(`[portfolio-tracker-task-executor] Success`);

  if (callback) {
    reportComplete(callback, outRef);
  } else {
    process.exit(0);
  }
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error(`[portfolio-tracker-task-executor] Error:`, errorMsg);
  errStorage.write(errRef.value, errorMsg);
  // If we have a callback, report failure; otherwise fall back to exit code
  try {
    const rawIn2 = inStorage.read(inRef.value);
    if (rawIn2) {
      const envelope = JSON.parse(rawIn2);
      if (envelope.callback) { reportFailed(envelope.callback, errorMsg); return; }
    }
  } catch {}
  process.exit(1);
}
