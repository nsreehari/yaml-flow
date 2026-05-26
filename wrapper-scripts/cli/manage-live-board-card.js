#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { log_it, readKnownBaseRef, resolveKnownYamlFlowCliPath } from './shared_helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boardLiveCardsCliPath = resolveKnownYamlFlowCliPath('board-live-cards-cli.mjs');
const cardStoreCliPath = resolveKnownYamlFlowCliPath('card-store-cli.mjs');
const validateCandidateCardPath = path.join(__dirname, 'preflight-validate-candidate-card-definition.js');

const usageLines = [
  'Usage:',
  '  node manage-live-board-card.js read-card [--base-ref <board-ref>] --card-id <card-id>',
  '  cat payload.json | node manage-live-board-card.js upsert-card [--base-ref <board-ref>] --card-id <card-id>',
  '  node manage-live-board-card.js deprecate [--base-ref <board-ref>] --card-id <card-id>',
  '',
  'Upsert payload shape:',
  '  { "candidate_card_content": <card> }',
];

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
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

  return {
    command: positional[0],
    flags,
  };
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

function readStdinJson() {
  if (process.stdin.isTTY) {
    return null;
  }

  const input = fs.readFileSync(0, 'utf8').trim();
  return input ? JSON.parse(input) : null;
}

function readCandidateCardPayload() {
  const payload = readStdinJson();
  if (!payload) {
    printUsage(1);
  }

  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('stdin payload must be a JSON object');
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'candidate_card_content')) {
    throw new Error('payload must include candidate_card_content');
  }

  const candidateCard = payload.candidate_card_content;
  if (candidateCard == null || typeof candidateCard !== 'object' || Array.isArray(candidateCard)) {
    throw new Error('payload candidate_card_content must be a JSON object');
  }

  return candidateCard;
}

function runJsonScript(scriptPath, scriptArgs, payload) {
  const result = spawnSync(process.execPath, [scriptPath, ...scriptArgs], {
    encoding: 'utf8',
    input: payload === undefined ? undefined : JSON.stringify(payload),
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : '';
    throw new Error(stderr || `${path.basename(scriptPath)} failed with exit code ${result.status}`);
  }

  const out = result.stdout.trim();
  return out ? JSON.parse(out) : null;
}

function unwrapSuccessfulEnvelope(result, commandName) {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null;
  }

  if (result?.status === 'fail' || result?.status === 'error') {
    throw new Error(result.error || `${commandName} failed`);
  }

  throw new Error(`${commandName} returned an unexpected response shape`);
}

function readCardStoreRef(baseRef) {
  const result = runJsonScript(boardLiveCardsCliPath, ['get-card-store-ref', '--base-ref', baseRef]);
  const data = unwrapSuccessfulEnvelope(result, 'get-card-store-ref');
  const storeRef = data?.storeRef ?? data?.value;
  if (typeof storeRef !== 'string' || !storeRef.trim()) {
    throw new Error('get-card-store-ref did not return a card store ref');
  }
  return storeRef.trim();
}

function resolveBaseRef(flags) {
  if (typeof flags['base-ref'] === 'string' && flags['base-ref'].trim()) {
    return flags['base-ref'].trim();
  }

  return readKnownBaseRef();
}

function resolveCardStoreRef(flags) {
  if (typeof flags['store-ref'] === 'string' && flags['store-ref'].trim()) {
    throw new Error('--store-ref is no longer supported; use --base-ref or staged known constants instead');
  }

  return readCardStoreRef(resolveBaseRef(flags));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function handleReadCard(flags) {
  const storeRef = resolveCardStoreRef(flags);
  const cardId = requireArgText(flags, 'card-id');
  const result = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
  printJson(result);
}

function handleUpsertCard(flags) {
  const baseRef = resolveBaseRef(flags);
  const storeRef = readCardStoreRef(baseRef);
  const cardId = requireArgText(flags, 'card-id');
  const candidateCard = readCandidateCardPayload();

  if (typeof candidateCard.id !== 'string' || !candidateCard.id.trim()) {
    throw new Error('candidate_card_content.id must be a non-empty string');
  }
  if (candidateCard.id !== cardId) {
    throw new Error(`candidate_card_content.id must match --card-id (${cardId})`);
  }

  const validation = runJsonScript(validateCandidateCardPath, [], {
    candidate_card_content: candidateCard,
  });

  if (validation?.status !== 'success' || validation?.data?.isValid !== true) {
    printJson({
      status: 'fail',
      step: 'validate',
      validation,
    });
    process.exit(1);
  }

  let previousCard;
  try {
    const prev = runJsonScript(cardStoreCliPath, ['get', '--store-ref', storeRef, '--id', cardId]);
    previousCard = Array.isArray(prev) && prev.length > 0 ? prev[0] : null;
  } catch {
    previousCard = null;
  }

  const storeUpdate = runJsonScript(cardStoreCliPath, ['set', '--store-ref', storeRef], candidateCard);

  let boardUpdate;
  try {
    const boardRaw = runJsonScript(boardLiveCardsCliPath, ['upsert-card', '--base-ref', baseRef, '--card-id', cardId, '--restart']);
    unwrapSuccessfulEnvelope(boardRaw, 'upsert-card');
    boardUpdate = boardRaw;
  } catch (boardErr) {
    // Rollback card store to previous state
    try {
      if (previousCard) {
        runJsonScript(cardStoreCliPath, ['set', '--store-ref', storeRef], previousCard);
      }
    } catch { /* best-effort rollback */ }
    throw boardErr;
  }

  printJson({
    status: 'success',
    data: {
      validation,
      store_update: storeUpdate,
      board_update: boardUpdate,
    },
  });
}

function handleDeprecate(flags) {
  const baseRef = resolveBaseRef(flags);
  const cardId = requireArgText(flags, 'card-id');
  const result = runJsonScript(boardLiveCardsCliPath, ['remove-card', '--base-ref', baseRef, '--id', cardId]);
  unwrapSuccessfulEnvelope(result, 'remove-card');
  printJson(result);
}

function main() {
  const argv = process.argv.slice(2);
  log_it('manage-live-board-card.js', argv.join(' '));
  const { command, flags } = parseArgs(argv);
  if (flags.help || flags.h) {
    printUsage(0);
  }

  switch (command) {
    case 'read-card':
      handleReadCard(flags);
      return;
    case 'upsert-card':
      handleUpsertCard(flags);
      return;
    case 'deprecate':
      handleDeprecate(flags);
      return;
    default:
      printUsage(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}