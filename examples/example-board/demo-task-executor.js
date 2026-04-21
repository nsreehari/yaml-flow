#!/usr/bin/env node

/**
 * demo-task-executor.js — Simple mock source executor for example-board.
 *
 * Protocol (invoked by board-live-cards-cli):
 *   node demo-task-executor.js run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
 *
 * Expected source definition:
 *   { "bindTo": "...", "outputFile": "...", "mock": "keyName" }
 *
 * Behavior:
 *   1. Read mock.db (JSON file next to this script)
 *   2. Look up source.mock value as a key in mock.db
 *   3. Write corresponding value to --out file (as JSON)
 *   4. Exit 0 on success, exit 1 on error
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_DB_PATH = path.join(__dirname, 'mock.db');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function fail(msg, errFile) {
  if (errFile) {
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`[demo-task-executor] ${msg}`);
  process.exit(1);
}

function runSourceFetchSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const outIdx = argv.indexOf('--out');
  const errIdx = argv.indexOf('--err');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? argv[errIdx + 1] : undefined;

  if (!inFile || !outFile) {
    fail('Usage: run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]', errFile);
  }

  if (!fs.existsSync(inFile)) {
    fail(`Input file not found: ${inFile}`, errFile);
  }

  let sourceDef;
  try {
    sourceDef = readJson(inFile);
  } catch (err) {
    fail(`Cannot parse source file: ${String(err && err.message || err)}`, errFile);
  }

  // Load mock.db
  let mockDb;
  try {
    if (!fs.existsSync(MOCK_DB_PATH)) {
      fail(`mock.db not found at ${MOCK_DB_PATH}`, errFile);
    }
    mockDb = readJson(MOCK_DB_PATH);
  } catch (err) {
    fail(`Cannot parse mock.db: ${String(err && err.message || err)}`, errFile);
  }

  // Extract key from source.mock
  const mockKey = sourceDef.mock;
  if (!mockKey) {
    fail('Source definition missing "mock" field (key to lookup)', errFile);
  }

  // Look up value in mockDb
  const value = mockDb[mockKey];
  if (value === undefined) {
    fail(`Key "${mockKey}" not found in mock.db`, errFile);
  }

  // Write result to --out
  try {
    fs.writeFileSync(outFile, JSON.stringify(value, null, 2));
  } catch (err) {
    fail(`Cannot write output file: ${String(err && err.message || err)}`, errFile);
  }

  process.exit(0);
}

function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main();
