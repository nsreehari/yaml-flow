#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { log_it, readKnownBaseRef, resolveKnownYamlFlowCliPath } from './shared_helpers.js';

const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');

const usageLines = [
  'Usage:',
  '  node inspect-file-contents.js --card-id <card-id> --file-idx <file-idx>',
];

function parseArgs(argv) {
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      flags[key] = true;
      continue;
    }

    flags[key] = value;
    index += 1;
  }

  return flags;
}

function printUsage(exitCode = 0) {
  const writer = exitCode === 0 ? process.stdout : process.stderr;
  writer.write(`${usageLines.join('\n')}\n`);
  process.exit(exitCode);
}

function requireArgText(flags, key) {
  if (typeof flags[key] !== 'string' || !flags[key].trim()) {
    printUsage(1);
  }

  return flags[key].trim();
}

function parseRequiredNonNegativeInteger(flags, key) {
  const rawValue = flags[key];
  const parsedValue = Number.parseInt(String(rawValue), 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`--${key} must be a non-negative integer`);
  }

  return parsedValue;
}

function runTextScript(scriptPath, scriptArgs) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

function readAttachmentContents(cardId, fileIdx) {
  const baseRef = readKnownBaseRef();
  const result = runTextScript(boardLiveCardsCliPath, [
    'get-attachment-content',
    '--base-ref',
    baseRef,
    '--card-id',
    cardId,
    '--file-idx',
    String(fileIdx),
  ]);

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString('utf8').trim() : '';
    throw new Error(stderr || `get-attachment-content failed with exit code ${result.status}`);
  }

  return result.stdout;
}

function main() {
  const argv = process.argv.slice(2);
  log_it('inspect-file-contents.js', argv.join(' '));
  const flags = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }

  const cardId = typeof flags.cardid === 'string' && flags.cardid.trim()
    ? flags.cardid.trim()
    : typeof flags['card-id'] === 'string' && flags['card-id'].trim()
      ? flags['card-id'].trim()
      : requireArgText(flags, 'cardid');
  const fileIdx = parseRequiredNonNegativeInteger(flags, 'file-idx');
  const fileContents = readAttachmentContents(cardId, fileIdx);
  log_it('inspect-file-contents.js:response', {
    cardId,
    fileIdx,
    text: fileContents.toString('utf8'),
  });
  process.stdout.write(fileContents);
}

try {
  main();
} catch (error) {
  log_it('inspect-file-contents.js:error', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}