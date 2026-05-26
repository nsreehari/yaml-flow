#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { log_it, readKnownBaseRef, resolveKnownYamlFlowCliPath } from './shared_helpers.js';

const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');

const usageLines = [
  'Usage:',
  '  node discover-source-kinds.js',
  '',
  'Returns the source-authoring subset of describe-task-executor-capabilities:',
  '  { "version": "1.0", "commonSourceDefFields": {...}, "sourceKinds": {...} }',
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function main() {
  const argv = process.argv.slice(2);
  log_it('discover-source-kinds.js', argv.join(' '));
  const args = parseArgs(argv);
  if (args.help || args.h) {
    printUsage(0);
  }

  const baseRef = readKnownBaseRef();

  const result = spawnSync(
    process.execPath,
    [boardLiveCardsCliPath, 'describe-task-executor-capabilities', '--base-ref', baseRef],
    {
      encoding: 'utf8',
      windowsHide: true,
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `describe-task-executor-capabilities failed with exit code ${result.status}`);
  }

  const parsed = JSON.parse(result.stdout.trim());
  const capabilityReport = parsed?.status === 'success' && parsed.data != null ? parsed.data : parsed;
  if (parsed?.status === 'fail' || parsed?.status === 'error') {
    throw new Error(parsed.error || 'describe-task-executor-capabilities failed');
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        version: capabilityReport.version,
        commonSourceDefFields: capabilityReport.commonSourceDefFields ?? {},
        sourceKinds: capabilityReport.sourceKinds ?? {},
      },
      null,
      2
    )}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}