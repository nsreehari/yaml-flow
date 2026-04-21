#!/usr/bin/env node
/**
 * Portfolio Tracker Task-Executor
 * 
 * Implements the run-source-fetch protocol for board-live-cards.
 * This script acts as an external task-executor that can be registered via .task-executor file.
 * 
 * Contract:
 *   portfolio-tracker-task-executor.js run-source-fetch --in <defFile> --out <resultFile> --err <errFile>
 * 
 * Input (--in file):
 *   JSON source definition with { cli: "...", bindTo: "...", outputFile: "...", ... }
 * 
 * Output (on success):
 *   --out file contains the execution result
 *   Exit code: 0
 * 
 * Output (on error):
 *   --err file contains error message
 *   Exit code: 1
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse command line arguments
const args = process.argv.slice(2);
let subcommand = '';
let inFile = '';
let outFile = '';
let errFile = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === 'run-source-fetch') {
    subcommand = 'run-source-fetch';
  } else if (args[i] === '--in' && i + 1 < args.length) {
    inFile = args[i + 1];
  } else if (args[i] === '--out' && i + 1 < args.length) {
    outFile = args[i + 1];
  } else if (args[i] === '--err' && i + 1 < args.length) {
    errFile = args[i + 1];
  }
}

if (subcommand !== 'run-source-fetch' || !inFile || !outFile || !errFile) {
  console.error('Usage: portfolio-tracker-task-executor.js run-source-fetch --in <defFile> --out <resultFile> --err <errFile>');
  process.exit(1);
}

try {
  // 1. Read source definition from --in file
  console.log(`[portfolio-tracker-task-executor] Reading source definition from ${inFile}`);
  const sourceDefStr = fs.readFileSync(inFile, 'utf-8');
  const sourceDef = JSON.parse(sourceDefStr);
  
  // 2. Extract cli command from source definition
  const { cli: sourceCliCommand } = sourceDef;
  if (!sourceCliCommand) {
    throw new Error('cli is required in source definition');
  }
  
  console.log(`[portfolio-tracker-task-executor] Executing: ${sourceCliCommand}`);
  
  // 3. Execute source.cli synchronously and capture output
  let output;
  try {
    output = execSync(sourceCliCommand, {
      encoding: 'utf-8',
      timeout: (sourceDef.timeout ?? 120) * 1000,  // Convert to ms
      cwd: sourceDef.cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],  // Capture stdout/stderr
    });
  } catch (execErr) {
    // Even on error, try to use what output we got
    output = execErr.stdout || '';
    if (!output) {
      throw new Error(`Command execution failed: ${execErr.message}`);
    }
  }
  
  // 4. Write output to --out file
  console.log(`[portfolio-tracker-task-executor] Writing result to ${outFile}`);
  fs.writeFileSync(outFile, output.trim(), 'utf-8');
  
  console.log(`[portfolio-tracker-task-executor] Success`);
  process.exit(0);
} catch (error) {
  // 3a. On error: write error message to --err file and exit non-zero
  const errorMsg = error instanceof Error ? error.message : String(error);
  console.error(`[portfolio-tracker-task-executor] Error:`, errorMsg);
  
  fs.writeFileSync(errFile, errorMsg, 'utf-8');
  process.exit(1);
}
